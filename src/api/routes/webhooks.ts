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
import { query } from '../../db/index.js';
import { syncSkuToMedusa } from '../../lib/medusa-inventory.js';

const router = express.Router();

const WEBHOOK_SECRET = process.env.MEDUSA_WEBHOOK_SECRET ?? '';

function verifySignature(rawBody: Buffer, signature: string): boolean {
  if (!WEBHOOK_SECRET) return true; // skip verification if secret not configured
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
}

router.post('/medusa', express.raw({ type: '*/*' }), async (req: Request, res: Response) => {
  try {
    const sig = (req.headers['x-medusa-signature'] as string) ?? '';
    if (WEBHOOK_SECRET && !verifySignature(req.body as Buffer, sig)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const payload = JSON.parse((req.body as Buffer).toString());
    const { event, data } = payload;

    if (event === 'order.placed') {
      await handleOrderPlaced(data);
    }
    // Add more event handlers here as needed (order.cancelled, order.fulfilled, etc.)

    res.json({ received: true, event });
  } catch (err: any) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

async function handleOrderPlaced(order: any) {
  const medusaOrderId = order.id;
  const displayId = order.display_id ?? order.id;

  // Check if pick list already exists for this order
  const existing = await query(`SELECT id FROM pick_lists WHERE medusa_order_id = $1`, [medusaOrderId]);
  if (existing.rows.length > 0) return; // idempotent

  const pickListNumber = `PL-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(displayId).padStart(4, '0')}`;

  const plResult = await query(`
    INSERT INTO pick_lists (medusa_order_id, pick_list_number, status, created_at, updated_at)
    VALUES ($1, $2, 'PENDING', NOW(), NOW())
    RETURNING id
  `, [medusaOrderId, pickListNumber]);

  const pickListId = plResult.rows[0].id;
  let lineNumber = 1;

  for (const item of order.items ?? []) {
    const sku = item.variant?.sku ?? item.variant_sku ?? item.sku;
    if (!sku) continue;

    const colourCode = sku.split('-').pop()?.match(/[a-z]{2}\d/) ? sku.split('-').pop() : null;

    await query(`
      INSERT INTO pick_list_items
        (pick_list_id, line_number, product_sku, colour_code, quantity_required, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, 'PENDING', NOW(), NOW())
    `, [pickListId, lineNumber++, sku, colourCode, item.quantity]);

    // Reserve the quantity immediately across all locations holding this SKU
    await query(
      `UPDATE warehouse_inventory
       SET quantity_reserved = quantity_reserved + $1, updated_at = NOW()
       WHERE product_sku = $2`,
      [item.quantity, sku]
    );
  }

  // Push WMS available (quantity - quantity_reserved) to Medusa stocked_quantity
  // so Medusa's stock count drops immediately — no separate Medusa reservation needed
  const affectedSkus = new Set<string>((order.items ?? []).map((i: any) => i.variant?.sku ?? i.variant_sku ?? i.sku).filter((s: unknown): s is string => typeof s === 'string'));
  for (const sku of affectedSkus) {
    const row = await query(
      `SELECT SUM(quantity) as qty, SUM(quantity_reserved) as reserved FROM warehouse_inventory WHERE product_sku = $1`,
      [sku]
    );
    const available = Math.max(0, parseInt(row.rows[0]?.qty ?? '0') - parseInt(row.rows[0]?.reserved ?? '0'));
    await syncSkuToMedusa(sku, available);
  }

  console.log(`✓ Pick list ${pickListNumber} created for order ${medusaOrderId} (${order.items?.length ?? 0} lines)`);
}

/** GET /api/webhooks/test — manual trigger for testing (dev only) */
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
