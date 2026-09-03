/**
 * Dashboard API — real-time stats from the WMS database.
 * GET /api/dashboard — returns counts for all key entities.
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';

const router = express.Router();

router.get('/', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const [
      products,
      orders,
      checkin,
      requiresLocation,
      pickLists,
      skuMappings,
      inventory,
    ] = await Promise.all([
      query(`SELECT
               COUNT(DISTINCT medusa_product_id)::int AS total_products,
               COUNT(*)::int                          AS total_variants,
               COUNT(*) FILTER (WHERE is_kit)::int    AS kit_variants,
               MAX(last_synced_at)                    AS last_synced_at
             FROM wms_products`),
      query(`SELECT
               COUNT(*) FILTER (WHERE status = 'DRAFT')::int      AS draft,
               COUNT(*) FILTER (WHERE status = 'SUBMITTED')::int  AS submitted,
               COUNT(*) FILTER (WHERE status = 'DISPATCHED')::int AS dispatched,
               COUNT(*)::int                                       AS total
             FROM supplier_orders`),
      query(`SELECT
               COUNT(*) FILTER (WHERE status = 'OPEN')::int       AS open_sessions,
               COUNT(*) FILTER (WHERE status = 'COMPLETE')::int   AS completed_sessions
             FROM checkin_sessions`),
      query(`SELECT
               COUNT(*) FILTER (WHERE status = 'PENDING')::int  AS pending,
               COUNT(*) FILTER (WHERE status = 'ASSIGNED')::int AS assigned
             FROM requires_location_queue`),
      query(`SELECT
               COUNT(*) FILTER (WHERE status = 'PENDING')::int     AS pending,
               COUNT(*) FILTER (WHERE status = 'IN_PROGRESS')::int AS in_progress,
               COUNT(*) FILTER (WHERE status = 'PICKED')::int      AS picked
             FROM pick_lists`),
      query(`SELECT
               COUNT(*) FILTER (WHERE status = 'VALIDATED')::int AS validated,
               COUNT(*) FILTER (WHERE status = 'UNMAPPED')::int  AS unmapped,
               COUNT(*)::int                                      AS total
             FROM sku_mappings`), // LEGACY/PAUSED (2026-09-03) - table wiped, stats will read 0
      query(`SELECT
               COUNT(*)::int          AS locations_in_use,
               COALESCE(SUM(quantity), 0)::int AS total_units
             FROM warehouse_inventory
             WHERE quantity > 0`),
    ]);

    res.json({
      products: products.rows[0],
      orders: orders.rows[0],
      checkin: checkin.rows[0],
      requires_location: requiresLocation.rows[0],
      pick_lists: pickLists.rows[0],
      sku_mappings: skuMappings.rows[0], // LEGACY/PAUSED (2026-09-03)
      inventory: inventory.rows[0],
    });
  } catch (err) {
    console.error('Dashboard stats error:', err);
    res.status(500).json({ error: 'Failed to load dashboard stats' });
  }
});

export default router;
