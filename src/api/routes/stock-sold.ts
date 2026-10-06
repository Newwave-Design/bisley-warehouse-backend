/**
 * Stock Sold report — what sold from our own inventory, by ISO week, to pay the supplier for that stock.
 *
 * Same lines as Supplier Re-orders (customer-order lines, kits expanded to components, supplier SKU + colour, summed per
 * SKU), but only units that came out of stock we have checked in: per SKU, the total quantity on completed check-in
 * sessions is used up by that SKU's orders oldest first, and what each order consumes counts in the week it was placed.
 * A sale never counts for more than was checked in, and still counts if the stock has since run to 0.
 *
 * GET /api/stock-sold?from=YYYY-MM-DD&to=YYYY-MM-DD         — weeks with rows, plus SKUs sold that have no supplier SKU
 * GET /api/stock-sold/export?from=...&to=...                 — the same as an .xlsx (Week, SKU, Title, Colour, Full SKU, Quantity)
 * Dates are inclusive; default is the last 8 weeks.
 */

import express, { Response } from 'express';
import XLSX from 'xlsx';
import { query } from '../../db/index.js';
import { authMiddleware, requirePermission, AuthRequest } from '../../middleware/auth.js';
import { buildLines, safeCell } from './supplier-reorders.js';

const router = express.Router();

const DAY = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoWeek(d: Date): { key: string; start: Date } {
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(t - dow * DAY);
  const thursday = new Date(start.getTime() + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY / 7) + 1;
  return { key: `${year}-W${String(week).padStart(2, '0')}`, start };
}

function fmt(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function parseRange(q: any): { from: Date; to: Date } | null {
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const to = q.to ? (DATE_RE.test(String(q.to)) ? new Date(`${q.to}T00:00:00Z`) : null) : todayUtc;
  const from = q.from ? (DATE_RE.test(String(q.from)) ? new Date(`${q.from}T00:00:00Z`) : null) : new Date(todayUtc.getTime() - 55 * DAY);
  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return null;
  if ((to.getTime() - from.getTime()) / DAY > 800) return null;
  return { from, to };
}

export async function buildReport(from: Date, to: Date) {
  const [lines, checkedIn] = await Promise.all([
    buildLines(),
    query(`SELECT ci.medusa_sku AS sku, SUM(ci.quantity_scanned)::int AS qty
           FROM checkin_items ci JOIN checkin_sessions s ON s.id = ci.session_id
           WHERE s.status = 'COMPLETE' AND NOT s.is_sandbox AND ci.removed_at IS NULL AND ci.medusa_sku IS NOT NULL
           GROUP BY ci.medusa_sku`),
  ]);
  const remaining = new Map<string, number>(checkedIn.rows.map((r: any) => [r.sku, Number(r.qty)]));
  const endExclusive = to.getTime() + DAY;

  type Row = { supplier_sku: string; colour: string; full_sku: string; title: string; quantity: number };
  const weeks = new Map<string, { key: string; start: Date; rows: Map<string, Row> }>();
  const missing = new Map<string, number>();

  // Oldest orders first: they consume checked-in stock first, across all history, not just the report range
  lines.sort((a, b) => a.ordered_at.localeCompare(b.ordered_at) || a.pick_list_number.localeCompare(b.pick_list_number));
  for (const l of lines) {
    const available = remaining.get(l.sku) ?? 0;
    const qty = Math.min(l.quantity, available);
    if (qty <= 0) continue;
    remaining.set(l.sku, available - qty);
    const t = new Date(l.ordered_at).getTime();
    if (t < from.getTime() || t >= endExclusive) continue;
    if (!l.supplier_sku) { missing.set(l.sku, (missing.get(l.sku) ?? 0) + qty); continue; }
    const w = isoWeek(new Date(t));
    const wk = weeks.get(w.key) ?? weeks.set(w.key, { key: w.key, start: w.start, rows: new Map() }).get(w.key)!;
    const k = `${l.supplier_sku}|${l.supplier_colour}`;
    const row = wk.rows.get(k);
    if (row) row.quantity += qty;
    else wk.rows.set(k, {
      supplier_sku: l.supplier_sku, colour: l.supplier_colour,
      full_sku: l.supplier_colour ? `${l.supplier_sku}-${l.supplier_colour}` : l.supplier_sku,
      title: l.title, quantity: qty,
    });
  }

  const out = [...weeks.values()].sort((a, b) => a.key.localeCompare(b.key)).map((w) => {
    const rows = [...w.rows.values()].sort((a, b) => a.supplier_sku.localeCompare(b.supplier_sku) || a.colour.localeCompare(b.colour));
    const end = new Date(w.start.getTime() + 6 * DAY);
    return { key: w.key, label: `${fmt(w.start)} – ${fmt(end)} ${end.getUTCFullYear()}`, rows, total: rows.reduce((s, r) => s + r.quantity, 0) };
  });
  return { weeks: out, missing: [...missing.entries()].map(([sku, quantity]) => ({ sku, quantity })), stocked_skus: checkedIn.rows.length };
}

router.get('/', authMiddleware, requirePermission('manage_orders'), async (req: AuthRequest, res: Response) => {
  const range = parseRange(req.query);
  if (!range) return res.status(400).json({ error: 'Invalid date range' });
  try {
    res.json(await buildReport(range.from, range.to));
  } catch (err) {
    console.error('[stock-sold] report failed:', err);
    res.status(500).json({ error: 'Failed to build the report' });
  }
});

router.get('/export', authMiddleware, requirePermission('manage_orders'), async (req: AuthRequest, res: Response) => {
  const range = parseRange(req.query);
  if (!range) return res.status(400).json({ error: 'Invalid date range' });
  try {
    const report = await buildReport(range.from, range.to);
    const aoa: (string | number)[][] = [['Week', 'SKU', 'Title', 'Colour', 'Full SKU', 'Quantity']];
    for (const w of report.weeks) for (const r of w.rows) {
      aoa.push([w.key, safeCell(r.supplier_sku), safeCell(r.title), safeCell(r.colour), safeCell(r.full_sku), r.quantity]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 10 }, { wch: 22 }, { wch: 50 }, { wch: 14 }, { wch: 30 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Stock sold');
    const buffer: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="bisley-stock-sold-${iso(range.from)}-to-${iso(range.to)}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    console.error('[stock-sold] export failed:', err);
    res.status(500).json({ error: 'Failed to build the spreadsheet' });
  }
});

export default router;
