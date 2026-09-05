/**
 * Reorder Rules & Pending Reorders API
 *
 * GET  /api/reorder-rules              — list all rules
 * POST /api/reorder-rules/init         — generate rules from an order (order_qty/2 = monthly demand)
 * PUT  /api/reorder-rules/:id          — update a rule
 * POST /api/reorder-rules/check        — run check: compare WMS stock vs reorder points
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
        COUNT(pr.id) FILTER (WHERE pr.status = 'PENDING')::int AS pending_count
      FROM reorder_rules rr
      LEFT JOIN warehouse_inventory wi ON wi.product_sku = rr.sku
      LEFT JOIN pending_reorders pr ON pr.reorder_rule_id = rr.id
      GROUP BY rr.id
      ORDER BY rr.family, rr.sku
    `);
    res.json({ rules: r.rows, total: r.rows.length });
  } catch (err) { res.status(500).json({ error: 'Failed to load rules' }); }
});

/** POST /api/reorder-rules/init — generate rules from an order's line items */
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
      const monthlyDemand = line.quantity_ordered / months_of_stock;
      const reorderPoint = Math.max(1, Math.round(monthlyDemand));
      // ROQ = 2 months worth, minimum of 2
      const reorderQty = Math.max(2, Math.round(monthlyDemand * months_of_stock));

      const existing = await query('SELECT id FROM reorder_rules WHERE sku=$1', [line.sku]);
      if (existing.rows[0]) {
        await query(`
          UPDATE reorder_rules SET reorder_point=$1, reorder_qty=$2, monthly_demand=$3,
            product_name=$4, family=$5, updated_at=NOW()
          WHERE sku=$6
        `, [reorderPoint, reorderQty, monthlyDemand, line.product_name, line.family, line.sku]);
        updated++;
      } else {
        await query(`
          INSERT INTO reorder_rules (sku, product_name, family, reorder_point, reorder_qty, monthly_demand, lead_time_weeks)
          VALUES ($1,$2,$3,$4,$5,$6,8)
        `, [line.sku, line.product_name, line.family, reorderPoint, reorderQty, monthlyDemand]);
        created++;
      }
    }

    res.json({ created, updated, total: lines.rows.length, months_of_stock });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', authMiddleware, requirePermission('manage_reorder_rules'), async (req: AuthRequest, res: Response) => {
  try {
    const { reorder_point, reorder_qty, lead_time_weeks, is_active, notes } = req.body;
    const r = await query(`
      UPDATE reorder_rules SET
        reorder_point = COALESCE($1, reorder_point),
        reorder_qty   = COALESCE($2, reorder_qty),
        lead_time_weeks = COALESCE($3, lead_time_weeks),
        is_active     = COALESCE($4, is_active),
        notes         = COALESCE($5, notes),
        updated_at    = NOW()
      WHERE id=$6 RETURNING *
    `, [reorder_point, reorder_qty, lead_time_weeks, is_active, notes, req.params.id]);
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
  // Get all active rules with current stock
  const rules = await query(`
    SELECT rr.id, rr.sku, rr.product_name, rr.reorder_point, rr.reorder_qty,
           COALESCE(SUM(wi.quantity), 0)::int AS current_stock
    FROM reorder_rules rr
    LEFT JOIN warehouse_inventory wi ON wi.product_sku = rr.sku
    WHERE rr.is_active = true
    GROUP BY rr.id
    HAVING COALESCE(SUM(wi.quantity), 0) <= rr.reorder_point
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

    await query(`
      INSERT INTO pending_reorders (reorder_rule_id, sku, product_name, qty_to_order, current_stock, reorder_point)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [rule.id, rule.sku, rule.product_name, rule.reorder_qty, rule.current_stock, rule.reorder_point]);

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
