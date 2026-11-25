/**
 * Sets aside parts that have arrived for the custom order lines waiting on them.
 *
 * A custom line has no SKU, only a part code in its title. When stock of that code is on the shelf, the oldest
 * paid open order that needs it gets it, recorded in custom_line_arrivals. Rules:
 *   - codes match once separators and case are tidied (see custom-arrivals-plan.ts); near misses are only
 *     suggested for a person to confirm, and a confirmed link is kept;
 *   - catalogue holds (order_stock_holds) come off the shelf figure first, so nothing is promised twice;
 *   - the order's status is never changed here: a person still confirms and ships it;
 *   - safe to run any number of times: it recomputes the open lines and leaves shipped ones alone.
 */

import { getPool } from '../db/index.js';
import { customPartCode, isChargeTitle } from '../api/routes/supplier-reorders.js';
import { planCustomArrivals, suggestParts, type CustomLine, type FreeStock, type PartSuggestion } from './custom-arrivals-plan.js';

export interface MatchResult { lines: number; matched: number; units: number }

/** A pool client, a transaction in a test, or the plain `query` helper. */
type Db = { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

const OPEN_CUSTOM_LINES = `
  SELECT pli.id AS item_id, pli.line_number, pli.item_title, pli.quantity_required, pli.quantity_picked,
         pl.pick_list_number, pl.created_at AS ordered_at
    FROM pick_list_items pli
    JOIN pick_lists pl ON pl.id = pli.pick_list_id
   WHERE pli.is_custom = true AND NOT COALESCE(pli.is_archived, false) AND NOT COALESCE(pli.is_sandbox, false)
     AND NOT pl.is_sandbox AND NOT COALESCE(pl.is_archived, false)
     AND pl.status NOT IN ('DISPATCHED', 'CANCELLED')
     AND (pl.payment_status IN ('captured', 'partially_refunded') OR COALESCE(pl.purchase_order_number, '') <> '')
     AND pli.quantity_picked < pli.quantity_required`;

/** The part code a custom line is waiting for, or null for a delivery charge or a line with no code. */
export function codeForLine(title: string | null | undefined): string | null {
  const t = String(title || '').trim();
  if (!t || isChargeTitle(t)) return null;
  return customPartCode(t);
}

/** Shelf stock for any SKU that starts like one of these codes (or is one of extraSkus), less what catalogue orders hold. */
export async function freeStockNear(db: Db, codes: string[], extraSkus: string[] = []): Promise<FreeStock[]> {
  const prefixes = [...new Set(codes.map((c) => c.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5)).filter((p) => p.length >= 3))];
  if (!prefixes.length && !extraSkus.length) return [];
  const shelf = await db.query(
    `SELECT upper(product_sku) AS sku, COALESCE(SUM(quantity), 0)::int AS qty
       FROM warehouse_inventory
      WHERE upper(product_sku) = ANY($2::text[])
         OR upper(regexp_replace(product_sku, '[^A-Za-z0-9]', '', 'g')) LIKE ANY (SELECT p || '%' FROM unnest($1::text[]) AS p)
      GROUP BY 1 HAVING COALESCE(SUM(quantity), 0) > 0`,
    [prefixes, extraSkus.map((s) => s.toUpperCase())],
  );
  const skus = shelf.rows.map((r: { sku: string }) => r.sku);
  if (!skus.length) return [];
  const held = await db.query(
    `SELECT upper(sku) AS sku, COALESCE(SUM(qty), 0)::int AS qty FROM order_stock_holds WHERE upper(sku) = ANY($1::text[]) GROUP BY 1`,
    [skus],
  );
  const heldBy = new Map<string, number>(held.rows.map((r: { sku: string; qty: number }) => [r.sku, Number(r.qty) || 0]));
  return shelf.rows.map((r: { sku: string; qty: number }) => ({ sku: r.sku, free: Math.max(0, (Number(r.qty) || 0) - (heldBy.get(r.sku) ?? 0)) }));
}

async function run(db: Db): Promise<MatchResult> {
  await db.query('SELECT pg_advisory_xact_lock(842463)');

  const open = await db.query(OPEN_CUSTOM_LINES);
  const lines: CustomLine[] = [];
  for (const row of open.rows) {
    const code = codeForLine(row.item_title);
    if (!code) continue;
    lines.push({
      itemId: row.item_id,
      orderedAt: new Date(row.ordered_at).getTime(),
      pickListNumber: row.pick_list_number || '',
      lineNumber: Number(row.line_number) || 0,
      code,
      needed: (Number(row.quantity_required) || 0) - (Number(row.quantity_picked) || 0),
    });
  }

  const pinnedRows = await db.query(`SELECT pick_list_item_id AS "itemId", sku FROM custom_line_arrivals WHERE manual AND consumed_at IS NULL`);
  const stock = await freeStockNear(db, lines.map((l) => l.code), pinnedRows.rows.map((r: { sku: string }) => r.sku));
  const plan = planCustomArrivals(lines, stock, pinnedRows.rows);

  // Drop what no longer applies (order gone, part used elsewhere); shipped lines (consumed) stay as history.
  await db.query(
    `DELETE FROM custom_line_arrivals WHERE consumed_at IS NULL AND NOT (pick_list_item_id = ANY($1::uuid[]))`,
    [plan.map((p) => p.itemId)],
  );
  if (plan.length) {
    await db.query(
      `INSERT INTO custom_line_arrivals (pick_list_item_id, sku, qty, manual)
       SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::int[], $4::boolean[])
       ON CONFLICT (pick_list_item_id) DO UPDATE
         SET sku = EXCLUDED.sku, qty = EXCLUDED.qty, manual = EXCLUDED.manual, updated_at = NOW()
         WHERE custom_line_arrivals.consumed_at IS NULL
           AND (custom_line_arrivals.sku IS DISTINCT FROM EXCLUDED.sku OR custom_line_arrivals.qty IS DISTINCT FROM EXCLUDED.qty
                OR custom_line_arrivals.manual IS DISTINCT FROM EXCLUDED.manual)`,
      [plan.map((p) => p.itemId), plan.map((p) => p.sku), plan.map((p) => p.qty), plan.map((p) => p.manual)],
    );
  }
  return { lines: lines.length, matched: plan.length, units: plan.reduce((sum, p) => sum + p.qty, 0) };
}

/** [existing] runs inside the caller's transaction (used by tests); otherwise it opens and commits its own. */
export async function matchCustomArrivals(existing?: Db): Promise<MatchResult> {
  if (existing) return run(existing);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Suggestions for the lines still short, from what is on the shelf. */
export async function suggestionsFor(db: Db, lines: { id: string; code: string }[]): Promise<Map<string, PartSuggestion[]>> {
  const stock = await freeStockNear(db, lines.map((l) => l.code));
  return new Map(lines.map((l) => [l.id, suggestParts(l.code, stock)]));
}

export type LinkOutcome = { ok: true } | { ok: false; status: number; error: string };

/** A person says this stocked SKU is the part a custom line is waiting for. */
export async function linkCustomArrival(itemId: string, sku: string, existing?: Db): Promise<LinkOutcome> {
  const target = String(sku || '').trim().toUpperCase();
  if (!itemId || !target) return { ok: false, status: 400, error: 'item and sku required' };
  const work = async (db: Db): Promise<LinkOutcome> => {
    const line = await db.query(`${OPEN_CUSTOM_LINES} AND pli.id = $1`, [itemId]);
    if (!line.rows[0]) return { ok: false, status: 404, error: 'That custom line is not open' };
    const free = await freeStockNear(db, [], [target]);
    if (!(free.find((f) => f.sku === target)?.free ?? 0)) return { ok: false, status: 409, error: `None of ${target} is free on the shelf` };
    await db.query(
      `INSERT INTO custom_line_arrivals (pick_list_item_id, sku, qty, manual) VALUES ($1, $2, 1, true)
       ON CONFLICT (pick_list_item_id) DO UPDATE SET sku = EXCLUDED.sku, manual = true, updated_at = NOW()
       WHERE custom_line_arrivals.consumed_at IS NULL`,
      [itemId, target],
    );
    await run(db);
    return { ok: true };
  };
  if (existing) return work(existing);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await work(client);
    await client.query(out.ok ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Undo a link: the part goes back on the shelf for the next match. */
export async function unlinkCustomArrival(itemId: string, existing?: Db): Promise<void> {
  const db: Db = existing ?? getPool();
  await db.query(`DELETE FROM custom_line_arrivals WHERE pick_list_item_id = $1 AND consumed_at IS NULL`, [itemId]);
  if (!existing) await matchCustomArrivals();
}

/** Run a match without ever failing the caller (a check-in or a timer). */
export function matchCustomArrivalsQuietly(reason: string): void {
  matchCustomArrivals()
    .then((r) => { if (r.matched) console.log(`[custom-arrivals] ${reason}: ${r.matched} of ${r.lines} custom lines have parts (${r.units} units)`); })
    .catch((err) => console.warn('[custom-arrivals]', reason, err instanceof Error ? err.message : err));
}
