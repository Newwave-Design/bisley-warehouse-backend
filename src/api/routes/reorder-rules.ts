/**
 * Reorder Rules & Pending Reorders API
 * 
 * SIMPLIFIED MODEL: 
 * - Benchmark Quantity: 2-month stock quantity (set on init from order, editable)
 * - Trigger Point: Automatically 60% of benchmark (read-only, derived)
 * - Order Quantity: Automatically = benchmark (read-only, derived)
 * - Lead Time: Fixed 8 weeks (2 months for replenishment)
 * 
 * Logic: When current_stock < (benchmark * 0.60) → Create pending reorder for (benchmark qty)
 *
 * GET  /api/reorder-rules              — list all rules
 * POST /api/reorder-rules/init         — generate rules from an order (benchmark = order qty)
 * PUT  /api/reorder-rules/:id          — update benchmark_quantity and/or is_active
 * POST /api/reorder-rules/check        — run check: compare WMS stock vs 60% of benchmark
 *
 * GET  /api/pending-reorders           — list pending/delayed reorders
 * POST /api/pending-reorders/:id/approve — approve → creates/appends to a DRAFT supplier order
 * POST /api/pending-reorders/:id/delay  — snooze until a date
 * POST /api/pending-reorders/:id/cancel — cancel
 * POST /api/pending-reorders/bulk-approve — approve all pending
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, requirePermission, AuthRequest } from '../../middleware/auth.js';

const router = express.Router();

// ── Reorder Rules ────────────────────────────────────────────────────────────

router.get('/', authMiddleware, requirePermission('manage_reorder_rules'), async (_req: AuthRequest, res: Response) => {
  try {
    const r = await query(`
      SELECT rr.*,
        COALESCE(SUM(wi.quantity), 0)::int AS current_stock,
        COUNT(pr.id) FILTER (WHERE pr.status = 'PENDING')::int AS pending_count,
        wp.product_status,
        CASE 
          WHEN rr.benchmark_quantity > 0 THEN ROUND(rr.benchmark_quantity * 0.6)
          ELSE rr.reorder_point
        END as calculated_trigger_point,
        COALESCE(SUM(pli.quantity) FILTER (WHERE pl.status = 'COMPLETED' 
          AND pl.completed_at >= NOW() - INTERVAL '60 days'), 0)::int AS sales_60d
      FROM reorder_rules rr
      LEFT JOIN warehouse_inventory wi ON wi.product_sku = rr.sku
      LEFT JOIN pending_reorders pr ON pr.reorder_rule_id = rr.id
      LEFT JOIN wms_products wp ON wp.variant_sku = rr.sku
      LEFT JOIN pick_list_items pli ON pli.product_sku = rr.sku
      LEFT JOIN pick_lists pl ON pl.id = pli.pick_list_id
      WHERE COALESCE(wp.product_status, 'draft') = 'published'
      GROUP BY rr.id, wp.product_status
      ORDER BY rr.family, rr.sku
    `);
    
    // Add recommendations based on sales velocity
    const items = r.rows.map((row: any) => {
      const sales_60d = row.sales_60d || 0;
      const benchmark = row.benchmark_quantity || 0;
      const monthly_avg = Math.round(sales_60d / 2);
      
      let recommendation = 'No sales data';
      let recommendation_class = 'text-gray-400';
      
      if (sales_60d > 0 && benchmark > 0) {
        const ratio = sales_60d / benchmark;
        if (ratio > 1.5) {
          recommendation = `INCREASE benchmark (${Math.round(ratio * 100)}% of current)`;
          recommendation_class = 'text-red-600';
        } else if (ratio < 0.5) {
          recommendation = `DECREASE benchmark (${Math.round(ratio * 100)}% of current)`;
          recommendation_class = 'text-yellow-600';
        } else {
          recommendation = 'Benchmark aligned ✓';
          recommendation_class = 'text-green-600';
        }
      } else if (benchmark === 0) {
        recommendation = 'Benchmark not set';
        recommendation_class = 'text-gray-400';
      }
      
      return { ...row, monthly_avg, recommendation, recommendation_class };
    });
    
    res.json({ rules: items, total: items.length });
  } catch (err) { res.status(500).json({ error: 'Failed to load rules' }); }
});

/** POST /api/reorder-rules/init — generate rules from an order's line items 
 * Sets benchmark_quantity = order line quantity (2-month stock baseline)
 * Derives trigger point (60% of benchmark) and order quantity (= benchmark)
 */
router.post('/init', authMiddleware, requirePermission('manage_reorder_rules'), async (req: AuthRequest, res: Response) => {
  try {
    const { order_id, months_of_stock = 2 } = req.body;
    if (!order_id) return res.status(400).json({ error: 'order_id required' });

    const lines = await query(
      `SELECT DISTINCT ON (medusa_sku) medusa_sku AS sku, product_name, family, quantity_ordered
       FROM order_line_items WHERE order_id=$1 AND medusa_sku IS NOT NULL ORDER BY medusa_sku`,
      [order_id]
    );
    if (!lines.rows.length) return res.status(400).json({ error: 'No line items found' });

    let created = 0, updated = 0;
    for (const line of lines.rows) {
      // benchmark = total 2-month quantity from order
      const benchmark = line.quantity_ordered;
      // trigger point = 60% of benchmark
      const triggerPoint = Math.round(benchmark * 0.6);
      // order quantity = benchmark (replenish back to 2-month level)
      const orderQty = benchmark;

      const existing = await query('SELECT id FROM reorder_rules WHERE sku=$1', [line.sku]);
      if (existing.rows[0]) {
        await query(`
          UPDATE reorder_rules SET 
            benchmark_quantity=$1, 
            reorder_point=$2, 
            reorder_qty=$3,
            product_name=$4, 
            family=$5, 
            updated_at=NOW()
          WHERE sku=$6
        `, [benchmark, triggerPoint, orderQty, line.product_name, line.family, line.sku]);
        updated++;
      } else {
        await query(`
          INSERT INTO reorder_rules (sku, product_name, family, benchmark_quantity, reorder_point, reorder_qty, lead_time_weeks)
          VALUES ($1,$2,$3,$4,$5,$6,8)
        `, [line.sku, line.product_name, line.family, benchmark, triggerPoint, orderQty]);
        created++;
      }
    }

    res.json({ created, updated, total: lines.rows.length, months_of_stock, note: 'Benchmark set to order quantity. Trigger point = 60% of benchmark. Order quantity = benchmark.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/reorder-rules/init-from-inventory — generate rules from current warehouse stock
 * Sets benchmark_quantity = current_stock for each published product
 * Useful for initial setup: "what we have today IS our 2-month baseline"
 */
router.post('/init-from-inventory', authMiddleware, requirePermission('manage_reorder_rules'), async (req: AuthRequest, res: Response) => {
  try {
    // Get all published products with their current stock
    const products = await query(`
      SELECT 
        wp.variant_sku AS sku,
        wp.product_title AS product_name,
        wp.product_family AS family,
        COALESCE(SUM(wi.quantity), 0)::int AS current_stock
      FROM wms_products wp
      LEFT JOIN warehouse_inventory wi ON wi.product_sku = wp.variant_sku
      WHERE wp.product_status = 'published'
      GROUP BY wp.variant_sku, wp.product_title, wp.product_family
      ORDER BY wp.product_family, wp.product_title
    `);

    if (!products.rows.length) return res.status(400).json({ error: 'No published products found' });

    let created = 0, updated = 0;
    for (const product of products.rows) {
      // Only create rules for products with stock
      if (product.current_stock === 0) continue;

      const benchmark = product.current_stock;
      const triggerPoint = Math.round(benchmark * 0.6);
      const orderQty = benchmark;

      const existing = await query('SELECT id FROM reorder_rules WHERE sku=$1', [product.sku]);
      if (existing.rows[0]) {
        await query(`
          UPDATE reorder_rules SET 
            benchmark_quantity=$1, 
            reorder_point=$2, 
            reorder_qty=$3,
            product_name=$4, 
            family=$5, 
            updated_at=NOW()
          WHERE sku=$6
        `, [benchmark, triggerPoint, orderQty, product.product_name, product.family, product.sku]);
        updated++;
      } else {
        await query(`
          INSERT INTO reorder_rules (sku, product_name, family, benchmark_quantity, reorder_point, reorder_qty, lead_time_weeks, is_active)
          VALUES ($1,$2,$3,$4,$5,$6,8,true)
        `, [product.sku, product.product_name, product.family, benchmark, triggerPoint, orderQty]);
        created++;
      }
    }

    res.json({ 
      created, 
      updated, 
      total: created + updated, 
      note: `Created from current inventory. Benchmark = current stock. Trigger = 60% of current stock. Ready to monitor.` 
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', authMiddleware, requirePermission('manage_reorder_rules'), async (req: AuthRequest, res: Response) => {
  try {
    const { benchmark_quantity, is_active, notes } = req.body;
    
    // If benchmark_quantity is provided, recalculate trigger point and order qty
    let updateQuery = `
      UPDATE reorder_rules SET
        is_active     = COALESCE($1, is_active),
        notes         = COALESCE($2, notes),
        updated_at    = NOW()
    `;
    const params: any[] = [is_active, notes];
    
    if (benchmark_quantity !== undefined && benchmark_quantity > 0) {
      const triggerPoint = Math.round(benchmark_quantity * 0.6);
      updateQuery = `
        UPDATE reorder_rules SET
          benchmark_quantity = $1,
          reorder_point = $2,
          reorder_qty = $3,
          is_active = COALESCE($4, is_active),
          notes = COALESCE($5, notes),
          updated_at = NOW()
      `;
      params.unshift(benchmark_quantity, triggerPoint, benchmark_quantity);
    }
    
    updateQuery += ` WHERE id=$${params.length + 1} RETURNING *`;
    params.push(req.params.id);
    
    const r = await query(updateQuery, params);
    if (!r.rows[0]) return res.status(404).json({ error: 'Rule not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Update failed' }); }
});

/** POST /api/reorder-rules/check — compare WMS stock vs reorder points, create pending reorders */
router.post('/check', authMiddleware, requirePermission('manage_reorder_rules'), async (req: AuthRequest, res: Response) => {
  try {
    const triggered = await runReorderCheck();
    res.json({ triggered: triggered.length, items: triggered });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export async function runReorderCheck(): Promise<string[]> {
  // Get all active rules with current stock — only published products
  // Trigger when: current_stock < (benchmark * 0.60)
  const rules = await query(`
    SELECT rr.id, rr.sku, rr.product_name, rr.benchmark_quantity,
           COALESCE(SUM(wi.quantity), 0)::int AS current_stock,
           wp.product_status,
           ROUND(rr.benchmark_quantity * 0.6)::int as trigger_point
    FROM reorder_rules rr
    LEFT JOIN warehouse_inventory wi ON wi.product_sku = rr.sku
    LEFT JOIN wms_products wp ON wp.variant_sku = rr.sku
    WHERE rr.is_active = true
      AND rr.benchmark_quantity > 0
      AND COALESCE(wp.product_status, 'draft') = 'published'
    GROUP BY rr.id, wp.product_status
    HAVING COALESCE(SUM(wi.quantity), 0) < ROUND(rr.benchmark_quantity * 0.6)
  `);

  const triggered: string[] = [];
  for (const rule of rules.rows) {
    // Don't create duplicate pending reorders
    const existing = await query(
      `SELECT id FROM pending_reorders WHERE sku=$1 AND status IN ('PENDING','DELAYED')`,
      [rule.sku]
    );
    if (existing.rows.length > 0) continue;

    // Check if delayed_until has passed
    const delayed = await query(
      `SELECT id FROM pending_reorders WHERE sku=$1 AND status='DELAYED' AND delayed_until > NOW()::date`,
      [rule.sku]
    );
    if (delayed.rows.length > 0) continue;

    // Order quantity = benchmark_quantity (replenish back to 2-month stock level)
    await query(`
      INSERT INTO pending_reorders (reorder_rule_id, sku, product_name, qty_to_order, current_stock, reorder_point)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [rule.id, rule.sku, rule.product_name, rule.benchmark_quantity, rule.current_stock, rule.trigger_point]);

    await query(`UPDATE reorder_rules SET last_triggered_at=NOW() WHERE id=$1`, [rule.id]);
    triggered.push(rule.sku);
  }
  return triggered;
}

// ── Pending Reorders ─────────────────────────────────────────────────────────

const pendingRouter = express.Router();

pendingRouter.get('/', authMiddleware, requirePermission('manage_reorder_rules'), async (req: AuthRequest, res: Response) => {
  try {
    const statusFilter = (req.query.status as string) ?? 'PENDING,DELAYED';
    const statuses = statusFilter.split(',').map(s => s.trim());
    const r = await query(`
      SELECT pr.*,
        COALESCE(SUM(wi.quantity), 0)::int AS live_stock,
        wp.variant_thumbnail AS thumbnail,
        opl.pick_list_number AS origin_pick_list_number
      FROM pending_reorders pr
      LEFT JOIN warehouse_inventory wi ON wi.product_sku = pr.sku
      LEFT JOIN wms_products wp ON wp.variant_sku = pr.sku
      LEFT JOIN pick_lists opl ON opl.id = pr.origin_pick_list_id
      WHERE pr.status = ANY($1::text[])
      GROUP BY pr.id, wp.variant_thumbnail, opl.pick_list_number
      ORDER BY pr.triggered_at DESC
    `, [statuses]);
    res.json({ pending: r.rows, total: r.rows.length });
  } catch (err) { res.status(500).json({ error: 'Failed to load pending reorders' }); }
});

pendingRouter.post('/:id/approve', authMiddleware, requirePermission('manage_reorder_rules'), async (req: AuthRequest, res: Response) => {
  try {
    const pr = await query('SELECT * FROM pending_reorders WHERE id=$1', [req.params.id]);
    if (!pr.rows[0]) return res.status(404).json({ error: 'Not found' });
    const item = pr.rows[0];

    // Find or create a DRAFT order for today's reorders
    const today = new Date().toISOString().slice(0,10).replace(/-/g,'');
    const orderNum = `ORD-REORDER-${today}`;
    let order = await query("SELECT id FROM supplier_orders WHERE order_number=$1", [orderNum]);
    if (!order.rows[0]) {
      order = await query(`
        INSERT INTO supplier_orders (order_number, status, notes, created_at, updated_at)
        VALUES ($1,'DRAFT','Auto-generated from approved pending reorders',NOW(),NOW()) RETURNING id
      `, [orderNum]);
    }
    const orderId = order.rows[0].id;

    // Add or update line item in the order
    const existing = await query(
      'SELECT id, quantity_ordered FROM order_line_items WHERE order_id=$1 AND medusa_sku=$2',
      [orderId, item.sku]
    );
    if (existing.rows[0]) {
      await query(
        'UPDATE order_line_items SET quantity_ordered=quantity_ordered+$1, updated_at=NOW() WHERE id=$2',
        [item.qty_to_order, existing.rows[0].id]
      );
    } else {
      await query(`
        INSERT INTO order_line_items (order_id, nw_code, medusa_sku, product_name, quantity_ordered, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
      `, [orderId, item.sku, item.sku, item.product_name, item.qty_to_order]);
    }

    await query(`
      UPDATE pending_reorders SET status='APPROVED', approved_at=NOW(), approved_by=$1, supplier_order_id=$2, updated_at=NOW()
      WHERE id=$3
    `, [(req as any).user?.email ?? 'system', orderId, item.id]);

    res.json({ success: true, order_number: orderNum, order_id: orderId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

pendingRouter.post('/:id/delay', authMiddleware, requirePermission('manage_reorder_rules'), async (req: AuthRequest, res: Response) => {
  try {
    const { delayed_until, delay_reason } = req.body;
    if (!delayed_until) return res.status(400).json({ error: 'delayed_until (date) required' });
    await query(`
      UPDATE pending_reorders SET status='DELAYED', delayed_until=$1, delay_reason=$2, updated_at=NOW()
      WHERE id=$3
    `, [delayed_until, delay_reason ?? null, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Delay failed' }); }
});

pendingRouter.post('/:id/cancel', authMiddleware, requirePermission('manage_reorder_rules'), async (req: AuthRequest, res: Response) => {
  try {
    const pr = await query('SELECT * FROM pending_reorders WHERE id=$1', [req.params.id]);
    if (!pr.rows[0]) return res.status(404).json({ error: 'Not found' });
    const item = pr.rows[0];

    // Already approved — undo its contribution to the draft supplier order line
    // so the order doesn't silently retain quantity for a reorder that's been cancelled.
    if (item.status === 'APPROVED' && item.supplier_order_id) {
      const line = await query(
        'SELECT id, quantity_ordered FROM order_line_items WHERE order_id=$1 AND medusa_sku=$2',
        [item.supplier_order_id, item.sku]
      );
      if (line.rows[0]) {
        const remaining = line.rows[0].quantity_ordered - item.qty_to_order;
        if (remaining > 0) {
          await query('UPDATE order_line_items SET quantity_ordered=$1, updated_at=NOW() WHERE id=$2', [remaining, line.rows[0].id]);
        } else {
          await query('DELETE FROM order_line_items WHERE id=$1', [line.rows[0].id]);
        }
      }
    }

    await query("UPDATE pending_reorders SET status='CANCELLED', updated_at=NOW() WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Cancel failed' }); }
});

pendingRouter.post('/bulk-approve', authMiddleware, requirePermission('manage_reorder_rules'), async (req: AuthRequest, res: Response) => {
  try {
    const pending = await query("SELECT id FROM pending_reorders WHERE status='PENDING'");
    let approved = 0;
    for (const row of pending.rows) {
      // Call the approve logic inline
      req.params = { id: row.id };
      // Simple inline version to avoid Express routing complexity
      const pr = await query('SELECT * FROM pending_reorders WHERE id=$1', [row.id]);
      const item = pr.rows[0];
      if (!item) continue;

      const today = new Date().toISOString().slice(0,10).replace(/-/g,'');
      const orderNum = `ORD-REORDER-${today}`;
      let order = await query("SELECT id FROM supplier_orders WHERE order_number=$1", [orderNum]);
      if (!order.rows[0]) {
        order = await query(`INSERT INTO supplier_orders (order_number, status, notes, created_at, updated_at)
          VALUES ($1,'DRAFT','Auto-generated from bulk reorder approval',NOW(),NOW()) RETURNING id`, [orderNum]);
      }
      const orderId = order.rows[0].id;
      const existing = await query('SELECT id FROM order_line_items WHERE order_id=$1 AND medusa_sku=$2', [orderId, item.sku]);
      if (existing.rows[0]) {
        await query('UPDATE order_line_items SET quantity_ordered=quantity_ordered+$1, updated_at=NOW() WHERE id=$2', [item.qty_to_order, existing.rows[0].id]);
      } else {
        await query(`INSERT INTO order_line_items (order_id, nw_code, medusa_sku, product_name, quantity_ordered, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,NOW(),NOW())`, [orderId, item.sku, item.sku, item.product_name, item.qty_to_order]);
      }
      await query("UPDATE pending_reorders SET status='APPROVED', approved_at=NOW(), supplier_order_id=$1, updated_at=NOW() WHERE id=$2", [orderId, item.id]);
      approved++;
    }
    res.json({ approved });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export { pendingRouter };
export default router;
