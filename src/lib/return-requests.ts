/**
 * A return request is the queue for the warehouse. Booking the collection comes after.
 */
import { query } from '../db/index.js';
import { outcomeChange } from './return-booking-rules.js';
import { openReturnReplacement, releaseReturnReplacement } from './return-replacement.js';
import { mirrorRequestToDesk, unmirrorRequest, type ReturnDetail } from './return-desk-mirror.js';
import { isPhotoKind } from './return-fault.js';

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
            COALESCE((
              SELECT json_agg(json_build_object('id', i.id, 'content_type', i.content_type, 'created_at', i.created_at) ORDER BY i.created_at)
                FROM return_request_images i
               WHERE i.return_request_id = r.id
            ), '[]'::json) AS images,
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

/** Mark the whole order, or the given items, as waiting for a return collection. A replacement is created for Plan picks and is not put on a pick list. */
export async function requestReturns(pickListId: string, skus: string[] | null, actor: string, outcome: string, detail?: ReturnDetail) {
  const choice = outcome === 'replace' ? 'replace' : outcome === 'refund' ? 'refund' : outcome === 'collect' ? 'collect' : '';
  if (!choice) throw new ReturnRequestError('Choose whether this return is a refund, a replacement, or a collection only.');
  const found = await query(`SELECT id, status FROM pick_lists WHERE id = $1`, [pickListId]);
  const list = found.rows[0];
  if (!list) throw new ReturnRequestError('Unknown order', 404);
  if (!RETURNABLE.includes(list.status)) {
    throw new ReturnRequestError('A return request is for an order that has been picked or shipped.');
  }
  const onList = await skusOnList(pickListId);
  const parts = await query(
    `SELECT DISTINCT comp->>'sku' AS sku
       FROM pick_list_items pli
       JOIN wms_products wp ON wp.variant_sku = pli.product_sku AND COALESCE(wp.is_kit, false)
       CROSS JOIN LATERAL jsonb_array_elements(wp.kit_components) comp
      WHERE pli.pick_list_id = $1 AND NOT COALESCE(pli.is_archived, false)
        AND comp->>'sku' <> '' AND comp->>'sku' <> pli.product_sku`,
    [pickListId]
  );
  const allowed = new Set([...onList, ...parts.rows.map((row: { sku: string }) => row.sku)]);
  const wanted = skus?.length ? [...new Set(skus.map((sku) => sku.trim()).filter(Boolean))] : onList;
  if (!wanted.length) throw new ReturnRequestError('This order has no items to return.');
  const missing = wanted.filter((sku) => !allowed.has(sku));
  if (missing.length) throw new ReturnRequestError(`${missing[0]} is not on this order.`);

  for (const sku of wanted) {
    const current = await query(
      `SELECT status, outcome FROM return_requests
        WHERE pick_list_id = $1 AND sku = $2 AND status <> 'cancelled'
        ORDER BY created_at DESC LIMIT 1`,
      [pickListId, sku]
    );
    const booked = await query(
      `SELECT outcome FROM collection_bookings
        WHERE pick_list_id = $1 AND sku = $2 AND status <> 'cancelled'
          AND COALESCE(direction, 'outbound') = 'return'
        ORDER BY created_at DESC LIMIT 1`,
      [pickListId, sku]
    );
    const existing = booked.rows[0]
      ? { status: 'booked', outcome: booked.rows[0].outcome || current.rows[0]?.outcome }
      : current.rows[0] || null;
    const change = outcomeChange(existing, choice);
    if (!change.ok) throw new ReturnRequestError(change.error);
    if (booked.rows[0]) {
      // Already booked with the courier, so there is nothing to queue. The desk's reason, note and enquiry still go onto the Returns screen.
      await mirrorRequestToDesk(pickListId, sku, detail).catch((error) => console.error('Return not copied to the Returns screen:', error instanceof Error ? error.message : error));
      continue;
    }
    await query(
      `INSERT INTO return_requests (pick_list_id, sku, created_by, outcome)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (pick_list_id, sku) WHERE status <> 'cancelled'
       DO UPDATE SET outcome = EXCLUDED.outcome, updated_at = NOW()
       WHERE return_requests.status = 'requested'`,
      [pickListId, sku, actor.slice(0, 255), choice]
    );
    // Show it on the Returns screen as well. A failure here must not stop the request.
    await mirrorRequestToDesk(pickListId, sku, detail).catch((error) => console.error('Return not copied to the Returns screen:', error instanceof Error ? error.message : error));
    if (change.createOrder) await openReturnReplacement(pickListId, sku);
    if (change.releaseOrder) await releaseReturnReplacement(pickListId, sku);
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
  const replaceSkus = replacing.rows.map((row: { sku: string }) => row.sku);
  if (replaceSkus.length) {
    const picked = await query(
      `SELECT ci.product_sku
         FROM pick_lists c
         JOIN pick_list_items ci ON ci.pick_list_id = c.id AND NOT COALESCE(ci.is_archived, false)
        WHERE c.parent_pick_list_id = $1
          AND COALESCE(c.is_return, false)
          AND c.status NOT IN ('DISPATCHED', 'CANCELLED')
          AND ci.product_sku = ANY($2::text[])
          AND (
            COALESCE(ci.quantity_picked, 0) > 0
            OR EXISTS (SELECT 1 FROM pick_scans ps WHERE ps.pick_list_item_id = ci.id)
          )
        LIMIT 1`,
      [pickListId, replaceSkus]
    );
    if (picked.rows.length) {
      throw new ReturnRequestError(`${picked.rows[0].product_sku} has already been picked on the replacement.`);
    }
  }
  await query(
    `UPDATE return_requests
        SET status = 'cancelled', updated_at = NOW()
      WHERE pick_list_id = $1 AND sku = ANY($2::text[]) AND status = 'requested'`,
    [pickListId, wanted]
  );
  for (const row of replacing.rows) await releaseReturnReplacement(pickListId, row.sku);
  for (const sku of wanted) {
    await unmirrorRequest(pickListId, sku).catch((error) => console.error('Return not taken off the Returns screen:', error instanceof Error ? error.message : error));
  }
  return listReturnRequests(pickListId);
}

export async function markReturnRequestsBooked(pickListId: string, sku: string, bookingId: string | null, outcome?: string) {
  if (!sku) return;
  const choice = outcome === 'replace' || outcome === 'refund' ? outcome : null;
  await query(
    `UPDATE return_requests
        SET status = 'booked', booking_id = $3,
            outcome = COALESCE($4, outcome),
            updated_at = NOW()
      WHERE pick_list_id = $1 AND sku = $2 AND status = 'requested'`,
    [pickListId, sku, bookingId, choice]
  );
  // A collection booked straight to the courier has no request behind it. It still belongs on the Returns screen.
  await mirrorRequestToDesk(pickListId, sku).catch((error) => console.error('Return not copied to the Returns screen:', error instanceof Error ? error.message : error));
}

const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function looksLikeImage(bytes: Buffer, contentType: string) {
  if (contentType === 'image/png') return bytes[0] === 0x89 && bytes[1] === 0x50;
  if (contentType === 'image/gif') return bytes.subarray(0, 3).toString() === 'GIF';
  if (contentType === 'image/webp') return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  return bytes[0] === 0xff && bytes[1] === 0xd8;
}

/** Attach a photo to the open return for this item. */
export async function addReturnRequestImage(pickListId: string, sku: string, bytes: Buffer, contentType: string, actor: string) {
  const type = contentType.toLowerCase().split(';')[0].trim();
  if (!PHOTO_TYPES.has(type) || !looksLikeImage(bytes, type)) {
    throw new ReturnRequestError('Use a JPEG, PNG, WebP or GIF photo.');
  }
  if (bytes.length > 8 * 1024 * 1024) throw new ReturnRequestError('That photo must be under 8 MB.');
  const found = await query(
    `SELECT id FROM return_requests
      WHERE pick_list_id = $1 AND sku = $2 AND status <> 'cancelled'
      ORDER BY created_at DESC LIMIT 1`,
    [pickListId, sku]
  );
  const request = found.rows[0];
  if (!request) throw new ReturnRequestError('Mark this item as a return before adding a photo.', 404);
  const count = await query(`SELECT COUNT(*)::int AS n FROM return_request_images WHERE return_request_id = $1`, [request.id]);
  if (Number(count.rows[0]?.n) >= 8) throw new ReturnRequestError('This return already has 8 photos.');
  await query(
    `INSERT INTO return_request_images (return_request_id, content_type, image, created_by)
     VALUES ($1, $2, $3, $4)`,
    [request.id, type, bytes, actor.slice(0, 255)]
  );
  return listReturnRequests(pickListId);
}

/**
 * A photo from the customer desk goes onto the order's open return or damage case, whichever the order has.
 * It carries the desk's picture id, so sending it twice attaches it once. An order with no return or damage case has nowhere to put it.
 */
export async function addDeskPhoto(
  pickListId: string,
  bytes: Buffer,
  contentType: string,
  sourceKey: string,
  actor: string,
  extra: { caseId?: string; kind?: string; sku?: string; caption?: string } = {}
): Promise<{ attached: boolean; rma: string }> {
  const type = contentType.toLowerCase().split(';')[0].trim();
  if (!PHOTO_TYPES.has(type) || !looksLikeImage(bytes, type)) throw new ReturnRequestError('Use a JPEG, PNG, WebP or GIF photo.');
  if (bytes.length > 8 * 1024 * 1024) throw new ReturnRequestError('That photo must be under 8 MB.');
  const key = sourceKey.trim().slice(0, 80);
  if (!key) throw new ReturnRequestError('Send the desk picture id so the photo is only attached once.');
  const found = await query(
    `SELECT id, rma_number FROM return_authorizations
      WHERE pick_list_id = $1
      ORDER BY (desk_case_id IS NOT NULL AND desk_case_id = $2) DESC, (COALESCE(desk_status, 'due_back') <> 'closed') DESC, created_at DESC LIMIT 1`,
    [pickListId, String(extra.caseId || '').trim().slice(0, 60)]
  );
  const ra = found.rows[0];
  if (!ra) throw new ReturnRequestError('This order has no return or damage case to attach a photo to.', 404);
  const count = await query(`SELECT COUNT(*)::int AS n FROM return_desk_photos WHERE return_authorization_id = $1`, [ra.id]);
  if (Number(count.rows[0]?.n) >= 12) throw new ReturnRequestError('This case already has 12 photos.');
  const saved = await query(
    `INSERT INTO return_desk_photos (return_authorization_id, content_type, image, created_by, source_key, photo_kind, sku, caption)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (return_authorization_id, source_key) WHERE source_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [ra.id, type, bytes, actor.slice(0, 255), key, isPhotoKind(extra.kind) ? extra.kind : 'item', String(extra.sku || '').trim().slice(0, 120) || null, String(extra.caption || '').trim().slice(0, 200) || null]
  );
  return { attached: !!saved.rows[0], rma: ra.rma_number };
}

export async function returnRequestImage(id: string) {
  const found = await query(`SELECT content_type, image FROM return_request_images WHERE id = $1`, [id]);
  return found.rows[0] || null;
}

export async function deleteReturnRequestImage(id: string) {
  const removed = await query(
    `DELETE FROM return_request_images WHERE id = $1 RETURNING return_request_id`,
    [id]
  );
  if (!removed.rows[0]) throw new ReturnRequestError('Photo not found', 404);
  const parent = await query(`SELECT pick_list_id FROM return_requests WHERE id = $1`, [removed.rows[0].return_request_id]);
  return listReturnRequests(parent.rows[0]?.pick_list_id);
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
