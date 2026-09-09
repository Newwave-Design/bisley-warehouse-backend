/**
 * Box Size Requirements API
 *
 * GET /api/box-sizes — reference packaging box sizes per product range (from Ovara's
 * measurements), each tagged to real Medusa products by matching title/handle rules.
 */

import express, { Response } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { query } from '../../db/index.js';

const router = express.Router();

interface MatchRule { field: 'title' | 'handle'; contains: string }
interface MatchedProduct {
  id: string; title: string; handle: string; status: string; thumbnail: string | null
  variant_count: number; total_stock: number
}

function matchesRules(rules: MatchRule[], title: string, handle: string): boolean {
  if (!Array.isArray(rules) || !rules.length) return false;
  const t = title.toLowerCase();
  const h = handle.toLowerCase();
  return rules.some(r => (r.field === 'handle' ? h : t).includes(String(r.contains).toLowerCase()));
}

router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const [requirementsResult, productsResult] = await Promise.all([
      query(`SELECT * FROM box_size_requirements ORDER BY sort_order ASC, product_range ASC`),
      query(`
        SELECT medusa_product_id,
               MAX(product_title) AS product_title,
               MAX(product_handle) AS product_handle,
               MAX(product_status) AS product_status,
               MAX(product_thumbnail) AS product_thumbnail,
               COUNT(*)::int AS variant_count,
               COALESCE(SUM(inventory_qty), 0)::int AS total_stock
        FROM wms_products
        GROUP BY medusa_product_id
      `),
    ]);

    const products: MatchedProduct[] = productsResult.rows.map((r: any) => ({
      id: r.medusa_product_id,
      title: r.product_title ?? '',
      handle: r.product_handle ?? '',
      status: r.product_status,
      thumbnail: r.product_thumbnail,
      variant_count: r.variant_count,
      total_stock: r.total_stock,
    }));

    const matchedProductIds = new Set<string>();
    const requirements = requirementsResult.rows.map((row: any) => {
      const rules: MatchRule[] = row.match_rules ?? [];
      const matched = products.filter(p => matchesRules(rules, p.title, p.handle));
      for (const p of matched) matchedProductIds.add(p.id);
      return {
        id: row.id,
        code: row.code,
        product_range: row.product_range,
        product_label: row.product_label,
        width_mm: row.width_mm,
        depth_mm: row.depth_mm,
        height_mm: row.height_mm,
        protection_type: row.protection_type,
        foam_thickness_mm: row.foam_thickness_mm,
        box_internal_width_mm: row.box_internal_width_mm,
        box_internal_depth_mm: row.box_internal_depth_mm,
        box_internal_height_mm: row.box_internal_height_mm,
        notes: row.notes,
        matched_products: matched,
      };
    });

    // Published products with no box size on record at all — a gap for ops to fill in.
    const unmatchedPublishedProducts = products.filter(p => p.status === 'published' && !matchedProductIds.has(p.id));

    res.json({
      requirements,
      unmatched_published_products: unmatchedPublishedProducts,
      stats: {
        requirements_count: requirements.length,
        zero_match_requirements_count: requirements.filter(r => r.matched_products.length === 0).length,
        unmatched_published_count: unmatchedPublishedProducts.length,
      },
    });
  } catch (err) {
    console.error('Box sizes fetch error:', err);
    res.status(500).json({ error: 'Failed to load box size requirements', detail: (err as Error).message });
  }
});

export default router;
