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
        await handleOrderCancelled(data);
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
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

async function handleOrderPlaced(order: any) {
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

  const pickListNumber = `PL-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(displayId).padStart(4, '0')}`;

  // Everything below runs in one transaction: a failed item insert must not
  // leave behind an empty pick_lists row that then silently blocks retries
  // via the idempotency check.
  const client = await getPool().connect();
  let pickListId: string;
  try {
    await client.query('BEGIN');

    const existing = await client.query(`SELECT id FROM pick_lists WHERE medusa_order_id = $1`, [medusaOrderId]);
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return; // idempotent
    }

    const plResult = await client.query(`
      INSERT INTO pick_lists (
        medusa_order_id, pick_list_number, status,
        customer_name, customer_email,
        shipping_method_name, shipping_method_code, shipping_address,
        created_at, updated_at
      )
      VALUES ($1, $2, 'PENDING', $3, $4, $5, $6, $7::jsonb, NOW(), NOW())
      RETURNING id
    `, [
      medusaOrderId,
      pickListNumber,
      customerName,
      order.email ?? order.customer?.email ?? null,
      primaryShippingMethod?.name ?? primaryShippingMethod?.shipping_option?.name ?? null,
      primaryShippingMethod?.id ?? primaryShippingMethod?.shipping_option_id ?? null,
      JSON.stringify(shippingSnapshot),
    ]);

    pickListId = plResult.rows[0].id;
    let lineNumber = 1;

    for (const item of order.items ?? []) {
      const sku = item.variant?.sku ?? item.variant_sku ?? item.sku;
      if (!sku) {
        console.warn(`[webhooks] order.placed ${medusaOrderId}: item ${item.id} has no sku, skipping line`);
        continue;
      }

      // quantity is a Medusa BigNumber-derived value — coerce defensively in
      // case an upstream query is missing the paired raw_quantity field.
      const quantity = Number(item.quantity) || 1;
      if (!item.quantity) {
        console.warn(`[webhooks] order.placed ${medusaOrderId}: item ${item.id} (${sku}) missing quantity, defaulting to 1`);
      }

      const colourCode = sku.split('-').pop()?.match(/[a-z]{2}\d/) ? sku.split('-').pop() : null;

      // Extract Medusa IDs for fulfillment sync
      const medusaLineItemId = item.id;
      const medusaVariantId = item.variant?.id ?? item.variant_id;
      const medusaProductId = item.product?.id ?? item.product_id;

      await client.query(`
        INSERT INTO pick_list_items
          (pick_list_id, line_number, product_sku, colour_code, quantity_required, status, 
           medusa_order_line_item_id, medusa_variant_id, medusa_product_id,
           created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8, NOW(), NOW())
      `, [pickListId, lineNumber++, sku, colourCode, quantity, medusaLineItemId, medusaVariantId, medusaProductId]);
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

  // Find the pick list
  const plResult = await query(`SELECT id, status FROM pick_lists WHERE medusa_order_id = $1`, [medusaOrderId]);
  if (plResult.rows.length === 0) {
    console.log(`[webhooks] No pick list found for order ${medusaOrderId}, skipping cancellation`);
    return;
  }

  const pickListId = plResult.rows[0].id;
  const pickListStatus = plResult.rows[0].status;

  // Don't cancel if already in final state
  if (['DISPATCHED', 'CANCELLED'].includes(pickListStatus)) {
    console.log(`[webhooks] Pick list ${pickListId} already in final state (${pickListStatus}), skipping`);
    return;
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
  }

  // Cancel the pick list
  await query(
    `UPDATE pick_lists SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1`,
    [pickListId]
  );

  // Sync updated available quantities back to Medusa
  const affectedSkus = new Set<string>(itemsResult.rows.map((r: any) => r.product_sku));
  for (const sku of affectedSkus) {
    const row = await query(
      `SELECT SUM(quantity) as qty, SUM(quantity_reserved) as reserved FROM warehouse_inventory WHERE product_sku = $1`,
      [sku]
    );
    const available = Math.max(0, parseInt(row.rows[0]?.qty ?? '0') - parseInt(row.rows[0]?.reserved ?? '0'));
    await syncSkuToMedusa(sku, available);
  }

  console.log(`✓ Order ${medusaOrderId} cancelled — pick list ${pickListId} marked CANCELLED, stock released`);
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
           WHERE product_sku = $2`,
          [qty, sku]
        );

        affectedSkus.add(sku);
        console.log(`✓ Redeemed ${qty}x ${sku} from return ${ret.id} (RMA: ${rma_number})`);
      }
    }

    // Sync updated available quantities to Medusa (only if redeemable)
    if (shouldRedeem) {
      for (const sku of affectedSkus) {
        const row = await query(
          `SELECT SUM(quantity) as qty, SUM(quantity_reserved) as reserved FROM warehouse_inventory WHERE product_sku = $1`,
          [sku]
        );
        const available = Math.max(0, parseInt(row.rows[0]?.qty ?? '0') - parseInt(row.rows[0]?.reserved ?? '0'));
        await syncSkuToMedusa(sku, available);
      }
    }

    console.log(`✓ Return processed: ${rma_number} (order: ${medusaOrderId}, redeemable: ${shouldRedeem})`);
  }


  console.log(`✓ Return processed for order ${medusaOrderId} — ${affectedSkus.size} SKUs restocked`);
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

export default router;
