/**
 * Sets aside parts that have arrived for the custom order lines waiting on them.
 *
 * A custom line has no SKU, only a part code in its title. When stock of that code is on the shelf, the oldest
 * paid open order that needs it gets it, recorded in custom_line_arrivals. Shared stock rules:
 *   - catalogue holds (order_stock_holds) are taken off the shelf figure first, so a code that is also a catalogue
 *     SKU is never promised twice;
 *   - the order's status is never changed here: a person still confirms and ships it;
 *   - safe to run any number of times: it recomputes the open lines and leaves shipped ones alone.
 */
import { getPool } from '../db/index.js';
import { customPartCode, isChargeTitle } from '../api/routes/supplier-reorders.js';
import { planCustomArrivals, type CustomLine } from './custom-arrivals-plan.js';

export interface MatchResult { lines: number; matched: number; units: number }

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

export async function matchCustomArrivals(): Promise<MatchResult> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(842463)');

    const open = await client.query(OPEN_CUSTOM_LINES);
    const lines: CustomLine[] = [];
    for (const row of open.rows) {
      const title = String(row.item_title || '').trim();
      if (!title || isChargeTitle(title)) continue;
      const code = customPartCode(title);
      if (!code) continue;
      lines.push({
        itemId: row.item_id,
        orderedAt: new Date(row.ordered_at).getTime(),
        pickListNumber: row.pick_list_number || '',
        lineNumber: Number(row.line_number) || 0,
        code: code.toUpperCase(),
        needed: (Number(row.quantity_required) || 0) - (Number(row.quantity_picked) || 0),
      });
    }

    const codes = [...new Set(lines.map((line) => line.code))];
    const free = new Map<string, number>();
    if (codes.length) {
      const shelf = await client.query(
        `SELECT upper(product_sku) AS code, COALESCE(SUM(quantity), 0)::int AS qty
           FROM warehouse_inventory WHERE upper(product_sku) = ANY($1::text[]) GROUP BY 1`,
        [codes],
      );
      const held = await client.query(
        `SELECT upper(sku) AS code, COALESCE(SUM(qty), 0)::int AS qty
           FROM order_stock_holds WHERE upper(sku) = ANY($1::text[]) GROUP BY 1`,
        [codes],
      );
      const heldBy = new Map<string, number>(held.rows.map((r: { code: string; qty: number }) => [r.code, Number(r.qty) || 0]));
      for (const row of shelf.rows as { code: string; qty: number }[]) {
        free.set(row.code, Math.max(0, (Number(row.qty) || 0) - (heldBy.get(row.code) ?? 0)));
      }
    }

    const plan = planCustomArrivals(lines, free);

    // Drop what no longer applies (order gone, shipped by another route, stock used), keep shipped ones as history.
    const keep = plan.map((p) => p.itemId);
    await client.query(
      `DELETE FROM custom_line_arrivals WHERE consumed_at IS NULL AND NOT (pick_list_item_id = ANY($1::uuid[]))`,
      [keep],
    );
    if (plan.length) {
      await client.query(
        `INSERT INTO custom_line_arrivals (pick_list_item_id, sku, qty)
         SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::int[])
         ON CONFLICT (pick_list_item_id) DO UPDATE
           SET sku = EXCLUDED.sku, qty = EXCLUDED.qty, updated_at = NOW()
           WHERE custom_line_arrivals.consumed_at IS NULL
             AND (custom_line_arrivals.sku IS DISTINCT FROM EXCLUDED.sku OR custom_line_arrivals.qty IS DISTINCT FROM EXCLUDED.qty)`,
        [plan.map((p) => p.itemId), plan.map((p) => p.sku), plan.map((p) => p.qty)],
      );
    }
    await client.query('COMMIT');
    return { lines: lines.length, matched: plan.length, units: plan.reduce((sum, p) => sum + p.qty, 0) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Run a match without ever failing the caller (a check-in or a timer). */
export function matchCustomArrivalsQuietly(reason: string): void {
  matchCustomArrivals()
    .then((r) => { if (r.matched) console.log(`[custom-arrivals] ${reason}: ${r.matched} of ${r.lines} custom lines have parts (${r.units} units)`); })
    .catch((err) => console.warn('[custom-arrivals]', reason, err instanceof Error ? err.message : err));
}
