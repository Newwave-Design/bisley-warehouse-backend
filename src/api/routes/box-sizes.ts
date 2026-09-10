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

interface MatchRule { field: 'title' | 'handle'; contains: string; width_mm?: number }
interface MatchedProduct {
  id: string; title: string; handle: string; status: string; thumbnail: string | null
  variant_count: number; total_stock: number
}
interface VariantRow {
  product_id: string; title: string; handle: string; status: string; thumbnail: string | null
  sku: string; width_mm: number | null; weight_grams: number | null; inventory_qty: number
}

function matchesRules(rules: MatchRule[], v: VariantRow): boolean {
  if (!Array.isArray(rules) || !rules.length) return false;
  const t = v.title.toLowerCase();
  const h = v.handle.toLowerCase();
  return rules.some(r => {
    const textMatch = (r.field === 'handle' ? h : t).includes(String(r.contains).toLowerCase());
    if (!textMatch) return false;
    return r.width_mm == null || v.width_mm === r.width_mm;
  });
}

router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const [requirementsResult, variantsResult] = await Promise.all([
      query(`SELECT * FROM box_size_requirements ORDER BY sort_order ASC, product_range ASC`),
      query(`
        SELECT medusa_product_id AS product_id, product_title, product_handle, product_status, product_thumbnail,
               variant_sku, COALESCE(variant_width_mm, width_mm) AS width_mm,
               COALESCE(variant_weight_grams, weight_grams) AS weight_grams, inventory_qty
        FROM wms_products
      `),
    ]);

    const variants: VariantRow[] = variantsResult.rows.map((r: any) => ({
      product_id: r.product_id,
      title: r.product_title ?? '',
      handle: r.product_handle ?? '',
      status: r.product_status,
      thumbnail: r.product_thumbnail,
      sku: r.variant_sku,
      width_mm: r.width_mm,
      weight_grams: r.weight_grams,
      inventory_qty: r.inventory_qty ?? 0,
    }));

    // Product-level summary, used for the "products with no box size at all" gap list below.
    const productsById = new Map<string, MatchedProduct>();
    for (const v of variants) {
      let p = productsById.get(v.product_id);
      if (!p) { p = { id: v.product_id, title: v.title, handle: v.handle, status: v.status, thumbnail: v.thumbnail, variant_count: 0, total_stock: 0 }; productsById.set(v.product_id, p); }
      p.variant_count++;
      p.total_stock += v.inventory_qty;
    }
    const products = [...productsById.values()];

    const matchedProductIds = new Set<string>();
    const requirements = requirementsResult.rows.map((row: any) => {
      const rules: MatchRule[] = row.match_rules ?? [];
      const matchingVariants = variants.filter(v => matchesRules(rules, v));

      // Roll matching variants back up to their product, but only counting the variants that
      // actually matched (e.g. a width-specific rule should only show that width's variants).
      const matchedByProduct = new Map<string, MatchedProduct>();
      let minWeightGrams: number | null = null;
      let maxWeightGrams: number | null = null;
      for (const v of matchingVariants) {
        let p = matchedByProduct.get(v.product_id);
        if (!p) { p = { id: v.product_id, title: v.title, handle: v.handle, status: v.status, thumbnail: v.thumbnail, variant_count: 0, total_stock: 0 }; matchedByProduct.set(v.product_id, p); }
        p.variant_count++;
        p.total_stock += v.inventory_qty;
        matchedProductIds.add(v.product_id);
        if (v.weight_grams != null) {
          minWeightGrams = minWeightGrams == null ? v.weight_grams : Math.min(minWeightGrams, v.weight_grams);
          maxWeightGrams = maxWeightGrams == null ? v.weight_grams : Math.max(maxWeightGrams, v.weight_grams);
        }
      }

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
        min_product_weight_kg: minWeightGrams != null ? minWeightGrams / 1000 : null,
        max_product_weight_kg: maxWeightGrams != null ? maxWeightGrams / 1000 : null,
        matched_products: [...matchedByProduct.values()],
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
