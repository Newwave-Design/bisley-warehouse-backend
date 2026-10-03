/**
 * Mobile sync API — reference data for the native Android handheld app so it can look up barcodes, products and
 * stock with no connection.
 *
 * GET /api/mobile-sync/reference — barcodes, products, bays and current stock in one compact download.
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
      query(`SELECT location_code, bay_code, bin_code FROM warehouse_locations WHERE is_active = true`),
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

export default router;
