/**
 * Stock Sold report — what sold from our own inventory, by ISO week, to pay the supplier for that stock.
 *
 * Same lines as Supplier Re-orders (customer-order lines, kits expanded to components, supplier SKU + colour, summed per
 * SKU), but only units that came out of stock we have checked in. Per SKU, orders (oldest first) use up completed check-in
 * batches (oldest first). A unit counts in the later of the week it was sold and the week its stock was checked in, so a
 * sale made before the stock arrived rolls forward to the check-in week, with a note of when it was sold.
 * A sale never counts for more than was checked in, and still counts if the stock has since run to 0.
 *
 * GET /api/stock-sold?from=YYYY-MM-DD&to=YYYY-MM-DD         — weeks with rows, plus SKUs sold that have no supplier SKU
 * GET /api/stock-sold/export?from=...&to=...                 — the same as an .xlsx (Week, SKU, Title, Colour, Full SKU, Quantity, Note)
 * Dates are inclusive and apply to the week a unit counts in; default is the last 8 weeks.
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
    query(`SELECT ci.medusa_sku AS sku, COALESCE(s.completed_at, s.updated_at) AS at, SUM(ci.quantity_scanned)::int AS qty
           FROM checkin_items ci JOIN checkin_sessions s ON s.id = ci.session_id
           WHERE s.status = 'COMPLETE' AND NOT s.is_sandbox AND ci.removed_at IS NULL AND ci.medusa_sku IS NOT NULL
           GROUP BY ci.medusa_sku, s.id, COALESCE(s.completed_at, s.updated_at)
           ORDER BY COALESCE(s.completed_at, s.updated_at)`),
  ]);
  const batches = new Map<string, { at: number; remaining: number }[]>();
  for (const r of checkedIn.rows) {
    const list = batches.get(r.sku) ?? batches.set(r.sku, []).get(r.sku)!;
    list.push({ at: new Date(r.at).getTime(), remaining: Number(r.qty) });
  }
  const endExclusive = to.getTime() + DAY;

  type Row = { supplier_sku: string; colour: string; full_sku: string; title: string; quantity: number; rolled: Map<number, number> };
  const weeks = new Map<string, { key: string; start: Date; rows: Map<string, Row> }>();
  const missing = new Map<string, number>();

  // Oldest orders first, across all history, so each takes the oldest stock still unsold
  lines.sort((a, b) => a.ordered_at.localeCompare(b.ordered_at) || a.pick_list_number.localeCompare(b.pick_list_number));
  for (const l of lines) {
    const skuBatches = batches.get(l.sku);
    if (!skuBatches) continue;
    const sold = new Date(l.ordered_at).getTime();
    let left = l.quantity;
    for (const b of skuBatches) {
      if (left <= 0) break;
      if (b.remaining <= 0) continue;
      const qty = Math.min(left, b.remaining);
      b.remaining -= qty;
      left -= qty;
      const counted = Math.max(sold, b.at);
      if (counted < from.getTime() || counted >= endExclusive) continue;
      if (!l.supplier_sku) { missing.set(l.sku, (missing.get(l.sku) ?? 0) + qty); continue; }
      const w = isoWeek(new Date(counted));
      const wk = weeks.get(w.key) ?? weeks.set(w.key, { key: w.key, start: w.start, rows: new Map() }).get(w.key)!;
      const k = `${l.supplier_sku}|${l.supplier_colour}`;
      const row = wk.rows.get(k) ?? wk.rows.set(k, {
        supplier_sku: l.supplier_sku, colour: l.supplier_colour,
        full_sku: l.supplier_colour ? `${l.supplier_sku}-${l.supplier_colour}` : l.supplier_sku,
        title: l.title, quantity: 0, rolled: new Map(),
      }).get(k)!;
      row.quantity += qty;
      if (sold < b.at) {
        const day = Date.UTC(new Date(sold).getUTCFullYear(), new Date(sold).getUTCMonth(), new Date(sold).getUTCDate());
        row.rolled.set(day, (row.rolled.get(day) ?? 0) + qty);
      }
    }
  }

  const out = [...weeks.values()].sort((a, b) => a.key.localeCompare(b.key)).map((w) => {
    const rows = [...w.rows.values()]
      .sort((a, b) => a.supplier_sku.localeCompare(b.supplier_sku) || a.colour.localeCompare(b.colour))
      .map(({ rolled, ...r }) => ({
        ...r,
        note: rolled.size ? `Sold before stocked: ${[...rolled.entries()].sort((a, b) => a[0] - b[0]).map(([d, q]) => `${q} × ${fmt(new Date(d))}`).join('; ')}` : '',
      }));
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
    const aoa: (string | number)[][] = [['Week', 'SKU', 'Title', 'Colour', 'Full SKU', 'Quantity', 'Note']];
    for (const w of report.weeks) for (const r of w.rows) {
      aoa.push([w.key, safeCell(r.supplier_sku), safeCell(r.title), safeCell(r.colour), safeCell(r.full_sku), r.quantity, r.note]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 10 }, { wch: 22 }, { wch: 50 }, { wch: 14 }, { wch: 30 }, { wch: 10 }, { wch: 45 }];
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
