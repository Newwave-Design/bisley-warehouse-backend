/**
 * Medusa webhook receiver — creates WMS pick lists when orders are placed.
 *
 * POST /api/webhooks/medusa — Medusa sends a signed JSON payload for each event.
 *
 * Setup in Medusa:
 *   Admin → Settings → Webhooks → add URL:
 *   https://bisley-warehouse-backend-production.up.railway.app/api/webhooks/medusa
 *   Event: order.placed
 *   Secret: set MEDUSA_WEBHOOK_SECRET env var on both sides
 */

import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { query, getPool } from '../../db/index.js';
import { syncSkuToMedusa } from '../../lib/medusa-inventory.js';
import { medusaGet } from '../../lib/medusa-client.js';
import { checkPaymentOnPlacement } from '../../lib/payment-status.js';
import { scheduleAllocationRun } from '../../lib/allocation.js';
import { authMiddleware, requirePermission } from '../../middleware/auth.js';
import { logError, logWarning } from '../../lib/logger.js';
import { createNotification, createNotificationOnce } from '../../lib/notifications.js';

const router = express.Router();

const WEBHOOK_SECRET = process.env.MEDUSA_WEBHOOK_SECRET ?? '';
if (!WEBHOOK_SECRET) {
  console.warn('[webhooks] MEDUSA_WEBHOOK_SECRET not set — /api/webhooks/medusa will reject all requests');
}

function verifySignature(rawBody: Buffer, signature: string): boolean {
  try {
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const sigBuf = Buffer.from(signature, 'hex');
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  } catch {
    return false; // malformed signature header (bad hex, wrong length, etc.)
  }
}

router.post('/medusa', express.raw({ type: '*/*' }), async (req: Request, res: Response) => {
  try {
    const sig = (req.headers['x-medusa-signature'] as string) ?? '';
    if (!WEBHOOK_SECRET || !verifySignature(req.body as Buffer, sig)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const payload = JSON.parse((req.body as Buffer).toString());
    const eventType = payload.type ?? payload.event; // support both 'type' (Medusa Cloud) and 'event' (legacy)
    const { data } = payload;

    switch (eventType) {
      case 'order.placed':
        await handleOrderPlaced(data);
        break;
      case 'order.cancelled':
      case 'order.canceled':
        await handleOrderCancelled(data);
        break;
      case 'order-edit.confirmed':
        await handleOrderEdited(data);
        break;
      case 'order.returned':
        await handleOrderReturned(data);
        break;
      default:
        console.log(`[webhooks] Unhandled event: ${eventType}`);
    }

    res.json({ received: true, event: eventType });
  } catch (err: any) {
    console.error('Webhook error:', err);
    // Visible in the Error Log; Medusa retries on the 500, and the order catch-up recovers anything still missing
    await logError('WEBHOOK', `Medusa webhook processing failed: ${err?.message ?? err}`, undefined, 'ERROR', err?.stack);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

/**
 * Order catch-up: Medusa orders (last N days) that have no WMS pick list — because the order.placed
 * webhook was never delivered or failed. Unless dryRun, creates them exactly as the webhook would
 * (pick list + items + stock reservation). Safe to re-run: orders that already have a pick list
 * (including split children), or whose pick list was deliberately deleted, are skipped.
 */
interface OrderSummary { display_id: number; order_id: string; created_at: string; email: string | null; items: (string | null)[] }
export interface ReconcileResult {
  at: string;
  dryRun: boolean;
  days: number;
  checked: number;
  missing: OrderSummary[];
  created: OrderSummary[];
  failed: (OrderSummary & { error: string })[];
}

const SKIP_STATUSES = new Set(['canceled', 'cancelled', 'archived', 'draft']);
const SHIPPED_FULFILMENT = new Set(['fulfilled', 'shipped', 'delivered', 'canceled']);
const ORDER_FIELDS = 'id,display_id,email,status,fulfillment_status,created_at,items.id,items.title,items.quantity,items.variant_id,items.product_id,items.variant_sku,shipping_address.*,shipping_methods.*';
const orderSummary = (o: any): OrderSummary => ({
  display_id: o.display_id, order_id: o.id, created_at: o.created_at, email: o.email ?? null,
  items: (o.items ?? []).map((i: any) => i.variant_sku ?? null),
});

async function doReconcile(days: number, dryRun: boolean): Promise<ReconcileResult> {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const PAGE = 50;

  // Small pages: the Medusa Cloud instance has a low memory ceiling
  const orders: any[] = [];
  for (let offset = 0; offset < 500; offset += PAGE) {
    const data = await medusaGet(`/admin/orders?limit=${PAGE}&offset=${offset}&order=-created_at&fields=${ORDER_FIELDS}`);
    if (!Array.isArray(data?.orders)) throw new Error(`Medusa orders request failed: ${JSON.stringify(data).slice(0, 200)}`);
    const page: any[] = data.orders;
    if (!page.length) break;
    orders.push(...page);
    if (new Date(page[page.length - 1].created_at).getTime() < since) break;
  }
  const recent = orders.filter(o =>
    new Date(o.created_at).getTime() >= since && !SKIP_STATUSES.has(o.status) && !SHIPPED_FULFILMENT.has(o.fulfillment_status));

  const ids = recent.map(o => o.id);
  // Split children are keyed `<order_id>-BO...`, so match on the part before the first '-'
  const have = await query(`SELECT DISTINCT split_part(medusa_order_id, '-', 1) AS base FROM pick_lists WHERE split_part(medusa_order_id, '-', 1) = ANY($1::text[])`, [ids]);
  const suppressed = await query(`SELECT medusa_order_id FROM suppressed_orders WHERE medusa_order_id = ANY($1::text[])`, [ids]);
  const skip = new Set<string>([...have.rows.map((r: any) => r.base), ...suppressed.rows.map((r: any) => r.medusa_order_id)]);
  const missing = recent.filter(o => !skip.has(o.id));

  const result: ReconcileResult = {
    at: new Date().toISOString(), dryRun, days, checked: recent.length,
    missing: missing.map(orderSummary), created: [], failed: [],
  };
  if (dryRun) return result;

  for (const o of missing) {
    try {
      await handleOrderPlaced(o);
      result.created.push(orderSummary(o));
    } catch (err: any) {
      result.failed.push({ ...orderSummary(o), error: err?.message ?? String(err) });
    }
  }

  if (result.created.length) {
    const list = result.created.map(o => `#${o.display_id}`).join(', ');
    await logWarning('WEBHOOK', `Recovered ${result.created.length} order(s) that never reached the WMS`, { orders: result.created });
    await createNotification('ORDER_RECOVERED',
      `${result.created.length} order${result.created.length === 1 ? ' was' : 's were'} missing from the WMS and recovered`,
      `${list} — the order webhook did not deliver. Pick lists have been created.`,
      { link: '/customer-orders', severity: 'warning', metadata: { orders: result.created.map(o => o.display_id) } });
  }
  if (result.failed.length) {
    await logError('WEBHOOK', `Could not recover ${result.failed.length} missing order(s)`, { failed: result.failed });
    await createNotificationOnce('ORDER_SYNC_FAILED',
      `${result.failed.length} Medusa order${result.failed.length === 1 ? '' : 's'} could not be added to the WMS`,
      result.failed.map(o => `#${o.display_id}: ${o.error}`).join('; ').slice(0, 500),
      { link: '/error-log', severity: 'error' });
  }
  return result;
}

// Runs are serialised so the scheduler, the dashboard and manual calls never create the same order twice
let reconcileQueue: Promise<unknown> = Promise.resolve();
export function reconcileOrders(opts: { days?: number; dryRun?: boolean } = {}): Promise<ReconcileResult> {
  const days = Math.min(Math.max(opts.days ?? 7, 1), 30);
  const run = reconcileQueue.catch(() => undefined).then(() => doReconcile(days, opts.dryRun ?? true));
  reconcileQueue = run;
  return run;
}

// Dashboard polls the dry-run check; cache it so it never hammers the Medusa admin API
const STATUS_TTL_MS = 2 * 60 * 1000;
const statusCache = new Map<number, { at: number; result: ReconcileResult }>();

/** GET /api/webhooks/sync-status?days=7 — Medusa orders vs WMS pick lists (read-only) */
router.get('/sync-status', authMiddleware, async (req: Request, res: Response) => {
  try {
    const days = Math.min(Math.max(parseInt(String(req.query.days)) || 7, 1), 30);
    const hit = statusCache.get(days);
    if (hit && Date.now() - hit.at < STATUS_TTL_MS) return res.json(hit.result);
    const result = await reconcileOrders({ days, dryRun: true });
    statusCache.set(days, { at: Date.now(), result });
    return res.json(result);
  } catch (err: any) {
    return res.status(502).json({ error: 'Could not check Medusa orders', details: err?.message ?? String(err) });
  }
});

/** POST /api/webhooks/reconcile-orders?days=7&dryRun=true — admin: preview or run the catch-up */
router.post('/reconcile-orders', authMiddleware, requirePermission('system_admin'), async (req: Request, res: Response) => {
  try {
    const result = await reconcileOrders({ days: parseInt(String(req.query.days)) || 7, dryRun: String(req.query.dryRun) !== 'false' });
    statusCache.clear();
    return res.json(result);
  } catch (err: any) {
    console.error('Reconcile error:', err);
    return res.status(500).json({ error: 'Reconcile failed', details: err?.message ?? String(err) });
  }
});

export async function handleOrderPlaced(order: any) {
  const medusaOrderId = order.id;
  const displayId = order.display_id ?? order.id;
  const primaryShippingMethod = order.shipping_methods?.[0] ?? null;
  const shippingAddress = order.shipping_address ?? order.address ?? null;
  const customerName = [shippingAddress?.first_name, shippingAddress?.last_name].filter(Boolean).join(' ') || order.customer?.email || null;
  const shippingSnapshot = shippingAddress ? {
    first_name: shippingAddress.first_name ?? null,
    last_name: shippingAddress.last_name ?? null,
    company: shippingAddress.company ?? null,
    address_1: shippingAddress.address_1 ?? null,
    address_2: shippingAddress.address_2 ?? null,
    city: shippingAddress.city ?? null,
    province: shippingAddress.province ?? null,
    postal_code: shippingAddress.postal_code ?? null,
    country_code: shippingAddress.country_code ?? null,
    phone: shippingAddress.phone ?? null,
  } : {};

  const placedAt = order.created_at ? new Date(order.created_at) : new Date();
  const pickListNumber = `PL-${placedAt.toISOString().slice(0, 10).replace(/-/g, '')}-${String(displayId).padStart(4, '0')}`;

  // Everything below runs in one transaction: a failed item insert must not
  // leave behind an empty pick_lists row that then silently blocks retries
  // via the idempotency check.
  const client = await getPool().connect();
  let pickListId: string;
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT 1 FROM pick_lists WHERE medusa_order_id = $1::text OR medusa_order_id LIKE $1::text || '-%'
       UNION ALL SELECT 1 FROM suppressed_orders WHERE medusa_order_id = $1::text`,
      [medusaOrderId]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return; // idempotent: already have it (or a split child of it), or it was deliberately deleted
    }

    const plResult = await client.query(`
      INSERT INTO pick_lists (
        medusa_order_id, pick_list_number, status,
        customer_name, customer_email,
        shipping_method_name, shipping_method_code, shipping_address,
        created_at, updated_at
      )
      VALUES ($1, $2, 'PENDING', $3, $4, $5, $6, $7::jsonb, COALESCE($8::timestamptz AT TIME ZONE 'UTC', NOW()), NOW())
      RETURNING id
    `, [
      medusaOrderId,
      pickListNumber,
      customerName,
      order.email ?? order.customer?.email ?? null,
      primaryShippingMethod?.name ?? primaryShippingMethod?.shipping_option?.name ?? null,
      primaryShippingMethod?.id ?? primaryShippingMethod?.shipping_option_id ?? null,
      JSON.stringify(shippingSnapshot),
      order.created_at ?? null,
    ]);

    pickListId = plResult.rows[0].id;
    let lineNumber = 1;

    for (const item of order.items ?? []) {
      const realSku = item.variant?.sku ?? item.variant_sku ?? item.sku;
      // A line with no SKU is a custom item: it still goes on the pick list, but is never re-ordered
      const isCustom = !realSku;
      const sku = realSku || 'CUSTOM';
      const itemTitle = isCustom ? String(item.title ?? item.product_title ?? 'Custom item').slice(0, 500) : null;

      // quantity is a Medusa BigNumber-derived value — coerce defensively in
      // case an upstream query is missing the paired raw_quantity field.
      const quantity = Number(item.quantity) || 1;
      if (!item.quantity) {
        console.warn(`[webhooks] order.placed ${medusaOrderId}: item ${item.id} (${sku}) missing quantity, defaulting to 1`);
      }

      const colourCode = !isCustom && sku.split('-').pop()?.match(/[a-z]{2}\d/) ? sku.split('-').pop() : null;

      // Extract Medusa IDs for fulfillment sync
      const medusaLineItemId = item.id;
      const medusaVariantId = item.variant?.id ?? item.variant_id;
      const medusaProductId = item.product?.id ?? item.product_id;

      await client.query(`
        INSERT INTO pick_list_items
          (pick_list_id, line_number, product_sku, colour_code, quantity_required, status, 
           medusa_order_line_item_id, medusa_variant_id, medusa_product_id, is_custom, item_title,
           created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8, $9, $10, NOW(), NOW())
      `, [pickListId, lineNumber++, sku, colourCode, quantity, medusaLineItemId, medusaVariantId, medusaProductId, isCustom, itemTitle]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Reserve the quantity immediately across all locations holding this SKU
  // Note: Do NOT sync to Medusa here — Medusa stock is already down from the order.placed event
  // (stock was deducted when the customer placed the order). We just reserve here in WMS.
  for (const item of order.items ?? []) {
    const sku = item.variant?.sku ?? item.variant_sku ?? item.sku;
    if (!sku) continue;
    const quantity = Number(item.quantity) || 1;

    await query(
      `UPDATE warehouse_inventory
       SET quantity_reserved = quantity_reserved + $1, updated_at = NOW()
       WHERE product_sku = $2`,
      [quantity, sku]
    );
  }

  console.log(`✓ Pick list ${pickListNumber} created for order ${medusaOrderId} (${order.items?.length ?? 0} lines)`);
  void checkPaymentOnPlacement(medusaOrderId);
  scheduleAllocationRun(`order ${pickListNumber} placed`);
}

/**
 * handleOrderCancelled — Release reserved stock and cancel pick list
 *
 * When customer cancels an order in Medusa:
 *   1. Find the WMS pick list for this order
 *   2. Release all reserved quantities back to available stock
 *   3. Mark pick list as CANCELLED (stop warehouse staff from picking)
 *   4. Update available qty in Medusa (so stock goes back to "in stock")
 */
async function handleOrderCancelled(order: any) {
  const medusaOrderId = order.id;
  console.log(`[webhooks] Processing order.cancelled for ${medusaOrderId}`);

  // Find the pick list and any split children (keyed `<order_id>-BO...`)
  const plResult = await query(
    `SELECT id, status FROM pick_lists WHERE medusa_order_id = $1 OR left(medusa_order_id, length($1) + 3) = $1 || '-BO'`,
    [medusaOrderId]
  );
  if (plResult.rows.length === 0) {
    console.log(`[webhooks] No pick list found for order ${medusaOrderId}, skipping cancellation`);
    return;
  }

  const affectedSkus = new Set<string>();
  for (const pl of plResult.rows) {
    const pickListId = pl.id;
    const pickListStatus = pl.status;

    // Don't cancel if already in final state
    if (['DISPATCHED', 'CANCELLED'].includes(pickListStatus)) {
      console.log(`[webhooks] Pick list ${pickListId} already in final state (${pickListStatus}), skipping`);
      continue;
    }

    // Get all items and their quantities
    const itemsResult = await query(
      `SELECT product_sku, quantity_required FROM pick_list_items WHERE pick_list_id = $1`,
      [pickListId]
    );

    // Release reserved stock for each item
    for (const item of itemsResult.rows) {
      await query(
        `UPDATE warehouse_inventory
         SET quantity_reserved = GREATEST(0, quantity_reserved - $1), updated_at = NOW()
         WHERE product_sku = $2`,
        [item.quantity_required, item.product_sku]
      );
      affectedSkus.add(item.product_sku);
    }

    // Cancel the pick list
    await query(
      `UPDATE pick_lists SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1`,
      [pickListId]
    );
    console.log(`✓ Order ${medusaOrderId} cancelled — pick list ${pickListId} marked CANCELLED, stock released`);
  }

  // Sync updated available quantities back to Medusa (only SKUs the WMS holds; otherwise Medusa's own stock would be zeroed)
  for (const sku of affectedSkus) {
    const row = await query(
      `SELECT COUNT(*)::int AS rows, SUM(quantity) as qty, SUM(quantity_reserved) as reserved FROM warehouse_inventory WHERE product_sku = $1`,
      [sku]
    );
    if (!row.rows[0]?.rows) continue;
    const available = Math.max(0, parseInt(row.rows[0]?.qty ?? '0') - parseInt(row.rows[0]?.reserved ?? '0'));
    await syncSkuToMedusa(sku, available);
  }
  scheduleAllocationRun(`order ${medusaOrderId} cancelled`);
}

/**
 * handleOrderEdited — bring an existing pick list in line with an order edited in Medusa
 *
 * Matches lines on medusa_order_line_item_id: changed quantities are updated, removed lines are archived (so
 * supplier-send history survives), new lines are added. Reservations move by the same amount. Anything that
 * can't be applied safely (already picked beyond the new quantity, split or dispatched orders) is left alone
 * and raised as a notification for a person to check. Re-delivery changes nothing.
 */
export async function handleOrderEdited(order: any) {
  const medusaOrderId = order.id;
  const lists = (await query(
    `SELECT id, status, medusa_order_id, is_sandbox FROM pick_lists
     WHERE medusa_order_id = $1 OR left(medusa_order_id, length($1) + 3) = $1 || '-BO'`,
    [medusaOrderId]
  )).rows;
  const label = `#${order.display_id ?? medusaOrderId}`;
  const review = (reason: string) => createNotification('ORDER_EDIT_REVIEW',
    `Order ${label} was edited in Medusa and needs checking`, reason,
    { link: '/customer-orders', severity: 'warning', metadata: { order_id: medusaOrderId } });

  if (lists.length === 0) { console.log(`[webhooks] order edit for ${medusaOrderId}: no pick list, skipping`); return; }
  const parent = lists.find((l: any) => l.medusa_order_id === medusaOrderId);
  if (lists.length > 1 || !parent) { await review('The order is split across several pick lists, so the change was not applied automatically.'); return; }
  if (['DISPATCHED', 'CANCELLED'].includes(parent.status)) { await review(`The pick list is already ${parent.status}, so the change was not applied.`); return; }

  const medusaItems = (order.items ?? [])
    .map((i: any) => ({
      id: i.id as string,
      sku: (i.variant?.sku ?? i.variant_sku ?? i.sku) as string | undefined,
      title: String(i.title ?? i.product_title ?? 'Custom item').slice(0, 500),
      qty: Number(i.quantity) || 0,
      variantId: i.variant?.id ?? i.variant_id ?? null,
      productId: i.product?.id ?? i.product_id ?? null,
    }))
    .filter((i: any) => i.id);

  const notes: string[] = [];
  let changed = 0;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const wms = (await client.query(`SELECT * FROM pick_list_items WHERE pick_list_id = $1 ORDER BY line_number FOR UPDATE`, [parent.id])).rows;
    const reserve = (sku: string, delta: number) => client.query(
      `UPDATE warehouse_inventory SET quantity_reserved = GREATEST(0, quantity_reserved + $1), updated_at = NOW() WHERE product_sku = $2`,
      [delta, sku]
    );

    for (const w of wms) {
      if (!w.medusa_order_line_item_id || w.is_archived) continue;
      const m = medusaItems.find((i: any) => i.id === w.medusa_order_line_item_id);
      if (!m) {
        if ((w.quantity_picked ?? 0) > 0) { notes.push(`${w.product_sku} was removed but ${w.quantity_picked} are already picked`); continue; }
        await client.query(`UPDATE pick_list_items SET is_archived = true, archived_at = NOW(), updated_at = NOW() WHERE id = $1`, [w.id]);
        if (!w.is_custom) await reserve(w.product_sku, -w.quantity_required);
        changed++;
      } else if (m.qty !== w.quantity_required) {
        if (m.qty < (w.quantity_picked ?? 0)) { notes.push(`${w.product_sku} was reduced to ${m.qty} but ${w.quantity_picked} are already picked`); continue; }
        await client.query(`UPDATE pick_list_items SET quantity_required = $1, updated_at = NOW() WHERE id = $2`, [m.qty, w.id]);
        if (!w.is_custom) await reserve(w.product_sku, m.qty - w.quantity_required);
        changed++;
      }
    }

    const known = new Set(wms.map((w: any) => w.medusa_order_line_item_id).filter(Boolean));
    let lineNumber = wms.reduce((max: number, w: any) => Math.max(max, w.line_number), 0);
    for (const m of medusaItems) {
      if (known.has(m.id) || m.qty <= 0) continue;
      const tail = m.sku?.split('-').pop();
      await client.query(
        `INSERT INTO pick_list_items
           (pick_list_id, line_number, product_sku, colour_code, quantity_required, status, is_sandbox,
            medusa_order_line_item_id, medusa_variant_id, medusa_product_id, is_custom, item_title, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8, $9, $10, $11, NOW(), NOW())`,
        [parent.id, ++lineNumber, m.sku ?? 'CUSTOM', tail?.match(/[a-z]{2}\d/) ? tail : null, m.qty, parent.is_sandbox, m.id, m.variantId, m.productId, !m.sku, m.sku ? null : m.title]
      );
      if (m.sku) await reserve(m.sku, m.qty);
      changed++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  if (changed && ['PICKED', 'PACKING', 'PACKED', 'LABEL_PRINTED'].includes(parent.status)) {
    notes.push(`The pick list was already ${parent.status} when the lines changed`);
  }
  if (notes.length) await review(notes.join('; '));
  scheduleAllocationRun(`order ${label} edited`);
  console.log(`✓ Order ${label} edit applied to pick list ${parent.id} (${changed} line change${changed === 1 ? '' : 's'})`);
}

/**
 * handleOrderReturned — Create RMA and optionally redeem returned items
 *
 * When a return is initiated for an order:
 *   1. Create return_authorization record with RMA number
 *   2. Create return_items records
 *   3. If return.metadata.redeem_to_warehouse == true: add qty back to warehouse_inventory
 *   4. Sync updated available qty to Medusa (only if redeemed)
 * 
 * If not redeemed, items are discarded (e.g., damaged, hygiene, etc.) and NOT added back.
 */
async function handleOrderReturned(order: any) {
  const medusaOrderId = order.id;
  console.log(`[webhooks] Processing order.returned for ${medusaOrderId}`);

  // Medusa return data format:
  // order.returns is an array of return objects, each with metadata.redeem_to_warehouse
  const returns = order.returns ?? [];
  const restockedSkus = new Set<string>();

  for (const ret of returns) {
    // Generate RMA number: RMA-YYYYMMDD-XXXX
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const countResult = await query(
      `SELECT COUNT(*) as count FROM return_authorizations 
       WHERE rma_number LIKE $1`,
      [`RMA-${today}-%`]
    );
    const count = parseInt(countResult.rows[0].count) + 1;
    const rma_number = `RMA-${today}-${String(count).padStart(4, '0')}`;

    // Check if already processed
    const existingResult = await query(
      `SELECT id FROM return_authorizations WHERE medusa_return_id = $1`,
      [ret.id]
    );
    if (existingResult.rows.length > 0) {
      console.log(`[webhooks] Return ${ret.id} already processed, skipping`);
      continue;
    }

    // Only process if explicitly marked for warehouse redemption
    const shouldRedeem = ret.metadata?.redeem_to_warehouse === true;

    // Create return authorization
    const raResult = await query(
      `INSERT INTO return_authorizations
       (rma_number, medusa_order_id, medusa_return_id, status, redeem_to_warehouse)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [rma_number, medusaOrderId, ret.id, shouldRedeem ? 'AUTHORIZED' : 'AUTHORIZED', shouldRedeem]
    );

    const raId = raResult.rows[0].id;
    const returnItems = ret.items ?? [];
    const affectedSkus = new Set<string>();

    for (const returnItem of returnItems) {
      // returnItem has: id (line item id), quantity
      const itemResult = await query(
        `SELECT product_sku FROM pick_list_items WHERE medusa_order_line_item_id = $1`,
        [returnItem.id]
      );

      if (itemResult.rows.length === 0) continue;

      const sku = itemResult.rows[0].product_sku;
      const qty = returnItem.quantity || 1;

      // Create return item record
      await query(
        `INSERT INTO return_items
         (return_authorization_id, medusa_order_line_item_id, product_sku, quantity_requested)
         VALUES ($1, $2, $3, $4)`,
        [raId, returnItem.id, sku, qty]
      );

      // If redeemable, add stock back to inventory
      if (shouldRedeem) {
        await query(
          `UPDATE warehouse_inventory
           SET quantity = quantity + $1, updated_at = NOW()
           WHERE id = (SELECT id FROM warehouse_inventory WHERE product_sku = $2 ORDER BY quantity DESC LIMIT 1)`,
          [qty, sku]
        );

        affectedSkus.add(sku);
        restockedSkus.add(sku);
        console.log(`✓ Redeemed ${qty}x ${sku} from return ${ret.id} (RMA: ${rma_number})`);
      }
    }

    // Sync updated available quantities to Medusa (only if redeemable)
    if (shouldRedeem) {
      for (const sku of affectedSkus) {
        const row = await query(
          `SELECT COUNT(*)::int AS rows, SUM(quantity) as qty, SUM(quantity_reserved) as reserved FROM warehouse_inventory WHERE product_sku = $1`,
          [sku]
        );
        if (!row.rows[0]?.rows) continue;
        const available = Math.max(0, parseInt(row.rows[0]?.qty ?? '0') - parseInt(row.rows[0]?.reserved ?? '0'));
        await syncSkuToMedusa(sku, available);
      }
    }

    console.log(`✓ Return processed: ${rma_number} (order: ${medusaOrderId}, redeemable: ${shouldRedeem})`);
  }


  console.log(`✓ Return processed for order ${medusaOrderId} — ${restockedSkus.size} SKUs restocked`);
}

router.get('/test-order', async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).end();
  try {
    await handleOrderPlaced({
      id: `test-${Date.now()}`,
      display_id: 9999,
      items: [
        { variant: { sku: 'H2910NL-av1' }, quantity: 2 },
        { variant: { sku: 'H298BNL-aa3' }, quantity: 1 },
        { variant: { sku: '362-bc6' }, quantity: 3 },
      ],
    });
    res.json({ created: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/webhooks/medusa/fulfillment-created
 * 
 * Receives fulfillment_created events from Medusa.
 * Associates the fulfillment ID with the pick list so dispatch can use it.
 *
 * Payload: { event: "fulfillment.created", order_id, fulfillment_id, timestamp }
 * Signature: x-medusa-signature header (HMAC SHA-256)
 */
router.post('/medusa/fulfillment-created', express.raw({ type: '*/*' }), async (req: Request, res: Response) => {
  try {
    const sig = (req.headers['x-medusa-signature'] as string) ?? '';
    if (!WEBHOOK_SECRET || !verifySignature(req.body as Buffer, sig)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const payload = JSON.parse((req.body as Buffer).toString());
    const { order_id, fulfillment_id } = payload;

    if (!order_id || !fulfillment_id) {
      return res.status(400).json({ error: 'Missing order_id or fulfillment_id' });
    }

    await handleFulfillmentCreated(order_id, fulfillment_id);
    res.json({ received: true, event: 'fulfillment.created' });
  } catch (err: any) {
    console.error('[webhooks] fulfillment-created error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

async function handleFulfillmentCreated(orderId: string, fulfillmentId: string) {
  console.log(`[webhooks] Processing fulfillment.created for order ${orderId} fulfillment ${fulfillmentId}`);

  // Update the pick list to associate it with the fulfillment
  const result = await query(
    `UPDATE pick_lists 
     SET medusa_fulfillment_id = $1, updated_at = NOW()
     WHERE medusa_order_id = $2
     RETURNING id, pick_list_number`,
    [fulfillmentId, orderId]
  );

  if (result.rows.length === 0) {
    console.warn(`[webhooks] No pick list found for order ${orderId}, fulfillment ID not stored`);
    return;
  }

  const pickList = result.rows[0];
  console.log(`✓ Pick list ${pickList.pick_list_number} (${pickList.id}) associated with fulfillment ${fulfillmentId}`);
}

export default router;
