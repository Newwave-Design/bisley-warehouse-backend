/**
 * Force-add an item to a pick list.
 * The line is marked forced, and the stock and box planners serve a forced line before every other order, so it takes what it
 * needs from newer orders. Units already picked or scanned for another order stay with that order; only what that order had
 * reserved but not yet picked moves. The orders that lose out are named, flagged and recorded, and the add can be undone.
 */
import { query } from '../db/index.js';
import { ensureStockHolds } from './stock-holds.js';
import { recordPickListEvents } from './pick-list-events.js';

export class ForceAddError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const OPEN_FOR_ADD = ['PENDING', 'IN_PROGRESS', 'AWAITING_STOCK', 'PICKED'];

interface HoldRow { item_id: string; pick_list_id: string; pick_list_number: string; customer_name: string | null; sku: string; qty: number }

/** Every open order's reservation, as it stands: stock by SKU and boxes by box code. */
async function holdSnapshot(): Promise<{ stock: Map<string, HoldRow>; boxes: Map<string, HoldRow> }> {
  const stock = await query(
    `SELECT h.pick_list_item_id AS item_id, pl.id AS pick_list_id, pl.pick_list_number, pl.customer_name, h.sku, h.qty
       FROM order_stock_holds h JOIN pick_list_items pli ON pli.id = h.pick_list_item_id JOIN pick_lists pl ON pl.id = pli.pick_list_id`
  );
  const boxes = await query(
    `SELECT h.pick_list_item_id AS item_id, pl.id AS pick_list_id, pl.pick_list_number, pl.customer_name,
            COALESCE(pi.name, pi.code, h.packaging_item_id::text) AS sku, h.qty
       FROM order_box_holds h
       JOIN pick_list_items pli ON pli.id = h.pick_list_item_id
       JOIN pick_lists pl ON pl.id = pli.pick_list_id
       LEFT JOIN packaging_items pi ON pi.id = h.packaging_item_id`
  );
  const key = (row: HoldRow) => `${row.item_id}\n${row.sku}`;
  return {
    stock: new Map((stock.rows as HoldRow[]).map((row) => [key(row), { ...row, qty: Number(row.qty) }])),
    boxes: new Map((boxes.rows as HoldRow[]).map((row) => [key(row), { ...row, qty: Number(row.qty) }])),
  };
}

export interface Loss { pick_list_id: string; pick_list_number: string; customer_name: string | null; what: string; kind: 'stock' | 'box'; qty: number }

/** What each other order held before and no longer holds. */
export function lossesBetween(
  before: { stock: Map<string, HoldRow>; boxes: Map<string, HoldRow> },
  after: { stock: Map<string, HoldRow>; boxes: Map<string, HoldRow> },
  forcedItemId: string
): Loss[] {
  const out: Loss[] = [];
  const compare = (kind: 'stock' | 'box', was: Map<string, HoldRow>, now: Map<string, HoldRow>) => {
    for (const [key, row] of was) {
      if (row.item_id === forcedItemId) continue;
      const left = now.get(key)?.qty ?? 0;
      if (left < row.qty) out.push({ pick_list_id: row.pick_list_id, pick_list_number: row.pick_list_number, customer_name: row.customer_name, what: row.sku, kind, qty: row.qty - left });
    }
  };
  compare('stock', before.stock, after.stock);
  compare('box', before.boxes, after.boxes);
  return out;
}

export interface ForceAddResult {
  item: { id: string; pick_list_id: string; product_sku: string; quantity_required: number; forced_at: string };
  increased: boolean;
  /** What the forced line now holds, by stock SKU and box. */
  holds: { stock: { sku: string; qty: number }[]; boxes: { name: string; qty: number }[] };
  /** The other orders that lost reserved stock or boxes to it. */
  losses: Loss[];
}

export async function forceAdd(input: { pickListId: string; sku: string; quantity: number; actor: string; note?: string }): Promise<ForceAddResult> {
  const sku = String(input.sku || '').trim();
  const quantity = Math.floor(Number(input.quantity));
  if (!sku) throw new ForceAddError(400, 'Say which item to add');
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 99) throw new ForceAddError(400, 'The quantity must be between 1 and 99');
  if (/SAMPLE/i.test(sku)) throw new ForceAddError(400, 'Samples do not use stock, so there is nothing to force');

  const found = await query(`SELECT id, pick_list_number, status, is_archived, is_return, payment_status, purchase_order_number FROM pick_lists WHERE id = $1`, [input.pickListId]);
  const list = found.rows[0];
  if (!list) throw new ForceAddError(404, 'Pick list not found');
  if (list.is_archived || !OPEN_FOR_ADD.includes(list.status)) {
    throw new ForceAddError(409, `An order that is ${String(list.status).toLowerCase().replace(/_/g, ' ')} cannot take another item. Add it before it is packed.`);
  }
  const paid = ['captured', 'partially_refunded'].includes(String(list.payment_status || '')) || String(list.purchase_order_number || '').trim() !== '';
  if (!paid) throw new ForceAddError(409, 'This order has not been paid, and stock is only reserved for paid orders.');

  const product = await query(`SELECT variant_sku FROM wms_products WHERE upper(variant_sku) = upper($1) AND NOT is_archived LIMIT 1`, [sku]);
  if (!product.rows[0]) throw new ForceAddError(404, `${sku} is not a product in the warehouse catalogue`);
  const exactSku = String(product.rows[0].variant_sku);

  await ensureStockHolds(true);
  const before = await holdSnapshot();

  const existing = await query(
    `SELECT id, quantity_required, quantity_picked FROM pick_list_items
      WHERE pick_list_id = $1 AND upper(product_sku) = upper($2) AND NOT is_archived AND COALESCE(quantity_picked, 0) < quantity_required
      ORDER BY line_number LIMIT 1`,
    [list.id, exactSku]
  );
  let item: ForceAddResult['item'];
  let increased = false;
  if (existing.rows[0]) {
    increased = true;
    const updated = await query(
      `UPDATE pick_list_items SET quantity_required = quantity_required + $2, forced_at = COALESCE(forced_at, NOW()), forced_by = COALESCE(forced_by, $3), updated_at = NOW()
        WHERE id = $1 RETURNING id, pick_list_id, product_sku, quantity_required, forced_at`,
      [existing.rows[0].id, quantity, input.actor.slice(0, 255)]
    );
    item = updated.rows[0];
  } else {
    const created = await query(
      `INSERT INTO pick_list_items (pick_list_id, line_number, product_sku, quantity_required, quantity_picked, status, forced_at, forced_by, notes)
       VALUES ($1, COALESCE((SELECT MAX(line_number) FROM pick_list_items WHERE pick_list_id = $1), 0) + 1, $2, $3, 0, 'PENDING', NOW(), $4, $5)
       RETURNING id, pick_list_id, product_sku, quantity_required, forced_at`,
      [list.id, exactSku, quantity, input.actor.slice(0, 255), input.note ? String(input.note).slice(0, 500) : null]
    );
    item = created.rows[0];
  }
  // A picked order with a new unpicked line is not picked any more.
  if (list.status === 'PICKED') await query(`UPDATE pick_lists SET status = 'IN_PROGRESS', updated_at = NOW() WHERE id = $1 AND status = 'PICKED'`, [list.id]);

  await ensureStockHolds(true);
  const after = await holdSnapshot();
  const losses = lossesBetween(before, after, item.id);
  const holds = {
    stock: [...after.stock.values()].filter((row) => row.item_id === item.id).map((row) => ({ sku: row.sku, qty: row.qty })),
    boxes: [...after.boxes.values()].filter((row) => row.item_id === item.id).map((row) => ({ name: row.sku, qty: row.qty })),
  };

  // Each order that lost something is flagged, so the people picking it know why it is short.
  const byList = new Map<string, Loss[]>();
  for (const loss of losses) byList.set(loss.pick_list_id, [...(byList.get(loss.pick_list_id) || []), loss]);
  for (const [listId, rows] of byList) {
    const what = rows.map((row) => `${row.qty} x ${row.what}${row.kind === 'box' ? ' (box)' : ''}`).join(', ');
    const text = `Stock reassigned: ${what} now reserved for ${list.pick_list_number} (forced add by ${input.actor}). This order is short until more arrives.`;
    await query(
      `INSERT INTO pick_list_notes (pick_list_id, note_text, is_flagged, created_by)
       SELECT $1, $2, true, 'Force add' WHERE NOT EXISTS (SELECT 1 FROM pick_list_notes WHERE pick_list_id = $1 AND note_text = $2 AND resolved_at IS NULL)`,
      [listId, text]
    );
    await recordPickListEvents({ ids: [listId], actor: input.actor, action: 'force-add', summary: `Lost ${what} to a forced add on ${list.pick_list_number}` });
  }
  const took = [...new Set(losses.map((loss) => loss.pick_list_number))];
  await recordPickListEvents({
    ids: [list.id],
    actor: input.actor,
    action: 'force-add',
    summary: `Force added ${quantity} x ${exactSku}${took.length ? `, taking stock from ${took.join(', ')}` : ', nothing needed taking from other orders'}${input.note ? `. ${String(input.note).slice(0, 200)}` : ''}`,
  });

  return { item, increased, holds, losses };
}

/** Takes a forced line back off, if nothing has been picked on it. Other orders get their reservations back on the next rebuild. */
export async function undoForceAdd(input: { pickListId: string; itemId: string; actor: string }): Promise<{ removed: boolean; reducedTo?: number }> {
  const found = await query(
    `SELECT id, product_sku, quantity_required, quantity_picked, forced_at FROM pick_list_items WHERE id = $1 AND pick_list_id = $2`,
    [input.itemId, input.pickListId]
  );
  const row = found.rows[0];
  if (!row || !row.forced_at) throw new ForceAddError(404, 'That is not a forced line on this order');
  if (Number(row.quantity_picked) > 0) throw new ForceAddError(409, 'Some of this line has been picked, so it cannot be taken back off');
  await query(`DELETE FROM pick_list_items WHERE id = $1`, [row.id]);
  await ensureStockHolds(true);
  await recordPickListEvents({ ids: [input.pickListId], actor: input.actor, action: 'force-add', summary: `Took the forced ${row.quantity_required} x ${row.product_sku} back off` });
  return { removed: true };
}
