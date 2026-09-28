/**
 * Barcode Test Generator
 * 
 * Generates ~50 real product barcodes for testing scanner functionality.
 * Returns barcodes grouped by product range, with colour and SKU info.
 */

import { Router } from 'express';
import { query } from '@/db/client';
import { authMiddleware, requirePermission } from '@/middleware/auth';

const router = Router();

router.use(authMiddleware);

/**
 * GET /api/barcode-test/samples
 * 
 * Returns ~50 sample barcodes from real products, grouped by range.
 * Includes: barcode, product SKU, colour code, colour name, product name
 */
router.get('/samples', async (req, res) => {
  try {
    // Query real barcodes, grouped by product range, varying colours
    // Select diverse product types and colours for comprehensive testing
    const barcodes = await query`
      SELECT DISTINCT ON (bm.product_sku)
        bm.barcode,
        bm.product_sku,
        bm.colour_code,
        bm.colour_name,
        bm.product_name,
        wp.variant_thumbnail,
        -- Extract product range prefix (e.g., "046P" from "046P-av1")
        SUBSTRING(bm.product_sku FROM 1 FOR POSITION('-' IN bm.product_sku) - 1) as product_range
      FROM barcode_mappings bm
      LEFT JOIN wms_products wp ON wp.variant_sku = bm.product_sku
      WHERE bm.is_active = true
        AND bm.barcode IS NOT NULL
        AND bm.barcode <> ''
      ORDER BY bm.product_sku, bm.barcode
      LIMIT 50
    `;

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
    console.error('Barcode test query failed:', err);
    res.status(500).json({ 
      error: err.message || 'Failed to fetch barcode samples'
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
router.get('/balanced', async (req, res) => {
  try {
    // Strategy: Pick 2-4 distinct SKU prefixes, then get 2-3 colour variants of each
    const query1 = await query`
      WITH product_ranges AS (
        SELECT DISTINCT 
          SUBSTRING(product_sku FROM 1 FOR POSITION('-' IN product_sku) - 1) as range_code
        FROM wms_products
        WHERE is_archived = false
        LIMIT 12
      ),
      colour_samples AS (
        SELECT DISTINCT ON (wp.product_sku)
          bm.barcode,
          bm.product_sku,
          bm.colour_code,
          bm.colour_name,
          bm.product_name,
          wp.variant_thumbnail,
          SUBSTRING(bm.product_sku FROM 1 FOR POSITION('-' IN bm.product_sku) - 1) as product_range,
          ROW_NUMBER() OVER (
            PARTITION BY SUBSTRING(bm.product_sku FROM 1 FOR POSITION('-' IN bm.product_sku) - 1)
            ORDER BY bm.barcode
          ) as colour_order
        FROM barcode_mappings bm
        LEFT JOIN wms_products wp ON wp.variant_sku = bm.product_sku
        WHERE bm.is_active = true
          AND SUBSTRING(bm.product_sku FROM 1 FOR POSITION('-' IN bm.product_sku) - 1) IN (
            SELECT range_code FROM product_ranges
          )
      )
      SELECT * FROM colour_samples
      WHERE colour_order <= 4
      ORDER BY product_range, colour_order
    `;

    if (query1.length === 0) {
      return res.json({ 
        samples: [],
        grouped: {},
        count: 0
      });
    }

    // Group by product range
    const grouped: Record<string, typeof query1> = {};
    query1.forEach(item => {
      const range = item.product_range || 'Unknown';
      if (!grouped[range]) grouped[range] = [];
      grouped[range].push(item);
    });

    res.json({
      samples: query1,
      grouped,
      count: query1.length,
      groups: Object.keys(grouped).length
    });
  } catch (err: any) {
    console.error('Balanced barcode query failed:', err);
    res.status(500).json({ 
      error: err.message || 'Failed to fetch balanced barcode samples'
    });
  }
});

export default router;
