/**
 * Stock Sold V2 weekly statements (Friday to Thursday, UK time).
 *
 * A statement lists payable units allocated in that week, grouped by supplier SKU + colour (WMS SKUs are translated through
 * wms_products.supplier_part_code / supplier_colour_code). Custom (no SKU) lines are listed by title. An open week is computed
 * live from sale_allocations; a locked week is read from its stored snapshot, so it never changes after it is sent.
 */
import { query } from '../db/index.js';
import { setAuditContext } from './audit.js';
import { currentWeekStart, fmtDay, thursdayOf, ukDate, utcDay, weekLabel, isoOf } from './weeks.js';

type Db = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

export interface StatementSource { pick_list_number: string | null; medusa_order_id: string | null; quantity: number; ordered_at: string | null; status: string }
export interface StatementRow {
  supplier_sku: string; supplier_colour: string; colour: string; full_sku: string; title: string; quantity: number;
  kind: 'STOCK' | 'CUSTOM'; note: string; wms_skus: string; sources: StatementSource[];
}
export interface Statement {
  week_start: string; week_end: string; label: string; status: 'OPEN' | 'LOCKED'; locked_at: string | null; locked_by: string | null;
  rows: StatementRow[]; total: number; no_supplier_sku: number; custom_units: number;
}

interface Info { title: string; colour: string; supplier_sku: string | null; supplier_colour: string }

async function loadInfo(db: Db, skus: string[]): Promise<Map<string, Info>> {
  const out = new Map<string, Info>();
  if (!skus.length) return out;
  const wp = await db.query(
    `SELECT DISTINCT ON (variant_sku) variant_sku, product_title, colour_name, colour_code, supplier_part_code, supplier_colour_code
     FROM wms_products WHERE variant_sku = ANY($1) ORDER BY variant_sku, is_archived`, [skus]);
  for (const r of wp.rows) {
    out.set(r.variant_sku, {
      title: r.product_title ?? '', colour: r.colour_name || r.colour_code || '',
      supplier_sku: r.supplier_part_code ?? null, supplier_colour: r.supplier_colour_code ?? '',
    });
  }
  return out;
}

function keyOf(kind: string, sku: string, title: string | null, i?: Info): string {
  if (kind === 'CUSTOM') return `custom|${title ?? 'Custom item'}`;
  return i?.supplier_sku ? `${i.supplier_sku}|${i.supplier_colour}` : `nosup|${sku}`;
}

export async function buildWeek(db: Db, weekStart: string): Promise<Statement> {
  const week = (await db.query(`SELECT locked_at, locked_by FROM settlement_weeks WHERE week_start = $1::date`, [weekStart])).rows[0];
  const locked = !!week?.locked_at;

  const alloc = (await db.query(
    `SELECT sku, kind, title, payable_qty, pick_list_number, medusa_order_id, ordered_at, status
     FROM sale_allocations
     WHERE week_start = $1::date AND payable_qty > 0 AND status IN ('ACTIVE', 'RELEASED_PAID')
     ORDER BY ordered_at, pick_list_number`, [weekStart])).rows;
  const info = await loadInfo(db, [...new Set(alloc.filter((a: any) => a.kind === 'STOCK').map((a: any) => a.sku))]);

  const sourcesByKey = new Map<string, StatementSource[]>();
  const live = new Map<string, StatementRow>();
  const rolled = new Map<string, Map<string, number>>();
  for (const a of alloc) {
    const i = info.get(a.sku);
    const key = keyOf(a.kind, a.sku, a.title, i);
    (sourcesByKey.get(key) ?? sourcesByKey.set(key, []).get(key)!).push({
      pick_list_number: a.pick_list_number, medusa_order_id: a.medusa_order_id, quantity: a.payable_qty,
      ordered_at: a.ordered_at ? new Date(a.ordered_at).toISOString() : null, status: a.status,
    });
    if (locked) continue;
    if (a.status !== 'ACTIVE') continue;
    const row = live.get(key) ?? live.set(key, {
      supplier_sku: a.kind === 'CUSTOM' ? '' : (i?.supplier_sku ?? ''),
      supplier_colour: a.kind === 'CUSTOM' ? '' : (i?.supplier_colour ?? ''),
      colour: a.kind === 'CUSTOM' ? '' : (i?.colour ?? ''),
      full_sku: a.kind === 'CUSTOM' ? '' : (i?.supplier_sku ? (i.supplier_colour ? `${i.supplier_sku}-${i.supplier_colour}` : i.supplier_sku) : ''),
      title: a.kind === 'CUSTOM' ? (a.title ?? 'Custom item') : (i?.title || a.sku),
      quantity: 0, kind: a.kind, note: '', wms_skus: '', sources: [],
    }).get(key)!;
    row.quantity += a.payable_qty;
    if (!row.wms_skus.split(',').includes(a.sku)) row.wms_skus = row.wms_skus ? `${row.wms_skus},${a.sku}` : a.sku;
    if (a.kind === 'STOCK' && !i?.supplier_sku) row.note = `No supplier SKU - WMS SKU ${a.sku}`;
    if (a.ordered_at) {
      const od = ukDate(new Date(a.ordered_at));
      if (od < weekStart) {
        const m = rolled.get(key) ?? rolled.set(key, new Map()).get(key)!;
        m.set(od, (m.get(od) ?? 0) + a.payable_qty);
      }
    }
  }

  let rows: StatementRow[];
  if (locked) {
    const snap = (await db.query(`SELECT supplier_sku, supplier_colour, full_sku, title, colour, quantity, kind, note, wms_skus FROM settlement_week_lines WHERE week_start = $1::date ORDER BY supplier_sku, supplier_colour, title`, [weekStart])).rows;
    rows = snap.map((s: any) => {
      const key = s.kind === 'CUSTOM' ? `custom|${s.title}` : (s.supplier_sku ? `${s.supplier_sku}|${s.supplier_colour ?? ''}` : `nosup|${s.wms_skus}`);
      return { supplier_sku: s.supplier_sku ?? '', supplier_colour: s.supplier_colour ?? '', colour: s.colour ?? '', full_sku: s.full_sku ?? '', title: s.title ?? '', quantity: s.quantity, kind: s.kind, note: s.note ?? '', wms_skus: s.wms_skus ?? '', sources: sourcesByKey.get(key) ?? [] };
    });
  } else {
    rows = [...live.entries()].map(([key, r]) => {
      const m = rolled.get(key);
      const earlier = m ? `Ordered earlier: ${[...m.entries()].sort().map(([d, q]) => `${q} × ${fmtDay(d)}`).join('; ')}` : '';
      r.note = [r.note, earlier].filter(Boolean).join('. ');
      r.sources = sourcesByKey.get(key) ?? [];
      return r;
    }).sort((a, b) => a.supplier_sku.localeCompare(b.supplier_sku) || a.colour.localeCompare(b.colour) || a.title.localeCompare(b.title));
  }

  return {
    week_start: weekStart, week_end: thursdayOf(weekStart), label: weekLabel(weekStart),
    status: locked ? 'LOCKED' : 'OPEN', locked_at: week?.locked_at ? new Date(week.locked_at).toISOString() : null, locked_by: week?.locked_by ?? null,
    rows, total: rows.reduce((s, r) => s + r.quantity, 0),
    no_supplier_sku: rows.filter((r) => r.kind === 'STOCK' && !r.supplier_sku).length,
    custom_units: rows.filter((r) => r.kind === 'CUSTOM').reduce((s, r) => s + r.quantity, 0),
  };
}

export async function listWeeks(): Promise<{ week_start: string; week_end: string; label: string; status: 'OPEN' | 'LOCKED'; locked_at: string | null; units: number; current: boolean }[]> {
  const cur = currentWeekStart();
  const open = (await query(`SELECT week_start::text AS w, COALESCE(SUM(payable_qty), 0)::int AS units FROM sale_allocations WHERE status = 'ACTIVE' AND payable_qty > 0 GROUP BY week_start`)).rows;
  const locks = (await query(`SELECT week_start::text AS w, locked_at, (SELECT COALESCE(SUM(quantity), 0)::int FROM settlement_week_lines l WHERE l.week_start = s.week_start) AS units FROM settlement_weeks s WHERE locked_at IS NOT NULL`)).rows;
  const weeks = new Map<string, { units: number; locked_at: string | null }>();
  for (const r of open) weeks.set(r.w, { units: r.units, locked_at: null });
  for (const r of locks) weeks.set(r.w, { units: r.units, locked_at: new Date(r.locked_at).toISOString() });
  if (!weeks.has(cur)) weeks.set(cur, { units: 0, locked_at: null });
  // Fill any gaps so every week between the first and now can be opened
  const sorted = [...weeks.keys()].sort();
  for (let t = utcDay(sorted[0]); t <= utcDay(cur); t += 7 * 86400000) if (!weeks.has(isoOf(t))) weeks.set(isoOf(t), { units: 0, locked_at: null });
  return [...weeks.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([w, v]) => ({
    week_start: w, week_end: thursdayOf(w), label: weekLabel(w), status: v.locked_at ? 'LOCKED' as const : 'OPEN' as const,
    locked_at: v.locked_at, units: v.units, current: w === cur,
  }));
}

export class LockError extends Error { constructor(message: string, public status = 400) { super(message); } }

/** Fix a finished week: store its statement lines so it can never change. Releases after this turn into stock we own. */
export async function lockWeek(client: Db & { query: any }, weekStart: string, actor: string, force: boolean): Promise<Statement> {
  await client.query('SELECT pg_advisory_xact_lock(727001)');
  if (!force && thursdayOf(weekStart) >= ukDate(new Date())) throw new LockError('That week has not finished yet');
  const existing = (await client.query(`SELECT locked_at FROM settlement_weeks WHERE week_start = $1::date FOR UPDATE`, [weekStart])).rows[0];
  if (existing?.locked_at) throw new LockError('That week is already locked', 409);
  const statement = await buildWeek(client, weekStart);
  for (const r of statement.rows) {
    await client.query(
      `INSERT INTO settlement_week_lines (week_start, supplier_sku, supplier_colour, full_sku, title, colour, quantity, kind, note, wms_skus)
       VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [weekStart, r.supplier_sku, r.supplier_colour, r.full_sku, r.title, r.colour, r.quantity, r.kind, r.note, r.wms_skus]
    );
  }
  await client.query(
    `INSERT INTO settlement_weeks (week_start, locked_at, locked_by) VALUES ($1::date, NOW(), $2)
     ON CONFLICT (week_start) DO UPDATE SET locked_at = NOW(), locked_by = $2`,
    [weekStart, actor]
  );
  return { ...statement, status: 'LOCKED', locked_at: new Date().toISOString(), locked_by: actor };
}

export { setAuditContext };
