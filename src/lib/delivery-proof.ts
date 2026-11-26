/**
 * The courier's own proof of delivery, pulled onto a return or damage case: the driver's delivery photos, the signature,
 * who signed, when, and where (GPS). It shows what the box looked like at the door, which is the strongest evidence of
 * whether damage happened in transit. Each image is keyed on the courier's attachment reference, so pulling again adds nothing twice.
 *
 * DX gives this through GetTracking and GetTrackingAttachment. APC does not give images through the API we use, so an APC
 * order says so rather than failing.
 */
import { query } from '../db/index.js';
import { fetchDxAttachment, fetchDxTracking, type DxTrackingEvent } from './dx-freight.js';

export interface DeliveryProof {
  courier: string | null;
  consignment: string | null;
  delivered_at: string | null;
  signed_by: string | null;
  gps: { lat: number; lng: number } | null;
  added: number;
  already: number;
  message: string;
}

/** The delivered event: the one with a signature or photos, else the last one with a delivery time. */
export function deliveredEvent(events: DxTrackingEvent[]): DxTrackingEvent | null {
  const withProof = events.filter((event) => event.signatureRef || event.photoRefs.length || event.podName);
  const pool = withProof.length ? withProof : events.filter((event) => event.podAt);
  if (!pool.length) return null;
  return [...pool].sort((a, b) => String(b.podAt || b.at || '').localeCompare(String(a.podAt || a.at || '')))[0];
}

export function deliveryCaption(courier: string, event: Pick<DxTrackingEvent, 'podAt' | 'at' | 'podName'>, what: 'photo' | 'signature'): string {
  const when = event.podAt || event.at;
  const stamp = when ? new Date(when).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  return [`${courier} ${what === 'photo' ? 'delivery photo' : 'signature'}`, stamp, event.podName ? `signed ${event.podName}` : ''].filter(Boolean).join(', ').slice(0, 200);
}

/** The outbound courier and consignment for an order: the pick list's own shipment first, then an outbound booking. */
async function outboundShipment(pickListId: string): Promise<{ courier: string; consignment: string } | null> {
  const pick = await query(`SELECT carrier, tracking_number FROM pick_lists WHERE id = $1`, [pickListId]);
  const row = pick.rows[0];
  if (row?.carrier && row?.tracking_number) return { courier: String(row.carrier).toUpperCase(), consignment: String(row.tracking_number).trim() };
  const booked = await query(
    `SELECT courier, waybill FROM collection_bookings
      WHERE pick_list_id = $1 AND COALESCE(direction, 'outbound') = 'outbound' AND status <> 'cancelled' AND waybill IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [pickListId]
  );
  const b = booked.rows[0];
  return b ? { courier: String(b.courier).toUpperCase(), consignment: String(b.waybill).trim() } : null;
}

export async function pullDeliveryProof(returnId: string, actor = 'courier'): Promise<DeliveryProof> {
  const found = await query(`SELECT id, pick_list_id FROM return_authorizations WHERE id = $1`, [returnId]);
  const ra = found.rows[0];
  const empty = { courier: null, consignment: null, delivered_at: null, signed_by: null, gps: null, added: 0, already: 0 };
  if (!ra?.pick_list_id) return { ...empty, message: 'This case has no order to look up.' };
  const shipment = await outboundShipment(ra.pick_list_id);
  if (!shipment) return { ...empty, message: 'The order has no outbound courier tracking.' };
  if (shipment.courier !== 'DX') {
    return { ...empty, courier: shipment.courier, consignment: shipment.consignment, message: `${shipment.courier} does not send delivery photos through its API. Check its tracking page.` };
  }
  const event = deliveredEvent(await fetchDxTracking(shipment.consignment));
  if (!event) return { ...empty, courier: 'DX', consignment: shipment.consignment, message: 'DX has no proof of delivery for this consignment yet.' };

  let added = 0;
  let already = 0;
  const images: { ref: string; kind: 'delivery' | 'signature' }[] = [
    ...event.photoRefs.map((ref) => ({ ref, kind: 'delivery' as const })),
    ...(event.signatureRef ? [{ ref: event.signatureRef, kind: 'signature' as const }] : []),
  ];
  for (const image of images) {
    const key = `dx:${image.ref}`.slice(0, 80);
    const have = await query(`SELECT 1 FROM return_desk_photos WHERE return_authorization_id = $1 AND source_key = $2`, [ra.id, key]);
    if (have.rows[0]) { already += 1; continue; }
    const file = await fetchDxAttachment(image.ref);
    if (!file) continue;
    const saved = await query(
      `INSERT INTO return_desk_photos (return_authorization_id, content_type, image, created_by, source_key, photo_kind, caption)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (return_authorization_id, source_key) WHERE source_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [ra.id, file.contentType, file.bytes, actor.slice(0, 255), key, image.kind, deliveryCaption('DX', event, image.kind === 'delivery' ? 'photo' : 'signature')]
    );
    if (saved.rows[0]) added += 1; else already += 1;
  }
  const deliveredAt = event.podAt || event.at;
  await query(
    `UPDATE return_authorizations
        SET delivered_at = COALESCE($2::timestamp, delivered_at), delivered_signed_by = COALESCE($3, delivered_signed_by),
            delivery_gps = COALESCE($4, delivery_gps), updated_at = NOW()
      WHERE id = $1`,
    [ra.id, deliveredAt, event.podName, event.gps ? `${event.gps.lat},${event.gps.lng}` : null]
  );
  const total = event.photoRefs.length + (event.signatureRef ? 1 : 0);
  return {
    courier: 'DX',
    consignment: shipment.consignment,
    delivered_at: deliveredAt,
    signed_by: event.podName,
    gps: event.gps,
    added,
    already,
    message: total ? `${added} new from DX${already ? `, ${already} already on the case` : ''}.` : 'DX recorded the delivery but has no photo or signature for it.',
  };
}

/** Pull it without holding up whatever made the case. A failure is only logged. */
export function pullDeliveryProofLater(returnId: string): void {
  pullDeliveryProof(returnId).catch((error) => console.warn('[delivery proof]', error instanceof Error ? error.message : error));
}
