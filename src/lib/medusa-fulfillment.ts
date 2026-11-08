import { query } from '../db/index.js';
import { medusaGet, medusaPost } from './medusa-client.js';
import { rootMedusaOrderId } from './order-values.js';

const LOCATION_ID = process.env.MEDUSA_LOCATION_ID || 'sloc_01KY792H831KT3TKH4CYPF7FT9';

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

function alreadyDone(status: string | null | undefined): boolean {
  return ['fulfilled', 'shipped', 'delivered'].includes(String(status || '').toLowerCase());
}

async function loadMedusaOrder(orderId: string): Promise<any> {
  const data = await medusaGet(
    `/admin/orders/${encodeURIComponent(orderId)}?fields=*items,*items.variant,*fulfillments,*fulfillments.items,fulfillment_status`
  );
  if (data?.type === 'not_allowed' || data?.message || data?.code) {
    if (!data?.order && !data?.id) {
      throw new Error(data.message || data.code || 'Failed to load Medusa order');
    }
  }
  return data.order || data;
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
     WHERE pick_list_id = $1
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
    const remaining = (Number(line.quantity) || wanted) - fulfilledQuantity(order, line.id);
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

async function createFulfillment(orderId: string, items: { id: string; quantity: number }[]): Promise<string> {
  const body = { items, location_id: LOCATION_ID, no_notification: false };
  try {
    const created = await medusaPost(`/admin/orders/${encodeURIComponent(orderId)}/fulfillments`, body);
    const id = fulfillmentIdFrom(created);
    if (id) return id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/location/i.test(message)) throw err;
  }
  const created = await medusaPost(`/admin/orders/${encodeURIComponent(orderId)}/fulfillments`, {
    items,
    no_notification: false,
  });
  const id = fulfillmentIdFrom(created);
  if (!id) throw new Error(`Medusa created a fulfillment but returned no id: ${JSON.stringify(created).slice(0, 400)}`);
  return id;
}

export async function saveMedusaShipment(orderId: string, fulfillmentId: string, trackingNumber?: string | null, trackingUrl?: string | null) {
  const loaded = await medusaGet(
    `/admin/orders/${encodeURIComponent(orderId)}?fields=*fulfillments,*fulfillments.items,*fulfillments.labels`
  );
  const source = (loaded?.order?.fulfillments || []).find((entry: { id?: string }) => entry.id === fulfillmentId);
  if (!source) return;
  const labels = Array.isArray(source.labels) ? source.labels : [];
  if (trackingNumber && labels.some((label: { tracking_number?: string }) => label.tracking_number === trackingNumber)) return;
  const items = (Array.isArray(source.items) ? source.items : [])
    .map((item: { line_item_id?: string; id?: string; quantity?: number }) => ({
      id: item.line_item_id || item.id,
      quantity: Number(item.quantity) || 1,
    }))
    .filter((item: { id?: string }) => item.id);
  if (!items.length) throw new Error('Medusa fulfillment has no items to ship');
  const body: { items: { id: string; quantity: number }[]; no_notification: boolean; labels?: { tracking_number: string; tracking_url: string; label_url: string }[] } = {
    items,
    no_notification: true,
  };
  if (trackingNumber && trackingUrl) {
    body.labels = [{ tracking_number: trackingNumber, tracking_url: trackingUrl, label_url: trackingUrl }];
  }
  await medusaPost(
    `/admin/orders/${encodeURIComponent(orderId)}/fulfillments/${encodeURIComponent(fulfillmentId)}/shipments`,
    body
  );
}

async function createShipment(orderId: string, fulfillmentId: string, trackingNumber?: string | null, trackingUrl?: string | null) {
  await saveMedusaShipment(orderId, fulfillmentId, trackingNumber, trackingUrl);
}

/** Create (or reuse) a Medusa fulfillment so a WMS "Shipped" order is fulfilled on the shop. */
export async function fulfillPickListInMedusa(pickListId: string): Promise<MedusaFulfillResult> {
  const pl = await query(
    `SELECT id, medusa_order_id, medusa_fulfillment_id, tracking_number, tracking_url, is_sandbox, status, is_return
     FROM pick_lists WHERE id = $1`,
    [pickListId]
  );
  const pickList = pl.rows[0];
  if (!pickList) return { ok: false, error: 'Pick list not found' };
  if (pickList.is_sandbox || pickList.is_return) return { ok: true, skipped: true };
  if (!pickList.medusa_order_id || !String(pickList.medusa_order_id).startsWith('order_')) {
    return { ok: true, skipped: true };
  }

  const orderId = rootMedusaOrderId(pickList.medusa_order_id);

  try {
    const order = await loadMedusaOrder(orderId);
    if (alreadyDone(order.fulfillment_status) && pickList.medusa_fulfillment_id) {
      await query(`UPDATE pick_lists SET synced_to_medusa_at = NOW() WHERE id = $1`, [pickListId]);
      if (pickList.tracking_number && pickList.tracking_url) {
        await saveMedusaShipment(orderId, pickList.medusa_fulfillment_id, pickList.tracking_number, pickList.tracking_url).catch((error) => {
          console.warn('[tracking] Medusa label was not saved', error instanceof Error ? error.message : 'failed');
        });
      }
      return { ok: true, fulfillment_id: pickList.medusa_fulfillment_id };
    }

    let fulfillmentId = pickList.medusa_fulfillment_id as string | null;
    // A part fulfilment has its own fulfillment. Do not attach this list to the other part's.
    if (!fulfillmentId && alreadyDone(order.fulfillment_status) && !(await sharesOrder(orderId, pickListId))) {
      fulfillmentId = order.fulfillments?.slice(-1)[0]?.id || null;
    }

    if (!fulfillmentId) {
      const items = await resolveLineItems(pickListId, order);
      if (!items.length) {
        return { ok: false, error: `No remaining shop quantity to fulfill for ${orderId}. These lines may already be on another fulfillment.` };
      }
      fulfillmentId = await createFulfillment(orderId, items);
    }

    await query(
      `UPDATE pick_lists
       SET medusa_fulfillment_id = $1, synced_to_medusa_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [fulfillmentId, pickListId]
    );

    try {
      await createShipment(orderId, fulfillmentId, pickList.tracking_number, pickList.tracking_url);
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

export async function fulfillPickListsInMedusa(ids: string[]): Promise<MedusaFulfillResult[]> {
  const results: MedusaFulfillResult[] = [];
  for (const id of ids) {
    results.push(await fulfillPickListInMedusa(id));
  }
  return results;
}
