/**
 * Reports API — real warehouse activity and KPIs.
 * GET /api/reports — complete summary (today's activity, order pipeline, stock health)
 * GET /api/reports/movements — paginated warehouse movement log
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';

const router = express.Router();

router.get('/', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    const [
      todayMovements,
      stockHealth,
      orderPipeline,
      checkinSummary,
      genoroSummary,
      skuCoverage,
      topMovedSkus,
    ] = await Promise.all([

      // Today's warehouse movements
      query(`
        SELECT
          COUNT(*) FILTER (WHERE movement_type = 'RECEIVE')::int  AS received,
          COUNT(*) FILTER (WHERE movement_type = 'PICK')::int     AS picked,
          COUNT(*) FILTER (WHERE movement_type = 'ADJUST')::int   AS adjusted,
          COALESCE(SUM(quantity) FILTER (WHERE movement_type = 'RECEIVE'), 0)::int AS units_received,
          COALESCE(SUM(ABS(quantity)) FILTER (WHERE movement_type = 'PICK'), 0)::int AS units_picked
        FROM warehouse_movements
        WHERE movement_date >= $1::date
      `, [today]),

      // Stock health
      query(`
        SELECT
          COUNT(DISTINCT product_sku)::int           AS unique_skus,
          COUNT(*)::int                              AS location_count,
          COALESCE(SUM(quantity), 0)::int            AS total_units,
          COALESCE(SUM(quantity_reserved), 0)::int   AS reserved_units,
          COALESCE(SUM(quantity_available), 0)::int  AS available_units
        FROM warehouse_inventory
        WHERE quantity > 0
      `),

      // Order pipeline
      query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'DRAFT')::int               AS draft,
          COUNT(*) FILTER (WHERE status = 'SUBMITTED')::int           AS submitted,
          COUNT(*) FILTER (WHERE status = 'ACKNOWLEDGED')::int        AS acknowledged,
          COUNT(*) FILTER (WHERE status = 'DISPATCHED')::int          AS dispatched,
          COUNT(*) FILTER (WHERE status = 'PARTIALLY_RECEIVED')::int  AS partially_received,
          COUNT(*) FILTER (WHERE status = 'RECEIVED')::int            AS received,
          COUNT(*)::int                                                AS total
        FROM supplier_orders
      `),

      // Check-in summary (last 30 days)
      query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'OPEN')::int       AS open_sessions,
          COUNT(*) FILTER (WHERE status = 'COMPLETE')::int   AS completed_sessions,
          COUNT(*) FILTER (WHERE status = 'COMPLETE' AND completed_at >= NOW() - INTERVAL '30 days')::int AS completed_30d
        FROM checkin_sessions
      `),

      // Genero open lines
      query(`
        SELECT
          COUNT(*)::int                                                      AS total_lines,
          COUNT(*) FILTER (WHERE bisley_order IS NOT NULL)::int              AS submitted_lines,
          COUNT(*) FILTER (WHERE est_delivery IS NOT NULL)::int              AS with_delivery_date,
          COUNT(*) FILTER (WHERE genero_status NOT IN ('Received','Cancelled','Complete','Delivered')
                           OR genero_status IS NULL)::int                    AS open_lines,
          MIN(est_delivery)                                                   AS next_delivery
        FROM genero_order_lines
      `),

      // SKU mapping coverage
      query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'VALIDATED')::int  AS validated,
          COUNT(*) FILTER (WHERE status = 'ASSUMED')::int    AS assumed,
          COUNT(*) FILTER (WHERE status = 'UNMAPPED')::int   AS unmapped,
          COUNT(*)::int                                       AS total
        FROM sku_mappings
      `),

      // Top 8 most moved SKUs (all time)
      query(`
        SELECT product_sku AS sku, colour_code, SUM(ABS(quantity))::int AS total_movements
        FROM warehouse_movements
        WHERE product_sku IS NOT NULL
        GROUP BY product_sku, colour_code
        ORDER BY total_movements DESC
        LIMIT 8
      `),
    ]);

    res.json({
      today: {
        date: today,
        ...todayMovements.rows[0],
      },
      stock: stockHealth.rows[0],
      orders: orderPipeline.rows[0],
      checkin: checkinSummary.rows[0],
      genero: genoroSummary.rows[0],
      sku_mappings: skuCoverage.rows[0],
      top_skus: topMovedSkus.rows,
    });
  } catch (err) {
    console.error('Reports error:', err);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

/** GET /api/reports/movements — recent warehouse movements log */
router.get('/movements', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) ?? '50');
    const offset = parseInt((req.query.offset as string) ?? '0');

    const result = await query(`
      SELECT
        m.id, m.movement_type, m.product_sku, m.colour_code,
        m.quantity, m.notes, m.movement_date,
        l.location_code, l.bay_code, l.bin_code
      FROM warehouse_movements m
      LEFT JOIN warehouse_locations l ON l.id = m.location_id
      ORDER BY m.movement_date DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const countResult = await query('SELECT COUNT(*)::int AS total FROM warehouse_movements');

    res.json({
      movements: result.rows,
      total: countResult.rows[0].total,
      limit,
      offset,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch movements' });
  }
});

export default router;
