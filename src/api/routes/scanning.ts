/**
 * Warehouse Scanning API
 * Endpoints for barcode scanning, intake, and picking
 */

import express, { Request, Response } from 'express';
import { parseSupercode, validateBarcodeExists } from '../../modules/scanning/barcode.js';
import { query } from '../../db/index.js';
import { authMiddleware } from '../../middleware/auth.js';

const router = express.Router();

/**
 * POST /api/scan
 * Process a barcode scan input
 * 
 * Used by: Mark at intake/picking stations
 * Input: { barcode: "H2910NL-BLK" }
 * Output: { isValid, productSku, colourCode, error?, ... }
 */
router.post('/scan', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { barcode } = req.body;

    if (!barcode) {
      return res.status(400).json({ error: 'Barcode required' });
    }

    // Parse the barcode
    let parsed = parseSupercode(barcode);

    // Validate against database
    if (parsed.isValid) {
      parsed = await validateBarcodeExists(parsed, query);
    }

    // Log the scan attempt (audit trail)
    if (parsed.isValid) {
      await query(
        `INSERT INTO audit_log (action, entity_type, entity_id, user_id, new_values, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          'BARCODE_SCANNED',
          'barcode',
          parsed.productSku,
          (req as any).user.id,
          JSON.stringify(parsed),
        ]
      );
    }

    return res.json(parsed);
  } catch (error) {
    console.error('Scan error:', error);
    return res.status(500).json({ error: 'Scan processing failed' });
  }
});

/**
 * POST /api/inventory/receive
 * Log receipt of stock from supplier
 * 
 * Input: {
 *   locationCode: "A1",
 *   productSku: "H2910NL",
 *   colourCode: "BLK",
 *   quantity: 10,
 *   notes?: "Delivery from supplier"
 * }
 */
router.post('/inventory/receive', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { locationCode, productSku, colourCode, quantity, notes } = req.body;

    // Validate required fields
    if (!locationCode || !productSku || !quantity) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get location ID
    const locationResult = await query(
      'SELECT id FROM warehouse_locations WHERE location_code = $1',
      [locationCode]
    );

    if (locationResult.rows.length === 0) {
      return res.status(404).json({ error: `Location not found: ${locationCode}` });
    }

    const locationId = locationResult.rows[0].id;

    // Upsert inventory (insert or update)
    const inventoryResult = await query(
      `INSERT INTO warehouse_inventory 
       (location_id, product_sku, colour_code, quantity)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (location_id, product_sku, COALESCE(colour_code, ''))
       DO UPDATE SET quantity = quantity + $4, updated_at = NOW()
       RETURNING *`,
      [locationId, productSku, colourCode || null, quantity]
    );

    // Log the movement
    await query(
      `INSERT INTO warehouse_movements 
       (movement_type, location_id, product_sku, colour_code, quantity, notes, performed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'RECEIVE',
        locationId,
        productSku,
        colourCode || null,
        quantity,
        notes || null,
        (req as any).user.id,
      ]
    );

    return res.json({
      success: true,
      inventory: inventoryResult.rows[0],
      message: `Received ${quantity} units of ${productSku} at ${locationCode}`,
    });
  } catch (error) {
    console.error('Receive error:', error);
    return res.status(500).json({ error: 'Receive failed' });
  }
});

/**
 * GET /api/inventory/location/:locationCode
 * View current stock at a specific bin/location
 */
router.get('/inventory/location/:locationCode', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { locationCode } = req.params;

    const result = await query(
      `SELECT 
         wl.location_code,
         wi.product_sku,
         wi.colour_code,
         wi.quantity,
         wi.quantity_reserved,
         wi.quantity_available
       FROM warehouse_inventory wi
       JOIN warehouse_locations wl ON wl.id = wi.location_id
       WHERE wl.location_code = $1
       ORDER BY wi.product_sku, wi.colour_code`,
      [locationCode]
    );

    return res.json({
      location: locationCode,
      items: result.rows,
      totalItems: result.rows.length,
    });
  } catch (error) {
    console.error('Inventory lookup error:', error);
    return res.status(500).json({ error: 'Inventory lookup failed' });
  }
});

/**
 * GET /api/inventory/search/:productSku
 * Find where a SKU is stored
 */
router.get('/inventory/search/:productSku', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { productSku } = req.params;

    const result = await query(
      `SELECT 
         wl.location_code,
         wi.product_sku,
         wi.colour_code,
         wi.quantity,
         wi.quantity_available
       FROM warehouse_inventory wi
       JOIN warehouse_locations wl ON wl.id = wi.location_id
       WHERE wi.product_sku = $1 AND wi.quantity_available > 0
       ORDER BY wl.location_code`,
      [productSku]
    );

    return res.json({
      sku: productSku,
      locations: result.rows,
    });
  } catch (error) {
    console.error('SKU search error:', error);
    return res.status(500).json({ error: 'SKU search failed' });
  }
});

export default router;
