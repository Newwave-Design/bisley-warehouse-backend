/**
 * A return request is the queue for the warehouse. Booking the collection comes after.
 */
import { query } from '../db/index.js';
import { openReturnReplacement, releaseReturnReplacement } from './return-replacement.js';

const RETURNABLE = ['DISPATCHED', 'PICKED', 'PACKING', 'PACKED', 'LABEL_PRINTED'];

export class ReturnRequestError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function listReturnRequests(pickListId?: string) {
  const params: string[] = [];
  let where = `r.status <> 'cancelled'`;
  if (pickListId) {
    params.push(pickListId);
    where += ` AND r.pick_list_id = $1`;
  }
  const result = await query(
    `SELECT r.id, r.pick_list_id, r.sku, r.status, r.outcome, r.booking_id, r.created_by, r.created_at,
            pli.item_title, pl.pick_list_number,
            repl.id AS replacement_id, repl.pick_list_number AS replacement_number, repl.status AS replacement_status
       FROM return_requests r
       JOIN pick_lists pl ON pl.id = r.pick_list_id
       LEFT JOIN LATERAL (
         SELECT item_title FROM pick_list_items
          WHERE pick_list_id = r.pick_list_id AND product_sku = r.sku AND NOT COALESCE(is_archived, false)
          ORDER BY line_number LIMIT 1
       ) pli ON true
       LEFT JOIN LATERAL (
         SELECT c.id, c.pick_list_number, c.status
           FROM pick_lists c
           JOIN pick_list_items ci ON ci.pick_list_id = c.id
            AND ci.product_sku = r.sku AND NOT COALESCE(ci.is_archived, false)
          WHERE c.parent_pick_list_id = r.pick_list_id
            AND COALESCE(c.is_return, false)
            AND c.status <> 'CANCELLED'
          ORDER BY c.created_at DESC
          LIMIT 1
       ) repl ON true
      WHERE ${where}
      ORDER BY r.created_at, r.sku`,
    params
  );
  return result.rows;
}

async function skusOnList(pickListId: string): Promise<string[]> {
  const items = await query(
    `SELECT DISTINCT product_sku
       FROM pick_list_items
      WHERE pick_list_id = $1 AND NOT COALESCE(is_archived, false)
        AND COALESCE(product_sku, '') <> ''
        AND product_sku NOT ILIKE '%SAMPLE%'
      ORDER BY product_sku`,
    [pickListId]
  );
  return items.rows.map((row: { product_sku: string }) => row.product_sku);
}

/** Mark the whole order, or the given items, as waiting for a return collection. A replacement goes straight to To pick. */
export async function requestReturns(pickListId: string, skus: string[] | null, actor: string, outcome: string) {
  const choice = outcome === 'replace' ? 'replace' : outcome === 'refund' ? 'refund' : '';
  if (!choice) throw new ReturnRequestError('Choose whether this return is a refund or a replacement.');
  const found = await query(`SELECT id, status FROM pick_lists WHERE id = $1`, [pickListId]);
  const list = found.rows[0];
  if (!list) throw new ReturnRequestError('Unknown order', 404);
  if (!RETURNABLE.includes(list.status)) {
    throw new ReturnRequestError('A return request is for an order that has been picked or shipped.');
  }
  const onList = await skusOnList(pickListId);
  const wanted = skus?.length ? [...new Set(skus.map((sku) => sku.trim()).filter(Boolean))] : onList;
  if (!wanted.length) throw new ReturnRequestError('This order has no items to return.');
  const missing = wanted.filter((sku) => !onList.includes(sku));
  if (missing.length) throw new ReturnRequestError(`${missing[0]} is not on this order.`);

  for (const sku of wanted) {
    await query(
      `INSERT INTO return_requests (pick_list_id, sku, created_by, outcome)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (pick_list_id, sku) WHERE status <> 'cancelled'
       DO UPDATE SET outcome = EXCLUDED.outcome, updated_at = NOW()
       WHERE return_requests.status = 'requested'`,
      [pickListId, sku, actor.slice(0, 255), choice]
    );
    if (choice === 'replace') await openReturnReplacement(pickListId, sku);
    else await releaseReturnReplacement(pickListId, sku);
  }
  return listReturnRequests(pickListId);
}

/** Take an unbooked request off the Returns tab. */
export async function cancelReturnRequests(pickListId: string, skus: string[]) {
  const wanted = [...new Set(skus.map((sku) => sku.trim()).filter(Boolean))];
  if (!wanted.length) throw new ReturnRequestError('Choose an item to remove.');
  const replacing = await query(
    `SELECT sku FROM return_requests
      WHERE pick_list_id = $1 AND sku = ANY($2::text[]) AND status = 'requested' AND outcome = 'replace'`,
    [pickListId, wanted]
  );
  await query(
    `UPDATE return_requests
        SET status = 'cancelled', updated_at = NOW()
      WHERE pick_list_id = $1 AND sku = ANY($2::text[]) AND status = 'requested'`,
    [pickListId, wanted]
  );
  for (const row of replacing.rows) await releaseReturnReplacement(pickListId, row.sku);
  return listReturnRequests(pickListId);
}

export async function markReturnRequestsBooked(pickListId: string, sku: string, bookingId: string | null) {
  if (!sku) return;
  await query(
    `UPDATE return_requests
        SET status = 'booked', booking_id = $3, updated_at = NOW()
      WHERE pick_list_id = $1 AND sku = $2 AND status = 'requested'`,
    [pickListId, sku, bookingId]
  );
}

export async function reopenReturnRequests(pickListId: string, sku: string) {
  if (!sku) return;
  await query(
    `UPDATE return_requests
        SET status = 'requested', booking_id = NULL, updated_at = NOW()
      WHERE pick_list_id = $1 AND sku = $2 AND status = 'booked'`,
    [pickListId, sku]
  );
}
