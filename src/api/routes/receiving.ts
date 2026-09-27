/**
 * Receiving & Bay Assignment API — Phases 4, 5, & 5.5
 *
 * Phase 4 — Discrepancies:
 * GET    /api/receiving/discrepancies           — List all flagged discrepancies
 * PATCH  /api/receiving/discrepancies/:id       — Accept or resolve with notes
 *
 * Phase 5.5 — Pallets (grouping items during scanning):
 * POST   /api/receiving/pallets                 — Create a new pallet (start pallet)
 * GET    /api/receiving/pallets                 — List all pallets (open + completed)
 * PATCH  /api/receiving/pallets/:id/add-item    — Add queue item to a pallet
 * PATCH  /api/receiving/pallets/:id/complete    — Mark pallet as completed (finalize)
 * PATCH  /api/receiving/pallets/:id/assign      — Assign entire pallet to a bay
 * POST   /api/receiving/pallets/:id/stock       — Stock entire pallet to warehouse_inventory
 *
 * Phase 5 — Requires Location (individual item mode):
 * GET    /api/receiving/queue                   — Items awaiting bay assignment
 * GET    /api/receiving/locations               — Available warehouse bays
 * POST   /api/receiving/locations               — Create a new bay
 * GET    /api/receiving/locations/:id/inventory — Products currently stocked in a bay
 * PATCH  /api/receiving/locations/:id           — Edit a bay's description/max weight
 * DELETE /api/receiving/locations/:id           — Remove an empty, unused bay
 * PATCH  /api/receiving/queue/:id/assign        — Assign item to a bay
 * POST   /api/receiving/queue/:id/stock         — Mark stocked (moves to warehouse_inventory)
 * POST   /api/receiving/queue/bulk-stock        — Stock multiple items at once
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, requirePermission, AuthRequest } from '../../middleware/auth.js';
import { syncSkuToMedusa } from '../../lib/medusa-inventory.js';
import { unblockBackorderedPickLists } from './pick-lists.js';
import { getLogger } from '../../lib/logger.js';
import { getProductDetails } from '../../lib/inventory-sync-service.js';

const router = express.Router();
const logger = getLogger('receiving');

/** Current default liability owner applied to newly received stock (Bisley by default). */
async function getDefaultLiabilityStatus(): Promise<string> {
  const result = await query(`SELECT value FROM wms_settings WHERE key = 'default_liability_status'`);
  return result.rows[0]?.value ?? 'Bisley';
}

/** Generate unique pallet code */
function generatePalletCode(): string {
  return `PALLET-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
}

// ================================================================================
// PHASE 5.5: PALLETS (Grouping items during receiving)
// ================================================================================

/** POST /api/receiving/pallets — Create a new pallet (start pallet) */
router.post('/pallets', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { session_id, order_id, notes } = req.body;
    const pallet_code = generatePalletCode();

    const result = await query(
      `INSERT INTO receiving_pallets (pallet_code, session_id, order_id, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       RETURNING *`,
      [pallet_code, session_id || null, order_id || null, notes || null]
    );

    logger.info(`[pallet] Created new pallet: ${pallet_code}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
    logger.error(`Failed to create pallet: ${errMsg}`);
    res.status(500).json({ error: 'Failed to create pallet' });
  }
});

/** GET /api/receiving/pallets — List all pallets */
router.get('/pallets', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { status = 'OPEN', limit = '50', offset = '0' } = req.query;

    const result = await query(
      `SELECT p.*, 
        COUNT(q.id) as item_count,
        COALESCE(SUM(q.quantity), 0) as total_qty
       FROM receiving_pallets p
       LEFT JOIN requires_location_queue q ON q.pallet_id = p.id
       WHERE p.status = $1
       GROUP BY p.id
       ORDER BY p.created_at DESC
       LIMIT $2 OFFSET $3`,
      [status, parseInt(limit as string), parseInt(offset as string)]
    );

    const countResult = await query(
      `SELECT COUNT(DISTINCT id) as count FROM receiving_pallets WHERE status = $1`,
      [status]
    );

    res.json({
      pallets: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pallets' });
  }
});

/** GET /api/receiving/pallets/:id — Get a specific pallet with items */
router.get('/pallets/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const pallet = await query(
      `SELECT p.*, 
        COUNT(q.id) as item_count,
        COALESCE(SUM(q.quantity), 0) as total_qty
       FROM receiving_pallets p
       LEFT JOIN requires_location_queue q ON q.pallet_id = p.id
       WHERE p.id = $1
       GROUP BY p.id`,
      [req.params.id]
    );

    if (!pallet.rows[0]) return res.status(404).json({ error: 'Pallet not found' });

    const items = await query(
      `SELECT * FROM requires_location_queue WHERE pallet_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );

    res.json({
      pallet: pallet.rows[0],
      items: items.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pallet' });
  }
});

/** PATCH /api/receiving/pallets/:id/add-item — Add queue item to pallet */
router.patch('/pallets/:id/add-item', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { queue_item_id } = req.body;
    if (!queue_item_id) return res.status(400).json({ error: 'queue_item_id required' });

    const pallet = await query(`SELECT * FROM receiving_pallets WHERE id = $1`, [req.params.id]);
    if (!pallet.rows[0]) return res.status(404).json({ error: 'Pallet not found' });
    if (pallet.rows[0].status !== 'OPEN') {
      return res.status(400).json({ error: 'Can only add items to OPEN pallets' });
    }

    const queueItem = await query(
      `SELECT * FROM requires_location_queue WHERE id = $1`,
      [queue_item_id]
    );
    if (!queueItem.rows[0]) return res.status(404).json({ error: 'Queue item not found' });

    // Update queue item with pallet_id
    const updated = await query(
      `UPDATE requires_location_queue 
       SET pallet_id = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [req.params.id, queue_item_id]
    );

    // Update pallet totals
    const totals = await query(
      `SELECT COUNT(*) as item_count, COALESCE(SUM(quantity), 0) as total_qty
       FROM requires_location_queue WHERE pallet_id = $1`,
      [req.params.id]
    );

    await query(
      `UPDATE receiving_pallets 
       SET total_items = $1, total_qty = $2, updated_at = NOW()
       WHERE id = $3`,
      [
        parseInt(totals.rows[0].item_count),
        parseInt(totals.rows[0].total_qty),
        req.params.id,
      ]
    );

    logger.info(`[pallet] Added item ${queueItem.rows[0].nw_code} to pallet ${pallet.rows[0].pallet_code}`);
    res.json(updated.rows[0]);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
    logger.error(`Failed to add item to pallet: ${errMsg}`);
    res.status(500).json({ error: 'Failed to add item to pallet' });
  }
});

/** PATCH /api/receiving/pallets/:id/complete — Mark pallet as completed */
router.patch('/pallets/:id/complete', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const pallet = await query(
      `SELECT * FROM receiving_pallets WHERE id = $1`,
      [req.params.id]
    );
    if (!pallet.rows[0]) return res.status(404).json({ error: 'Pallet not found' });
    if (pallet.rows[0].status !== 'OPEN') {
      return res.status(400).json({ error: 'Can only complete OPEN pallets' });
    }

    const result = await query(
      `UPDATE receiving_pallets 
       SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    const itemCount = result.rows[0].total_items;
    const itemQty = result.rows[0].total_qty;
    logger.info(`[pallet] Completed pallet ${pallet.rows[0].pallet_code} with ${itemCount} items (${itemQty} units)`);

    res.json(result.rows[0]);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
    logger.error(`Failed to complete pallet: ${errMsg}`);
    res.status(500).json({ error: 'Failed to complete pallet' });
  }
});

/** PATCH /api/receiving/pallets/:id/assign — Assign entire pallet to a bay */
router.patch('/pallets/:id/assign', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { location_id } = req.body;
    if (!location_id) return res.status(400).json({ error: 'location_id required' });

    const pallet = await query(
      `SELECT * FROM receiving_pallets WHERE id = $1`,
      [req.params.id]
    );
    if (!pallet.rows[0]) return res.status(404).json({ error: 'Pallet not found' });

    const loc = await query(
      `SELECT * FROM warehouse_locations WHERE id = $1 AND is_active = true`,
      [location_id]
    );
    if (!loc.rows[0]) return res.status(404).json({ error: 'Location not found' });

    // Assign all queue items in this pallet to the same location
    await query(
      `UPDATE requires_location_queue 
       SET location_id = $1, status = 'ASSIGNED', assigned_at = NOW(), assigned_by = $2, updated_at = NOW()
       WHERE pallet_id = $3`,
      [location_id, (req as any).user?.email || 'warehouse', req.params.id]
    );

    // Update pallet status
    const result = await query(
      `UPDATE receiving_pallets 
       SET location_id = $1, status = 'ASSIGNED', assigned_at = NOW(), assigned_by = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [location_id, (req as any).user?.email || 'warehouse', req.params.id]
    );

    logger.info(`[pallet] Assigned pallet ${pallet.rows[0].pallet_code} to location ${loc.rows[0].location_code}`);
    res.json(result.rows[0]);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
    logger.error(`Failed to assign pallet: ${errMsg}`);
    res.status(500).json({ error: 'Failed to assign pallet' });
  }
});

/** POST /api/receiving/pallets/:id/stock — Stock entire pallet to warehouse_inventory */
router.post('/pallets/:id/stock', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const pallet = await query(
      `SELECT * FROM receiving_pallets WHERE id = $1`,
      [req.params.id]
    );
    if (!pallet.rows[0]) return res.status(404).json({ error: 'Pallet not found' });
    if (!pallet.rows[0].location_id) {
      return res.status(400).json({ error: 'Pallet must be assigned to a location first' });
    }

    // Get all items in this pallet
    const items = await query(
      `SELECT * FROM requires_location_queue WHERE pallet_id = $1`,
      [req.params.id]
    );

    const defaultLiability = await getDefaultLiabilityStatus();
    let stocked = 0;
    const syncedSkus = new Set<string>();

    logger.info(`[pallet] Stocking pallet ${pallet.rows[0].pallet_code} with ${items.rows.length} items...`);

    for (const item of items.rows) {
      const sku = item.medusa_sku || item.nw_code;
      const productDetails = await getProductDetails(sku);
      const productDisplay = productDetails ? `${productDetails.name} (${productDetails.dimensions || 'n/a'})` : sku;

      // Insert into warehouse_inventory
      await query(
        `INSERT INTO warehouse_inventory (location_id, product_sku, colour_code, quantity, liability_status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (location_id, product_sku, COALESCE(colour_code, ''))
         DO UPDATE SET quantity = warehouse_inventory.quantity + $4, updated_at = NOW()`,
        [
          pallet.rows[0].location_id,
          sku,
          item.colour || '',
          item.quantity,
          defaultLiability,
        ]
      );

      // Mark queue item as stocked
      await query(
        `UPDATE requires_location_queue SET status = 'STOCKED', stocked_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [item.id]
      );

      syncedSkus.add(sku);
      stocked++;
      logger.info(`  ✓ ${item.quantity}x ${productDisplay}`);
    }

    // Push updated totals for all SKUs to Medusa
    const syncErrors: string[] = [];
    logger.info(`[pallet] Syncing ${syncedSkus.size} unique SKUs to Medusa...`);

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
        logger.error(`[pallet] Medusa sync failed: ${errMsg}`);
      } else {
        logger.info(`[pallet] ✓ Medusa sync: ${sku} → ${newTotal} units`);
      }
    }

    const unblocked = await unblockBackorderedPickLists([...syncedSkus]);
    if (unblocked && unblocked.length > 0) {
      logger.info(`[pallet] Unblocked ${unblocked.length} pick lists`);
    }

    // Mark pallet as stocked
    await query(
      `UPDATE receiving_pallets SET status = 'STOCKED', stocked_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    res.json({
      success: true,
      pallet_code: pallet.rows[0].pallet_code,
      stocked,
      medusa_synced: syncedSkus.size - syncErrors.length,
      sync_errors: syncErrors.length,
      unblocked_pick_lists: unblocked,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
    logger.error(`[pallet] Failed to stock pallet: ${errMsg}`);
    res.status(500).json({ error: 'Failed to stock pallet' });
  }
});

// ================================================================================
// PHASE 4: DISCREPANCIES
// ================================================================================

router.get('/discrepancies', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { status = 'FLAGGED', limit = '100', offset = '0' } = req.query;
    const result = await query(`
      SELECT d.*, s.created_at as session_date, o.order_number
      FROM checkin_discrepancies d
      LEFT JOIN checkin_sessions s ON s.id = d.session_id
      LEFT JOIN supplier_orders o ON o.id = d.order_id
      WHERE d.status = $1
      ORDER BY d.created_at DESC
      LIMIT $2 OFFSET $3
    `, [status, parseInt(limit as string), parseInt(offset as string)]);

    const countResult = await query(`SELECT COUNT(*) FROM checkin_discrepancies WHERE status = $1`, [status]);

    res.json({ discrepancies: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch discrepancies' });
  }
});

router.patch('/discrepancies/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { status, resolution_notes } = req.body;
    if (!['ACCEPTED', 'RESOLVED'].includes(status)) {
      return res.status(400).json({ error: 'status must be ACCEPTED or RESOLVED' });
    }
    const result = await query(
      `UPDATE checkin_discrepancies SET status=$1, resolution_notes=$2, updated_at=NOW() WHERE id=$3 RETURNING *`,
      [status, resolution_notes || null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Discrepancy not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update discrepancy' });
  }
});

// ================================================================================
// PHASE 5: REQUIRES LOCATION QUEUE
// ================================================================================

router.get('/queue', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { status = 'PENDING' } = req.query;
    const result = await query(`
      SELECT q.*, o.order_number, l.location_code, l.description as location_description
      FROM requires_location_queue q
      LEFT JOIN supplier_orders o ON o.id = q.order_id
      LEFT JOIN warehouse_locations l ON l.id = q.location_id
      WHERE q.status = $1
      ORDER BY q.created_at ASC
    `, [status]);

    const stats = await query(`
      SELECT status, COUNT(*) as count, SUM(quantity) as total_units
      FROM requires_location_queue
      GROUP BY status
    `);

    res.json({ queue: result.rows, stats: stats.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch queue' });
  }
});

router.get('/locations', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(`
      SELECT l.*,
        COUNT(q.id) as pending_items,
        COALESCE(SUM(i.quantity), 0) as current_stock
      FROM warehouse_locations l
      LEFT JOIN requires_location_queue q ON q.location_id = l.id AND q.status = 'PENDING'
      LEFT JOIN warehouse_inventory i ON i.location_id = l.id
      WHERE l.is_active = true
      GROUP BY l.id
      ORDER BY l.bay_code, l.bin_code
    `);
    res.json({ locations: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch locations' });
  }
});

router.post('/locations', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { aisle_code, bay_code, bin_code, description } = req.body;
    if (!bay_code || !bin_code) return res.status(400).json({ error: 'bay_code and bin_code required' });

    const aisle = aisle_code ? String(aisle_code).toUpperCase() : null;
    const row   = String(bay_code).toUpperCase();
    const bay   = String(bin_code).toUpperCase();
    const location_code = aisle ? `${aisle}-${row}-${bay}` : `${row}-${bay}`;

    const result = await query(
      `INSERT INTO warehouse_locations (aisle_code, bay_code, bin_code, location_code, description, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (location_code) DO UPDATE SET is_active = true, updated_at = NOW()
         WHERE warehouse_locations.is_active = false
       RETURNING *`,
      [aisle, row, bay, location_code, description || (aisle ? `Aisle ${aisle}, Row ${row}, Bay ${bay}` : `Row ${row}, Bay ${bay}`)]
    );
    if (!result.rows[0]) return res.status(409).json({ error: 'Location already exists' });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create location' });
  }
});

router.patch('/queue/:id/assign', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { location_id } = req.body;
    if (!location_id) return res.status(400).json({ error: 'location_id required' });

    // Verify location exists
    const loc = await query(`SELECT * FROM warehouse_locations WHERE id = $1 AND is_active = true`, [location_id]);
    if (!loc.rows[0]) return res.status(404).json({ error: 'Location not found' });

    const result = await query(
      `UPDATE requires_location_queue
       SET location_id=$1, status='ASSIGNED', assigned_by=$2, assigned_at=NOW(), updated_at=NOW()
       WHERE id=$3 AND status='PENDING' RETURNING *`,
      [location_id, (req as any).user?.email || 'warehouse', req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Queue item not found or already assigned' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to assign location' });
  }
});

// Stock a single item — moves from queue to warehouse_inventory
router.post('/queue/:id/stock', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const itemId = req.params.id;
    const item = await query(`SELECT * FROM requires_location_queue WHERE id = $1`, [itemId]);
    if (!item.rows[0]) return res.status(404).json({ error: 'Item not found' });
    if (!item.rows[0].location_id) return res.status(400).json({ error: 'Must assign a location first' });

    const { location_id, nw_code, colour, medusa_sku, quantity } = item.rows[0];
    const sku = medusa_sku || nw_code;
    const defaultLiability = await getDefaultLiabilityStatus();

    // Fetch product details for richer logging
    const productDetails = await getProductDetails(sku);
    const productDisplay = productDetails ? `${productDetails.name} (${productDetails.dimensions || 'unknown dims'})` : sku;

    logger.info(`Receiving ${quantity}x ${productDisplay}, colour: ${colour || 'default'}, location: ${location_id}`);

    // Upsert into warehouse_inventory
    await query(`
      INSERT INTO warehouse_inventory (location_id, product_sku, colour_code, quantity, liability_status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      ON CONFLICT (location_id, product_sku, COALESCE(colour_code, ''))
      DO UPDATE SET quantity = warehouse_inventory.quantity + $4, updated_at = NOW()
    `, [location_id, sku, colour || '', quantity, defaultLiability]);

    logger.info(`✓ Stocked: ${quantity}x ${productDisplay}`);

    await query(
      `UPDATE requires_location_queue SET status='STOCKED', stocked_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [itemId]
    );

    // Push WMS available (physical - reserved) to Medusa — no Medusa reservation needed
    const totalResult = await query(
      `SELECT SUM(quantity) as qty, SUM(quantity_reserved) as reserved FROM warehouse_inventory WHERE product_sku = $1`,
      [sku]
    );
    const newTotal = Math.max(0, parseInt(totalResult.rows[0]?.qty ?? '0') - parseInt(totalResult.rows[0]?.reserved ?? '0'));
    
    logger.info(`Pushing to Medusa: ${productDisplay} → ${newTotal} units available`);
    const syncResult = await syncSkuToMedusa(sku, newTotal);
    
    if (!syncResult.ok) {
      logger.error(`❌ Medusa sync failed: ${syncResult.error}`);
    } else {
      logger.info(`✅ Medusa synced: ${productDisplay} now at ${newTotal} units`);
    }
    
    const unblocked = await unblockBackorderedPickLists([sku]);
    if (unblocked && unblocked.length > 0) {
      logger.info(`Unblocked ${unblocked.length} pick lists for ${sku}`);
    }

    res.json({ 
      success: true, 
      stocked: quantity, 
      location_id, 
      medusa_synced: syncResult.ok, 
      new_total: newTotal, 
      unblocked_pick_lists: unblocked 
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
    logger.error(`Stock endpoint error: ${errMsg}`);
    res.status(500).json({ error: 'Failed to stock item' });
  }
});

// Bulk stock — stock all ASSIGNED items in the queue
router.post('/queue/bulk-stock', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const assigned = await query(`SELECT * FROM requires_location_queue WHERE status = 'ASSIGNED'`);
    let stocked = 0;
    const syncedSkus = new Set<string>();
    const defaultLiability = await getDefaultLiabilityStatus();

    logger.info(`Bulk-stocking ${assigned.rows.length} items...`);

    for (const item of assigned.rows) {
      const sku = item.medusa_sku || item.nw_code;
      const productDetails = await getProductDetails(sku);
      const productDisplay = productDetails ? `${productDetails.name} (${productDetails.dimensions || 'n/a'})` : sku;

      await query(`
        INSERT INTO warehouse_inventory (location_id, product_sku, colour_code, quantity, liability_status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
        ON CONFLICT (location_id, product_sku, COALESCE(colour_code, ''))
        DO UPDATE SET quantity = warehouse_inventory.quantity + $4, updated_at = NOW()
      `, [item.location_id, sku, item.colour || '', item.quantity, defaultLiability]);

      await query(
        `UPDATE requires_location_queue SET status='STOCKED', stocked_at=NOW(), updated_at=NOW() WHERE id=$1`,
        [item.id]
      );
      syncedSkus.add(sku);
      stocked++;
      logger.info(`  ✓ ${item.quantity}x ${productDisplay}`);
    }

    // Push updated totals for all affected SKUs to Medusa
    const syncErrors: string[] = [];
    logger.info(`Syncing ${syncedSkus.size} unique SKUs to Medusa...`);
    
    for (const sku of syncedSkus) {
      const totalResult = await query(`SELECT SUM(quantity) as qty, SUM(quantity_reserved) as reserved FROM warehouse_inventory WHERE product_sku = $1`, [sku]);
      const newTotal = Math.max(0, parseInt(totalResult.rows[0]?.qty ?? '0') - parseInt(totalResult.rows[0]?.reserved ?? '0'));
      const syncResult = await syncSkuToMedusa(sku, newTotal);
      if (!syncResult.ok) {
        const errMsg = `${sku}: ${syncResult.error}`;
        syncErrors.push(errMsg);
        logger.error(`Medusa sync failed: ${errMsg}`);
      } else {
        logger.info(`✓ Medusa sync: ${sku} → ${newTotal} units`);
      }
    }
    
    const unblocked = await unblockBackorderedPickLists([...syncedSkus]);
    if (unblocked && unblocked.length > 0) {
      logger.info(`Unblocked ${unblocked.length} pick lists`);
    }

    res.json({ success: true, stocked, medusa_synced: syncedSkus.size - syncErrors.length, sync_errors: syncErrors.length, unblocked_pick_lists: unblocked });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
    logger.error(`Bulk-stock endpoint error: ${errMsg}`);
    res.status(500).json({ error: 'Failed to bulk stock' });
  }
});

// Bulk-generate bay locations (e.g. rows A-C, bins 1-10 = 30 bays)
router.post('/locations/generate', authMiddleware, requirePermission('system_admin'), async (req: AuthRequest, res: Response) => {
  try {
    const { aisles = ['A'], rows_per_aisle = 5, bays_per_row = 10 } = req.body;
    if (!Array.isArray(aisles) || aisles.length === 0 || aisles.length > 10) {
      return res.status(400).json({ error: 'aisles must be a non-empty array of at most 10' });
    }
    if (!Number.isInteger(rows_per_aisle) || rows_per_aisle < 1 || rows_per_aisle > 100) {
      return res.status(400).json({ error: 'rows_per_aisle must be an integer between 1 and 100' });
    }
    if (!Number.isInteger(bays_per_row) || bays_per_row < 1 || bays_per_row > 100) {
      return res.status(400).json({ error: 'bays_per_row must be an integer between 1 and 100' });
    }
    let created = 0, skipped = 0;

    for (const aisle of aisles) {
      const aisle_code = String(aisle).toUpperCase();
      for (let row = 1; row <= rows_per_aisle; row++) {
        const bay_code = String(row);
        for (let bay = 1; bay <= bays_per_row; bay++) {
          const bin_code = String(bay).padStart(2, '0');
          const location_code = `${aisle_code}-${bay_code}-${bin_code}`;
          const result = await query(
            `INSERT INTO warehouse_locations (aisle_code, bay_code, bin_code, location_code, description, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
             ON CONFLICT (location_code) DO UPDATE SET is_active = true, updated_at = NOW()
               WHERE warehouse_locations.is_active = false`,
            [aisle_code, bay_code, bin_code, location_code, `Aisle ${aisle_code}, Row ${bay_code}, Bay ${bin_code}`]
          );
          if (result.rowCount && result.rowCount > 0) created++;
          else skipped++;
        }
      }
    }

    const total = aisles.length * rows_per_aisle * bays_per_row;
    res.json({ success: true, created, skipped, total });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate bays' });
  }
});

/** GET /api/receiving/locations/:id/inventory — products currently stocked in this bay */
router.get('/locations/:id/inventory', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(`
      SELECT wi.id, wi.product_sku, wi.colour_code, wi.quantity, wi.quantity_reserved, wi.quantity_available,
        wi.liability_status, wi.last_counted_at,
        wp.product_title, wp.variant_title, wp.colour_name, wp.variant_thumbnail
      FROM warehouse_inventory wi
      LEFT JOIN wms_products wp ON wp.variant_sku = wi.product_sku
      WHERE wi.location_id = $1
      ORDER BY COALESCE(wp.product_title, wi.product_sku)
    `, [req.params.id]);
    res.json({ items: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bay inventory' });
  }
});

/** PATCH /api/receiving/locations/:id — edit a bay's description / max weight */
router.patch('/locations/:id', authMiddleware, requirePermission('system_admin'), async (req: AuthRequest, res: Response) => {
  try {
    const { description, max_weight_kg } = req.body;
    const weight = max_weight_kg === '' || max_weight_kg === undefined || max_weight_kg === null ? null : Number(max_weight_kg);
    if (weight !== null && (!Number.isFinite(weight) || weight < 0)) {
      return res.status(400).json({ error: 'max_weight_kg must be a positive number' });
    }
    const result = await query(
      `UPDATE warehouse_locations SET description=$1, max_weight_kg=$2, updated_at=NOW() WHERE id=$3 AND is_active=true RETURNING *`,
      [description || null, weight, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Location not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update location' });
  }
});

/** DELETE /api/receiving/locations/:id — remove an empty, unused bay (soft delete) */
router.delete('/locations/:id', authMiddleware, requirePermission('system_admin'), async (req: AuthRequest, res: Response) => {
  try {
    const stock = await query(`SELECT COALESCE(SUM(quantity), 0)::int AS qty FROM warehouse_inventory WHERE location_id = $1`, [req.params.id]);
    if (stock.rows[0].qty > 0) {
      return res.status(400).json({ error: 'Cannot remove a bay that still has stock — clear or move it first' });
    }
    const pending = await query(`SELECT COUNT(*)::int AS n FROM requires_location_queue WHERE location_id = $1 AND status != 'STOCKED'`, [req.params.id]);
    if (pending.rows[0].n > 0) {
      return res.status(400).json({ error: 'Cannot remove a bay with items still awaiting assignment/stocking' });
    }
    const result = await query(`UPDATE warehouse_locations SET is_active=false, updated_at=NOW() WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Location not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove location' });
  }
});

/** DELETE /api/receiving/queue/:id — remove a pending item from the bay assignment queue */
router.delete('/queue/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const existing = await query(`SELECT status FROM requires_location_queue WHERE id = $1`, [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Queue item not found' });
    if (existing.rows[0].status === 'STOCKED') {
      return res.status(400).json({ error: 'Cannot remove an already stocked item' });
    }
    await query(`DELETE FROM requires_location_queue WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove queue item' });
  }
});

/**
 * PATCH /api/receiving/inventory/liability — manually correct/reassign the liability owner
 * for existing stock (e.g. after the 3-month Bisley period ends and you tell us to switch a SKU).
 * Body: { product_sku, liability_status: 'Bisley' | 'Ovara' }
 */
router.patch('/inventory/liability', authMiddleware, requirePermission('manage_settings'), async (req: AuthRequest, res: Response) => {
  try {
    const { product_sku, liability_status } = req.body;
    if (!product_sku || !['Bisley', 'Ovara'].includes(liability_status)) {
      return res.status(400).json({ error: "product_sku and liability_status ('Bisley' or 'Ovara') are required" });
    }
    const result = await query(
      `UPDATE warehouse_inventory SET liability_status = $1, updated_at = NOW() WHERE product_sku = $2 RETURNING id`,
      [liability_status, product_sku]
    );
    res.json({ success: true, updated_rows: result.rowCount ?? 0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update liability status' });
  }
});

/**
 * GET /api/receiving/audit/logs — query recent receiving & Medusa sync activities
 * Query params:
 *   - limit: max results (default 50, max 500)
 *   - offset: pagination offset (default 0)
 *   - status: filter by sync status (PENDING, SYNCED, FAILED, SKIPPED)
 *   - sku: filter by product_sku (contains search)
 *
 * Returns inventory_sync_log entries with product name, dimensions, and Medusa sync details
 */
router.get('/audit/logs', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as string;
    const sku = req.query.sku as string;

    let whereClause = '1=1';
    const params: any[] = [];

    if (status) {
      whereClause += ` AND status = $${params.length + 1}`;
      params.push(status);
    }

    if (sku) {
      whereClause += ` AND product_sku ILIKE $${params.length + 1}`;
      params.push(`%${sku}%`);
    }

    const result = await query(
      `SELECT 
        id,
        product_sku,
        product_name,
        product_dimensions,
        medusa_variant_id,
        medusa_product_id,
        available_qty,
        status,
        error_message,
        created_at,
        updated_at
       FROM inventory_sync_log
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    const countResult = await query(
      `SELECT COUNT(*) FROM inventory_sync_log WHERE ${whereClause}`,
      params
    );

    res.json({
      logs: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit,
      offset,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
    logger.error(`Audit logs endpoint error: ${errMsg}`);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

/**
 * GET /api/receiving/audit/summary — quick summary of recent activity
 * Returns:
 *   - total_received_today: sum of quantities received in last 24h
 *   - synced_skus_count: unique SKUs synced to Medusa today
 *   - failed_syncs_count: number of failed Medusa syncs
 *   - avg_sync_time_seconds: average time between receive and sync (approximation)
 */
router.get('/audit/summary', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const summary = await query(
      `SELECT
        (SELECT COALESCE(SUM(quantity), 0) FROM warehouse_inventory WHERE updated_at > NOW() - INTERVAL '24 hours') as total_received_24h,
        (SELECT COUNT(DISTINCT product_sku) FROM inventory_sync_log WHERE created_at > NOW() - INTERVAL '24 hours' AND status = 'SYNCED') as synced_skus_count,
        (SELECT COUNT(*) FROM inventory_sync_log WHERE created_at > NOW() - INTERVAL '24 hours' AND status = 'FAILED') as failed_syncs_count,
        (SELECT ROUND(EXTRACT(EPOCH FROM AVG(updated_at - created_at))) FROM inventory_sync_log WHERE created_at > NOW() - INTERVAL '24 hours' AND status = 'SYNCED') as avg_sync_time_seconds`
    );

    const { total_received_24h, synced_skus_count, failed_syncs_count, avg_sync_time_seconds } = summary.rows[0];

    res.json({
      period: 'last 24 hours',
      total_received_qty: parseInt(total_received_24h) || 0,
      synced_skus_count: parseInt(synced_skus_count) || 0,
      failed_syncs_count: parseInt(failed_syncs_count) || 0,
      avg_sync_time_seconds: parseInt(avg_sync_time_seconds) || null,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
    logger.error(`Audit summary endpoint error: ${errMsg}`);
    res.status(500).json({ error: 'Failed to fetch audit summary' });
  }
});

// ================================================================================
// PHASE 5.5: NEW PALLET OPERATIONS (Pallet-focused scanning workflow)
// ================================================================================

/** GET /api/receiving/pallets/number/:number — Get pallet by auto-incremented number */
router.get('/pallets/number/:number', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const pallet = await query(
      `SELECT p.*, 
        COUNT(q.id) as item_count,
        COALESCE(SUM(q.quantity), 0) as total_qty
       FROM receiving_pallets p
       LEFT JOIN requires_location_queue q ON q.pallet_id = p.id
       WHERE p.pallet_number = $1
       GROUP BY p.id`,
      [parseInt(req.params.number)]
    );

    if (!pallet.rows[0]) return res.status(404).json({ error: `Pallet #${req.params.number} not found` });

    const items = await query(
      `SELECT * FROM requires_location_queue WHERE pallet_id = $1 ORDER BY created_at ASC`,
      [pallet.rows[0].id]
    );

    res.json({
      pallet: pallet.rows[0],
      items: items.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pallet' });
  }
});

/** POST /api/receiving/pallets/:id/add-queue-item — Create queue item and add to pallet */
router.post('/pallets/:id/add-queue-item', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { nw_code, colour, quantity, session_id, order_id } = req.body;
    if (!nw_code || !quantity) {
      return res.status(400).json({ error: 'nw_code and quantity required' });
    }

    const pallet = await query(`SELECT * FROM receiving_pallets WHERE id = $1`, [req.params.id]);
    if (!pallet.rows[0]) return res.status(404).json({ error: 'Pallet not found' });
    if (pallet.rows[0].status !== 'OPEN') {
      return res.status(400).json({ error: 'Can only add items to OPEN pallets' });
    }

    // Create queue item
    const queueItem = await query(
      `INSERT INTO requires_location_queue 
       (nw_code, colour, quantity, pallet_id, session_id, order_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       RETURNING *`,
      [nw_code, colour || null, quantity, req.params.id, session_id || null, order_id || null]
    );

    // Update pallet totals
    const totals = await query(
      `SELECT COUNT(*) as item_count, COALESCE(SUM(quantity), 0) as total_qty
       FROM requires_location_queue WHERE pallet_id = $1`,
      [req.params.id]
    );

    await query(
      `UPDATE receiving_pallets 
       SET total_items = $1, total_qty = $2, updated_at = NOW()
       WHERE id = $3`,
      [
        parseInt(totals.rows[0].item_count),
        parseInt(totals.rows[0].total_qty),
        req.params.id,
      ]
    );

    logger.info(`[pallet] Added ${nw_code} (qty: ${quantity}) to pallet #${pallet.rows[0].pallet_number}`);
    res.status(201).json(queueItem.rows[0]);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
    logger.error(`Failed to add queue item to pallet: ${errMsg}`);
    res.status(500).json({ error: 'Failed to add item to pallet' });
  }
});

/** PATCH /api/receiving/queue/:id/move-to-pallet/:pallet_number — Move item to a pallet */
router.patch('/queue/:id/move-to-pallet/:pallet_number', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const queueItem = await query(
      `SELECT * FROM requires_location_queue WHERE id = $1`,
      [req.params.id]
    );
    if (!queueItem.rows[0]) return res.status(404).json({ error: 'Queue item not found' });

    const pallet = await query(
      `SELECT * FROM receiving_pallets WHERE pallet_number = $1`,
      [parseInt(req.params.pallet_number)]
    );
    if (!pallet.rows[0]) return res.status(404).json({ error: `Pallet #${req.params.pallet_number} not found` });
    if (pallet.rows[0].status !== 'OPEN') {
      return res.status(400).json({ error: 'Can only add items to OPEN pallets' });
    }

    // Move item to new pallet
    const updated = await query(
      `UPDATE requires_location_queue 
       SET pallet_id = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [pallet.rows[0].id, req.params.id]
    );

    // Update totals for OLD pallet (if it had one)
    if (queueItem.rows[0].pallet_id) {
      const oldTotals = await query(
        `SELECT COUNT(*) as item_count, COALESCE(SUM(quantity), 0) as total_qty
         FROM requires_location_queue WHERE pallet_id = $1`,
        [queueItem.rows[0].pallet_id]
      );

      await query(
        `UPDATE receiving_pallets 
         SET total_items = $1, total_qty = $2, updated_at = NOW()
         WHERE id = $3`,
        [
          parseInt(oldTotals.rows[0].item_count),
          parseInt(oldTotals.rows[0].total_qty),
          queueItem.rows[0].pallet_id,
        ]
      );
    }

    // Update totals for NEW pallet
    const newTotals = await query(
      `SELECT COUNT(*) as item_count, COALESCE(SUM(quantity), 0) as total_qty
       FROM requires_location_queue WHERE pallet_id = $1`,
      [pallet.rows[0].id]
    );

    await query(
      `UPDATE receiving_pallets 
       SET total_items = $1, total_qty = $2, updated_at = NOW()
       WHERE id = $3`,
      [
        parseInt(newTotals.rows[0].item_count),
        parseInt(newTotals.rows[0].total_qty),
        pallet.rows[0].id,
      ]
    );

    logger.info(`[pallet] Moved ${queueItem.rows[0].nw_code} to pallet #${pallet.rows[0].pallet_number}`);
    res.json(updated.rows[0]);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
    logger.error(`Failed to move item to pallet: ${errMsg}`);
    res.status(500).json({ error: 'Failed to move item to pallet' });
  }
});

/** PATCH /api/receiving/queue/:id/move-to-bay — Move item directly to bay (remove from pallet if any) */
router.patch('/queue/:id/move-to-bay', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { location_id } = req.body;
    if (!location_id) return res.status(400).json({ error: 'location_id required' });

    const queueItem = await query(
      `SELECT * FROM requires_location_queue WHERE id = $1`,
      [req.params.id]
    );
    if (!queueItem.rows[0]) return res.status(404).json({ error: 'Queue item not found' });

    const loc = await query(
      `SELECT * FROM warehouse_locations WHERE id = $1 AND is_active = true`,
      [location_id]
    );
    if (!loc.rows[0]) return res.status(404).json({ error: 'Location not found' });

    // Move to bay
    const updated = await query(
      `UPDATE requires_location_queue 
       SET location_id = $1, status = 'ASSIGNED', pallet_id = NULL, 
           assigned_at = NOW(), assigned_by = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [location_id, (req as any).user?.email || 'warehouse', req.params.id]
    );

    // Update pallet totals if item was in one
    if (queueItem.rows[0].pallet_id) {
      const totals = await query(
        `SELECT COUNT(*) as item_count, COALESCE(SUM(quantity), 0) as total_qty
         FROM requires_location_queue WHERE pallet_id = $1`,
        [queueItem.rows[0].pallet_id]
      );

      await query(
        `UPDATE receiving_pallets 
         SET total_items = $1, total_qty = $2, updated_at = NOW()
         WHERE id = $3`,
        [
          parseInt(totals.rows[0].item_count),
          parseInt(totals.rows[0].total_qty),
          queueItem.rows[0].pallet_id,
        ]
      );
    }

    logger.info(`[pallet] Moved ${queueItem.rows[0].nw_code} to bay ${loc.rows[0].location_code} (removed from pallet)`);
    res.json(updated.rows[0]);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
    logger.error(`Failed to move item to bay: ${errMsg}`);
    res.status(500).json({ error: 'Failed to move item to bay' });
  }
});

export default router;
