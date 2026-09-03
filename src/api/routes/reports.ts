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

      // SKU mapping coverage — sku_mappings is LEGACY/PAUSED (expected to be empty until
      // Genero is connected); the Reports UI already renders a "paused" message for this.
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

/** Escapes a value for a CSV cell (quotes if it contains a comma, quote or newline). */
function toCsvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.join(',');
  const body = rows.map(r => columns.map(c => toCsvCell(r[c])).join(','));
  return [header, ...body].join('\n');
}

/** Default to the last 7 days when no date range is given. */
function resolveDateRange(from?: string, to?: string): { from: string; to: string } {
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from: fromDate.toISOString().split('T')[0], to: toDate.toISOString().split('T')[0] };
}

/**
 * GET /api/reports/weekly-sku-summary?from=&to=&liability=Bisley|Ovara&format=csv|json
 * SKU-level breakdown of what was sold (dispatched) in the date range, for the weekly
 * reconciliation/invoicing report sent to Bisley. Liability status is the value stamped
 * on each pick_list_item at dispatch time — not the current default.
 */
router.get('/weekly-sku-summary', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = resolveDateRange(req.query.from as string, req.query.to as string);
    const liability = (req.query.liability as string) || null;
    const format = (req.query.format as string) || 'json';

    const result = await query(`
      SELECT
        pli.product_sku AS sku,
        COALESCE(wp.product_title, sm.product_name)         AS product_name,
        COALESCE(wp.colour_name, sm.colour, pli.colour_code) AS colour,
        pli.liability_status                                 AS liability_status,
        SUM(pli.quantity_picked)::int                        AS qty_sold,
        ROUND(AVG(pli.unit_cost_gbp), 2)                     AS unit_cost_gbp,
        ROUND(AVG(pli.unit_price_gbp), 2)                    AS unit_price_gbp,
        ROUND(SUM(pli.quantity_picked * COALESCE(pli.unit_cost_gbp, 0)), 2)  AS total_cost_gbp,
        ROUND(SUM(pli.quantity_picked * COALESCE(pli.unit_price_gbp, 0)), 2) AS total_sales_value_gbp,
        ROUND(SUM(pli.quantity_picked * COALESCE(pli.unit_price_gbp, 0))
            - SUM(pli.quantity_picked * COALESCE(pli.unit_cost_gbp, 0)), 2)  AS gross_margin_gbp
      FROM pick_list_items pli
      JOIN pick_lists pl ON pl.id = pli.pick_list_id
      LEFT JOIN wms_products wp ON wp.variant_sku = pli.product_sku
      -- sku_mappings is LEGACY/PAUSED (empty) - product_name/colour fall back to wp.* anyway
      LEFT JOIN sku_mappings sm ON sm.medusa_sku = pli.product_sku
      WHERE pl.status = 'DISPATCHED'
        AND pl.dispatched_at::date BETWEEN $1 AND $2
        AND pli.is_sandbox = false
        AND ($3::varchar IS NULL OR pli.liability_status = $3)
      GROUP BY pli.product_sku, wp.product_title, sm.product_name, wp.colour_name, sm.colour, pli.colour_code, pli.liability_status
      ORDER BY sku
    `, [from, to, liability]);

    if (format === 'csv') {
      const csv = toCsv(result.rows, ['sku', 'product_name', 'colour', 'liability_status', 'qty_sold',
        'unit_cost_gbp', 'unit_price_gbp', 'total_cost_gbp', 'total_sales_value_gbp', 'gross_margin_gbp']);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="weekly-sku-summary-${from}-to-${to}.csv"`);
      return res.send(csv);
    }

    res.json({ from, to, liability: liability ?? 'ALL', rows: result.rows });
  } catch (err) {
    console.error('Weekly SKU summary error:', err);
    res.status(500).json({ error: 'Failed to generate weekly SKU summary' });
  }
});

/**
 * GET /api/reports/financials?group=day|week|month&from=&to=&liability=
 * Sales rolled up by period for the internal financials view (Sales tab).
 */
router.get('/financials', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = resolveDateRange(req.query.from as string, req.query.to as string);
    const liability = (req.query.liability as string) || null;
    const group = (['day', 'week', 'month'].includes(req.query.group as string) ? req.query.group : 'day') as string;

    const result = await query(`
      SELECT
        date_trunc($4, pl.dispatched_at)::date                              AS period,
        SUM(pli.quantity_picked)::int                                       AS units_sold,
        ROUND(SUM(pli.quantity_picked * COALESCE(pli.unit_price_gbp, 0)), 2) AS sales_value_gbp,
        ROUND(SUM(pli.quantity_picked * COALESCE(pli.unit_cost_gbp, 0)), 2)  AS cogs_gbp,
        ROUND(SUM(pli.quantity_picked * COALESCE(pli.unit_price_gbp, 0))
            - SUM(pli.quantity_picked * COALESCE(pli.unit_cost_gbp, 0)), 2)  AS gross_margin_gbp
      FROM pick_list_items pli
      JOIN pick_lists pl ON pl.id = pli.pick_list_id
      WHERE pl.status = 'DISPATCHED'
        AND pl.dispatched_at::date BETWEEN $1 AND $2
        AND pli.is_sandbox = false
        AND ($3::varchar IS NULL OR pli.liability_status = $3)
      GROUP BY period
      ORDER BY period
    `, [from, to, liability, group]);

    res.json({ from, to, group, liability: liability ?? 'ALL', rows: result.rows });
  } catch (err) {
    console.error('Financials report error:', err);
    res.status(500).json({ error: 'Failed to generate financials report' });
  }
});

/**
 * GET /api/reports/inventory-value?liability=
 * Current stock value (qty x unit cost), split by liability status, for the
 * financials view's Inventory tab.
 */
router.get('/inventory-value', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const liability = (req.query.liability as string) || null;

    const [bySku, byLiability, total] = await Promise.all([
      query(`
        SELECT
          wi.product_sku AS sku,
          COALESCE(wp.product_title, sm.product_name)         AS product_name,
          COALESCE(wp.colour_name, sm.colour, wi.colour_code) AS colour,
          wi.liability_status                                  AS liability_status,
          SUM(wi.quantity)::int                                AS qty_on_hand,
          ROUND(AVG(pc.unit_cost_gbp), 2)                      AS unit_cost_gbp,
          ROUND(SUM(wi.quantity * COALESCE(pc.unit_cost_gbp, 0)), 2) AS stock_value_gbp
        FROM warehouse_inventory wi
        LEFT JOIN wms_products wp ON wp.variant_sku = wi.product_sku
        LEFT JOIN product_costs pc ON pc.medusa_sku = wi.product_sku
        -- sku_mappings is LEGACY/PAUSED (empty) - product_name/colour fall back to wp.* anyway
        LEFT JOIN sku_mappings sm ON sm.medusa_sku = wi.product_sku
        WHERE wi.quantity > 0
          AND ($1::varchar IS NULL OR wi.liability_status = $1)
        GROUP BY wi.product_sku, wp.product_title, sm.product_name, wp.colour_name, sm.colour, wi.colour_code, wi.liability_status
        ORDER BY stock_value_gbp DESC NULLS LAST
      `, [liability]),
      query(`
        SELECT wi.liability_status, SUM(wi.quantity)::int AS qty_on_hand,
               ROUND(SUM(wi.quantity * COALESCE(pc.unit_cost_gbp, 0)), 2) AS stock_value_gbp
        FROM warehouse_inventory wi
        LEFT JOIN product_costs pc ON pc.medusa_sku = wi.product_sku
        WHERE wi.quantity > 0
        GROUP BY wi.liability_status
      `),
      query(`
        SELECT SUM(wi.quantity)::int AS qty_on_hand,
               ROUND(SUM(wi.quantity * COALESCE(pc.unit_cost_gbp, 0)), 2) AS stock_value_gbp
        FROM warehouse_inventory wi
        LEFT JOIN product_costs pc ON pc.medusa_sku = wi.product_sku
        WHERE wi.quantity > 0
      `),
    ]);

    res.json({
      liability: liability ?? 'ALL',
      total: total.rows[0],
      by_liability: byLiability.rows,
      by_sku: bySku.rows,
    });
  } catch (err) {
    console.error('Inventory value report error:', err);
    res.status(500).json({ error: 'Failed to generate inventory value report' });
  }
});

export default router;
