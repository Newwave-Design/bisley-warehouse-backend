/**
 * Supplier Orders API Routes — Phase 2: Order Management
 *
 * GET    /api/orders              — List orders with filters
 * POST   /api/orders              — Create new order
 * GET    /api/orders/:id          — Order detail with line items
 * PATCH  /api/orders/:id          — Update order (status, notes, expected delivery)
 * DELETE /api/orders/:id          — Delete draft order
 * PATCH  /api/orders/:orderId/items/:itemId — Update a line item (nw_code, qty, notes, etc.)
 * POST   /api/orders/:id/submit   — Submit order to supplier
 * POST   /api/orders/:id/receive  — Mark as received
 * POST   /api/orders/from-nw      — Auto-create order from NW stocking programme
 *
 * GET    /api/orders/thresholds          — List thresholds
 * PATCH  /api/orders/thresholds/:id      — Update threshold
 *
 * POST   /api/orders/genero/dispatch     — Receive dispatch note webhook
 */

import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../../db/index.js';
import { authMiddleware, requireRole, AuthRequest } from '../../middleware/auth.js';

const router = express.Router();

// Shared secret for the inbound Genero dispatch webhook (Genero has no way to send a JWT).
// Not yet configured anywhere -> fail closed rather than accept unauthenticated writes.
const GENERO_WEBHOOK_SECRET = process.env.GENERO_WEBHOOK_SECRET ?? '';
function verifyGeneroSecret(provided: string): boolean {
  if (!GENERO_WEBHOOK_SECRET || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(GENERO_WEBHOOK_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ================================================================================
// ORDERS
// ================================================================================

router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { status = '', limit = '50', offset = '0' } = req.query;

    let sql = `
      SELECT
        o.*,
        COUNT(li.id) as line_item_count,
        SUM(li.quantity_ordered) as total_units,
        SUM(li.quantity_received) as received_units
      FROM supplier_orders o
      LEFT JOIN order_line_items li ON li.order_id = o.id
      WHERE 1=1
    `;
    const params: any[] = [];
    let i = 1;

    if (status) {
      const statuses = (status as string).split(',').map(s => s.trim());
      sql += ` AND o.status = ANY($${i}::text[])`;
      params.push(statuses); i++;
    }

    sql += ` GROUP BY o.id ORDER BY o.created_at DESC LIMIT $${i} OFFSET $${i+1}`;
    params.push(parseInt(limit as string), parseInt(offset as string));

    const countSql = `SELECT COUNT(*) FROM supplier_orders${status ? ` WHERE status = ANY($1::text[])` : ''}`;
    const [result, countResult] = await Promise.all([
      query(sql, params),
      query(countSql, status ? [(status as string).split(',').map(s => s.trim())] : []),
    ]);

    res.json({ orders: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

router.post('/', authMiddleware, requireRole(['MANAGER','ADMIN']), async (req: AuthRequest, res: Response) => {
  try {
    const { notes, expected_delivery, line_items } = req.body;

    if (!Array.isArray(line_items) || line_items.length === 0) {
      return res.status(400).json({ error: 'line_items array required' });
    }

    // Generate order number
    const countResult = await query('SELECT COUNT(*) FROM supplier_orders');
    const orderNumber = `ORD-${String(parseInt(countResult.rows[0].count) + 1).padStart(4, '0')}`;

    const orderResult = await query(
      `INSERT INTO supplier_orders (order_number, status, notes, expected_delivery, created_by, created_at, updated_at)
       VALUES ($1, 'DRAFT', $2, $3, $4, NOW(), NOW()) RETURNING *`,
      [orderNumber, notes || null, expected_delivery || null, (req as any).user?.email || 'system']
    );
    const order = orderResult.rows[0];

    for (const item of line_items) {
      await query(
        `INSERT INTO order_line_items (order_id, nw_code, medusa_sku, product_name, family, colour, quantity_ordered, unit_cost, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
        [order.id, item.nw_code, item.medusa_sku || null, item.product_name || null, item.family || null, item.colour || null, item.quantity_ordered, item.unit_cost || null]
      );
    }

    const full = await query(`SELECT o.*, json_agg(li.*) as line_items FROM supplier_orders o JOIN order_line_items li ON li.order_id = o.id WHERE o.id = $1 GROUP BY o.id`, [order.id]);
    res.status(201).json(full.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

router.get('/thresholds', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(`
      SELECT t.*, s.product_name, s.family, s.medusa_sku
      FROM inventory_thresholds t
      LEFT JOIN sku_mappings s ON s.nw_code = t.nw_code
      ORDER BY t.nw_code, t.colour
    `);
    res.json({ thresholds: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch thresholds' });
  }
});

router.patch('/thresholds/:id', authMiddleware, requireRole(['MANAGER','ADMIN']), async (req: AuthRequest, res: Response) => {
  try {
    const { min_quantity, reorder_quantity, is_active } = req.body;
    const result = await query(
      `UPDATE inventory_thresholds SET min_quantity=$1, reorder_quantity=$2, is_active=$3, updated_at=NOW() WHERE id=$4 RETURNING *`,
      [min_quantity, reorder_quantity, is_active ?? true, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Threshold not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update threshold' });
  }
});

// Auto-create a draft order from the NW stocking programme items
router.post('/from-nw', authMiddleware, requireRole(['MANAGER','ADMIN']), async (req: AuthRequest, res: Response) => {
  try {
    const { notes, expected_delivery } = req.body;

    const items = await query(`
      SELECT n.nw_code, n.description, n.family, n.colour, n.quantity_ordered, n.unit_cost,
             s.medusa_sku, s.product_name
      FROM nw_stocking_items n
      LEFT JOIN sku_mappings s ON s.nw_code = n.nw_code
      WHERE n.quantity_ordered > 0
      ORDER BY n.family, n.nw_code, n.colour
    `);

    if (items.rows.length === 0) {
      return res.status(400).json({ error: 'No NW stocking items found' });
    }

    const countResult = await query('SELECT COUNT(*) FROM supplier_orders');
    const orderNumber = `ORD-NW-${String(parseInt(countResult.rows[0].count) + 1).padStart(4, '0')}`;

    const orderResult = await query(
      `INSERT INTO supplier_orders (order_number, status, notes, expected_delivery, created_by, created_at, updated_at)
       VALUES ($1, 'DRAFT', $2, $3, 'system', NOW(), NOW()) RETURNING *`,
      [orderNumber, notes || 'Auto-created from NW stocking programme', expected_delivery || null]
    );
    const order = orderResult.rows[0];

    for (const item of items.rows) {
      await query(
        `INSERT INTO order_line_items (order_id, nw_code, medusa_sku, product_name, family, colour, quantity_ordered, unit_cost, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
        [order.id, item.nw_code, item.medusa_sku || null, item.product_name || item.description, item.family, item.colour, item.quantity_ordered, item.unit_cost || null]
      );
    }

    res.status(201).json({ order_id: order.id, order_number: orderNumber, line_items: items.rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create order from NW stocking' });
  }
});

router.get('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const order = await query(`SELECT * FROM supplier_orders WHERE id = $1`, [req.params.id]);
    if (!order.rows[0]) return res.status(404).json({ error: 'Order not found' });

    const items = await query(`SELECT * FROM order_line_items WHERE order_id = $1 ORDER BY family, nw_code, colour`, [req.params.id]);
    res.json({ ...order.rows[0], line_items: items.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

router.patch('/:id', authMiddleware, requireRole(['MANAGER','ADMIN']), async (req: AuthRequest, res: Response) => {
  try {
    const { status, notes, expected_delivery, genero_dispatch_ref } = req.body;
    const fields: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (status !== undefined) { fields.push(`status=$${i++}`); params.push(status); }
    if (notes !== undefined) { fields.push(`notes=$${i++}`); params.push(notes); }
    if (expected_delivery !== undefined) { fields.push(`expected_delivery=$${i++}`); params.push(expected_delivery); }
    if (genero_dispatch_ref !== undefined) { fields.push(`genero_dispatch_ref=$${i++}`); params.push(genero_dispatch_ref); }

    if (status === 'SUBMITTED') { fields.push(`submitted_at=$${i++}`); params.push(new Date()); }
    if (status === 'DISPATCHED') { fields.push(`dispatched_at=$${i++}`); params.push(new Date()); }
    if (status === 'RECEIVED') { fields.push(`received_at=$${i++}`); params.push(new Date()); }

    fields.push(`updated_at=$${i++}`); params.push(new Date());
    params.push(req.params.id);

    const result = await query(`UPDATE supplier_orders SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`, params);
    if (!result.rows[0]) return res.status(404).json({ error: 'Order not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update order' });
  }
});

router.delete('/:id', authMiddleware, requireRole(['MANAGER','ADMIN']), async (req: AuthRequest, res: Response) => {
  try {
    const order = await query(`SELECT status FROM supplier_orders WHERE id=$1`, [req.params.id]);
    if (!order.rows[0]) return res.status(404).json({ error: 'Order not found' });
    if (order.rows[0].status !== 'DRAFT') return res.status(400).json({ error: 'Only DRAFT orders can be deleted' });

    await query(`DELETE FROM supplier_orders WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete order' });
  }
});

// Update a single line item (e.g. correct nw_code, product_name, notes)
router.patch('/:orderId/items/:itemId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { nw_code, medusa_sku, product_name, family, colour, quantity_ordered, unit_cost, notes } = req.body;
    const fields: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (nw_code !== undefined)        { fields.push(`nw_code=$${i++}`);        params.push(nw_code); }
    if (medusa_sku !== undefined)     { fields.push(`medusa_sku=$${i++}`);     params.push(medusa_sku); }
    if (product_name !== undefined)   { fields.push(`product_name=$${i++}`);   params.push(product_name); }
    if (family !== undefined)         { fields.push(`family=$${i++}`);         params.push(family); }
    if (colour !== undefined)         { fields.push(`colour=$${i++}`);         params.push(colour); }
    if (quantity_ordered !== undefined){ fields.push(`quantity_ordered=$${i++}`); params.push(quantity_ordered); }
    if (unit_cost !== undefined)      { fields.push(`unit_cost=$${i++}`);      params.push(unit_cost); }
    if (notes !== undefined)          { fields.push(`notes=$${i++}`);          params.push(notes); }

    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

    fields.push(`updated_at=$${i++}`); params.push(new Date());
    params.push(req.params.itemId, req.params.orderId);

    const result = await query(
      `UPDATE order_line_items SET ${fields.join(', ')} WHERE id=$${i} AND order_id=$${i + 1} RETURNING *`,
      params
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Line item not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update line item' });
  }
});

// Genero dispatch note webhook — authenticated via shared secret header (x-genero-secret),
// since Genero cannot send a JWT. Set GENERO_WEBHOOK_SECRET on both sides to enable.
router.post('/genero/dispatch', async (req: Request, res: Response) => {
  if (!verifyGeneroSecret((req.headers['x-genero-secret'] as string) ?? '')) {
    return res.status(401).json({ error: 'Invalid or missing webhook secret' });
  }
  try {
    const { dispatch_ref, order_number, dispatch_date, expected_delivery, carrier, tracking_number } = req.body;

    if (!dispatch_ref) return res.status(400).json({ error: 'dispatch_ref required' });

    const order = order_number
      ? await query(`SELECT id FROM supplier_orders WHERE order_number = $1`, [order_number])
      : { rows: [] };

    await query(
      `INSERT INTO genero_dispatch_notes (dispatch_ref, order_id, dispatch_date, expected_delivery, carrier, tracking_number, raw_payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (dispatch_ref) DO UPDATE SET raw_payload=$7, updated_at=NOW() WHERE false`,
      [dispatch_ref, order.rows[0]?.id || null, dispatch_date || null, expected_delivery || null, carrier || null, tracking_number || null, JSON.stringify(req.body)]
    );

    if (order.rows[0]?.id) {
      await query(`UPDATE supplier_orders SET status='DISPATCHED', dispatched_at=NOW(), genero_dispatch_ref=$1, updated_at=NOW() WHERE id=$2`, [dispatch_ref, order.rows[0].id]);
    }

    res.json({ success: true, dispatch_ref });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process dispatch note' });
  }
});

export default router;
