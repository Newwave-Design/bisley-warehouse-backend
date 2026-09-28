/**
 * Barcode Test Generator
 * 
 * Generates ~50 real product barcodes for testing scanner functionality.
 * Returns barcodes grouped by product range, with colour and SKU info.
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { getLogger } from '../../lib/logger.js';

const router = express.Router();
const logger = getLogger('barcode-test');

router.use(authMiddleware);

/**
 * GET /api/barcode-test/samples
 * 
 * Returns ~50 sample barcodes from real products, grouped by range.
 * Includes: barcode, product SKU, colour code, colour name, product name
 */
router.get('/samples', async (req: AuthRequest, res: Response) => {
  try {
    // Query real barcodes from published products only
    // Only select barcodes that have matching products in wms_products (curated published list)
    const result = await query(
      `SELECT 
        bm.barcode,
        bm.product_sku,
        bm.colour_code,
        bm.colour_name,
        bm.product_name,
        wp.variant_thumbnail,
        SUBSTRING(bm.product_sku FROM 1 FOR POSITION('-' IN bm.product_sku) - 1) as product_range
      FROM barcode_mappings bm
      INNER JOIN wms_products wp ON wp.variant_sku = bm.product_sku
      WHERE bm.is_active = true
        AND bm.barcode IS NOT NULL
        AND bm.barcode <> ''
        AND wp.is_archived = false
      ORDER BY bm.product_sku, bm.colour_name
      LIMIT 50`
    );

    const barcodes = result.rows;

    if (barcodes.length === 0) {
      return res.json({ 
        samples: [],
        grouped: {},
        count: 0,
        message: 'No barcodes found in database'
      });
    }

    // Group by product range
    const grouped: Record<string, typeof barcodes> = {};
    barcodes.forEach(barcode => {
      const range = barcode.product_range || 'Unknown';
      if (!grouped[range]) grouped[range] = [];
      grouped[range].push(barcode);
    });

    res.json({
      samples: barcodes,
      grouped,
      count: barcodes.length,
      groups: Object.keys(grouped).length
    });
  } catch (err: any) {
    logger.error(`Barcode test query failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    res.status(500).json({ 
      error: 'Failed to fetch barcode samples'
    });
  }
});

/**
 * GET /api/barcode-test/balanced
 * 
 * Returns carefully selected ~50 barcodes with:
 * - Multiple product ranges (filing, multidrawer, essentials, etc.)
 * - Varied colours per range (e.g., black, white, blue, custom)
 * - Balanced representation across product categories
 */
router.get('/balanced', async (req: AuthRequest, res: Response) => {
  try {
    // Strategy: Pick 12 distinct SKU prefixes from published products, then get 2-4 colour variants
    const result = await query(
      `WITH product_ranges AS (
        SELECT DISTINCT 
          SUBSTRING(variant_sku FROM 1 FOR POSITION('-' IN variant_sku) - 1) as range_code
        FROM wms_products
        WHERE is_archived = false
        ORDER BY range_code
        LIMIT 12
      ),
      barcode_with_ranges AS (
        SELECT 
          bm.barcode,
          bm.product_sku,
          bm.colour_code,
          bm.colour_name,
          bm.product_name,
          wp.variant_thumbnail,
          SUBSTRING(bm.product_sku FROM 1 FOR POSITION('-' IN bm.product_sku) - 1) as product_range,
          ROW_NUMBER() OVER (
            PARTITION BY SUBSTRING(bm.product_sku FROM 1 FOR POSITION('-' IN bm.product_sku) - 1)
            ORDER BY bm.product_sku ASC
          ) as colour_order
        FROM barcode_mappings bm
        INNER JOIN wms_products wp ON wp.variant_sku = bm.product_sku
        WHERE bm.is_active = true
          AND bm.barcode IS NOT NULL
          AND bm.barcode <> ''
          AND wp.is_archived = false
      )
      SELECT 
        barcode,
        product_sku,
        colour_code,
        colour_name,
        product_name,
        variant_thumbnail,
        product_range,
        colour_order
      FROM barcode_with_ranges
      WHERE product_range IN (SELECT range_code FROM product_ranges)
        AND colour_order <= 4
      ORDER BY product_range ASC, colour_order ASC`
    );

    const samples = result.rows;

    if (samples.length === 0) {
      return res.json({ 
        samples: [],
        grouped: {},
        count: 0
      });
    }

    // Group by product range
    const grouped: Record<string, typeof samples> = {};
    samples.forEach(item => {
      const range = item.product_range || 'Unknown';
      if (!grouped[range]) grouped[range] = [];
      grouped[range].push(item);
    });

    res.json({
      samples,
      grouped,
      count: samples.length,
      groups: Object.keys(grouped).length
    });
  } catch (err: any) {
    logger.error(`Balanced barcode query failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    res.status(500).json({ 
      error: 'Failed to fetch balanced barcode samples'
    });
  }
});

export default router;
