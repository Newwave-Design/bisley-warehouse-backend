/**
 * Pick List API
 * Endpoints for managing pick lists and picking operations
 */

import express, { Request, Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware } from '../../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import { syncSkuToMedusa } from '../../lib/medusa-inventory.js';

const router = express.Router();

/**
 * GET /api/pick-lists
 * List all active pick lists (with status filtering)
 * 
 * Query params: ?status=PENDING,IN_PROGRESS&limit=50&offset=0
 */
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { status = 'PENDING,IN_PROGRESS', limit = '50', offset = '0' } = req.query;

    const statuses = (status as string).toUpperCase().split(',').map(s => s.trim());

    const result = await query(
      `SELECT 
         pl.id,
         pl.pick_list_number,
         pl.medusa_order_id,
         pl.status,
         pl.created_at,
         COUNT(pli.id) as item_count,
         SUM(CASE WHEN pli.status = 'PICKED' THEN 1 ELSE 0 END) as items_picked
       FROM pick_lists pl
       LEFT JOIN pick_list_items pli ON pli.pick_list_id = pl.id
       WHERE pl.status = ANY($1::text[])
       GROUP BY pl.id
       ORDER BY pl.created_at ASC
       LIMIT $2 OFFSET $3`,
      [statuses, parseInt(limit as string), parseInt(offset as string)]
    );

    return res.json({
      pickLists: result.rows,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });
  } catch (error) {
    console.error('Pick list fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch pick lists' });
  }
});

/**
 * GET /api/pick-lists/:pickListId
 * Get detailed view of a specific pick list with all items
 */
router.get('/:pickListId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pickListId } = req.params;

    // Get pick list header
    const headerResult = await query(
      'SELECT * FROM pick_lists WHERE id = $1',
      [pickListId]
    );

    if (headerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pick list not found' });
    }

    const pickList = headerResult.rows[0];

    // Get items in pick list
    const itemsResult = await query(
      `SELECT 
         pli.*,
         wl.location_code,
         wl.bay_code,
         wl.bin_code
       FROM pick_list_items pli
       LEFT JOIN warehouse_locations wl ON wl.id = pli.picked_from_location_id
       WHERE pli.pick_list_id = $1
       ORDER BY pli.line_number`,
      [pickListId]
    );

    return res.json({
      pickList,
      items: itemsResult.rows,
    });
  } catch (error) {
    console.error('Pick list detail error:', error);
    return res.status(500).json({ error: 'Failed to fetch pick list details' });
  }
});

/**
 * POST /api/pick-lists
 * Create a new pick list from a Medusa order
 * 
 * Input: { medusaOrderId: "...", notes?: "..." }
 */
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { medusaOrderId, notes } = req.body;

    if (!medusaOrderId) {
      return res.status(400).json({ error: 'medusaOrderId required' });
    }

    // Check if pick list already exists
    const existingResult = await query(
      'SELECT id FROM pick_lists WHERE medusa_order_id = $1',
      [medusaOrderId]
    );

    if (existingResult.rows.length > 0) {
      return res.status(400).json({ error: 'Pick list already exists for this order' });
    }

    // Generate pick list number (e.g., PL-20260818-0001)
    const datePrefix = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const counterResult = await query(
      `SELECT COUNT(*) as count FROM pick_lists 
       WHERE pick_list_number LIKE $1`,
      [`PL-${datePrefix}-%`]
    );
    const pickNumber = `PL-${datePrefix}-${String(counterResult.rows[0].count + 1).padStart(4, '0')}`;

    // Create pick list
    const result = await query(
      `INSERT INTO pick_lists (id, medusa_order_id, pick_list_number, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [uuidv4(), medusaOrderId, pickNumber, notes || null]
    );

    return res.status(201).json({
      pickList: result.rows[0],
      message: `Pick list ${pickNumber} created`,
    });
  } catch (error) {
    console.error('Pick list creation error:', error);
    return res.status(500).json({ error: 'Failed to create pick list' });
  }
});

/**
 * POST /api/pick-lists/:pickListId/items
 * Add an item to a pick list
 * 
 * Input: {
 *   lineNumber: 1,
 *   productSku: "H2910NL",
 *   colourCode: "BLK",
 *   quantityRequired: 5
 * }
 */
router.post('/:pickListId/items', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pickListId } = req.params;
    const { lineNumber, productSku, colourCode, quantityRequired } = req.body;

    if (!lineNumber || !productSku || !quantityRequired) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await query(
      `INSERT INTO pick_list_items 
       (id, pick_list_id, line_number, product_sku, colour_code, quantity_required)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (pick_list_id, line_number) 
       DO UPDATE SET product_sku = $4, colour_code = $5, quantity_required = $6
       RETURNING *`,
      [uuidv4(), pickListId, lineNumber, productSku, colourCode || null, quantityRequired]
    );

    return res.json({
      item: result.rows[0],
      message: `Added line ${lineNumber}: ${productSku}`,
    });
  } catch (error) {
    console.error('Pick item error:', error);
    return res.status(500).json({ error: 'Failed to add pick item' });
  }
});

/**
 * PATCH /api/pick-lists/:pickListId/items/:itemId/pick
 * Mark an item as picked (scan to confirm)
 * 
 * Input: {
 *   quantityPicked: 5,
 *   pickedFromLocationCode: "A1",
 *   notes?: "Item damaged, substituted with..."
 * }
 */
router.patch('/:pickListId/items/:itemId/pick', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { itemId } = req.params;
    const { quantityPicked, pickedFromLocationCode, notes } = req.body;

    // Get location ID
    let locationId = null;
    if (pickedFromLocationCode) {
      const locResult = await query(
        'SELECT id FROM warehouse_locations WHERE location_code = $1',
        [pickedFromLocationCode]
      );
      if (locResult.rows.length > 0) {
        locationId = locResult.rows[0].id;
      }
    }

    // Update pick list item
    const result = await query(
      `UPDATE pick_list_items 
       SET status = 'PICKED', 
           quantity_picked = $1, 
           picked_from_location_id = $2,
           notes = $3,
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [quantityPicked, locationId, notes || null, itemId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pick item not found' });
    }

    // Update inventory (reserve the quantity)
    if (locationId && quantityPicked) {
      await query(
        `UPDATE warehouse_inventory 
         SET quantity_reserved = quantity_reserved + $1, updated_at = NOW()
         WHERE location_id = $2 AND product_sku = (
           SELECT product_sku FROM pick_list_items WHERE id = $3
         )`,
        [quantityPicked, locationId, itemId]
      );
    }

    return res.json({
      item: result.rows[0],
      message: `Picked ${quantityPicked} units`,
    });
  } catch (error) {
    console.error('Pick confirmation error:', error);
    return res.status(500).json({ error: 'Failed to confirm pick' });
  }
});

/**
 * PATCH /api/pick-lists/:pickListId/complete
 * Mark pick list as completed
 */
router.patch('/:pickListId/start', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pickListId } = req.params;
    const result = await query(
      `UPDATE pick_lists SET status = 'IN_PROGRESS', updated_at = NOW()
       WHERE id = $1 AND status = 'PENDING' RETURNING *`,
      [pickListId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pick list not found or already started' });
    }
    return res.json({ pickList: result.rows[0] });
  } catch (error) {
    console.error('Pick list start error:', error);
    return res.status(500).json({ error: 'Failed to start pick list' });
  }
});

router.patch('/:pickListId/complete', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pickListId } = req.params;
    const { notes } = req.body;

    const result = await query(
      `UPDATE pick_lists 
       SET status = 'PICKED', completed_at = NOW(), notes = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [notes || null, pickListId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pick list not found' });
    }

    return res.json({ pickList: result.rows[0], message: 'Pick list completed' });
  } catch (error) {
    console.error('Pick completion error:', error);
    return res.status(500).json({ error: 'Failed to complete pick list' });
  }
});

/**
 * PATCH /api/pick-lists/:pickListId/dispatch
 * Mark pick list as dispatched (items have physically left the warehouse).
 * Decrements warehouse_inventory.quantity, clears reservations, pushes to Medusa.
 * This is the only point where physical stock numbers change on outbound.
 */
router.patch('/:pickListId/dispatch', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pickListId } = req.params;

    const pickList = await query(`SELECT * FROM pick_lists WHERE id = $1`, [pickListId]);
    if (!pickList.rows[0]) return res.status(404).json({ error: 'Pick list not found' });
    if (!['PICKED', 'IN_PROGRESS'].includes(pickList.rows[0].status)) {
      return res.status(400).json({ error: 'Pick list must be PICKED or IN_PROGRESS to dispatch' });
    }

    // Get all picked items
    const items = await query(
      `SELECT pli.*, wi.location_id as inv_location_id
       FROM pick_list_items pli
       LEFT JOIN warehouse_inventory wi
         ON wi.product_sku = pli.product_sku
         AND wi.location_id = pli.picked_from_location_id
       WHERE pli.pick_list_id = $1 AND pli.quantity_picked > 0`,
      [pickListId]
    );

    const syncSkus = new Set<string>();

    for (const item of items.rows) {
      const sku = item.product_sku;
      const qty = parseInt(item.quantity_picked);
      const locationId = item.picked_from_location_id;
      if (!sku || !qty || !locationId) continue;

      // Decrement physical stock and clear the reservation
      await query(
        `UPDATE warehouse_inventory
         SET quantity = GREATEST(quantity - $1, 0),
             quantity_reserved = GREATEST(quantity_reserved - $1, 0),
             updated_at = NOW()
         WHERE product_sku = $2 AND location_id = $3`,
        [qty, sku, locationId]
      );
      syncSkus.add(sku);
    }

    // Mark pick list as dispatched
    await query(
      `UPDATE pick_lists SET status = 'DISPATCHED', dispatched_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [pickListId]
    );

    // Push new WMS totals to Medusa for all affected SKUs
    const syncErrors: string[] = [];
    for (const sku of syncSkus) {
      const totalResult = await query(
        `SELECT SUM(quantity) as total FROM warehouse_inventory WHERE product_sku = $1`,
        [sku]
      );
      const newTotal = parseInt(totalResult.rows[0]?.total ?? '0');
      const result = await syncSkuToMedusa(sku, newTotal);
      if (!result.ok) syncErrors.push(`${sku}: ${result.error}`);
    }

    res.json({
      success: true,
      dispatched: items.rows.length,
      skus_synced: syncSkus.size - syncErrors.length,
      sync_errors: syncErrors.length > 0 ? syncErrors : undefined,
    });
  } catch (error) {
    console.error('Pick list dispatch error:', error);
    res.status(500).json({ error: 'Failed to dispatch pick list' });
  }
});

/** DELETE /api/pick-lists/:pickListId — cancel a pending or in-progress pick list */
router.delete('/:pickListId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pickListId } = req.params;
    const existing = await query(`SELECT status FROM pick_lists WHERE id = $1`, [pickListId]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Pick list not found' });
    if (existing.rows[0].status === 'PICKED') {
      return res.status(400).json({ error: 'Cannot cancel a completed pick list' });
    }
    await query(
      `UPDATE pick_lists SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1`,
      [pickListId]
    );
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to cancel pick list' });
  }
});

export default router;
