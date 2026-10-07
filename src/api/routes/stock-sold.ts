/**
 * Stock Sold report — units of our own stock that have shipped, by settlement week, to pay the supplier for that stock.
 *
 * A unit becomes payable when it is dispatched: every DISPATCH row in warehouse_movements (kits already expanded to
 * components) that took stock from a bay counts once, as one row per supplier SKU + colour with the summed quantity.
 * Weeks run Saturday to Friday and are labelled by their Friday (send day), using UK dates.
 * Units shipped with no checked-in stock behind them (location null) are not payable and are listed separately.
 *
 * GET /api/stock-sold?from=YYYY-MM-DD&to=YYYY-MM-DD   — weeks with rows, SKUs with no supplier SKU, and unstocked shipments
 * GET /api/stock-sold/export?from=...&to=...           — the same as an .xlsx (Week, SKU, Title, Colour, Full SKU, Quantity, Note)
 * Dates are inclusive and apply to the dispatch date; default is the last 8 weeks.
 */

import express, { Response } from 'express';
import XLSX from 'xlsx';
import { query } from '../../db/index.js';
import { authMiddleware, requirePermission, AuthRequest } from '../../middleware/auth.js';
import { safeCell } from './supplier-reorders.js';

const router = express.Router();

const DAY = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// movement_date is a naive timestamp written by the server clock (UTC on Railway); read it back as a UK calendar date.
function ukDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}

function utcDay(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

/** The Friday that ends the Saturday–Friday week containing the given date. */
function fridayOf(iso: string): number {
  const t = utcDay(iso);
  const dow = new Date(t).getUTCDay(); // Sunday = 0 ... Saturday = 6
  return t + ((5 - dow + 7) % 7) * DAY;
}

function fmt(t: number): string {
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function parseRange(q: any): { from: string; to: string } | null {
  const today = ukDate(new Date());
  const to = q.to ? String(q.to) : today;
  const from = q.from ? String(q.from) : new Date(utcDay(today) - 55 * DAY).toISOString().slice(0, 10);
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || Number.isNaN(utcDay(from)) || Number.isNaN(utcDay(to))) return null;
  if (from > to || (utcDay(to) - utcDay(from)) / DAY > 800) return null;
  return { from, to };
}

export async function buildReport(from: string, to: string) {
  // Pad the SQL window by a day each side, then filter on the UK date so the boundary is exact
  const moves = await query(
    `SELECT m.product_sku, m.movement_date, m.location_id, -m.quantity AS qty, pli.is_custom, pli.item_title
     FROM warehouse_movements m
     LEFT JOIN pick_list_items pli ON pli.id = m.pick_list_item_id
     WHERE m.movement_type = 'DISPATCH' AND m.movement_date >= $1::date - 1 AND m.movement_date < $2::date + 2`,
    [from, to]
  );

  const skus = [...new Set(moves.rows.map((r: any) => r.product_sku as string))];
  const info = new Map<string, { title: string; colour: string; supplier_sku: string | null; supplier_colour: string }>();
  if (skus.length) {
    const wp = await query(
      `SELECT DISTINCT ON (variant_sku) variant_sku, product_title, colour_name, colour_code, supplier_part_code, supplier_colour_code
       FROM wms_products WHERE variant_sku = ANY($1) ORDER BY variant_sku, is_archived`,
      [skus]
    );
    for (const r of wp.rows) {
      info.set(r.variant_sku, {
        title: r.product_title ?? '',
        colour: r.colour_name || r.colour_code || '',
        supplier_sku: r.supplier_part_code ?? null,
        supplier_colour: r.supplier_colour_code ?? '',
      });
    }
  }

  type Row = { supplier_sku: string; colour: string; full_sku: string; title: string; quantity: number; custom: boolean; days: Map<string, number> };
  const weeks = new Map<number, Map<string, Row>>();
  const missing = new Map<string, number>();
  const unstocked = new Map<string, number>();

  for (const m of moves.rows) {
    const day = ukDate(new Date(m.movement_date));
    if (day < from || day > to) continue;
    const qty = Number(m.qty);
    const custom = !!m.is_custom;
    if (!custom && !m.location_id) { unstocked.set(m.product_sku, (unstocked.get(m.product_sku) ?? 0) + qty); continue; }
    // Custom items have no SKU: they are listed by title
    const i = custom
      ? { title: m.item_title || 'Custom item', colour: '', supplier_sku: '', supplier_colour: '' }
      : info.get(m.product_sku);
    if (!i || (!custom && !i.supplier_sku)) { missing.set(m.product_sku, (missing.get(m.product_sku) ?? 0) + qty); continue; }

    const friday = fridayOf(day);
    const rows = weeks.get(friday) ?? weeks.set(friday, new Map()).get(friday)!;
    const k = custom ? `custom|${i.title}` : `${i.supplier_sku}|${i.supplier_colour}`;
    const row = rows.get(k) ?? rows.set(k, {
      supplier_sku: i.supplier_sku ?? '', colour: i.colour, title: i.title, quantity: 0, custom, days: new Map(),
      full_sku: i.supplier_colour ? `${i.supplier_sku}-${i.supplier_colour}` : (i.supplier_sku ?? ''),
    }).get(k)!;
    row.quantity += qty;
    row.days.set(day, (row.days.get(day) ?? 0) + qty);
  }

  const out = [...weeks.entries()].sort((a, b) => a[0] - b[0]).map(([friday, map]) => {
    const rows = [...map.values()]
      .sort((a, b) => a.supplier_sku.localeCompare(b.supplier_sku) || a.colour.localeCompare(b.colour))
      .map(({ days, custom, ...r }) => ({
        ...r,
        note: `${custom ? 'Custom item (no SKU). ' : ''}Dispatched: ${[...days.entries()].sort().map(([d, q]) => `${q} × ${fmt(utcDay(d))}`).join('; ')}`,
      }));
    const iso = new Date(friday).toISOString().slice(0, 10);
    return {
      key: `w/e ${iso}`,
      label: `${fmt(friday - 6 * DAY)} – ${fmt(friday)} ${new Date(friday).getUTCFullYear()}`,
      rows,
      total: rows.reduce((s, r) => s + r.quantity, 0),
    };
  });

  const list = (m: Map<string, number>) => [...m.entries()].map(([sku, quantity]) => ({ sku, quantity }));
  return { weeks: out, missing: list(missing), unstocked: list(unstocked) };
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
    ws['!cols'] = [{ wch: 16 }, { wch: 22 }, { wch: 50 }, { wch: 14 }, { wch: 30 }, { wch: 10 }, { wch: 45 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Stock sold');
    const buffer: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="bisley-stock-sold-${range.from}-to-${range.to}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    console.error('[stock-sold] export failed:', err);
    res.status(500).json({ error: 'Failed to build the spreadsheet' });
  }
});

export default router;
