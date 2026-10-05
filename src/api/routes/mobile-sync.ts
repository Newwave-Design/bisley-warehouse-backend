/**
 * Mobile sync API — reference data for the native Android handheld app so it can look up barcodes, products and
 * stock with no connection.
 *
 * GET /api/mobile-sync/reference — barcodes, products, bays and current stock in one compact download.
 * POST /api/mobile-sync/barcodes — assign a scanned, unrecognised code to a product.
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';

const router = express.Router();

router.get('/reference', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const [barcodes, products, locations, stock] = await Promise.all([
      query(
        `SELECT barcode, product_sku AS sku, product_name, colour_code, colour_name, thumbnail_url AS thumbnail
           FROM barcode_mappings WHERE is_active = true`
      ),
      query(
        `SELECT variant_sku AS sku, product_title AS title, colour_code, colour_name, variant_thumbnail AS thumbnail, nw_code
           FROM wms_products WHERE is_archived = false`
      ),
      query(
        `SELECT id, location_code, aisle_code, bay_code, bin_code, description, max_weight_kg::float8 AS max_weight_kg
           FROM warehouse_locations WHERE is_active = true`
      ),
      query(
        `SELECT wi.product_sku AS sku, wi.colour_code, wl.location_code, wi.quantity, wi.quantity_reserved
           FROM warehouse_inventory wi JOIN warehouse_locations wl ON wl.id = wi.location_id
          WHERE wi.quantity > 0`
      ),
    ]);
    res.json({
      generated_at: new Date().toISOString(),
      barcodes: barcodes.rows,
      products: products.rows,
      locations: locations.rows,
      stock: stock.rows,
    });
  } catch (err) {
    console.error('Mobile reference sync error:', err);
    res.status(500).json({ error: 'Failed to build reference data' });
  }
});

/**
 * POST /api/mobile-sync/barcodes { barcode, sku }
 * Permanently assigns a scanned code that the system did not recognise to a product (the handheld's
 * "search and assign" step). Idempotent for the same SKU; refuses a code already in use by another SKU.
 */
router.post('/barcodes', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const barcode = String(req.body?.barcode ?? '').trim();
    const sku = String(req.body?.sku ?? '').trim();
    if (!barcode || !sku) return res.status(400).json({ error: 'barcode and sku required' });
    if (barcode.length > 100) return res.status(400).json({ error: 'Barcode is too long' });

    const product = await query(
      `SELECT variant_sku, product_title, colour_code, colour_name, variant_thumbnail, medusa_product_id, medusa_variant_id
         FROM wms_products WHERE variant_sku = $1 AND is_archived = false LIMIT 1`,
      [sku]
    );
    const p = product.rows[0];
    if (!p) return res.status(404).json({ error: `Product not found: ${sku}` });

    const existing = await query(`SELECT product_sku, is_active FROM barcode_mappings WHERE barcode = $1`, [barcode]);
    const ex = existing.rows[0];
    if (ex?.is_active && ex.product_sku !== p.variant_sku) {
      return res.status(409).json({ error: `Barcode ${barcode} is already assigned to ${ex.product_sku}` });
    }

    await query(
      `INSERT INTO barcode_mappings
         (barcode, product_sku, colour_code, colour_name, product_name, thumbnail_url, medusa_product_id, medusa_variant_id, assigned_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (barcode) DO UPDATE SET
         product_sku = EXCLUDED.product_sku, colour_code = EXCLUDED.colour_code, colour_name = EXCLUDED.colour_name,
         product_name = EXCLUDED.product_name, thumbnail_url = EXCLUDED.thumbnail_url,
         medusa_product_id = EXCLUDED.medusa_product_id, medusa_variant_id = EXCLUDED.medusa_variant_id,
         is_active = true, assigned_by = EXCLUDED.assigned_by, updated_at = NOW()`,
      [barcode, p.variant_sku, p.colour_code, p.colour_name, p.product_title, p.variant_thumbnail, p.medusa_product_id, p.medusa_variant_id, req.user?.email ?? null]
    );
    console.log(`[mobile-sync] Barcode ${barcode} assigned to ${p.variant_sku} by ${req.user?.email}`);
    res.json({ success: true, barcode, sku: p.variant_sku });
  } catch (err) {
    console.error('Barcode assignment error:', err);
    res.status(500).json({ error: 'Failed to assign barcode' });
  }
});

export default router;
