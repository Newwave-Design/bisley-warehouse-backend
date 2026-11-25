/**
 * Mobile sync API — reference data for the native Android handheld app so it can look up barcodes, products and
 * stock with no connection.
 *
 * GET /api/mobile-sync/reference — barcodes, products, bays and current stock in one compact download.
 * POST /api/mobile-sync/barcodes — assign a scanned, unrecognised code to a product.
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { assignBarcode } from '../../lib/assign-barcode.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { customPartCode, isChargeTitle } from './supplier-reorders.js';

/** Newest change across barcodes, products, bays and stock. The scanner skips the catalogue download when this matches. */
export async function catalogueRevisedAt(): Promise<string | null> {
  const result = await query(`
    SELECT GREATEST(
      (SELECT MAX(updated_at) FROM barcode_mappings WHERE source IS DISTINCT FROM 'bisley_export'),
      (SELECT MAX(updated_at) FROM wms_products),
      (SELECT MAX(updated_at) FROM warehouse_inventory),
      (SELECT MAX(updated_at) FROM warehouse_locations)
    ) AS revised_at
  `);
  const value = result.rows[0]?.revised_at;
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const router = express.Router();

router.get('/reference', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const [barcodes, products, locations, stock, revisedAt] = await Promise.all([
      query(
        `SELECT barcode, product_sku AS sku, product_name, colour_code, colour_name, thumbnail_url AS thumbnail
           FROM barcode_mappings WHERE is_active = true AND source IS DISTINCT FROM 'bisley_export'`
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
      catalogueRevisedAt(),
    ]);
    res.json({
      generated_at: new Date().toISOString(),
      revised_at: revisedAt || '',
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

    let saved = await assignBarcode(barcode, sku, req.user?.email ?? null);
    let needsReview = false;
    if (!saved) {
      const taken = await query(
        `SELECT product_sku FROM barcode_mappings WHERE upper(barcode) = upper($1) AND is_active = true`,
        [barcode],
      );
      if (taken.rows[0]) return res.status(409).json({ error: `Barcode ${barcode} is already assigned to ${taken.rows[0].product_sku}` });
      // `manual`: the person typed a SKU that is not in the catalogue. Keep it, usable straight away, flagged for the desk.
      if (req.body?.manual !== true) return res.status(404).json({ error: `Product not found: ${sku}` });
      const typed = sku.toUpperCase();
      if (typed.length > 50) return res.status(400).json({ error: 'SKU is too long' });
      await query(
        `INSERT INTO barcode_mappings (barcode, product_sku, product_name, is_active, assigned_by, source, needs_review)
         VALUES ($1, $2, 'Typed on the scanner, to check', true, $3, 'manual_sku', true)
         ON CONFLICT (barcode) DO UPDATE SET
           product_sku = EXCLUDED.product_sku, is_active = true, assigned_by = EXCLUDED.assigned_by,
           source = 'manual_sku', needs_review = true, reviewed_by = NULL, reviewed_at = NULL,
           product_name = COALESCE(barcode_mappings.product_name, EXCLUDED.product_name), updated_at = NOW()`,
        [barcode, typed, req.user?.email ?? null],
      );
      saved = { matched: true, source: 'barcode', sku: typed, nw_code: typed, medusa_sku: typed, colour_code: null, colour_name: null, product_name: typed, thumbnail: null };
      needsReview = true;
    }
    console.log(`[mobile-sync] Barcode ${barcode} assigned to ${saved.sku} by ${req.user?.email}${needsReview ? ' (typed, to review)' : ''}`);
    // every scan of this code that failed earlier is now explained
    await query(
      `UPDATE failed_scans SET resolved_at = NOW(), resolution = 'ASSIGNED', resolved_sku = $2 WHERE code = $1 AND resolved_at IS NULL`,
      [barcode, saved.sku]
    );
    res.json({ success: true, barcode, sku: saved.sku, needs_review: needsReview });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to assign barcode';
    console.error('Barcode assignment error:', message);
    res.status(409).json({ error: message });
  }
});

/**
 * GET /api/mobile-sync/open-custom-lines
 * Custom (not in the catalogue) lines on orders that have not shipped, one per part code. The scanner offers these first
 * when a scanned code is not recognised anywhere, so it can be tied to what a customer is waiting for.
 */
router.get('/open-custom-lines', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT pli.item_title, pli.quantity_required, pl.pick_list_number, pl.customer_name
         FROM pick_list_items pli JOIN pick_lists pl ON pl.id = pli.pick_list_id
        WHERE pli.is_custom = true AND pli.is_archived = false AND pli.is_sandbox = false
          AND pli.quantity_picked < pli.quantity_required
          AND pl.status NOT IN ('DISPATCHED', 'CANCELLED')`,
    );
    const byCode = new Map<string, { sku: string; title: string; quantity: number; orders: string[] }>();
    for (const r of result.rows) {
      const title = String(r.item_title || '').trim();
      if (!title || isChargeTitle(title)) continue;
      const code = customPartCode(title);
      if (!code) continue;
      const line = byCode.get(code) ?? { sku: code, title, quantity: 0, orders: [] };
      line.quantity += Number(r.quantity_required) || 0;
      line.orders.push(String(r.pick_list_number));
      byCode.set(code, line);
    }
    res.json({ lines: [...byCode.values()].sort((a, b) => a.sku.localeCompare(b.sku)) });
  } catch (err) {
    console.error('Open custom lines error:', err);
    res.status(500).json({ error: 'Failed to load open order items' });
  }
});

/** GET /api/mobile-sync/barcode-reviews — SKUs typed on a scanner that the desk has not checked yet. */
router.get('/barcode-reviews', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT bm.barcode, bm.product_sku, bm.product_name, bm.assigned_by, bm.created_at, bm.updated_at,
              (SELECT COALESCE(SUM(ci.quantity_scanned), 0)::int FROM checkin_items ci
                WHERE ci.removed_at IS NULL AND upper(ci.nw_code) = upper(bm.product_sku)) AS units_scanned,
              EXISTS (SELECT 1 FROM wms_products wp WHERE upper(wp.variant_sku) = upper(bm.product_sku)) AS in_catalogue
         FROM barcode_mappings bm
        WHERE bm.needs_review = true
        ORDER BY bm.updated_at DESC
        LIMIT 500`,
    );
    res.json({ reviews: result.rows });
  } catch (err) {
    console.error('Barcode reviews error:', err);
    res.status(500).json({ error: 'Failed to load barcodes to check' });
  }
});

/**
 * POST /api/mobile-sync/barcode-reviews/resolve { barcode, sku? }
 * Desk check of a typed SKU. With `sku` the barcode moves to that catalogue product; without it the typed SKU is accepted as it is.
 */
router.post('/barcode-reviews/resolve', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const barcode = String(req.body?.barcode ?? '').trim();
    const sku = String(req.body?.sku ?? '').trim();
    if (!barcode) return res.status(400).json({ error: 'barcode required' });
    const by = req.user?.email ?? null;
    if (sku) {
      const p = await query(
        `SELECT variant_sku, product_title, colour_code, colour_name, variant_thumbnail, medusa_product_id, medusa_variant_id
           FROM wms_products WHERE upper(variant_sku) = upper($1) ORDER BY is_archived ASC LIMIT 1`,
        [sku],
      );
      const row = p.rows[0];
      if (!row) return res.status(404).json({ error: `Product not found: ${sku}` });
      const done = await query(
        `UPDATE barcode_mappings SET product_sku = $2, colour_code = $3, colour_name = $4, product_name = $5, thumbnail_url = $6,
                medusa_product_id = $7, medusa_variant_id = $8, needs_review = false, reviewed_by = $9, reviewed_at = NOW(), updated_at = NOW()
          WHERE barcode = $1 AND needs_review = true`,
        [barcode, row.variant_sku, row.colour_code, row.colour_name, row.product_title, row.variant_thumbnail, row.medusa_product_id, row.medusa_variant_id, by],
      );
      if (!done.rowCount) return res.status(404).json({ error: 'Nothing to check for that barcode' });
      return res.json({ success: true, barcode, sku: row.variant_sku });
    }
    const done = await query(
      `UPDATE barcode_mappings SET needs_review = false, reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
        WHERE barcode = $1 AND needs_review = true`,
      [barcode, by],
    );
    if (!done.rowCount) return res.status(404).json({ error: 'Nothing to check for that barcode' });
    res.json({ success: true, barcode });
  } catch (err) {
    console.error('Barcode review resolve error:', err);
    res.status(500).json({ error: 'Failed to save the check' });
  }
});

/**
 * POST /api/mobile-sync/failed-scans { client_id, source: STOCK_IN|MOVE|PICK, session_id, code, quantity, scanned_at }
 * Keeps a scan the handheld could not match against the session it happened in. Idempotent on client_id; if the code
 * has been assigned to a product in the meantime the row is stored already resolved.
 */
router.post('/failed-scans', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { client_id, source, session_id, code, quantity, scanned_at } = req.body ?? {};
    if (!client_id || !code || !['STOCK_IN', 'MOVE', 'PICK'].includes(source)) {
      return res.status(400).json({ error: 'client_id, code and a valid source required' });
    }
    const at = scanned_at && !isNaN(Date.parse(scanned_at)) ? new Date(scanned_at) : new Date();
    const mapped = await query(`SELECT product_sku FROM barcode_mappings WHERE barcode = $1 AND is_active = true LIMIT 1`, [String(code)]);
    const sku: string | null = mapped.rows[0]?.product_sku ?? null;
    await query(
      `INSERT INTO failed_scans (client_id, source, session_id, code, quantity, scanned_by, scanned_at, resolved_at, resolution, resolved_sku)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (client_id) DO NOTHING`,
      [String(client_id), source, session_id ? String(session_id) : null, String(code).slice(0, 100), Math.max(1, parseInt(quantity) || 1),
        req.user?.email ?? null, at, sku ? new Date() : null, sku ? 'ASSIGNED' : null, sku]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Failed scan save error:', err);
    res.status(500).json({ error: 'Failed to save scan' });
  }
});

/** POST /api/mobile-sync/failed-scans/resolve { client_id } — the person discarded a failed scan on the handheld. */
router.post('/failed-scans/resolve', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const clientId = String(req.body?.client_id ?? '');
    if (!clientId) return res.status(400).json({ error: 'client_id required' });
    await query(
      `UPDATE failed_scans SET resolved_at = NOW(), resolution = 'DISCARDED' WHERE client_id = $1 AND resolved_at IS NULL`,
      [clientId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Failed scan resolve error:', err);
    res.status(500).json({ error: 'Failed to update scan' });
  }
});

export default router;
