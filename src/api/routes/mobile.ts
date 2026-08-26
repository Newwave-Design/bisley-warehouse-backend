/**
 * Mobile Scanner API
 * Optimised endpoints for handheld scanner workflows.
 *
 * POST /api/mobile/receive   — scan + stock in to a bay
 * POST /api/mobile/move      — move SKU from one bay to another
 * GET  /api/mobile/lookup    — barcode/NW-code → product + current stock
 * GET  /api/mobile/locations — all bays (for bay picker)
 * POST /api/mobile/undo      — reverse a recent receive or move
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';

const router = express.Router();

/** GET /api/mobile/lookup?q=BARCODE — resolve any scan to product info + stock */
router.get('/lookup', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const q = ((req.query.q as string) ?? '').trim().toUpperCase();
    if (!q) return res.status(400).json({ error: 'q required' });

    // 1. Exact barcode match (EAN, supercode like H2910NL-av1)
    const bm = await query(
      `SELECT bm.product_sku AS sku, bm.colour_code, bm.colour_name, bm.product_name,
              bm.thumbnail_url AS thumbnail, bm.medusa_variant_id
       FROM barcode_mappings bm WHERE bm.barcode = $1 AND is_active = true LIMIT 1`,
      [q]
    );
    if (bm.rows[0]) {
      const stock = await getStock(bm.rows[0].sku, bm.rows[0].colour_code);
      return res.json({ found: true, source: 'barcode', ...bm.rows[0], stock });
    }

    // 2. NW code in sku_mappings
    const sm = await query(
      `SELECT s.nw_code AS sku, s.colour AS colour_name, s.product_name,
              w.variant_thumbnail AS thumbnail, w.colour_code
       FROM sku_mappings s
       LEFT JOIN wms_products w ON w.variant_sku = s.medusa_sku
       WHERE UPPER(s.nw_code) = $1 LIMIT 1`,
      [q]
    );
    if (sm.rows[0]) {
      const stock = await getStock(sm.rows[0].sku, sm.rows[0].colour_code);
      return res.json({ found: true, source: 'nw_code', ...sm.rows[0], stock });
    }

    // 3. Partial SKU search in wms_products
    const wp = await query(
      `SELECT DISTINCT ON (product_title) variant_sku AS sku, colour_code, colour_name,
              product_title AS product_name, variant_thumbnail AS thumbnail
       FROM wms_products WHERE variant_sku ILIKE $1 LIMIT 5`,
      [`%${q}%`]
    );
    if (wp.rows.length > 0) {
      const stock = await getStock(wp.rows[0].sku, wp.rows[0].colour_code);
      return res.json({ found: true, source: 'sku_search', ...wp.rows[0], stock, alternatives: wp.rows });
    }

    res.json({ found: false, query: q });
  } catch (err) {
    res.status(500).json({ error: 'Lookup failed' });
  }
});

async function getStock(sku: string, colourCode: string | null) {
  const r = await query(
    `SELECT l.location_code, wi.quantity, wi.quantity_reserved, wi.quantity_available
     FROM warehouse_inventory wi
     JOIN warehouse_locations l ON l.id = wi.location_id
     WHERE wi.product_sku = $1 AND (wi.colour_code = $2 OR $2 IS NULL)
     ORDER BY wi.quantity DESC`,
    [sku, colourCode]
  );
  return {
    locations: r.rows,
    total: r.rows.reduce((s: number, row: any) => s + row.quantity, 0),
  };
}

/** POST /api/mobile/receive — stock in items to a bay */
router.post('/receive', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { sku, colour_code, location_code, quantity, notes, product_name } = req.body;
    if (!sku || !location_code || !quantity) {
      return res.status(400).json({ error: 'sku, location_code, quantity required' });
    }

    const locResult = await query(
      `SELECT id FROM warehouse_locations WHERE location_code = $1`,
      [location_code.toUpperCase()]
    );
    if (!locResult.rows[0]) {
      return res.status(404).json({ error: `Bay ${location_code} not found` });
    }
    const locationId = locResult.rows[0].id;

    // Upsert inventory
    await query(`
      INSERT INTO warehouse_inventory (location_id, product_sku, colour_code, quantity)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (location_id, product_sku, colour_code)
      DO UPDATE SET quantity = warehouse_inventory.quantity + $4, updated_at = NOW()
    `, [locationId, sku, colour_code ?? null, quantity]);

    // Record movement
    const mvt = await query(`
      INSERT INTO warehouse_movements (movement_type, location_id, product_sku, colour_code, quantity, notes, performed_by, movement_date)
      VALUES ('RECEIVE', $1, $2, $3, $4, $5, $6, NOW())
      RETURNING id
    `, [locationId, sku, colour_code ?? null, quantity, notes ?? null, (req as any).user?.id ?? '1']);

    res.json({
      success: true,
      movement_id: mvt.rows[0].id,
      sku, colour_code, location_code: location_code.toUpperCase(), quantity,
    });
  } catch (err: any) {
    console.error('Mobile receive error:', err);
    res.status(500).json({ error: err.message ?? 'Receive failed' });
  }
});

/** POST /api/mobile/move — move qty from one bay to another */
router.post('/move', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { sku, colour_code, from_location, to_location, quantity } = req.body;
    if (!sku || !from_location || !to_location || !quantity) {
      return res.status(400).json({ error: 'sku, from_location, to_location, quantity required' });
    }

    const [fromLoc, toLoc] = await Promise.all([
      query(`SELECT id FROM warehouse_locations WHERE location_code = $1`, [from_location.toUpperCase()]),
      query(`SELECT id FROM warehouse_locations WHERE location_code = $1`, [to_location.toUpperCase()]),
    ]);
    if (!fromLoc.rows[0]) return res.status(404).json({ error: `Bay ${from_location} not found` });
    if (!toLoc.rows[0]) return res.status(404).json({ error: `Bay ${to_location} not found` });

    const fromId = fromLoc.rows[0].id;
    const toId = toLoc.rows[0].id;

    // Verify sufficient stock at source
    const srcStock = await query(
      `SELECT quantity FROM warehouse_inventory WHERE location_id=$1 AND product_sku=$2 AND (colour_code=$3 OR $3 IS NULL)`,
      [fromId, sku, colour_code ?? null]
    );
    if (!srcStock.rows[0] || srcStock.rows[0].quantity < quantity) {
      return res.status(400).json({ error: `Insufficient stock at ${from_location}` });
    }

    // Deduct from source
    await query(`
      UPDATE warehouse_inventory SET quantity = quantity - $1, updated_at = NOW()
      WHERE location_id=$2 AND product_sku=$3 AND (colour_code=$4 OR $4 IS NULL)
    `, [quantity, fromId, sku, colour_code ?? null]);

    // Add to destination
    await query(`
      INSERT INTO warehouse_inventory (location_id, product_sku, colour_code, quantity)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (location_id, product_sku, colour_code)
      DO UPDATE SET quantity = warehouse_inventory.quantity + $4, updated_at = NOW()
    `, [toId, sku, colour_code ?? null, quantity]);

    // Record both movements
    const [mvtOut, mvtIn] = await Promise.all([
      query(`INSERT INTO warehouse_movements (movement_type,location_id,product_sku,colour_code,quantity,notes,performed_by,movement_date)
             VALUES ('ADJUST',$1,$2,$3,$4,$5,$6,NOW()) RETURNING id`,
        [fromId, sku, colour_code ?? null, -quantity, `Moved to ${to_location}`, (req as any).user?.id ?? '1']),
      query(`INSERT INTO warehouse_movements (movement_type,location_id,product_sku,colour_code,quantity,notes,performed_by,movement_date)
             VALUES ('RECEIVE',$1,$2,$3,$4,$5,$6,NOW()) RETURNING id`,
        [toId, sku, colour_code ?? null, quantity, `Moved from ${from_location}`, (req as any).user?.id ?? '1']),
    ]);

    res.json({ success: true, movement_out: mvtOut.rows[0].id, movement_in: mvtIn.rows[0].id });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Move failed' });
  }
});

/** GET /api/mobile/locations — all bay locations for the bay picker */
router.get('/locations', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const r = await query(`
      SELECT l.id, l.location_code, l.bay_code, l.bin_code,
             COALESCE(SUM(wi.quantity),0)::int AS total_units,
             COUNT(DISTINCT wi.product_sku)::int AS unique_skus
      FROM warehouse_locations l
      LEFT JOIN warehouse_inventory wi ON wi.location_id = l.id AND wi.quantity > 0
      WHERE l.is_active = true
      GROUP BY l.id ORDER BY l.bay_code, l.bin_code
    `);
    res.json({ locations: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load locations' });
  }
});

/** POST /api/mobile/undo — reverse a warehouse movement */
router.post('/undo', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { movement_id } = req.body;
    if (!movement_id) return res.status(400).json({ error: 'movement_id required' });

    const mvt = await query(
      `SELECT * FROM warehouse_movements WHERE id = $1 AND movement_date > NOW() - INTERVAL '1 hour'`,
      [movement_id]
    );
    if (!mvt.rows[0]) {
      // Check if it exists but is too old
      const old = await query(`SELECT movement_date FROM warehouse_movements WHERE id = $1`, [movement_id]);
      if (old.rows[0]) return res.status(400).json({ error: 'Action is older than 1 hour — cannot undo' });
      return res.status(404).json({ error: 'Movement not found' });
    }
    if (!['RECEIVE', 'ADJUST'].includes(mvt.rows[0].movement_type)) {
      return res.status(400).json({ error: `Cannot undo a ${mvt.rows[0].movement_type} movement` });
    }

    const m = mvt.rows[0];
    if (m.movement_type === 'RECEIVE') {
      // Undo a stock-in: remove the quantity from that bay
      await query(`
        UPDATE warehouse_inventory SET quantity = GREATEST(0, quantity - $1), updated_at = NOW()
        WHERE location_id = $2 AND product_sku = $3 AND (colour_code = $4 OR $4 IS NULL)
      `, [m.quantity, m.location_id, m.product_sku, m.colour_code]);

    } else if (m.movement_type === 'ADJUST' && m.quantity < 0) {
      // Undo the out-leg of a move: add back to source.
      // Also find and reverse the paired in-leg (same SKU/colour, RECEIVE, same time window).
      await query(`
        UPDATE warehouse_inventory SET quantity = quantity + $1, updated_at = NOW()
        WHERE location_id = $2 AND product_sku = $3 AND (colour_code = $4 OR $4 IS NULL)
      `, [Math.abs(m.quantity), m.location_id, m.product_sku, m.colour_code]);

      // Remove from destination: find the RECEIVE movement created at the same time
      const paired = await query(`
        SELECT id, location_id FROM warehouse_movements
        WHERE product_sku = $1 AND (colour_code = $2 OR $2 IS NULL)
          AND movement_type = 'RECEIVE' AND quantity = $3
          AND notes ILIKE '%Moved from%'
          AND movement_date BETWEEN $4::timestamptz - INTERVAL '5 seconds'
                                AND $4::timestamptz + INTERVAL '5 seconds'
        LIMIT 1
      `, [m.product_sku, m.colour_code, Math.abs(m.quantity), m.movement_date]);

      if (paired.rows[0]) {
        await query(`
          UPDATE warehouse_inventory SET quantity = GREATEST(0, quantity - $1), updated_at = NOW()
          WHERE location_id = $2 AND product_sku = $3 AND (colour_code = $4 OR $4 IS NULL)
        `, [Math.abs(m.quantity), paired.rows[0].location_id, m.product_sku, m.colour_code]);
      }
    }

    // Log the undo
    await query(`
      INSERT INTO warehouse_movements (movement_type,location_id,product_sku,colour_code,quantity,notes,performed_by)
      VALUES ('ADJUST',$1,$2,$3,$4,$5,$6)
    `, [m.location_id, m.product_sku, m.colour_code, -m.quantity, `Undo of movement ${movement_id}`, (req as any).user?.id ?? '1']);

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Undo failed' });
  }
});

export default router;
