/**
 * Unified Stock-In Flow API
 * Consolidates Scanning, Checkin, and Receiving pallet workflows into one process:
 * 1. Start session (mobile scanner mode)
 * 2. Scan items (cumulative per SKU+colour, one row per unique combo)
 * 3. Review (table of scanned items, editable quantities)
 * 4. Confirm (commit to warehouse_inventory + Medusa sync)
 *
 * GET    /api/stock-in/sessions              — List active sessions
 * POST   /api/stock-in/start-session         — Create new stock-in session
 * GET    /api/stock-in/sessions/:id          — Get session + all scanned items
 * POST   /api/stock-in/scan                  — Lookup barcode/NW code + scan/increment item
 * PATCH  /api/stock-in/sessions/:id/items/:itemId — Edit quantity (review screen)
 * DELETE /api/stock-in/sessions/:id/items/:itemId — Remove item
 * POST   /api/stock-in/sessions/:id/confirm  — Commit stock to warehouse + sync to Medusa
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, requirePermission, AuthRequest } from '../../middleware/auth.js';
import { getProductDetails } from '../../lib/inventory-sync-service.js';
import { syncSkuToMedusa } from '../../lib/medusa-inventory.js';
import { unblockBackorderedPickLists } from './pick-lists.js';
import { getLogger } from '../../lib/logger.js';

const router = express.Router();
const logger = getLogger('stock-in');

/** Get or create default "Receiving" location for stock-in */
async function getReceivingLocation(): Promise<string> {
  const result = await query(
    `SELECT id FROM warehouse_locations WHERE location_code = 'RECEIVING' LIMIT 1`
  );
  if (result.rows[0]) {
    return result.rows[0].id;
  }

  // Create default RECEIVING location if it doesn't exist
  const created = await query(
    `INSERT INTO warehouse_locations (location_code, aisle_code, bay_code, bin_code, description)
     VALUES ('RECEIVING', 'RCV', 'RCV', 'RCV', 'Default receiving bay for new stock')
     RETURNING id`,
    []
  );
  return created.rows[0].id;
}

/** List all sessions (active + recent) */
router.get('/sessions', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { status = 'OPEN', limit = '50', offset = '0' } = req.query;
    
    const result = await query(
      `SELECT s.*,
        COUNT(ci.id) as items_count,
        COALESCE(SUM(ci.quantity_scanned), 0) as total_units
       FROM checkin_sessions s
       LEFT JOIN checkin_items ci ON ci.session_id = s.id
       WHERE s.status = $1
       GROUP BY s.id
       ORDER BY s.created_at DESC
       LIMIT $2 OFFSET $3`,
      [status, parseInt(limit as string), parseInt(offset as string)]
    );

    res.json({ sessions: result.rows });
  } catch (err) {
    logger.error(`Failed to list sessions: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

/** POST /api/stock-in/start-session — Create new stock-in session */
router.post('/start-session', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { order_id, notes } = req.body;

    const result = await query(
      `INSERT INTO checkin_sessions (order_id, status, started_by, notes, created_at, updated_at)
       VALUES ($1, 'OPEN', $2, $3, NOW(), NOW())
       RETURNING *`,
      [order_id || null, (req as any).user?.email || 'warehouse', notes || null]
    );

    logger.info(`[stock-in] Started new session: ${result.rows[0].id}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error(`Failed to start session: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

/** GET /api/stock-in/sessions/:id — Get session detail + all scanned items */
router.get('/sessions/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const session = await query(
      `SELECT * FROM checkin_sessions WHERE id = $1`,
      [req.params.id]
    );

    if (!session.rows[0]) return res.status(404).json({ error: 'Session not found' });

    const items = await query(
      `SELECT * FROM checkin_items WHERE session_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    );

    const summary = await query(
      `SELECT COUNT(*) as item_count, SUM(quantity_scanned) as total_qty FROM checkin_items WHERE session_id = $1`,
      [req.params.id]
    );

    res.json({
      session: session.rows[0],
      items: items.rows,
      summary: summary.rows[0],
    });
  } catch (err) {
    logger.error(`Failed to fetch session: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

/** POST /api/stock-in/scan — Lookup barcode/NW code + scan item (cumulative per SKU+colour) */
router.post('/scan', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { session_id, scan_input, colour, quantity = 1 } = req.body;

    if (!session_id || !scan_input) {
      return res.status(400).json({ error: 'session_id and scan_input required' });
    }

    // Check session is open
    const session = await query(
      `SELECT status FROM checkin_sessions WHERE id = $1`,
      [session_id]
    );
    if (!session.rows[0]) return res.status(404).json({ error: 'Session not found' });
    if (session.rows[0].status !== 'OPEN') {
      return res.status(400).json({ error: 'Session is not open' });
    }

    // Lookup: try barcode first, then NW code
    const q = (scan_input as string).trim().toUpperCase();
    
    let productInfo: any = null;
    
    // Try barcode_mappings (EAN / Supercode)
    const barcode = await query(
      `SELECT bm.product_sku as nw_code, bm.colour_name as colour_name, bm.colour_code,
              bm.product_name, wp.variant_sku AS medusa_sku
       FROM barcode_mappings bm
       LEFT JOIN wms_products wp ON wp.variant_sku = bm.product_sku
       WHERE bm.barcode = $1 AND bm.is_active = true
       LIMIT 1`,
      [q]
    );
    
    if (barcode.rows[0]) {
      productInfo = barcode.rows[0];
    } else {
      // Try sku_mappings or wms_products by NW code / SKU
      const sku = await query(
        `SELECT DISTINCT variant_sku as medusa_sku, colour_code, product_title, nw_code
         FROM wms_products
         WHERE UPPER(COALESCE(nw_code, variant_sku)) = $1
         LIMIT 1`,
        [q]
      );
      if (sku.rows[0]) {
        productInfo = {
          nw_code: sku.rows[0].nw_code || q,
          medusa_sku: sku.rows[0].medusa_sku,
          product_name: sku.rows[0].product_title,
          colour_code: colour || sku.rows[0].colour_code || null,
        };
      }
    }

    if (!productInfo) {
      return res.status(404).json({ error: 'Product not found', query: q });
    }

    const nw_code = productInfo.nw_code;
    const medusa_sku = productInfo.medusa_sku;
    const colour_used = colour || productInfo.colour_name || productInfo.colour_code || '';

    // Check if this nw_code+colour already scanned in this session
    const existing = await query(
      `SELECT id, quantity_scanned FROM checkin_items
       WHERE session_id = $1 AND nw_code = $2 AND LOWER(COALESCE(colour, '')) = LOWER($3)`,
      [session_id, nw_code, colour_used]
    );

    let item;
    if (existing.rows[0]) {
      // Increment quantity
      const result = await query(
        `UPDATE checkin_items
         SET quantity_scanned = quantity_scanned + $1, updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [quantity, existing.rows[0].id]
      );
      item = result.rows[0];
      logger.info(`[stock-in] Incremented ${nw_code} (${colour_used}) to ${item.quantity_scanned}x in session ${session_id}`);
    } else {
      // Create new row
      const result = await query(
        `INSERT INTO checkin_items (session_id, nw_code, colour, medusa_sku, quantity_scanned, scanned_at, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         RETURNING *`,
        [session_id, nw_code, colour_used || null, medusa_sku || null, quantity]
      );
      item = result.rows[0];
      logger.info(`[stock-in] Scanned ${quantity}x ${nw_code} (${colour_used}) into session ${session_id}`);
    }

    res.json({
      success: true,
      item,
      product_name: productInfo.product_name,
      colour_found: productInfo.colour_name || colour_used,
    });
  } catch (err) {
    logger.error(`Scan failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    res.status(500).json({ error: 'Scan failed' });
  }
});

/** PATCH /api/stock-in/sessions/:id/items/:itemId — Edit quantity on review screen */
router.patch('/sessions/:id/items/:itemId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { quantity } = req.body;

    if (quantity === undefined || quantity < 0) {
      return res.status(400).json({ error: 'Invalid quantity' });
    }

    const result = await query(
      `UPDATE checkin_items
       SET quantity_scanned = $1, updated_at = NOW()
       WHERE id = $2 AND session_id = $3
       RETURNING *`,
      [quantity, req.params.itemId, req.params.id]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Item not found' });

    logger.info(`[stock-in] Updated item ${req.params.itemId} qty to ${quantity}`);
    res.json(result.rows[0]);
  } catch (err) {
    logger.error(`Failed to update item: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

/** DELETE /api/stock-in/sessions/:id/items/:itemId — Remove item from review */
router.delete('/sessions/:id/items/:itemId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    await query(
      `DELETE FROM checkin_items WHERE id = $1 AND session_id = $2`,
      [req.params.itemId, req.params.id]
    );

    logger.info(`[stock-in] Removed item ${req.params.itemId} from session ${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`Failed to remove item: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    res.status(500).json({ error: 'Failed to remove item' });
  }
});

/** POST /api/stock-in/sessions/:id/confirm — Commit stock to warehouse_inventory + sync to Medusa */
router.post('/sessions/:id/confirm', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const session = await query(
      `SELECT * FROM checkin_sessions WHERE id = $1`,
      [req.params.id]
    );

    if (!session.rows[0]) return res.status(404).json({ error: 'Session not found' });
    if (session.rows[0].status !== 'OPEN') {
      return res.status(400).json({ error: 'Session is not open' });
    }

    // Get all scanned items
    const items = await query(
      `SELECT * FROM checkin_items WHERE session_id = $1`,
      [req.params.id]
    );

    if (items.rows.length === 0) {
      return res.status(400).json({ error: 'No items scanned' });
    }

    // Get or create RECEIVING location
    const receivingLocationId = await getReceivingLocation();

    const defaultLiability = 'Bisley'; // Default for new stock-in
    let stocked = 0;
    const syncedSkus = new Set<string>();
    const syncErrors: string[] = [];

    logger.info(`[stock-in] Confirming ${items.rows.length} items to warehouse from session ${req.params.id}`);

    // Stock each item to warehouse_inventory
    for (const item of items.rows) {
      const sku = item.medusa_sku || item.nw_code;
      const productDetails = await getProductDetails(sku);
      const productDisplay = productDetails
        ? `${productDetails.name} (${productDetails.dimensions || 'n/a'})`
        : sku;

      // Upsert into warehouse_inventory
      await query(
        `INSERT INTO warehouse_inventory (location_id, product_sku, colour_code, quantity, liability_status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (location_id, product_sku, COALESCE(colour_code, ''))
         DO UPDATE SET quantity = warehouse_inventory.quantity + $4, updated_at = NOW()`,
        [
          receivingLocationId,
          sku,
          item.colour || '',
          item.quantity_scanned,
          defaultLiability,
        ]
      );

      syncedSkus.add(sku);
      stocked++;
      logger.info(`  ✓ Stocked ${item.quantity_scanned}x ${productDisplay}`);
    }

    // Sync all unique SKUs to Medusa
    logger.info(`[stock-in] Syncing ${syncedSkus.size} unique SKUs to Medusa...`);

    for (const sku of syncedSkus) {
      const totalResult = await query(
        `SELECT SUM(quantity) as qty, SUM(quantity_reserved) as reserved FROM warehouse_inventory WHERE product_sku = $1`,
        [sku]
      );
      const newTotal = Math.max(
        0,
        parseInt(totalResult.rows[0]?.qty ?? '0') - parseInt(totalResult.rows[0]?.reserved ?? '0')
      );
      const syncResult = await syncSkuToMedusa(sku, newTotal);
      if (!syncResult.ok) {
        const errMsg = `${sku}: ${syncResult.error}`;
        syncErrors.push(errMsg);
        logger.error(`[stock-in] Medusa sync failed: ${errMsg}`);
      } else {
        logger.info(`[stock-in] ✓ Medusa synced: ${sku} → ${newTotal} units`);
      }
    }

    // Unblock any backorder pick lists that can now be fulfilled
    const unblocked = await unblockBackorderedPickLists([...syncedSkus]);
    if (unblocked && unblocked.length > 0) {
      logger.info(`[stock-in] Unblocked ${unblocked.length} pick lists`);
    }

    // Mark session complete
    await query(
      `UPDATE checkin_sessions SET status = 'COMPLETE', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    res.json({
      success: true,
      session_id: req.params.id,
      items_stocked: stocked,
      unique_skus: syncedSkus.size,
      medusa_synced: syncedSkus.size - syncErrors.length,
      sync_errors: syncErrors.length,
      error_details: syncErrors.length > 0 ? syncErrors : undefined,
      unblocked_pick_lists: unblocked?.length ?? 0,
    });
  } catch (err) {
    logger.error(`Confirm failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    res.status(500).json({ error: 'Failed to confirm stock-in' });
  }
});

export default router;
