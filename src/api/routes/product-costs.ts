/**
 * Product Costs API
 * Per-SKU cost basis, used by reports.ts (gross margin / COGS / stock valuation) and
 * pick-lists.ts (stamped onto each line at dispatch time). Split out from sku_mappings
 * on 2026-09-03 — cost basis is unrelated to translating external NW/Genero codes.
 *
 * GET /api/product-costs        — list every SKU that has a cost set
 * PUT /api/product-costs/:sku   — upsert the cost for one SKU
 */
import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, requireRole, AuthRequest } from '../../middleware/auth.js';

const router = express.Router();

router.get('/', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(`SELECT medusa_sku, unit_cost_gbp, updated_at FROM product_costs ORDER BY medusa_sku`);
    res.json({ costs: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch product costs' });
  }
});

router.put('/:sku', authMiddleware, requireRole(['MANAGER','ADMIN']), async (req: AuthRequest, res: Response) => {
  try {
    const { unit_cost_gbp } = req.body;
    if (unit_cost_gbp !== null && (typeof unit_cost_gbp !== 'number' || Number.isNaN(unit_cost_gbp))) {
      return res.status(400).json({ error: 'unit_cost_gbp must be a number or null' });
    }
    const result = await query(
      `INSERT INTO product_costs (medusa_sku, unit_cost_gbp, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (medusa_sku) DO UPDATE SET unit_cost_gbp = EXCLUDED.unit_cost_gbp, updated_at = NOW()
       RETURNING *`,
      [req.params.sku, unit_cost_gbp]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update product cost' });
  }
});

export default router;
