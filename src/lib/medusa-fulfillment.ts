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
    `/admin/orders/${encodeURIComponent(orderId)}?fields=*items,*items.variant,*fulfillments,fulfillment_status`
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
    const qty = Math.max(1, Number(row.quantity_picked) || Number(row.quantity_required) || 1);
    const line = (row.medusa_order_line_item_id && byId.get(row.medusa_order_line_item_id))
      || bySku.get(row.product_sku);
    if (!line?.id) continue;
    payload.push({ id: line.id, quantity: Math.min(qty, Number(line.quantity) || qty) });
  }
  return payload;
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

async function createShipment(orderId: string, fulfillmentId: string, trackingNumber?: string | null) {
  const tracking = trackingNumber ? { tracking_numbers: [trackingNumber] } : {};
  try {
    await medusaPost(`/admin/orders/${encodeURIComponent(orderId)}/fulfillments/${fulfillmentId}/shipments`, {
      ...tracking,
    });
    return;
  } catch {
    await medusaPost(`/admin/fulfillments/${fulfillmentId}/shipment`, tracking);
  }
}

/** Create (or reuse) a Medusa fulfillment so a WMS "Shipped" order is fulfilled on the shop. */
export async function fulfillPickListInMedusa(pickListId: string): Promise<MedusaFulfillResult> {
  const pl = await query(
    `SELECT id, medusa_order_id, medusa_fulfillment_id, tracking_number, is_sandbox, status
     FROM pick_lists WHERE id = $1`,
    [pickListId]
  );
  const pickList = pl.rows[0];
  if (!pickList) return { ok: false, error: 'Pick list not found' };
  if (pickList.is_sandbox) return { ok: true, skipped: true };
  if (!pickList.medusa_order_id || !String(pickList.medusa_order_id).startsWith('order_')) {
    return { ok: true, skipped: true };
  }

  const orderId = rootMedusaOrderId(pickList.medusa_order_id);

  try {
    const order = await loadMedusaOrder(orderId);
    if (alreadyDone(order.fulfillment_status) && pickList.medusa_fulfillment_id) {
      await query(`UPDATE pick_lists SET synced_to_medusa_at = NOW() WHERE id = $1`, [pickListId]);
      return { ok: true, fulfillment_id: pickList.medusa_fulfillment_id };
    }

    let fulfillmentId = pickList.medusa_fulfillment_id as string | null;
    if (!fulfillmentId && alreadyDone(order.fulfillment_status)) {
      fulfillmentId = order.fulfillments?.slice(-1)[0]?.id || null;
    }

    if (!fulfillmentId) {
      const items = await resolveLineItems(pickListId, order);
      if (!items.length) {
        return { ok: false, error: `No Medusa line items on ${orderId} to fulfill` };
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
      await createShipment(orderId, fulfillmentId, pickList.tracking_number);
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
