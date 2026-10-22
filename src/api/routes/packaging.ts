/**
 * Packaging inventory, bills of packaging, links, stock, and shipping rate cards.
 * Full CRUD so a bot or the dashboard can keep the catalogue current.
 */
import express, { Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { query } from '../../db/index.js';
import { authMiddleware, requirePermission } from '../../middleware/auth.js';
import { importPackagingSnapshot } from '../../lib/packaging-import.js';
import { seedDpdRateCards } from '../../lib/shipping-rate-seed.js';

const router = express.Router();
router.use(authMiddleware);

const ITEM_TYPES = ['box', 'tray', 'sleeve', 'edge_guard', 'corner', 'foam', 'tape', 'wrap', 'label', 'other'];
const METHODS = ['box', 'sleeve_tray', 'own_box', 'pallet_wrap', 'pack_to_fit', 'needs_packaging'];
const LINK_KINDS = ['item', 'product', 'sku', 'sleeve_set'];
const MOVE_TYPES = ['receipt', 'pack_usage', 'adjustment', 'stocktake', 'return', 'write_off', 'opening'];

function pick(body: Record<string, any>, keys: string[]) {
  const out: Record<string, any> = {};
  for (const k of keys) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

function setClause(fields: Record<string, any>, start = 1) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${start + i}`);
  return { sets, values: keys.map((k) => fields[k]), next: start + keys.length };
}

const ITEM_COLS = [
  'item_type', 'code', 'name', 'internal_length_mm', 'internal_width_mm', 'internal_height_mm',
  'external_length_mm', 'external_width_mm', 'external_height_mm', 'length_mm', 'thickness_mm', 'gap_mm',
  'tare_weight_grams', 'unit_cost_gbp', 'supplier_id', 'supplier_name', 'supplier_code', 'pack_size',
  'reorder_level', 'reorder_qty', 'stocked', 'is_active', 'location_id', 'notes', 'extra',
];

router.get('/items', async (req: Request, res: Response) => {
  try {
    const { type, stocked, below_reorder, q, active } = req.query;
    const conds = ['1=1'];
    const params: any[] = [];
    if (type) { params.push(type); conds.push(`item_type = $${params.length}`); }
    if (stocked === 'true' || stocked === 'false') { params.push(stocked === 'true'); conds.push(`stocked = $${params.length}`); }
    if (active !== 'all') conds.push('is_active = true');
    if (below_reorder === 'true') conds.push('reorder_level IS NOT NULL AND stock_on_hand <= reorder_level');
    if (q) {
      params.push(`%${String(q).trim()}%`);
      conds.push(`(code ILIKE $${params.length} OR name ILIKE $${params.length} OR supplier_code ILIKE $${params.length})`);
    }
    const result = await query(
      `SELECT * FROM packaging_items WHERE ${conds.join(' AND ')} ORDER BY item_type, code`,
      params
    );
    res.json({ items: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list packaging items' });
  }
});

router.get('/items/:id', async (req: Request, res: Response) => {
  try {
    const item = await query(`SELECT * FROM packaging_items WHERE id = $1 OR code = $1`, [req.params.id]);
    if (!item.rows[0]) return res.status(404).json({ error: 'Item not found' });
    const id = item.rows[0].id;
    const [used, moves, links] = await Promise.all([
      query(
        `SELECT b.id AS bom_id, b.product_code, b.sku, b.method, b.option_rank, l.qty, l.qty_confirmed
         FROM packaging_bom_lines l JOIN packaging_boms b ON b.id = l.bom_id
         WHERE l.packaging_item_id = $1 ORDER BY b.product_code, b.sku, b.option_rank`,
        [id]
      ),
      query(
        `SELECT * FROM packaging_stock_movements WHERE packaging_item_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [id]
      ),
      query(
        `SELECT * FROM packaging_links
         WHERE (from_kind = 'item' AND from_key = $1) OR (to_kind = 'item' AND to_key = $1)
            OR (from_kind = 'item' AND from_key = $2) OR (to_kind = 'item' AND to_key = $2)`,
        [id, item.rows[0].code]
      ),
    ]);
    res.json({ item: item.rows[0], used_on: used.rows, movements: moves.rows, links: links.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch item' });
  }
});

router.post('/items', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const body = pick(req.body, ITEM_COLS);
    if (!body.code || !body.item_type) return res.status(400).json({ error: 'code and item_type are required' });
    if (!ITEM_TYPES.includes(body.item_type)) return res.status(400).json({ error: `item_type must be one of ${ITEM_TYPES.join(', ')}` });
    body.extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
    const cols = Object.keys(body);
    const result = await query(
      `INSERT INTO packaging_items (id, ${cols.join(', ')})
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
       RETURNING *`,
      [uuid(), ...cols.map((c) => body[c])]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create item', details: err.message });
  }
});

router.patch('/items/:id', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const body = pick(req.body, ITEM_COLS);
    if (body.item_type && !ITEM_TYPES.includes(body.item_type)) {
      return res.status(400).json({ error: `item_type must be one of ${ITEM_TYPES.join(', ')}` });
    }
    if (!Object.keys(body).length) return res.status(400).json({ error: 'No fields to update' });
    body.updated_at = new Date();
    const { sets, values, next } = setClause(body);
    const result = await query(
      `UPDATE packaging_items SET ${sets.join(', ')} WHERE id = $${next} OR code = $${next} RETURNING *`,
      [...values, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Item not found' });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update item', details: err.message });
  }
});

router.delete('/items/:id', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const result = await query(
      `UPDATE packaging_items SET is_active = false, updated_at = NOW() WHERE id = $1 OR code = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Item not found' });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete item', details: err.message });
  }
});

router.get('/sleeve-sets', async (_req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT s.*, t.code AS tray_code, v.code AS sleeve_code, e.code AS edge_guard_code
       FROM packaging_sleeve_sets s
       LEFT JOIN packaging_items t ON t.id = s.tray_item_id
       LEFT JOIN packaging_items v ON v.id = s.sleeve_item_id
       LEFT JOIN packaging_items e ON e.id = s.edge_guard_item_id
       ORDER BY s.label`
    );
    res.json({ sleeve_sets: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list sleeve sets' });
  }
});

router.post('/sleeve-sets', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const { label, packed_length_mm, packed_width_mm, packed_height_mm, tray_item_id, sleeve_item_id, edge_guard_item_id, stocked, notes, extra } = req.body;
    if (!label) return res.status(400).json({ error: 'label is required' });
    const result = await query(
      `INSERT INTO packaging_sleeve_sets (id, label, packed_length_mm, packed_width_mm, packed_height_mm, tray_item_id, sleeve_item_id, edge_guard_item_id, stocked, notes, extra)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [uuid(), label, packed_length_mm || null, packed_width_mm || null, packed_height_mm || null, tray_item_id || null, sleeve_item_id || null, edge_guard_item_id || null, !!stocked, notes || null, extra || {}]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create sleeve set', details: err.message });
  }
});

router.delete('/sleeve-sets/:id', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const result = await query(
      `UPDATE packaging_sleeve_sets SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete sleeve set', details: err.message });
  }
});

router.patch('/sleeve-sets/:id', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const body = pick(req.body, ['label', 'packed_length_mm', 'packed_width_mm', 'packed_height_mm', 'tray_item_id', 'sleeve_item_id', 'edge_guard_item_id', 'stocked', 'is_active', 'notes', 'extra']);
    body.updated_at = new Date();
    const { sets, values, next } = setClause(body);
    const result = await query(`UPDATE packaging_sleeve_sets SET ${sets.join(', ')} WHERE id = $${next} RETURNING *`, [...values, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update sleeve set', details: err.message });
  }
});

router.get('/products', async (req: Request, res: Response) => {
  try {
    const { method, q, active } = req.query;
    const conds = ['1=1'];
    const params: any[] = [];
    if (method) { params.push(method); conds.push(`s.method = $${params.length}`); }
    if (active !== 'all') conds.push('s.is_active = true');
    if (q) {
      params.push(`%${String(q).trim()}%`);
      conds.push(`(s.product_code ILIKE $${params.length} OR s.product_title ILIKE $${params.length} OR s.product_range ILIKE $${params.length})`);
    }
    const result = await query(
      `WITH weeks AS (
         SELECT GREATEST(
           1.0,
           EXTRACT(EPOCH FROM (NOW() - MIN(pl.created_at))) / 604800.0
         ) AS n
         FROM pick_lists pl
         WHERE NOT pl.is_sandbox
           AND pl.status <> 'CANCELLED'
           AND pl.payment_status IN ('captured', 'partially_refunded')
       ),
       sales AS (
         SELECT
           CASE
             WHEN position('-' IN pli.product_sku) > 0
             THEN left(pli.product_sku, length(pli.product_sku) - position('-' IN reverse(pli.product_sku)))
             ELSE pli.product_sku
           END AS product_code,
           SUM(pli.quantity_required)::numeric AS units_sold
         FROM pick_list_items pli
         JOIN pick_lists pl ON pl.id = pli.pick_list_id
         WHERE NOT pl.is_sandbox
           AND pl.status <> 'CANCELLED'
           AND pl.payment_status IN ('captured', 'partially_refunded')
           AND pli.product_sku NOT ILIKE '%SAMPLE%'
           AND COALESCE(pli.is_custom, false) = false
         GROUP BY 1
       ),
       prices AS (
         SELECT
           CASE
             WHEN position('-' IN wp.variant_sku) > 0
             THEN left(wp.variant_sku, length(wp.variant_sku) - position('-' IN reverse(wp.variant_sku)))
             ELSE wp.variant_sku
           END AS product_code,
           MIN(wp.price_gbp) AS price_gbp
         FROM wms_products wp
         WHERE wp.price_gbp IS NOT NULL
         GROUP BY 1
       )
       SELECT s.*,
              COALESCE(sales.units_sold, 0)::numeric AS units_sold,
              ROUND((COALESCE(sales.units_sold, 0) / weeks.n)::numeric, 1) AS qty_per_week,
              ROUND(weeks.n::numeric, 1) AS weeks_covered,
              prices.price_gbp
       FROM packaging_product_specs s
       CROSS JOIN weeks
       LEFT JOIN sales ON sales.product_code = s.product_code
       LEFT JOIN prices ON prices.product_code = s.product_code
       WHERE ${conds.join(' AND ')}
       ORDER BY s.product_code`,
      params
    );
    res.json({ products: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list product specs' });
  }
});

router.post('/products', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const body = pick(req.body, [
      'product_code', 'product_title', 'product_range', 'length_mm', 'width_mm', 'height_mm',
      'length_packed_mm', 'width_packed_mm', 'height_packed_mm', 'packed_dims_checked', 'weight_grams',
      'method', 'stocked', 'listed', 'is_active', 'units_per_month', 'notes', 'extra',
    ]);
    if (!body.product_code) return res.status(400).json({ error: 'product_code is required' });
    if (body.method && !METHODS.includes(body.method)) return res.status(400).json({ error: `method must be one of ${METHODS.join(', ')}` });
    const cols = Object.keys(body);
    const result = await query(
      `INSERT INTO packaging_product_specs (id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
      [uuid(), ...cols.map((c) => body[c])]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create product spec', details: err.message });
  }
});

router.patch('/products/:id', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const body = pick(req.body, [
      'product_code', 'product_title', 'product_range', 'length_mm', 'width_mm', 'height_mm',
      'length_packed_mm', 'width_packed_mm', 'height_packed_mm', 'packed_dims_checked', 'weight_grams',
      'method', 'stocked', 'listed', 'is_active', 'units_per_month', 'notes', 'extra',
    ]);
    if (body.method && !METHODS.includes(body.method)) return res.status(400).json({ error: `method must be one of ${METHODS.join(', ')}` });
    body.updated_at = new Date();
    const { sets, values, next } = setClause(body);
    const result = await query(
      `UPDATE packaging_product_specs SET ${sets.join(', ')} WHERE id = $${next} OR product_code = $${next} RETURNING *`,
      [...values, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update product spec', details: err.message });
  }
});

router.get('/boms', async (req: Request, res: Response) => {
  try {
    const { product, sku } = req.query;
    const conds = ['b.is_active = true'];
    const params: any[] = [];
    if (product) { params.push(product); conds.push(`b.product_code = $${params.length}`); }
    if (sku) { params.push(sku); conds.push(`b.sku = $${params.length}`); }
    const result = await query(
      `SELECT b.*, COALESCE(json_agg(json_build_object(
          'id', l.id, 'packaging_item_id', l.packaging_item_id, 'code', i.code, 'name', i.name,
          'item_type', i.item_type, 'qty', l.qty, 'qty_confirmed', l.qty_confirmed, 'notes', l.notes
        ) ORDER BY i.item_type, i.code) FILTER (WHERE l.id IS NOT NULL), '[]') AS lines
       FROM packaging_boms b
       LEFT JOIN packaging_bom_lines l ON l.bom_id = b.id
       LEFT JOIN packaging_items i ON i.id = l.packaging_item_id
       WHERE ${conds.join(' AND ')}
       GROUP BY b.id
       ORDER BY b.product_code, b.sku, b.option_rank`,
      params
    );
    res.json({ boms: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list BOMs' });
  }
});

router.get('/resolve', async (req: Request, res: Response) => {
  try {
    const sku = String(req.query.sku || '').trim();
    if (!sku) return res.status(400).json({ error: 'sku is required' });
    const prefix = sku.includes('-') ? sku.slice(0, sku.lastIndexOf('-')) : sku;
    const skuBoms = await query(
      `SELECT b.* FROM packaging_boms b WHERE b.sku = $1 AND b.is_active ORDER BY option_rank`,
      [sku]
    );
    const productBoms = await query(
      `SELECT b.* FROM packaging_boms b WHERE b.product_code = $1 AND b.sku IS NULL AND b.is_active ORDER BY option_rank`,
      [prefix]
    );
    const spec = await query(`SELECT * FROM packaging_product_specs WHERE product_code = $1`, [prefix]);
    const preferred = skuBoms.rows[0] || productBoms.rows[0] || null;
    let lines: any[] = [];
    if (preferred) {
      const r = await query(
        `SELECT l.*, i.code, i.name, i.item_type, i.stock_on_hand
         FROM packaging_bom_lines l JOIN packaging_items i ON i.id = l.packaging_item_id
         WHERE l.bom_id = $1`,
        [preferred.id]
      );
      lines = r.rows;
    }
    res.json({
      sku,
      product_code: prefix,
      spec: spec.rows[0] || null,
      preferred: preferred ? { ...preferred, lines } : null,
      alternates: [...skuBoms.rows, ...productBoms.rows].filter((b) => b.id !== preferred?.id),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve packaging' });
  }
});

router.post('/boms', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const { product_code, sku, method, option_rank, label, parcels, notes, extra, lines } = req.body;
    if (!product_code && !sku) return res.status(400).json({ error: 'product_code or sku is required' });
    if (product_code && sku) return res.status(400).json({ error: 'Set product_code or sku, not both' });
    if (!method || !METHODS.includes(method)) return res.status(400).json({ error: `method must be one of ${METHODS.join(', ')}` });
    const bom = await query(
      `INSERT INTO packaging_boms (id, product_code, sku, method, option_rank, label, parcels, notes, extra, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual') RETURNING *`,
      [uuid(), product_code || null, sku || null, method, option_rank || 1, label || null, parcels || 1, notes || null, extra || {}]
    );
    if (Array.isArray(lines)) {
      for (const line of lines) {
        await query(
          `INSERT INTO packaging_bom_lines (id, bom_id, packaging_item_id, qty, qty_confirmed, notes)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [uuid(), bom.rows[0].id, line.packaging_item_id, line.qty ?? 1, line.qty_confirmed !== false, line.notes || null]
        );
      }
    }
    res.status(201).json(bom.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create BOM', details: err.message });
  }
});

router.patch('/boms/:id', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const body = pick(req.body, ['method', 'option_rank', 'label', 'parcels', 'is_active', 'notes', 'extra']);
    if (body.method && !METHODS.includes(body.method)) return res.status(400).json({ error: `method must be one of ${METHODS.join(', ')}` });
    body.updated_at = new Date();
    const { sets, values, next } = setClause(body);
    const result = await query(`UPDATE packaging_boms SET ${sets.join(', ')} WHERE id = $${next} RETURNING *`, [...values, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update BOM', details: err.message });
  }
});

router.delete('/boms/:id', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const result = await query(`DELETE FROM packaging_boms WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete BOM', details: err.message });
  }
});

router.post('/boms/:id/lines', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const { packaging_item_id, qty, qty_confirmed, notes } = req.body;
    if (!packaging_item_id) return res.status(400).json({ error: 'packaging_item_id is required' });
    const result = await query(
      `INSERT INTO packaging_bom_lines (id, bom_id, packaging_item_id, qty, qty_confirmed, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [uuid(), req.params.id, packaging_item_id, qty ?? 1, qty_confirmed !== false, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to add BOM line', details: err.message });
  }
});

router.patch('/boms/:id/lines/:lineId', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const body = pick(req.body, ['packaging_item_id', 'qty', 'qty_confirmed', 'notes', 'extra']);
    const { sets, values, next } = setClause(body);
    const result = await query(
      `UPDATE packaging_bom_lines SET ${sets.join(', ')} WHERE id = $${next} AND bom_id = $${next + 1} RETURNING *`,
      [...values, req.params.lineId, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update BOM line', details: err.message });
  }
});

router.delete('/boms/:id/lines/:lineId', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const result = await query(`DELETE FROM packaging_bom_lines WHERE id = $1 AND bom_id = $2 RETURNING id`, [req.params.lineId, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete BOM line', details: err.message });
  }
});

router.get('/links', async (req: Request, res: Response) => {
  try {
    const { from_kind, from_key, to_kind, role } = req.query;
    const conds = ['1=1'];
    const params: any[] = [];
    if (from_kind) { params.push(from_kind); conds.push(`from_kind = $${params.length}`); }
    if (from_key) { params.push(from_key); conds.push(`from_key = $${params.length}`); }
    if (to_kind) { params.push(to_kind); conds.push(`to_kind = $${params.length}`); }
    if (role) { params.push(role); conds.push(`role = $${params.length}`); }
    const result = await query(`SELECT * FROM packaging_links WHERE ${conds.join(' AND ')} ORDER BY created_at DESC`, params);
    res.json({ links: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list links' });
  }
});

router.post('/links', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const { from_kind, from_key, to_kind, to_key, role, extra } = req.body;
    if (!from_kind || !from_key || !to_kind || !to_key) {
      return res.status(400).json({ error: 'from_kind, from_key, to_kind and to_key are required' });
    }
    if (!LINK_KINDS.includes(from_kind) || !LINK_KINDS.includes(to_kind)) {
      return res.status(400).json({ error: `kinds must be one of ${LINK_KINDS.join(', ')}` });
    }
    const result = await query(
      `INSERT INTO packaging_links (id, from_kind, from_key, to_kind, to_key, role, extra)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (from_kind, from_key, to_kind, to_key, role) DO UPDATE SET extra = EXCLUDED.extra
       RETURNING *`,
      [uuid(), from_kind, from_key, to_kind, to_key, role || 'uses', extra || {}]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create link', details: err.message });
  }
});

router.delete('/links/:id', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const result = await query(`DELETE FROM packaging_links WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete link', details: err.message });
  }
});

router.get('/movements', async (req: Request, res: Response) => {
  try {
    const { item_id } = req.query;
    const params: any[] = [];
    let where = '';
    if (item_id) { params.push(item_id); where = `WHERE m.packaging_item_id = $1`; }
    const result = await query(
      `SELECT m.*, i.code, i.name FROM packaging_stock_movements m
       JOIN packaging_items i ON i.id = m.packaging_item_id
       ${where} ORDER BY m.created_at DESC LIMIT 200`,
      params
    );
    res.json({ movements: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list movements' });
  }
});

router.post('/movements', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const { packaging_item_id, movement_type, qty, unit_cost_gbp, supplier_order_ref, reason } = req.body;
    if (!packaging_item_id || !movement_type || qty == null) {
      return res.status(400).json({ error: 'packaging_item_id, movement_type and qty are required' });
    }
    if (!MOVE_TYPES.includes(movement_type)) return res.status(400).json({ error: `movement_type must be one of ${MOVE_TYPES.join(', ')}` });
    const signed = movement_type === 'pack_usage' || movement_type === 'write_off' ? -Math.abs(Number(qty)) : Number(qty);
    const userId = (req as any).user?.id || null;
    const move = await query(
      `INSERT INTO packaging_stock_movements (id, packaging_item_id, movement_type, qty, unit_cost_gbp, supplier_order_ref, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [uuid(), packaging_item_id, movement_type, signed, unit_cost_gbp || null, supplier_order_ref || null, reason || null, userId]
    );
    await query(
      `UPDATE packaging_items SET stock_on_hand = stock_on_hand + $2, updated_at = NOW() WHERE id = $1`,
      [packaging_item_id, signed]
    );
    res.status(201).json(move.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to record movement', details: err.message });
  }
});

router.get('/gaps', async (_req: Request, res: Response) => {
  try {
    const [needs, unchecked, noCost, lowStock, frequentFree] = await Promise.all([
      query(`SELECT product_code, product_title, method FROM packaging_product_specs WHERE is_active AND method = 'needs_packaging' ORDER BY product_code`),
      query(`SELECT product_code, product_title FROM packaging_product_specs WHERE is_active AND stocked AND NOT packed_dims_checked ORDER BY product_code`),
      query(`SELECT code, name, item_type FROM packaging_items WHERE is_active AND unit_cost_gbp IS NULL ORDER BY code`),
      query(`SELECT code, name, stock_on_hand, reorder_level FROM packaging_items WHERE is_active AND reorder_level IS NOT NULL AND stock_on_hand <= reorder_level ORDER BY code`),
      query(
        `SELECT i.code, i.name, COUNT(*)::int AS free_choice_count
         FROM pick_list_package_packaging p
         JOIN packaging_items i ON i.id = p.packaging_item_id
         WHERE p.was_free_choice AND p.created_at > NOW() - INTERVAL '30 days'
         GROUP BY i.code, i.name ORDER BY free_choice_count DESC LIMIT 20`
      ),
    ]);
    res.json({
      needs_packaging: needs.rows,
      unchecked_dims: unchecked.rows,
      missing_cost: noCost.rows,
      below_reorder: lowStock.rows,
      frequent_free_choice: frequentFree.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to build gaps report' });
  }
});

router.get('/shipping-rates', async (_req: Request, res: Response) => {
  try {
    const cards = await query(`SELECT * FROM shipping_rate_cards ORDER BY courier_code, service_code, name`);
    const rows = await query(`SELECT * FROM shipping_rate_rows ORDER BY zone, parcel_index, min_kg`);
    const surcharges = await query(`SELECT * FROM shipping_rate_surcharges ORDER BY surcharge_type`);
    const byCard = new Map<string, any>();
    for (const c of cards.rows) byCard.set(c.id, { ...c, rows: [], surcharges: [] });
    for (const r of rows.rows) byCard.get(r.card_id)?.rows.push(r);
    for (const s of surcharges.rows) byCard.get(s.card_id)?.surcharges.push(s);
    res.json({ cards: [...byCard.values()] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list shipping rates' });
  }
});

router.post('/shipping-rates', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const { courier_code, service_code, name, currency, effective_from, effective_to, notes, extra, rows, surcharges } = req.body;
    if (!courier_code || !service_code || !name) return res.status(400).json({ error: 'courier_code, service_code and name are required' });
    const card = await query(
      `INSERT INTO shipping_rate_cards (id, courier_code, service_code, name, currency, effective_from, effective_to, notes, extra)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [uuid(), courier_code, service_code, name, currency || 'GBP', effective_from || null, effective_to || null, notes || null, extra || {}]
    );
    const cardId = card.rows[0].id;
    if (Array.isArray(rows)) {
      for (const r of rows) {
        await query(
          `INSERT INTO shipping_rate_rows (id, card_id, zone, min_kg, max_kg, amount_gbp, per_kg_gbp, parcel_index)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [uuid(), cardId, r.zone, r.min_kg ?? 0, r.max_kg ?? null, r.amount_gbp ?? 0, r.per_kg_gbp ?? 0, r.parcel_index ?? 1]
        );
      }
    }
    if (Array.isArray(surcharges)) {
      for (const s of surcharges) {
        await query(
          `INSERT INTO shipping_rate_surcharges (id, card_id, surcharge_type, min_value, max_value, amount_gbp)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [uuid(), cardId, s.surcharge_type, s.min_value ?? null, s.max_value ?? null, s.amount_gbp ?? 0]
        );
      }
    }
    res.status(201).json(card.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create rate card', details: err.message });
  }
});

router.patch('/shipping-rates/:id', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const body = pick(req.body, ['courier_code', 'service_code', 'name', 'currency', 'effective_from', 'effective_to', 'is_active', 'notes', 'extra']);
    body.updated_at = new Date();
    const { sets, values, next } = setClause(body);
    const result = await query(`UPDATE shipping_rate_cards SET ${sets.join(', ')} WHERE id = $${next} RETURNING *`, [...values, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update rate card', details: err.message });
  }
});

router.post('/shipping-rates/:id/rows', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const { zone, min_kg, max_kg, amount_gbp, per_kg_gbp, parcel_index } = req.body;
    if (!zone) return res.status(400).json({ error: 'zone is required' });
    const result = await query(
      `INSERT INTO shipping_rate_rows (id, card_id, zone, min_kg, max_kg, amount_gbp, per_kg_gbp, parcel_index)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [uuid(), req.params.id, zone, min_kg ?? 0, max_kg ?? null, amount_gbp ?? 0, per_kg_gbp ?? 0, parcel_index ?? 1]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to add rate row', details: err.message });
  }
});

router.patch('/shipping-rates/:id/rows/:rowId', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const body = pick(req.body, ['zone', 'min_kg', 'max_kg', 'amount_gbp', 'per_kg_gbp', 'parcel_index', 'extra']);
    const { sets, values, next } = setClause(body);
    const result = await query(
      `UPDATE shipping_rate_rows SET ${sets.join(', ')} WHERE id = $${next} AND card_id = $${next + 1} RETURNING *`,
      [...values, req.params.rowId, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update rate row', details: err.message });
  }
});

router.delete('/shipping-rates/:id/rows/:rowId', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const result = await query(`DELETE FROM shipping_rate_rows WHERE id = $1 AND card_id = $2 RETURNING id`, [req.params.rowId, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete rate row', details: err.message });
  }
});

router.post('/shipping-rates/:id/surcharges', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const { surcharge_type, min_value, max_value, amount_gbp } = req.body;
    if (!surcharge_type) return res.status(400).json({ error: 'surcharge_type is required' });
    const result = await query(
      `INSERT INTO shipping_rate_surcharges (id, card_id, surcharge_type, min_value, max_value, amount_gbp)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [uuid(), req.params.id, surcharge_type, min_value ?? null, max_value ?? null, amount_gbp ?? 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to add surcharge', details: err.message });
  }
});

router.patch('/shipping-rates/:id/surcharges/:surchargeId', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const body = pick(req.body, ['surcharge_type', 'min_value', 'max_value', 'amount_gbp', 'extra']);
    const { sets, values, next } = setClause(body);
    const result = await query(
      `UPDATE shipping_rate_surcharges SET ${sets.join(', ')} WHERE id = $${next} AND card_id = $${next + 1} RETURNING *`,
      [...values, req.params.surchargeId, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update surcharge', details: err.message });
  }
});

router.delete('/shipping-rates/:id/surcharges/:surchargeId', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const result = await query(
      `DELETE FROM shipping_rate_surcharges WHERE id = $1 AND card_id = $2 RETURNING id`,
      [req.params.surchargeId, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete surcharge', details: err.message });
  }
});

router.get('/fields', async (req: Request, res: Response) => {
  try {
    const entity = req.query.entity ? String(req.query.entity) : null;
    const result = entity
      ? await query(`SELECT * FROM packaging_field_defs WHERE entity = $1 ORDER BY field_key`, [entity])
      : await query(`SELECT * FROM packaging_field_defs ORDER BY entity, field_key`);
    res.json({ fields: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list fields' });
  }
});

router.post('/fields', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const { entity, field_key, label, data_type, extra } = req.body;
    if (!entity || !field_key) return res.status(400).json({ error: 'entity and field_key are required' });
    const result = await query(
      `INSERT INTO packaging_field_defs (id, entity, field_key, label, data_type, extra)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [uuid(), entity, field_key, label || field_key, data_type || 'text', extra || {}]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create field', details: err.message });
  }
});

router.patch('/fields/:id', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const body = pick(req.body, ['entity', 'field_key', 'label', 'data_type', 'extra']);
    const { sets, values, next } = setClause(body);
    const result = await query(`UPDATE packaging_field_defs SET ${sets.join(', ')} WHERE id = $${next} RETURNING *`, [...values, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update field', details: err.message });
  }
});

router.delete('/fields/:id', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const result = await query(`DELETE FROM packaging_field_defs WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete field', details: err.message });
  }
});

router.post('/import-snapshot', requirePermission('manage_settings'), async (req: Request, res: Response) => {
  try {
    const dryRun = String(req.query.dryRun ?? req.body?.dryRun ?? 'true') !== 'false';
    const result = await importPackagingSnapshot({ dryRun, sourceDir: req.body?.sourceDir });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: 'Import failed', details: err.message });
  }
});

router.post('/seed-shipping-rates', requirePermission('manage_settings'), async (_req: Request, res: Response) => {
  try {
    const result = await seedDpdRateCards();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: 'Seed failed', details: err.message });
  }
});

export default router;
