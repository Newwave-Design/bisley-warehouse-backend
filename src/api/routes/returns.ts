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
import { query } from '../../db/index.js';
import { authMiddleware, requirePermission, AuthRequest } from '../../middleware/auth.js';
import { syncSkuToMedusa } from '../../lib/medusa-inventory.js';
import { getLogger } from '../../lib/logger.js';

const router = express.Router();
const logger = getLogger('returns');

// Generate RMA number: RMA-YYYYMMDD-XXXX (e.g., RMA-20260916-0001)
async function generateRmaNumber(): Promise<string> {
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const result = await query(
    `SELECT COUNT(*) as count FROM return_authorizations 
     WHERE rma_number LIKE $1`,
    [`RMA-${today}-%`]
  );
  const count = parseInt(result.rows[0].count) + 1;
  return `RMA-${today}-${String(count).padStart(4, '0')}`;
}

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
router.post('/authorize', authMiddleware, requirePermission('manage_inventory'), async (req: AuthRequest, res: Response) => {
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

    // Generate RMA number
    const rma_number = await generateRmaNumber();

    // Create return authorization
    const raResult = await query(
      `INSERT INTO return_authorizations 
       (rma_number, medusa_order_id, medusa_return_id, status, redeem_to_warehouse, return_reason, customer_name, customer_email, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [rma_number, medusa_order_id, medusa_return_id || null, 'AUTHORIZED', redeem_to_warehouse, return_reason || null, customer_name || null, customer_email || null, notes || null]
    );

    const ra = raResult.rows[0];

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
    logger.error('Failed to authorize return:', err);
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

    const statusFilter = status === 'ALL' ? '' : `WHERE status = '${status}'`;

    const result = await query(`
      SELECT * FROM return_authorizations
      ${statusFilter}
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, [parseInt(limit as string), parseInt(offset as string)]);

    const countResult = await query(`
      SELECT COUNT(*) as count FROM return_authorizations
      ${statusFilter}
    `);

    res.json({
      returns: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit as string),
      offset: parseInt(offset as string)
    });
  } catch (err: any) {
    logger.error('Failed to fetch returns:', err);
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
    logger.error('Failed to fetch return:', err);
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
router.post('/:rma_id/receive', authMiddleware, requirePermission('manage_inventory'), async (req: AuthRequest, res: Response) => {
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
    logger.error('Failed to receive return items:', err);
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
router.post('/:rma_id/approve', authMiddleware, requirePermission('manage_inventory'), async (req: AuthRequest, res: Response) => {
  try {
    const { approval_notes } = req.body;

    const raResult = await query(`SELECT * FROM return_authorizations WHERE id = $1`, [req.params.rma_id]);
    if (!raResult.rows[0]) return res.status(404).json({ error: 'Return authorization not found' });

    const ra = raResult.rows[0];
    if (ra.status !== 'RECEIVED') {
      return res.status(400).json({ error: `Cannot approve return in ${ra.status} status — must be RECEIVED first` });
    }

    // Get all return items
    const itemsResult = await query(`SELECT * FROM return_items WHERE return_authorization_id = $1`, [req.params.rma_id]);

    const affectedSkus = new Set<string>();

    // If redeem_to_warehouse = true, add items back to inventory and track affected SKUs
    if (ra.redeem_to_warehouse) {
      for (const item of itemsResult.rows) {
        const qty = item.quantity_received || 0;

        if (qty > 0) {
          // Add stock back to inventory
          await query(
            `UPDATE warehouse_inventory
             SET quantity = quantity + $1, updated_at = NOW()
             WHERE product_sku = $2`,
            [qty, item.product_sku]
          );

          affectedSkus.add(item.product_sku);

          // Mark item as approved
          await query(
            `UPDATE return_items SET status = 'APPROVED', approved_at = NOW() WHERE id = $1`,
            [item.id]
          );
        }
      }

      // Sync updated available quantities to Medusa
      for (const sku of affectedSkus) {
        const row = await query(
          `SELECT SUM(quantity) as qty, SUM(quantity_reserved) as reserved FROM warehouse_inventory WHERE product_sku = $1`,
          [sku]
        );
        const available = Math.max(0, parseInt(row.rows[0]?.qty ?? '0') - parseInt(row.rows[0]?.reserved ?? '0'));
        await syncSkuToMedusa(sku, available);
      }
    } else {
      // Mark items as rejected (not redeemable)
      for (const item of itemsResult.rows) {
        await query(
          `UPDATE return_items SET status = 'REJECTED', approved_at = NOW() WHERE id = $1`,
          [item.id]
        );
      }
    }

    // Update return authorization as approved
    await query(
      `UPDATE return_authorizations SET status = 'APPROVED', approved_at = NOW(), approved_by = $1 WHERE id = $2`,
      [req.user?.id || null, req.params.rma_id]
    );

    logger.info(`✓ Return approved: ${ra.rma_number} (redeemable: ${ra.redeem_to_warehouse}, synced: ${affectedSkus.size} SKUs)`);

    res.json({
      success: true,
      rma_number: ra.rma_number,
      status: 'APPROVED',
      redeem_to_warehouse: ra.redeem_to_warehouse,
      synced_skus: Array.from(affectedSkus)
    });
  } catch (err: any) {
    logger.error('Failed to approve return:', err);
    res.status(500).json({ error: 'Failed to approve return' });
  }
});

/**
 * POST /api/returns/:rma_id/reject
 * Reject return (no refund, no inventory adjustment)
 */
router.post('/:rma_id/reject', authMiddleware, requirePermission('manage_inventory'), async (req: AuthRequest, res: Response) => {
  try {
    const { rejection_reason } = req.body;

    const raResult = await query(`SELECT * FROM return_authorizations WHERE id = $1`, [req.params.rma_id]);
    if (!raResult.rows[0]) return res.status(404).json({ error: 'Return authorization not found' });

    const ra = raResult.rows[0];

    // Mark all items as rejected
    await query(
      `UPDATE return_items SET status = 'REJECTED' WHERE return_authorization_id = $1`,
      [req.params.rma_id]
    );

    // Update return authorization as rejected
    await query(
      `UPDATE return_authorizations 
       SET status = 'REJECTED', rejected_at = NOW(), notes = CONCAT(notes, '\nRejection: ', $1)
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
    logger.error('Failed to reject return:', err);
    res.status(500).json({ error: 'Failed to reject return' });
  }
});

export default router;
