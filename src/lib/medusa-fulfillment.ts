import { query } from '../db/index.js';
import { parcelOnItsWay } from './carrier-progress.js';
import { medusaGet, medusaPost } from './medusa-client.js';
import { rootMedusaOrderId } from './order-values.js';

const LOCATION_ID = process.env.MEDUSA_LOCATION_ID || 'sloc_01KY7PZB8JRYF31JPJ6EYQD8DJ';

export type MedusaFulfillResult = {
  ok: boolean;
  skipped?: boolean;
  fulfillment_id?: string;
  error?: string;
};

function fulfillmentIdFrom(data: any): string | undefined {
  return data?.fulfillment?.id
    || data?.order?.fulfillments?.slice(-1)[0]?.id
    || data?.fulfillments?.slice(-1)[0]?.id;
}

function shopStatus(status: string | null | undefined): string {
  return String(status || '').toLowerCase();
}

function alreadyFulfilled(status: string | null | undefined): boolean {
  return ['fulfilled', 'partially_fulfilled', 'shipped', 'partially_shipped', 'delivered', 'partially_delivered'].includes(shopStatus(status));
}

function alreadyShipped(status: string | null | undefined): boolean {
  return ['shipped', 'partially_shipped', 'delivered', 'partially_delivered'].includes(shopStatus(status));
}

async function loadMedusaOrder(orderId: string): Promise<any> {
  const data = await medusaGet(
    `/admin/orders/${encodeURIComponent(orderId)}?fields=*items,*items.variant,*items.variant.inventory_items,*fulfillments,*fulfillments.items,fulfillment_status,*shipping_methods`
  );
  if (data?.type === 'not_allowed' || data?.message || data?.code) {
    if (!data?.order && !data?.id) {
      throw new Error(data.message || data.code || 'Failed to load Medusa order');
    }
  }
  return data.order || data;
}

function units(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) return Number(value) || 0
  if (value && typeof value === 'object') {
    const raw = value as { numeric?: unknown; value?: unknown }
    if (typeof raw.numeric === 'number') return raw.numeric
    if (raw.value != null) return Number(raw.value) || 0
  }
  return 0
}

async function resolveLineItems(pickListId: string, order: any): Promise<{ id: string; quantity: number }[]> {
  const items = await query<{
    medusa_order_line_item_id: string | null;
    quantity_required: number;
    quantity_picked: number;
    product_sku: string;
  }>(
    `SELECT medusa_order_line_item_id, quantity_required, quantity_picked, product_sku
     FROM pick_list_items
     WHERE pick_list_id = $1 AND NOT COALESCE(is_archived, false)
     ORDER BY line_number`,
    [pickListId]
  );

  const byId = new Map<string, any>();
  const bySku = new Map<string, any>();
  for (const line of order.items || []) {
    if (line?.id) byId.set(line.id, line);
    const sku = line?.variant?.sku || line?.variant_sku || line?.sku;
    if (sku) bySku.set(String(sku), line);
  }

  const payload: { id: string; quantity: number }[] = [];
  for (const row of items.rows) {
    const wanted = Math.max(1, Number(row.quantity_picked) || Number(row.quantity_required) || 1);
    const line = (row.medusa_order_line_item_id && byId.get(row.medusa_order_line_item_id))
      || bySku.get(row.product_sku);
    if (!line?.id) continue;
    const ordered = units(line.quantity)
    const remaining = (ordered || wanted) - fulfilledQuantity(order, line.id);
    const qty = Math.min(wanted, remaining);
    if (qty <= 0) continue;
    payload.push({ id: line.id, quantity: qty });
  }
  return payload;
}

function fulfilledQuantity(order: any, lineId: string): number {
  let total = 0;
  for (const fulfillment of order.fulfillments || []) {
    if (fulfillment?.canceled_at || fulfillment?.cancelled_at) continue;
    for (const item of fulfillment.items || []) {
      const id = item.line_item_id || item.id;
      if (id === lineId) total += Number(item.quantity) || 0;
    }
  }
  return total;
}

async function sharesOrder(orderId: string, pickListId: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM pick_lists
      WHERE id <> $2
        AND (medusa_order_id = $1 OR left(medusa_order_id, length($1) + 3) = $1 || '-BO' OR left(medusa_order_id, length($1) + 3) = $1 || '-PF')
      LIMIT 1`,
    [orderId, pickListId],
  );
  return result.rows.length > 0;
}

let liveShippingOptions: { id: string; name: string }[] | null = null

/** The order's shipping option when it still exists, otherwise the current option of the same name. */
async function shippingOptionFor(order: any): Promise<string | undefined> {
  const method = (order.shipping_methods || [])[0]
  const current = method?.shipping_option_id as string | undefined
  if (!current) return undefined
  const found = await medusaGet(`/admin/shipping-options/${encodeURIComponent(current)}?fields=id`)
  if (found?.shipping_option?.id) return current
  if (!liveShippingOptions) {
    const list = await medusaGet('/admin/shipping-options?limit=50&fields=id,name')
    liveShippingOptions = list.shipping_options || []
  }
  const name = String(method.name || '').trim()
  return liveShippingOptions.find((option) => option.name === name)?.id
}

async function ensureReservations(order: any, items: { id: string; quantity: number }[]): Promise<void> {
  const byId = new Map<string, any>((order.items || []).map((item: any) => [item.id, item]))
  for (const item of items) {
    const line = byId.get(item.id)
    const variant = line?.variant
    if (!variant?.manage_inventory) continue
    for (const link of variant.inventory_items || []) {
      const inventoryItemId = link?.inventory_item_id || link?.inventory?.id
      if (!inventoryItemId) continue
      const existing = await medusaGet(`/admin/reservations?inventory_item_id=${encodeURIComponent(inventoryItemId)}&line_item_id=${encodeURIComponent(item.id)}&limit=20&fields=id,line_item_id,inventory_item_id`)
      const rows = existing.reservations || []
      if (rows.some((reservation: { line_item_id?: string; inventory_item_id?: string }) => reservation.line_item_id === item.id && reservation.inventory_item_id === inventoryItemId)) continue
      const required = Number(link.required_quantity) || 1
      await medusaPost('/admin/reservations', {
        line_item_id: item.id,
        inventory_item_id: inventoryItemId,
        location_id: LOCATION_ID,
        quantity: item.quantity * required,
      })
    }
  }
}

async function createFulfillment(orderId: string, items: { id: string; quantity: number }[], shippingOptionId?: string): Promise<string> {
  const option = shippingOptionId ? { shipping_option_id: shippingOptionId } : {}
  const body = { items, location_id: LOCATION_ID, no_notification: true, ...option }
  try {
    const created = await medusaPost(`/admin/orders/${encodeURIComponent(orderId)}/fulfillments`, body)
    const id = fulfillmentIdFrom(created)
    if (id) return id
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!/location/i.test(message)) throw err
  }
  const created = await medusaPost(`/admin/orders/${encodeURIComponent(orderId)}/fulfillments`, {
    items,
    no_notification: true,
    ...option,
  })
  const id = fulfillmentIdFrom(created)
  if (!id) throw new Error(`Medusa created a fulfillment but returned no id: ${JSON.stringify(created).slice(0, 400)}`)
  return id
}

async function loadFulfillment(orderId: string, fulfillmentId: string) {
  const loaded = await medusaGet(
    `/admin/orders/${encodeURIComponent(orderId)}?fields=*fulfillments,*fulfillments.items,*fulfillments.labels`
  );
  return (loaded?.order?.fulfillments || []).find((entry: { id?: string }) => entry.id === fulfillmentId);
}

function shipmentItems(source: { items?: { line_item_id?: string; id?: string; quantity?: number }[] } | undefined) {
  return (Array.isArray(source?.items) ? source.items : [])
    .map((item) => ({
      id: item.line_item_id || item.id,
      quantity: Number(item.quantity) || 1,
    }))
    .filter((item) => item.id);
}

export async function saveMedusaShipment(orderId: string, fulfillmentId: string, trackingNumber?: string | null, trackingUrl?: string | null, notify = false) {
  let source = await loadFulfillment(orderId, fulfillmentId);
  let items = shipmentItems(source);
  if (!source || !items.length) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    source = await loadFulfillment(orderId, fulfillmentId);
    items = shipmentItems(source);
  }
  if (!source) throw new Error(`Shop fulfillment ${fulfillmentId} is not on ${orderId}`);
  const labels = Array.isArray(source.labels) ? source.labels : [];
  if (trackingNumber && labels.some((label: { tracking_number?: string }) => label.tracking_number === trackingNumber)) return;
  if (!items.length) throw new Error('Medusa fulfillment has no items to ship');
  const body: { items: { id: string; quantity: number }[]; no_notification: boolean; labels?: { tracking_number: string; tracking_url: string; label_url: string }[] } = {
    items,
    no_notification: !notify,
  };
  if (trackingNumber && trackingUrl) {
    body.labels = [{ tracking_number: trackingNumber, tracking_url: trackingUrl, label_url: trackingUrl }];
  }
  await medusaPost(
    `/admin/orders/${encodeURIComponent(orderId)}/fulfillments/${encodeURIComponent(fulfillmentId)}/shipments`,
    body
  );
}

async function saveTrackingNote(fulfillmentId: string, carrier: string | null | undefined, trackingNumber?: string | null, trackingUrl?: string | null) {
  if (!trackingNumber || !trackingUrl) return;
  const note = `${String(carrier || '').trim().toUpperCase()} ${trackingNumber}\n${trackingUrl}`.trim();
  await medusaPost(
    `/admin/fulfillments/${encodeURIComponent(fulfillmentId)}/tracking-note`,
    { tracking_note: note }
  );
}

/** Put the carrier link and the tracking note on the shop fulfillment. A shipment moves the shop order to Shipped. */
export async function saveShopTracking(orderId: string, fulfillmentId: string, carrier: string | null | undefined, trackingNumber?: string | null, trackingUrl?: string | null, notify = false) {
  await saveMedusaShipment(orderId, fulfillmentId, trackingNumber, trackingUrl, notify);
  await saveTrackingNote(fulfillmentId, carrier, trackingNumber, trackingUrl);
}

async function rememberFulfillment(pickListId: string, fulfillmentId: string) {
  await query(
    `UPDATE pick_lists
     SET medusa_fulfillment_id = $1, updated_at = NOW()
     WHERE id = $2`,
    [fulfillmentId, pickListId]
  );
}

async function markShopSynced(pickListId: string) {
  await query(`UPDATE pick_lists SET synced_to_medusa_at = NOW() WHERE id = $1`, [pickListId]);
}

async function markShopShipped(pickListId: string) {
  await query(
    `UPDATE pick_lists SET shop_shipped_at = COALESCE(shop_shipped_at, NOW()), synced_to_medusa_at = NOW() WHERE id = $1`,
    [pickListId]
  );
}

/**
 * Push one warehouse order to the shop.
 * APC and DX stay off the shop until the carrier shows the parcel is on its way.
 * Return collections are skipped.
 */
export async function fulfillPickListInMedusa(pickListId: string, options?: { ship?: boolean }): Promise<MedusaFulfillResult> {
  const pl = await query(
    `SELECT pl.id, pl.medusa_order_id, pl.medusa_fulfillment_id, pl.tracking_number, pl.tracking_url,
            pl.carrier, pl.is_sandbox, pl.status, pl.is_return, pl.shop_shipped_at,
            b.courier AS booking_courier, b.waybill, b.delivery_postcode
       FROM pick_lists pl
       LEFT JOIN LATERAL (
         SELECT courier, waybill, delivery_postcode
           FROM collection_bookings
          WHERE pick_list_id = pl.id
            AND status <> 'cancelled'
            AND COALESCE(direction, 'outbound') <> 'return'
          ORDER BY created_at DESC
          LIMIT 1
       ) b ON true
      WHERE pl.id = $1`,
    [pickListId]
  );
  const pickList = pl.rows[0];
  if (!pickList) return { ok: false, error: 'Pick list not found' };
  if (pickList.is_sandbox || pickList.is_return) return { ok: true, skipped: true };
  if (!pickList.medusa_order_id || !String(pickList.medusa_order_id).startsWith('order_')) {
    return { ok: true, skipped: true };
  }

  const hasLink = String(pickList.tracking_number || '').trim() !== '' && String(pickList.tracking_url || '').trim() !== '';
  const courier = String(pickList.booking_courier || pickList.carrier || '').trim().toUpperCase();
  const waitsForCarrier = (courier === 'APC' || courier === 'DX') && !pickList.shop_shipped_at;
  let ship = hasLink || options?.ship !== false;
  if (waitsForCarrier) {
    const waybill = String(pickList.waybill || pickList.tracking_number || '').trim();
    const postcode = String(pickList.delivery_postcode || '').trim();
    const ready = hasLink && await parcelOnItsWay(courier, waybill, postcode);
    if (!ready) return { ok: true, skipped: true };
    ship = true;
  }
  const orderId = rootMedusaOrderId(pickList.medusa_order_id);

  try {
    const order = await loadMedusaOrder(orderId);
    let fulfillmentId = pickList.medusa_fulfillment_id as string | null;
    // A part fulfilment has its own fulfillment. Do not attach this list to the other part's.
    if (!fulfillmentId && alreadyFulfilled(order.fulfillment_status) && !(await sharesOrder(orderId, pickListId))) {
      fulfillmentId = order.fulfillments?.slice(-1)[0]?.id || null;
    }

    const shipped = alreadyShipped(order.fulfillment_status);
    if (fulfillmentId && (shipped || !ship)) {
      await rememberFulfillment(pickListId, fulfillmentId);
      if (!shipped) {
        await saveTrackingNote(fulfillmentId, pickList.carrier, pickList.tracking_number, pickList.tracking_url);
        await markShopSynced(pickListId);
      } else {
        await saveShopTracking(orderId, fulfillmentId, pickList.carrier, pickList.tracking_number, pickList.tracking_url, false).catch((error) => {
          console.warn('[tracking] Medusa label was not saved', error instanceof Error ? error.message : 'failed');
        });
        await markShopShipped(pickListId);
      }
      return { ok: true, fulfillment_id: fulfillmentId };
    }

    if (!fulfillmentId) {
      const items = await resolveLineItems(pickListId, order);
      if (!items.length) {
        return { ok: false, error: `No remaining shop quantity to fulfill for ${orderId}. These lines may already be on another fulfillment.` };
      }
      await ensureReservations(order, items);
      fulfillmentId = await createFulfillment(orderId, items, await shippingOptionFor(order));
    }
    await rememberFulfillment(pickListId, fulfillmentId);

    if (!ship) {
      await saveTrackingNote(fulfillmentId, pickList.carrier, pickList.tracking_number, pickList.tracking_url);
      await markShopSynced(pickListId);
      return { ok: true, fulfillment_id: fulfillmentId };
    }

    try {
      await saveShopTracking(
        orderId,
        fulfillmentId,
        pickList.carrier,
        pickList.tracking_number,
        pickList.tracking_url,
        true,
      );
      await markShopShipped(pickListId);
    } catch (shipErr) {
      console.warn(
        `[medusa-fulfillment] fulfillment ${fulfillmentId} created; shipment skipped:`,
        shipErr instanceof Error ? shipErr.message : shipErr
      );
    }

    return { ok: true, fulfillment_id: fulfillmentId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[medusa-fulfillment] ${pickListId} / ${orderId}:`, error);
    return { ok: false, error };
  }
}

/** Mark shop orders shipped once APC or DX shows the parcel is on its way. Returns are left alone. */
export async function syncCollectionOrdersToMedusa(): Promise<void> {
  await query(`ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS shop_shipped_at TIMESTAMP`);
  const found = await query(
    `SELECT pl.id, pl.status, pl.tracking_number, pl.tracking_url
       FROM pick_lists pl
      WHERE NOT pl.is_archived
        AND NOT COALESCE(pl.is_sandbox, false)
        AND NOT COALESCE(pl.is_return, false)
        AND pl.status <> 'CANCELLED'
        AND pl.medusa_order_id LIKE 'order_%'
        AND EXISTS (
          SELECT 1 FROM collection_bookings b
           WHERE b.pick_list_id = pl.id
             AND b.status <> 'cancelled'
             AND COALESCE(b.direction, 'outbound') <> 'return'
        )
        AND (
          (
            COALESCE(btrim(pl.tracking_url), '') <> ''
            AND COALESCE(btrim(pl.tracking_number), '') <> ''
            AND pl.shop_shipped_at IS NULL
          )
          OR pl.medusa_fulfillment_id IS NULL
          OR (
            pl.status = 'DISPATCHED'
            AND (pl.synced_to_medusa_at IS NULL OR pl.updated_at > pl.synced_to_medusa_at)
          )
        )
      ORDER BY pl.updated_at DESC
      LIMIT 40`
  );
  let waiting = 0;
  for (const row of found.rows as { id: string; status: string; tracking_number: string | null; tracking_url: string | null }[]) {
    const hasLink = String(row.tracking_number || '').trim() !== '' && String(row.tracking_url || '').trim() !== '';
    const result = await fulfillPickListInMedusa(row.id, { ship: hasLink || row.status === 'DISPATCHED' });
    if (result.skipped && hasLink) waiting += 1;
  }
  if (waiting) console.log(`[medusa] ${waiting} order(s) are booked and waiting for the carrier to take the parcel`);
}

export async function fulfillPickListsInMedusa(ids: string[]): Promise<MedusaFulfillResult[]> {
  const results: MedusaFulfillResult[] = [];
  for (const id of ids) {
    results.push(await fulfillPickListInMedusa(id));
  }
  return results;
}
