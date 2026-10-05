/**
 * Unified Stock-In Flow API
 * Consolidates Scanning, Checkin, and Receiving pallet workflows into one process:
 * 1. Start session (mobile scanner mode)
 * 2. Scan items (cumulative per SKU+colour, one row per unique combo)
 * 3. Review (table of scanned items, editable quantities)
 * 4. Confirm (commit to warehouse_inventory + Medusa sync)
 *
 * GET    /api/stock-in/sessions              — List sessions (?status=OPEN default, ?status=ALL for history)
 * POST   /api/stock-in/start-session         — Create new stock-in session
 * GET    /api/stock-in/sessions/:id          — Get session + all scanned items
 * POST   /api/stock-in/scan                  — Lookup barcode/NW code + scan/increment item
 * PATCH  /api/stock-in/sessions/:id/items/:itemId — Edit quantity (review screen)
 * DELETE /api/stock-in/sessions/:id/items/:itemId — Remove item
 * POST   /api/stock-in/sessions/:id/confirm  — Commit stock to warehouse + sync to Medusa
 * POST   /api/stock-in/sessions/:id/reopen   — Put an abandoned session back to OPEN
 * DELETE /api/stock-in/sessions/:id/scans/:scanId — Trash one scan (struck through, units come off the count)
 * POST   /api/stock-in/sessions/:id/scans/:scanId/restore — Restore a trashed scan
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { failedScansFor } from '../../lib/failed-scans.js';
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

/**
 * warehouse_inventory.colour_code is VARCHAR(20), but checkin_items.colour can hold a
 * longer colour_name (scan step falls back to name when no short code is known).
 * Resolve the real short code from wms_products; truncate as a last resort so the
 * insert never fails on a length constraint.
 */
async function resolveColourCode(sku: string, checkinColour: string | null): Promise<string> {
  const result = await query(
    `SELECT colour_code FROM wms_products WHERE variant_sku = $1 AND colour_code IS NOT NULL LIMIT 1`,
    [sku]
  );
  const code = result.rows[0]?.colour_code || checkinColour || '';
  return code.slice(0, 20);
}

/** List all sessions (active + recent) */
router.get('/sessions', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { status = 'OPEN', limit = '50', offset = '0' } = req.query;
    const statusFilter = status === 'ALL' ? null : status;
    
    const result = await query(
      `SELECT s.*,
        COUNT(ci.id) as items_count,
        COALESCE(SUM(ci.quantity_scanned), 0) as total_units
       FROM checkin_sessions s
       LEFT JOIN checkin_items ci ON ci.session_id = s.id AND ci.removed_at IS NULL
       WHERE ($1::text IS NULL OR s.status = $1)
       GROUP BY s.id
       ORDER BY s.created_at DESC
       LIMIT $2 OFFSET $3`,
      [statusFilter, parseInt(limit as string), parseInt(offset as string)]
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

    // Get enriched items with product details
    // DISTINCT ON (ci.id) prevents duplicate rows if barcode_mappings or wms_products has multiple entries per SKU
    const items = await query(
      `SELECT DISTINCT ON (ci.id)
        ci.id,
        ci.session_id,
        ci.nw_code as product_sku,
        ci.colour,
        ci.medusa_sku,
        ci.quantity_scanned,
        ci.scanned_at,
        ci.removed_at,
        ci.created_at,
        COALESCE(bm.product_name, wp.product_title, 'Unknown') as product_name,
        COALESCE(bm.colour_code, wp.colour_code, '') as colour_code,
        COALESCE(bm.colour_name, wp.colour_name, ci.colour) as colour_name
       FROM checkin_items ci
       LEFT JOIN barcode_mappings bm ON bm.product_sku = ci.nw_code AND bm.is_active = true
       LEFT JOIN wms_products wp ON wp.nw_code = ci.nw_code 
       WHERE ci.session_id = $1 
       ORDER BY ci.id, ci.created_at DESC`,
      [req.params.id]
    );

    const scans = await query(
      `SELECT id, item_id, quantity, scanned_at, removed_at FROM checkin_scans
       WHERE session_id = $1 ORDER BY scanned_at DESC LIMIT 500`,
      [req.params.id]
    );

    const summary = await query(
      `SELECT COUNT(*) as item_count, SUM(quantity_scanned) as total_qty FROM checkin_items WHERE session_id = $1 AND removed_at IS NULL`,
      [req.params.id]
    );

    res.json({
      session: session.rows[0],
      items: items.rows,
      scans: scans.rows,
      summary: summary.rows[0],
      failed_scans: await failedScansFor('STOCK_IN', req.params.id),
    });
  } catch (err) {
    logger.error(`Failed to fetch session: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

/** POST /api/stock-in/sessions/:id/abandon — cancel an open session; nothing is stocked */
router.post('/sessions/:id/abandon', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `UPDATE checkin_sessions SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1 AND status = 'OPEN' RETURNING id`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(400).json({ error: 'Session not found or not open' });

    logger.info(`[stock-in] Abandoned session ${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`Failed to abandon session: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    res.status(500).json({ error: 'Failed to abandon session' });
  }
});

/** POST /api/stock-in/sessions/:id/reopen — put an abandoned session back to OPEN so scanning can carry on */
router.post('/sessions/:id/reopen', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `UPDATE checkin_sessions SET status = 'OPEN', updated_at = NOW() WHERE id = $1 AND status = 'CANCELLED' RETURNING id`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(400).json({ error: 'Session not found or not abandoned' });

    logger.info(`[stock-in] Reopened session ${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`Failed to reopen session: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    res.status(500).json({ error: 'Failed to reopen session' });
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
       WHERE session_id = $1 AND nw_code = $2 AND LOWER(COALESCE(colour, '')) = LOWER($3) AND removed_at IS NULL`,
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

    const scanLog = await query(
      `INSERT INTO checkin_scans (session_id, item_id, quantity) VALUES ($1, $2, $3) RETURNING id, item_id, quantity, scanned_at`,
      [session_id, item.id, quantity]
    );

    res.json({
      success: true,
      scan: scanLog.rows[0],
      item: {
        ...item,
        product_sku: item.nw_code,
        product_name: productInfo.product_name,
        colour_name: productInfo.colour_name || colour_used,
        colour_code: productInfo.colour_code || '',
      },
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : JSON.stringify(err);
    logger.error(`Scan failed: ${errorMsg}`);
    res.status(500).json({ error: `Scan failed: ${errorMsg}` });
  }
});

/**
 * DELETE /api/stock-in/sessions/:id/scans/:scanId — trash one scan: it stays in the history, struck through,
 * and its units come off the item's count. POST .../restore puts it back.
 */
router.delete('/sessions/:id/scans/:scanId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const session = await query(`SELECT status FROM checkin_sessions WHERE id = $1`, [req.params.id]);
    if (session.rows[0]?.status !== 'OPEN') return res.status(400).json({ error: 'Session is not open' });

    const scan = await query(
      `UPDATE checkin_scans SET removed_at = NOW() WHERE id = $1 AND session_id = $2 AND removed_at IS NULL RETURNING item_id, quantity`,
      [req.params.scanId, req.params.id]
    );
    if (!scan.rows[0]) return res.status(404).json({ error: 'Scan not found or already removed' });

    const item = await query(
      `UPDATE checkin_items SET quantity_scanned = GREATEST(quantity_scanned - $1, 0), updated_at = NOW() WHERE id = $2 RETURNING *`,
      [scan.rows[0].quantity, scan.rows[0].item_id]
    );
    res.json({ success: true, item: item.rows[0] });
  } catch (err) {
    logger.error(`Failed to remove scan: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    res.status(500).json({ error: 'Failed to remove scan' });
  }
});

router.post('/sessions/:id/scans/:scanId/restore', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const session = await query(`SELECT status FROM checkin_sessions WHERE id = $1`, [req.params.id]);
    if (session.rows[0]?.status !== 'OPEN') return res.status(400).json({ error: 'Session is not open' });

    const scan = await query(
      `UPDATE checkin_scans SET removed_at = NULL WHERE id = $1 AND session_id = $2 AND removed_at IS NOT NULL RETURNING item_id, quantity`,
      [req.params.scanId, req.params.id]
    );
    if (!scan.rows[0]) return res.status(404).json({ error: 'Removed scan not found' });

    const item = await query(
      `UPDATE checkin_items SET quantity_scanned = quantity_scanned + $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [scan.rows[0].quantity, scan.rows[0].item_id]
    );
    res.json({ success: true, item: item.rows[0] });
  } catch (err) {
    logger.error(`Failed to restore scan: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    res.status(500).json({ error: 'Failed to restore scan' });
  }
});

/** PATCH /api/stock-in/sessions/:id/scans/:scanId { quantity } — change one scan's quantity; the item's count moves by the difference */
router.patch('/sessions/:id/scans/:scanId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const qty = parseInt(req.body?.quantity);
    if (!(qty >= 1 && qty <= 9999)) return res.status(400).json({ error: 'Quantity must be between 1 and 9999' });

    const session = await query(`SELECT status FROM checkin_sessions WHERE id = $1`, [req.params.id]);
    if (session.rows[0]?.status !== 'OPEN') return res.status(400).json({ error: 'Session is not open' });

    const current = await query(
      `SELECT item_id, quantity, removed_at FROM checkin_scans WHERE id = $1 AND session_id = $2`,
      [req.params.scanId, req.params.id]
    );
    const scan = current.rows[0];
    if (!scan) return res.status(404).json({ error: 'Scan not found' });

    await query(`UPDATE checkin_scans SET quantity = $1 WHERE id = $2`, [qty, req.params.scanId]);
    // a trashed scan is not in the count, so only its own row changes
    const item = scan.removed_at
      ? await query(`SELECT * FROM checkin_items WHERE id = $1`, [scan.item_id])
      : await query(
          `UPDATE checkin_items SET quantity_scanned = GREATEST(quantity_scanned + $1, 0), updated_at = NOW() WHERE id = $2 RETURNING *`,
          [qty - scan.quantity, scan.item_id]
        );
    res.json({ success: true, item: item.rows[0] });
  } catch (err) {
    logger.error(`Failed to change scan quantity: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    res.status(500).json({ error: 'Failed to change scan quantity' });
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

/** DELETE /api/stock-in/sessions/:id/items/:itemId — Soft-remove an item (kept for scan history, restorable) */
router.delete('/sessions/:id/items/:itemId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    await query(
      `UPDATE checkin_items SET removed_at = NOW(), updated_at = NOW() WHERE id = $1 AND session_id = $2`,
      [req.params.itemId, req.params.id]
    );

    logger.info(`[stock-in] Removed item ${req.params.itemId} from session ${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`Failed to remove item: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    res.status(500).json({ error: 'Failed to remove item' });
  }
});

/** POST /api/stock-in/sessions/:id/items/:itemId/restore — Undo a removal; merges into the live row if the item was re-scanned since */
router.post('/sessions/:id/items/:itemId/restore', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const session = await query(`SELECT status FROM checkin_sessions WHERE id = $1`, [req.params.id]);
    if (session.rows[0]?.status !== 'OPEN') return res.status(400).json({ error: 'Session is not open' });

    const removed = await query(
      `SELECT * FROM checkin_items WHERE id = $1 AND session_id = $2 AND removed_at IS NOT NULL`,
      [req.params.itemId, req.params.id]
    );
    const item = removed.rows[0];
    if (!item) return res.status(404).json({ error: 'Removed item not found' });

    const live = await query(
      `SELECT id FROM checkin_items
       WHERE session_id = $1 AND nw_code = $2 AND LOWER(COALESCE(colour, '')) = LOWER($3) AND removed_at IS NULL LIMIT 1`,
      [req.params.id, item.nw_code, item.colour || '']
    );

    if (live.rows[0]) {
      await query(
        `UPDATE checkin_items SET quantity_scanned = quantity_scanned + $1, updated_at = NOW() WHERE id = $2`,
        [item.quantity_scanned, live.rows[0].id]
      );
      await query(`UPDATE checkin_scans SET item_id = $1 WHERE item_id = $2`, [live.rows[0].id, item.id]);
      await query(`DELETE FROM checkin_items WHERE id = $1`, [item.id]);
    } else {
      await query(`UPDATE checkin_items SET removed_at = NULL, updated_at = NOW() WHERE id = $1`, [item.id]);
    }

    logger.info(`[stock-in] Restored item ${item.id} in session ${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`Failed to restore item: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    res.status(500).json({ error: 'Failed to restore item' });
  }
});

/** POST /api/stock-in/sessions/:id/confirm — Commit stock to warehouse_inventory + sync to Medusa */
router.post('/sessions/:id/confirm', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = req.params.id;
    logger.info(`[stock-in] Confirm request for session ${sessionId}`);

    const session = await query(
      `SELECT * FROM checkin_sessions WHERE id = $1`,
      [sessionId]
    );

    if (!session.rows[0]) {
      logger.warn(`[stock-in] Session not found: ${sessionId}`);
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.rows[0].status !== 'OPEN') {
      logger.warn(`[stock-in] Session ${sessionId} not open, status: ${session.rows[0].status}`);
      return res.status(400).json({ error: 'Session is not open' });
    }

    // Get all scanned items
    const items = await query(
      `SELECT * FROM checkin_items WHERE session_id = $1 AND removed_at IS NULL`,
      [sessionId]
    );

    if (items.rows.length === 0) {
      logger.warn(`[stock-in] No items in session ${sessionId}`);
      return res.status(400).json({ error: 'No items scanned' });
    }

    logger.info(`[stock-in] Confirming ${items.rows.length} items to warehouse from session ${sessionId}`);

    // Get or create RECEIVING location
    let receivingLocationId: string;
    try {
      receivingLocationId = await getReceivingLocation();
      logger.info(`[stock-in] Using receiving location: ${receivingLocationId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : JSON.stringify(err);
      logger.error(`[stock-in] Failed to get receiving location: ${msg}`);
      return res.status(500).json({ error: `Failed to get receiving location: ${msg}` });
    }

    const defaultLiability = 'Bisley';
    let stocked = 0;
    const syncedSkus = new Set<string>();
    const failedItems: string[] = [];

    // Stock each item to warehouse_inventory
    for (let i = 0; i < items.rows.length; i++) {
      const item = items.rows[i];
      const sku = item.medusa_sku || item.nw_code;
      
      try {
        const productDetails = await getProductDetails(sku);
        const productDisplay = productDetails
          ? `${productDetails.name} (${productDetails.dimensions || 'n/a'})`
          : sku;

        // checkin_items.colour may hold a long colour_name rather than a short code —
        // resolve the real code (variant-specific) and fall back to truncating it.
        const colourCode = await resolveColourCode(sku, item.colour);

        logger.debug(`[stock-in] Stocking item ${i + 1}/${items.rows.length}: ${sku} qty=${item.quantity_scanned} colour=${colourCode || 'none'}`);

        // Upsert into warehouse_inventory
        const insertResult = await query(
          `INSERT INTO warehouse_inventory (location_id, product_sku, colour_code, quantity, liability_status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
           ON CONFLICT (location_id, product_sku, COALESCE(colour_code, ''))
           DO UPDATE SET quantity = warehouse_inventory.quantity + $4, updated_at = NOW()
           RETURNING id, quantity`,
          [
            receivingLocationId,
            sku,
            colourCode,
            item.quantity_scanned,
            defaultLiability,
          ]
        );

        if (!insertResult.rows[0]) {
          throw new Error('Insert returned no rows');
        }

        syncedSkus.add(sku);
        stocked++;
        logger.info(`  ✓ Stocked ${item.quantity_scanned}x ${productDisplay} (new quantity: ${insertResult.rows[0].quantity})`);
      } catch (itemErr) {
        const itemMsg = itemErr instanceof Error ? itemErr.message : JSON.stringify(itemErr);
        logger.error(`[stock-in] Failed to stock item ${i + 1}: ${sku} - ${itemMsg}`);
        failedItems.push(`Item ${i + 1} (${sku}): ${itemMsg}`);
      }
    }

    if (failedItems.length > 0) {
      logger.error(`[stock-in] Failed to stock ${failedItems.length} items: ${failedItems.join('; ')}`);
      return res.status(500).json({ 
        error: `Failed to stock items: ${failedItems[0]}`,
        details: failedItems,
        items_stocked: stocked,
        note: 'Some items failed to stock. Your session is saved and you can retry.'
      });
    }

    if (stocked === 0) {
      logger.error(`[stock-in] No items were successfully stocked in session ${sessionId}`);
      return res.status(500).json({ error: 'No items were successfully stocked' });
    }

    logger.info(`[stock-in] Successfully stocked ${stocked} items, attempting to unblock pick lists...`);

    // Unblock any backorder pick lists that can now be fulfilled
    let unblocked: string[] = [];
    try {
      unblocked = await unblockBackorderedPickLists([...syncedSkus]);
      if (unblocked && unblocked.length > 0) {
        logger.info(`[stock-in] Unblocked ${unblocked.length} pick lists: ${unblocked.join(', ')}`);
      }
    } catch (unlockErr) {
      const unlockMsg = unlockErr instanceof Error ? unlockErr.message : JSON.stringify(unlockErr);
      logger.error(`[stock-in] Failed to unblock pick lists: ${unlockMsg}`);
      // Non-fatal - continue to mark session complete
    }

    logger.info(`[stock-in] Stocked ${stocked} items to warehouse_inventory. Medusa inventory unchanged (sync disabled for now).`);

    // Mark session complete
    try {
      const updateResult = await query(
        `UPDATE checkin_sessions SET status = 'COMPLETE', completed_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING id`,
        [sessionId]
      );
      if (!updateResult.rows[0]) {
        throw new Error('Session update returned no rows');
      }
      logger.info(`[stock-in] Session ${sessionId} marked COMPLETE`);
    } catch (completeErr) {
      const completeMsg = completeErr instanceof Error ? completeErr.message : JSON.stringify(completeErr);
      logger.error(`[stock-in] Failed to mark session complete: ${completeMsg}`);
      return res.status(500).json({ 
        error: `Failed to mark session complete: ${completeMsg}`,
        items_stocked: stocked,
        note: 'Items were stocked but session completion failed. Your items are safe.'
      });
    }

    res.json({
      success: true,
      session_id: sessionId,
      items_stocked: stocked,
      unique_skus: syncedSkus.size,
      unblocked_pick_lists: unblocked?.length ?? 0,
      note: 'Medusa inventory is NOT changed by stock-in. It only changes during fulfillment/shipment.',
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
    logger.error(`[stock-in] Confirm failed with unhandled error: ${errMsg}`);
    logger.error(`[stock-in] Stack trace: ${err instanceof Error ? err.stack : 'N/A'}`);
    res.status(500).json({ error: `Failed to confirm stock-in: ${errMsg}` });
  }
});

export default router;
