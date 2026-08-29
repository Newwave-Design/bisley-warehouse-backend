/**
 * Discrepancy & Bay Assignment API — Phases 4 & 5
 *
 * Phase 4 — Discrepancies:
 * GET    /api/receiving/discrepancies           — List all flagged discrepancies
 * PATCH  /api/receiving/discrepancies/:id       — Accept or resolve with notes
 *
 * Phase 5 — Requires Location:
 * GET    /api/receiving/queue                   — Items awaiting bay assignment
 * GET    /api/receiving/locations               — Available warehouse bays
 * POST   /api/receiving/locations               — Create a new bay
 * PATCH  /api/receiving/queue/:id/assign        — Assign item to a bay
 * POST   /api/receiving/queue/:id/stock         — Mark stocked (moves to warehouse_inventory)
 * POST   /api/receiving/queue/bulk-stock        — Stock multiple items at once
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { syncSkuToMedusa } from '../../lib/medusa-inventory.js';

const router = express.Router();

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
       ON CONFLICT (location_code) DO NOTHING RETURNING *`,
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
    const item = await query(`SELECT * FROM requires_location_queue WHERE id = $1`, [req.params.id]);
    if (!item.rows[0]) return res.status(404).json({ error: 'Item not found' });
    if (!item.rows[0].location_id) return res.status(400).json({ error: 'Must assign a location first' });

    const { location_id, nw_code, colour, medusa_sku, quantity } = item.rows[0];

    // Upsert into warehouse_inventory
    await query(`
      INSERT INTO warehouse_inventory (location_id, product_sku, colour_code, quantity, created_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      ON CONFLICT (location_id, product_sku, colour_code)
      DO UPDATE SET quantity = warehouse_inventory.quantity + $4, updated_at = NOW()
    `, [location_id, medusa_sku || nw_code, colour || '', quantity]);

    await query(
      `UPDATE requires_location_queue SET status='STOCKED', stocked_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [req.params.id]
    );

    // Push WMS available (physical - reserved) to Medusa — no Medusa reservation needed
    const sku = medusa_sku || nw_code;
    const totalResult = await query(
      `SELECT SUM(quantity) as qty, SUM(quantity_reserved) as reserved FROM warehouse_inventory WHERE product_sku = $1`,
      [sku]
    );
    const newTotal = Math.max(0, parseInt(totalResult.rows[0]?.qty ?? '0') - parseInt(totalResult.rows[0]?.reserved ?? '0'));
    const syncResult = await syncSkuToMedusa(sku, newTotal);
    if (!syncResult.ok) {
      console.error(`[receiving/stock] Medusa sync failed for ${sku}: ${syncResult.error}`);
    }

    res.json({ success: true, stocked: quantity, location_id, medusa_synced: syncResult.ok, new_total: newTotal });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to stock item' });
  }
});

// Bulk stock — stock all ASSIGNED items in the queue
router.post('/queue/bulk-stock', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const assigned = await query(`SELECT * FROM requires_location_queue WHERE status = 'ASSIGNED'`);
    let stocked = 0;
    const syncedSkus = new Set<string>();

    for (const item of assigned.rows) {
      await query(`
        INSERT INTO warehouse_inventory (location_id, product_sku, colour_code, quantity, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (location_id, product_sku, colour_code)
        DO UPDATE SET quantity = warehouse_inventory.quantity + $4, updated_at = NOW()
      `, [item.location_id, item.medusa_sku || item.nw_code, item.colour || '', item.quantity]);

      await query(
        `UPDATE requires_location_queue SET status='STOCKED', stocked_at=NOW(), updated_at=NOW() WHERE id=$1`,
        [item.id]
      );
      syncedSkus.add(item.medusa_sku || item.nw_code);
      stocked++;
    }

    // Push updated totals for all affected SKUs to Medusa
    const syncErrors: string[] = [];
    for (const sku of syncedSkus) {
      const totalResult = await query(`SELECT SUM(quantity) as qty, SUM(quantity_reserved) as reserved FROM warehouse_inventory WHERE product_sku = $1`, [sku]);
      const newTotal = Math.max(0, parseInt(totalResult.rows[0]?.qty ?? '0') - parseInt(totalResult.rows[0]?.reserved ?? '0'));
      const syncResult = await syncSkuToMedusa(sku, newTotal);
      if (!syncResult.ok) syncErrors.push(`${sku}: ${syncResult.error}`);
    }
    if (syncErrors.length) console.error('[receiving/bulk-stock] Medusa sync errors:', syncErrors);

    res.json({ success: true, stocked, medusa_synced: syncedSkus.size - syncErrors.length, sync_errors: syncErrors.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to bulk stock' });
  }
});

// Bulk-generate bay locations (e.g. rows A-C, bins 1-10 = 30 bays)
router.post('/locations/generate', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { aisles = ['A'], rows_per_aisle = 5, bays_per_row = 10 } = req.body;
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
             ON CONFLICT (location_code) DO NOTHING`,
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

export default router;
