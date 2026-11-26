/**
 * Return Authorization API — Phase 4: Returns & Warehouse Redemption
 *
 * RMA (Return Merchandise Authorization) workflow:
 * 1. Customer initiates return in Medusa
 * 2. Medusa sends order.returned webhook with metadata.redeem_to_warehouse flag
 * 3. WMS creates return_authorization record
 * 4. Warehouse receives returned items (mark in return_items)
 * 5. Manager approves return (syncs stock back to Medusa if redeemable)
 *
 * Endpoints:
 * POST   /api/returns/authorize          — Create RMA (from webhook or manual)
 * GET    /api/returns                    — List all returns
 * GET    /api/returns/:rma_id            — Get return details
 * POST   /api/returns/:rma_id/receive    — Mark items as received in warehouse
 * POST   /api/returns/:rma_id/approve    — Approve return + sync to Medusa
 * POST   /api/returns/:rma_id/reject     — Reject return (no refund)
 */

import express, { Response } from 'express';
import { query, getPool } from '../../db/index.js';
import { authMiddleware, requirePermission, AuthRequest } from '../../middleware/auth.js';
import { getLogger } from '../../lib/logger.js';
import { withRmaNumber } from '../../lib/return-desk-mirror.js';
import { toUuidOrNull } from './mobile.js';
import { stockArrived } from './stock-in.js';

const router = express.Router();
const logger = getLogger('returns');

/**
 * POST /api/returns/authorize
 * Create a return authorization (RMA)
 *
 * Body: {
 *   medusa_order_id: "order_01J1234567",
 *   redeem_to_warehouse: true,           -- If false, items are discarded
 *   return_reason: "Item damaged",
 *   items: [
 *     { medusa_order_line_item_id: "item_01J", product_sku: "H2910NL", quantity_requested: 1 }
 *   ]
 * }
 */
router.post('/authorize', authMiddleware, requirePermission('manage_orders'), async (req: AuthRequest, res: Response) => {
  try {
    const {
      medusa_order_id,
      medusa_return_id,
      redeem_to_warehouse = true,
      return_reason,
      customer_name,
      customer_email,
      notes,
      items = []
    } = req.body;

    if (!medusa_order_id || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'medusa_order_id and items array required' });
    }

    // Create the return with the next free number (a clash with another return made at the same moment takes the next one)
    const raResult = await withRmaNumber((number) => query(
      `INSERT INTO return_authorizations 
       (rma_number, medusa_order_id, medusa_return_id, status, redeem_to_warehouse, return_reason, customer_name, customer_email, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [number, medusa_order_id, medusa_return_id || null, 'AUTHORIZED', redeem_to_warehouse, return_reason || null, customer_name || null, customer_email || null, notes || null]
    ));

    const ra = raResult.rows[0];
    const rma_number = ra.rma_number as string;

    // Create return items
    const returnItems = [];
    for (const item of items) {
      const riResult = await query(
        `INSERT INTO return_items
         (return_authorization_id, medusa_order_line_item_id, product_sku, colour_code, quantity_requested)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [ra.id, item.medusa_order_line_item_id || null, item.product_sku, item.colour_code || null, item.quantity_requested || 1]
      );
      returnItems.push(riResult.rows[0]);
    }

    logger.info(`✓ Return authorized: ${rma_number} (order: ${medusa_order_id}, redeem: ${redeem_to_warehouse}, items: ${items.length})`);

    res.status(201).json({
      success: true,
      rma_number,
      return_authorization_id: ra.id,
      status: ra.status,
      redeem_to_warehouse: ra.redeem_to_warehouse,
      items: returnItems
    });
  } catch (err: any) {
    logger.error(`Failed to authorize return: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Failed to authorize return' });
  }
});

/**
 * GET /api/returns
 * List all returns (filterable by status)
 */
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { status = 'AUTHORIZED', limit = '50', offset = '0' } = req.query;

    // The status is a parameter, never part of the SQL text.
    const wanted = status === 'ALL' ? null : String(status).slice(0, 40);
    const max = Math.min(200, Math.max(1, parseInt(limit as string) || 50));
    const skip = Math.max(0, parseInt(offset as string) || 0);

    const result = await query(`
      SELECT * FROM return_authorizations
      WHERE ($3::text IS NULL OR status = $3)
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, [max, skip, wanted]);

    const countResult = await query(`
      SELECT COUNT(*) as count FROM return_authorizations
      WHERE ($1::text IS NULL OR status = $1)
    `, [wanted]);

    res.json({
      returns: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: max,
      offset: skip
    });
  } catch (err: any) {
    logger.error(`Failed to fetch returns: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Failed to fetch returns' });
  }
});

/**
 * GET /api/returns/:rma_id
 * Get return authorization details with all items
 */
router.get('/:rma_id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const raResult = await query(`SELECT * FROM return_authorizations WHERE id = $1`, [req.params.rma_id]);
    if (!raResult.rows[0]) return res.status(404).json({ error: 'Return not found' });

    const itemsResult = await query(`SELECT * FROM return_items WHERE return_authorization_id = $1`, [req.params.rma_id]);

    res.json({
      return_authorization: raResult.rows[0],
      items: itemsResult.rows
    });
  } catch (err: any) {
    logger.error(`Failed to fetch return: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Failed to fetch return' });
  }
});

/**
 * POST /api/returns/:rma_id/receive
 * Mark returned items as received in warehouse
 *
 * Body: {
 *   return_items: [
 *     { return_item_id: "uuid", quantity_received: 1, item_condition: "unused" }
 *   ]
 * }
 */
router.post('/:rma_id/receive', authMiddleware, requirePermission('manage_orders'), async (req: AuthRequest, res: Response) => {
  try {
    const { return_items = [] } = req.body;

    const raResult = await query(`SELECT * FROM return_authorizations WHERE id = $1`, [req.params.rma_id]);
    if (!raResult.rows[0]) return res.status(404).json({ error: 'Return authorization not found' });

    const ra = raResult.rows[0];
    if (ra.status !== 'AUTHORIZED') {
      return res.status(400).json({ error: `Cannot receive items for return in ${ra.status} status` });
    }

    // Update each return item as received
    for (const item of return_items) {
      await query(
        `UPDATE return_items
         SET quantity_received = $1, item_condition = $2, received_at = NOW(), status = 'RECEIVED'
         WHERE id = $3 AND return_authorization_id = $4`,
        [item.quantity_received || 0, item.item_condition || null, item.return_item_id, req.params.rma_id]
      );
    }

    // Update return authorization status
    await query(
      `UPDATE return_authorizations SET status = 'RECEIVED', received_at = NOW() WHERE id = $1`,
      [req.params.rma_id]
    );

    logger.info(`✓ Items received for return: ${ra.rma_number}`);

    res.json({
      success: true,
      rma_number: ra.rma_number,
      status: 'RECEIVED'
    });
  } catch (err: any) {
    logger.error(`Failed to receive return items: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Failed to receive return items' });
  }
});

/**
 * POST /api/returns/:rma_id/approve
 * Approve return and sync stock back to Medusa (if redeem_to_warehouse = true)
 *
 * Body: {
 *   approval_notes?: "string"
 * }
 */
router.post('/:rma_id/approve', authMiddleware, requirePermission('manage_orders'), async (req: AuthRequest, res: Response) => {
  const client = await getPool().connect();
  try {
    const { approval_notes } = req.body || {};
    // Where each returned item goes: body.bay for all, or body.bays { <return_item_id>: <bay> } per item.
    const bays: Record<string, string> = req.body?.bays && typeof req.body.bays === 'object' ? req.body.bays : {};
    const userId = toUuidOrNull(req.user?.id);

    await client.query('BEGIN');
    // Lock the return so two approvals cannot both add the stock.
    const raResult = await client.query(`SELECT * FROM return_authorizations WHERE id = $1 FOR UPDATE`, [req.params.rma_id]);
    const ra = raResult.rows[0];
    if (!ra) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Return authorization not found' }); }
    if (ra.status !== 'RECEIVED') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Cannot approve return in ${ra.status} status — must be RECEIVED first` });
    }

    const itemsResult = await client.query(`SELECT * FROM return_items WHERE return_authorization_id = $1 ORDER BY created_at, id`, [req.params.rma_id]);
    const affectedSkus = new Set<string>();

    if (ra.redeem_to_warehouse) {
      if (!userId) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'A real user login is required to put stock back' }); }
      // Check every bay first, so nothing is added if one is missing or wrong.
      const plan: { item: any; qty: number; locationId: string }[] = [];
      for (const item of itemsResult.rows) {
        const qty = Number(item.quantity_received) || 0;
        if (qty <= 0) continue;
        const code = String(bays[item.id] || req.body?.bay || '').trim();
        if (!code) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Say which bay ${item.product_sku} goes back to (bay, or bays by item)` }); }
        const loc = await client.query(`SELECT id FROM warehouse_locations WHERE location_code = $1`, [code]);
        if (!loc.rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Bay ${code} was not found` }); }
        plan.push({ item, qty, locationId: loc.rows[0].id });
      }
      for (const { item, qty, locationId } of plan) {
        // One bay, owned by Ovara (returns are Ovara's), with a movement so it can be traced. Not every bay holding the SKU.
        await client.query(
          `INSERT INTO warehouse_inventory (location_id, product_sku, quantity, liability_status, created_at, updated_at)
           VALUES ($1,$2,$3,'OVARA', NOW(), NOW())
           ON CONFLICT (location_id, product_sku, COALESCE(colour_code, '')) DO UPDATE SET quantity = warehouse_inventory.quantity + $3, liability_status = 'OVARA', updated_at = NOW()`,
          [locationId, item.product_sku, qty]
        );
        await client.query(
          `INSERT INTO warehouse_movements (movement_type, location_id, product_sku, quantity, notes, performed_by)
           VALUES ('RETURN', $1, $2, $3, $4, $5)`,
          [locationId, item.product_sku, qty, `Return ${ra.rma_number} approved`, userId]
        );
        affectedSkus.add(item.product_sku);
        await client.query(`UPDATE return_items SET status = 'APPROVED', approved_at = NOW() WHERE id = $1`, [item.id]);
      }
    } else {
      await client.query(`UPDATE return_items SET status = 'REJECTED', approved_at = NOW() WHERE return_authorization_id = $1`, [req.params.rma_id]);
    }

    await client.query(
      `UPDATE return_authorizations SET status = 'APPROVED', approved_at = NOW(), approved_by = $1, notes = CASE WHEN $3::text IS NULL THEN notes ELSE CONCAT(COALESCE(notes, ''), E'\\nApproval: ', $3::text) END WHERE id = $2`,
      [userId, req.params.rma_id, approval_notes || null]
    );
    await client.query('COMMIT');

    // Returned stock is sellable again: send it to the shop and to any order waiting for it, as stock-in does.
    if (affectedSkus.size) void stockArrived([...affectedSkus]);

    logger.info(`✓ Return approved: ${ra.rma_number} (redeemable: ${ra.redeem_to_warehouse}, synced: ${affectedSkus.size} SKUs)`);
    res.json({
      success: true,
      rma_number: ra.rma_number,
      status: 'APPROVED',
      redeem_to_warehouse: ra.redeem_to_warehouse,
      synced_skus: Array.from(affectedSkus)
    });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    logger.error(`Failed to approve return: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Failed to approve return. Nothing was changed, so it is safe to try again.' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/returns/:rma_id/reject
 * Reject return (no refund, no inventory adjustment)
 */
router.post('/:rma_id/reject', authMiddleware, requirePermission('manage_orders'), async (req: AuthRequest, res: Response) => {
  try {
    const { rejection_reason } = req.body;

    const raResult = await query(`SELECT * FROM return_authorizations WHERE id = $1`, [req.params.rma_id]);
    if (!raResult.rows[0]) return res.status(404).json({ error: 'Return authorization not found' });

    const ra = raResult.rows[0];
    if (['APPROVED', 'REFUNDED', 'REJECTED'].includes(ra.status)) {
      return res.status(400).json({ error: `Cannot reject a return that is already ${ra.status}` });
    }

    // Mark all items as rejected
    await query(
      `UPDATE return_items SET status = 'REJECTED' WHERE return_authorization_id = $1`,
      [req.params.rma_id]
    );

    // Update return authorization as rejected
    await query(
      `UPDATE return_authorizations 
       SET status = 'REJECTED', rejected_at = NOW(), notes = CONCAT(COALESCE(notes, ''), E'\nRejection: ', $1::text)
       WHERE id = $2`,
      [rejection_reason || 'No reason provided', req.params.rma_id]
    );

    logger.info(`✓ Return rejected: ${ra.rma_number}`);

    res.json({
      success: true,
      rma_number: ra.rma_number,
      status: 'REJECTED'
    });
  } catch (err: any) {
    logger.error(`Failed to reject return: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Failed to reject return' });
  }
});

export default router;
