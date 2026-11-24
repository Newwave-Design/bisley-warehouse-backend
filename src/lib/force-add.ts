/**
 * Force-add an item to a pick list.
 * The line is marked forced, and the stock and box planners serve a forced line before every other order, whether or not the
 * order is paid, so it takes what it needs from newer orders. Units already picked or scanned for another order stay with that
 * order; only what that order had reserved but not yet picked moves. The orders that lose out are named, flagged and recorded,
 * and the add can be undone.
 * Only an order that has already shipped or been cancelled is refused, because nothing can be picked for it. Everything else
 * goes through, and anything worth knowing comes back as a warning.
 */
import { query } from '../db/index.js';
import { ensureStockHolds } from './stock-holds.js';
import { recordPickListEvents } from './pick-list-events.js';
import { ensureForcedColumns } from './forced-columns.js';
import { canonicalSku } from './colour-names.js';

export class ForceAddError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Past picking: adding an item means it has to be picked, and packed again. */
const BACK_TO_PICKING = ['PICKED', 'PACKING', 'PACKED', 'LABEL_PRINTED'];

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
  /** Things worth knowing that did not stop it: unpaid, not in the catalogue, already booked, and so on. */
  warnings: string[];
}

export async function forceAdd(input: { pickListId: string; sku: string; quantity: number; actor: string; note?: string }): Promise<ForceAddResult> {
  // A plinth is stocked as PLINTH-{colour} but sold as MDHP-{colour}. Either can be typed; the order line is the sold one, which has its own box.
  const typed = String(input.sku || '').trim();
  const sku = canonicalSku(typed);
  const quantity = Math.floor(Number(input.quantity));
  if (!sku) throw new ForceAddError(400, 'Say which item to add');
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 99) throw new ForceAddError(400, 'The quantity must be between 1 and 99');

  const found = await query(`SELECT id, pick_list_number, status, is_archived, payment_status, purchase_order_number, label_printed_at FROM pick_lists WHERE id = $1`, [input.pickListId]);
  const list = found.rows[0];
  if (!list) throw new ForceAddError(404, 'Pick list not found');
  if (list.is_archived || ['DISPATCHED', 'CANCELLED'].includes(list.status)) {
    throw new ForceAddError(409, `This order is ${list.is_archived ? 'archived' : String(list.status).toLowerCase()}, so nothing can be picked for it. Use a new order or a replacement.`);
  }

  const warnings: string[] = [];
  const paid = ['captured', 'partially_refunded'].includes(String(list.payment_status || '')) || String(list.purchase_order_number || '').trim() !== '';
  if (!paid) warnings.push('This order is not marked paid. It was added anyway and given stock.');
  const product = await query(`SELECT variant_sku FROM wms_products WHERE upper(variant_sku) = upper($1) AND NOT is_archived LIMIT 1`, [sku]);
  const exactSku = product.rows[0] ? String(product.rows[0].variant_sku) : sku;
  if (!product.rows[0]) warnings.push(`${typed} is not in the warehouse catalogue. The line was added, but no stock or box can be reserved for an unknown item.`);
  if (/SAMPLE/i.test(exactSku)) warnings.push('Samples do not use stock, so there is nothing to take from other orders.');
  const booked = await query(
    `SELECT courier FROM collection_bookings WHERE pick_list_id = $1 AND status <> 'cancelled' AND COALESCE(direction, 'outbound') <> 'return' ORDER BY created_at DESC LIMIT 1`,
    [list.id]
  );
  if (booked.rows[0]) warnings.push(`A ${booked.rows[0].courier} collection is already booked for this order. It does not include the new item: check the box count and rebook if needed.`);
  if (list.label_printed_at) warnings.push('A label has already been printed for this order. Reprint it once the new item is packed.');

  await ensureForcedColumns();
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
  // An order that was already picked or packed has a new line that is not, so it goes back to picking.
  if (BACK_TO_PICKING.includes(list.status)) {
    await query(`UPDATE pick_lists SET status = 'IN_PROGRESS', updated_at = NOW() WHERE id = $1 AND status = ANY($2::text[])`, [list.id, BACK_TO_PICKING]);
    warnings.push(`The order was ${String(list.status).toLowerCase().replace(/_/g, ' ')} and has gone back to In progress, because the new item has to be picked.`);
  }

  await ensureStockHolds(true);
  const after = await holdSnapshot();
  const losses = lossesBetween(before, after, item.id);
  const holds = {
    stock: [...after.stock.values()].filter((row) => row.item_id === item.id).map((row) => ({ sku: row.sku, qty: row.qty })),
    boxes: [...after.boxes.values()].filter((row) => row.item_id === item.id).map((row) => ({ name: row.sku, qty: row.qty })),
  };
  if (!/SAMPLE/i.test(exactSku) && product.rows[0] && !holds.stock.length) warnings.push('There is no stock to reserve for this item in the warehouse, so the line is waiting for stock.');

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

  return { item, increased, holds, losses, warnings };
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

export interface ForcePlanResult {
  planned_at: string | null;
  forced_lines: number;
  losses: Loss[];
  warnings: string[];
}

/**
 * Force an order onto the pick list from Plan picks, however it is blocked: no stock, no box, on hold.
 * Every line still to pick is marked forced, so the planners serve this order before the others and take what it needs from
 * newer orders. The order is planned, taken off hold, and the orders that lost something are named and flagged.
 */
export async function forcePlan(input: { pickListId: string; actor: string; note?: string }): Promise<ForcePlanResult> {
  const found = await query(
    `SELECT id, pick_list_number, status, is_archived, deferred_at, payment_status, purchase_order_number FROM pick_lists WHERE id = $1`,
    [input.pickListId]
  );
  const list = found.rows[0];
  if (!list) throw new ForceAddError(404, 'Pick list not found');
  if (list.is_archived || ['DISPATCHED', 'CANCELLED'].includes(list.status)) {
    throw new ForceAddError(409, `This order is ${list.is_archived ? 'archived' : String(list.status).toLowerCase()}, so nothing can be picked for it.`);
  }
  const warnings: string[] = [];
  const paid = ['captured', 'partially_refunded'].includes(String(list.payment_status || '')) || String(list.purchase_order_number || '').trim() !== '';
  if (!paid) warnings.push('This order is not marked paid. It was planned anyway and given stock.');
  if (list.deferred_at) warnings.push('The order was on hold. It has been taken off hold.');

  await ensureForcedColumns();
  await ensureStockHolds(true);
  const before = await holdSnapshot();

  const marked = await query(
    `UPDATE pick_list_items SET forced_at = COALESCE(forced_at, NOW()), forced_by = COALESCE(forced_by, $2), updated_at = NOW()
      WHERE pick_list_id = $1 AND NOT is_archived AND quantity_required > COALESCE(quantity_picked, 0) AND product_sku NOT ILIKE '%SAMPLE%'
      RETURNING id`,
    [list.id, input.actor.slice(0, 255)]
  );
  const itemIds = marked.rows.map((row: { id: string }) => row.id);
  const planned = await query(
    `UPDATE pick_lists
        SET planned_at = COALESCE(planned_at, NOW()), deferred_at = NULL,
            status = CASE WHEN status = 'AWAITING_STOCK' THEN 'PENDING' ELSE status END, updated_at = NOW()
      WHERE id = $1 RETURNING planned_at`,
    [list.id]
  );

  await ensureStockHolds(true);
  const after = await holdSnapshot();
  const mine = new Set(itemIds);
  const losses = [...mine].flatMap((id) => lossesBetween(before, after, id)).filter((loss, index, all) => all.findIndex((other) => other.pick_list_id === loss.pick_list_id && other.what === loss.what && other.kind === loss.kind) === index);
  const heldSkus = new Set([...after.stock.values()].filter((row) => mine.has(row.item_id)).map((row) => row.sku));
  if (!heldSkus.size && itemIds.length) warnings.push('There is no stock in the warehouse to reserve for this order, so it is on the pick list but cannot be picked yet.');
  const outBoxes = await query(
    `SELECT DISTINCT pi.code FROM order_box_holds h JOIN packaging_items pi ON pi.id = h.packaging_item_id WHERE h.pick_list_item_id = ANY($1::uuid[]) AND pi.stock_on_hand <= 0`,
    [itemIds]
  );
  for (const row of outBoxes.rows) warnings.push(`${row.code} shows no stock on the shelf. The box is reserved for this order, but check there is one to use.`);

  const byList = new Map<string, Loss[]>();
  for (const loss of losses) byList.set(loss.pick_list_id, [...(byList.get(loss.pick_list_id) || []), loss]);
  for (const [listId, rows] of byList) {
    const what = rows.map((row) => `${row.qty} x ${row.what}${row.kind === 'box' ? ' (box)' : ''}`).join(', ');
    const text = `Stock reassigned: ${what} now reserved for ${list.pick_list_number} (forced onto the pick list by ${input.actor}). This order is short until more arrives.`;
    await query(
      `INSERT INTO pick_list_notes (pick_list_id, note_text, is_flagged, created_by)
       SELECT $1, $2, true, 'Force add' WHERE NOT EXISTS (SELECT 1 FROM pick_list_notes WHERE pick_list_id = $1 AND note_text = $2 AND resolved_at IS NULL)`,
      [listId, text]
    );
    await recordPickListEvents({ ids: [listId], actor: input.actor, action: 'force-add', summary: `Lost ${what} to ${list.pick_list_number}, forced onto the pick list` });
  }
  const took = [...new Set(losses.map((loss) => loss.pick_list_number))];
  await recordPickListEvents({
    ids: [list.id],
    actor: input.actor,
    action: 'force-add',
    summary: `Forced onto the pick list${took.length ? `, taking stock from ${took.join(', ')}` : ', nothing needed taking from other orders'}${input.note ? `. ${String(input.note).slice(0, 200)}` : ''}`,
  });
  return { planned_at: planned.rows[0]?.planned_at ?? null, forced_lines: itemIds.length, losses, warnings };
}

/** Takes the order back off the pick list and gives the other orders their reservations back. */
export async function undoForcePlan(input: { pickListId: string; actor: string }): Promise<{ undone: boolean }> {
  await query(`UPDATE pick_list_items SET forced_at = NULL, forced_by = NULL, updated_at = NOW() WHERE pick_list_id = $1 AND forced_at IS NOT NULL AND COALESCE(quantity_picked, 0) = 0`, [input.pickListId]);
  await query(`UPDATE pick_lists SET planned_at = NULL, updated_at = NOW() WHERE id = $1 AND status IN ('PENDING', 'AWAITING_STOCK')`, [input.pickListId]);
  await ensureStockHolds(true);
  await recordPickListEvents({ ids: [input.pickListId], actor: input.actor, action: 'force-add', summary: 'Took the force-add off and back out of the pick list' });
  return { undone: true };
}
