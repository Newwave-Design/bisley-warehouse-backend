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
import { moveStockBetweenBays, MoveError } from '../../lib/stock-move.js';

const router = express.Router();

// performed_by columns are UUID - the demo token's user id ('1') is not a valid UUID, so guard it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function toUuidOrNull(id: unknown): string | null {
  return typeof id === 'string' && UUID_RE.test(id) ? id : null;
}

/** Resolve any scan (EAN/supercode, NW code, SKU) to product info + stock; shared with move sessions */
export async function lookupProduct(q: string): Promise<any> {
    // 1. Exact barcode match (EAN, supercode like H2910NL-av1)
    const bm = await query(
      `SELECT bm.product_sku AS sku, bm.colour_code, bm.colour_name, bm.product_name,
              bm.thumbnail_url AS thumbnail, bm.medusa_variant_id
       FROM barcode_mappings bm WHERE bm.barcode = $1 AND is_active = true LIMIT 1`,
      [q]
    );
    if (bm.rows[0]) {
      const stock = await getStock(bm.rows[0].sku, bm.rows[0].colour_code);
      return { found: true, source: 'barcode', ...bm.rows[0], stock };
    }

    // 2. NW code — checked directly against wms_products.nw_code first (the canonical mapping
    // key populated per-product from sku_mappings whenever a New Wave order PDF is parsed),
    // falling back to the sku_mappings join for any code not yet copied onto a product row.
    const wpNw = await query(
      `SELECT variant_sku AS sku, colour_code, colour_name, product_title AS product_name,
              variant_thumbnail AS thumbnail
       FROM wms_products WHERE UPPER(nw_code) = $1 AND is_archived = false LIMIT 1`,
      [q]
    );
    if (wpNw.rows[0]) {
      const stock = await getStock(wpNw.rows[0].sku, wpNw.rows[0].colour_code);
      return { found: true, source: 'nw_code', ...wpNw.rows[0], stock };
    }

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
      return { found: true, source: 'nw_code', ...sm.rows[0], stock };
    }

    // 3. Partial SKU search in wms_products
    const wp = await query(
      `SELECT DISTINCT ON (product_title) variant_sku AS sku, colour_code, colour_name,
              product_title AS product_name, variant_thumbnail AS thumbnail
       FROM wms_products WHERE variant_sku ILIKE $1 AND is_archived = false LIMIT 5`,
      [`%${q}%`]
    );
    if (wp.rows.length > 0) {
      const stock = await getStock(wp.rows[0].sku, wp.rows[0].colour_code);
      return { found: true, source: 'sku_search', ...wp.rows[0], stock, alternatives: wp.rows };
    }

    return { found: false, query: q };
}

/** GET /api/mobile/lookup?q=BARCODE — resolve any scan to product info + stock */
router.get('/lookup', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const q = ((req.query.q as string) ?? '').trim().toUpperCase();
    if (!q) return res.status(400).json({ error: 'q required' });
    res.json(await lookupProduct(q));
  } catch (err) {
    res.status(500).json({ error: 'Lookup failed' });
  }
});

export async function getStock(sku: string, colourCode: string | null) {
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

    // Upsert inventory — use COALESCE so NULL colour_code upserts work (functional unique index)
    await query(`
      INSERT INTO warehouse_inventory (location_id, product_sku, colour_code, quantity)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (location_id, product_sku, COALESCE(colour_code, ''))
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

    const r = await moveStockBetweenBays({
      fromCode: from_location, toCode: to_location, sku,
      colourCode: colour_code ?? null, quantity, userId: toUuidOrNull((req as any).user?.id),
    });

    res.json({ success: true, movement_out: r.movement_out, movement_in: r.movement_in });
  } catch (err: any) {
    if (err instanceof MoveError) return res.status(err.status).json({ error: err.message });
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

/**
 * GET /api/mobile/pick-lists — pick lists for the handheld
 *   ?status=PENDING,IN_PROGRESS (default) | any comma list | ALL     ?sort=asc (default, oldest first) | desc
 */
router.get('/pick-lists', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const statusParam = ((req.query.status as string) || 'PENDING,IN_PROGRESS').toUpperCase();
    const statuses = statusParam === 'ALL' ? null : statusParam.split(',').map(s => s.trim());
    const orderDir = String(req.query.sort).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const result = await query(`
      SELECT
        pl.id, pl.pick_list_number, pl.medusa_order_id, pl.status, pl.created_at, pl.customer_name,
        COUNT(pli.id)::int                                                     AS total_items,
        COUNT(*) FILTER (WHERE pli.status = 'PICKED')::int                    AS items_picked,
        COUNT(*) FILTER (WHERE pli.status = 'PENDING')::int                   AS items_pending
      FROM pick_lists pl
      LEFT JOIN pick_list_items pli ON pli.pick_list_id = pl.id
      WHERE pl.is_archived = false AND ($1::text[] IS NULL OR pl.status = ANY($1::text[]))
      GROUP BY pl.id
      ORDER BY pl.created_at ${orderDir}
      LIMIT 100
    `, [statuses]);
    res.json({ pick_lists: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load pick lists' });
  }
});

/** GET /api/mobile/pick-lists/:id — pick list detail with product thumbnails, customer info, and kit components */
router.get('/pick-lists/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const pl = await query(`
      SELECT id, pick_list_number, medusa_order_id, status, created_at,
             customer_name, customer_email, shipping_address
      FROM pick_lists WHERE id = $1
    `, [req.params.id]);
    if (!pl.rows[0]) return res.status(404).json({ error: 'Pick list not found' });

    const items = await query(`
      SELECT
        pli.id, pli.line_number, pli.product_sku, pli.colour_code,
        pli.quantity_required, pli.quantity_picked, pli.status,
        pli.picked_from_location_id, pli.notes,
        l.location_code,
        -- Enrich from wms_products for display
        wp.product_title, wp.colour_name, wp.variant_thumbnail, wp.metadata,
        COALESCE(wp.variant_width_mm, wp.width_mm) AS width_mm,
        COALESCE(wp.variant_height_mm, wp.height_mm) AS height_mm,
        COALESCE(wp.variant_depth_mm, wp.depth_mm) AS depth_mm,
        -- Kit detection and components
        CASE WHEN wp.kit_components IS NOT NULL AND jsonb_array_length(wp.kit_components) > 0 
          THEN true ELSE false END AS is_kit,
        wp.kit_components,
        -- Show where this SKU is in the warehouse
        (SELECT json_agg(json_build_object('location_code', wl.location_code, 'qty', wi.quantity) ORDER BY wi.quantity DESC)
         FROM warehouse_inventory wi
         JOIN warehouse_locations wl ON wl.id = wi.location_id
         WHERE wi.product_sku = pli.product_sku
           AND (wi.colour_code = pli.colour_code OR pli.colour_code IS NULL)
           AND wi.quantity > 0) AS stock_locations
      FROM pick_list_items pli
      LEFT JOIN warehouse_locations l ON l.id = pli.picked_from_location_id
      LEFT JOIN wms_products wp ON wp.variant_sku = pli.product_sku
      WHERE pli.pick_list_id = $1
      ORDER BY pli.line_number
    `, [req.params.id]);

    res.json({ ...pl.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load pick list detail' });
  }
});

/** Recompute a pick_list_item's quantity_picked/status from its pick_scans, then the parent pick_list's status. */
async function recomputePickItem(pickListId: string, itemId: string) {
  const sum = await query(
    `SELECT COALESCE(SUM(quantity), 0)::int AS qty FROM pick_scans WHERE pick_list_item_id = $1`,
    [itemId]
  );
  const item = await query(`SELECT quantity_required FROM pick_list_items WHERE id = $1`, [itemId]);
  const required = item.rows[0]?.quantity_required ?? 0;
  const picked = Math.min(sum.rows[0].qty, required);
  const status = picked >= required && required > 0 ? 'PICKED' : picked > 0 ? 'PICKING' : 'PENDING';

  const updated = await query(
    `UPDATE pick_list_items SET quantity_picked = $1, status = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
    [picked, status, itemId]
  );

  const remaining = await query(
    `SELECT COUNT(*) FROM pick_list_items WHERE pick_list_id = $1 AND status != 'PICKED'`,
    [pickListId]
  );
  const allPicked = parseInt(remaining.rows[0].count) === 0;
  await query(
    `UPDATE pick_lists SET status = $1, updated_at = NOW() WHERE id = $2`,
    [allPicked ? 'PICKED' : 'IN_PROGRESS', pickListId]
  );

  return { item: updated.rows[0], allPicked };
}

/**
 * POST /api/mobile/pick-lists/:id/scan — scan any item in the list, in any order.
 * For kit products: requires scanning individual kit components instead of the parent SKU.
 * Resolves the scanned barcode to whichever pending line it belongs to (rather than
 * trusting the client's "pick next" ordering), then picks its full remaining quantity.
 */
router.post('/pick-lists/:id/scan', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { scanned_barcode, location_code, quantity, scanned_component_sku } = req.body;
    const { id: pickListId } = req.params;
    if (!scanned_barcode) return res.status(400).json({ error: 'scanned_barcode required' });

    // Resolve barcode -> SKU. Fall back to treating the scan as a literal SKU
    // (pick tickets render the SKU itself as the barcode — see BarcodeDisplay usage).
    const bm = await query(
      `SELECT product_sku FROM barcode_mappings WHERE barcode = $1 AND is_active = true LIMIT 1`,
      [scanned_barcode]
    );
    const scannedSku = bm.rows[0]?.product_sku ?? scanned_barcode;

    // First, check if this scanned SKU is a kit component that's part of a pending pick item
    let candidates: any[] = [];
    let isKitComponentScan = false;
    
    // Get all pending items with their kit components
    const allItems = await query(
      `SELECT pli.id, pli.product_sku, pli.quantity_required, pli.quantity_picked, pli.status,
              wp.kit_components,
              CASE WHEN wp.kit_components IS NOT NULL AND jsonb_array_length(wp.kit_components) > 0 
                THEN true ELSE false END AS is_kit
       FROM pick_list_items pli
       LEFT JOIN wms_products wp ON wp.variant_sku = pli.product_sku
       WHERE pli.pick_list_id = $1 AND pli.status != 'PICKED'
       ORDER BY pli.line_number ASC`,
      [pickListId]
    );

    // Check if the scanned SKU is a kit component
    for (const item of allItems) {
      if (item.is_kit && item.kit_components) {
        const components = (item.kit_components as any[]);
        const matchingComponent = components.find((c: any) => c.sku === scannedSku);
        if (matchingComponent) {
          isKitComponentScan = true;
          // This is a kit item and the scan matches one of its components
          candidates = [item];
          break;
        }
      }
    }

    // If not a kit component scan, try direct SKU match
    if (!isKitComponentScan) {
      candidates = await query(
        `SELECT * FROM pick_list_items WHERE pick_list_id = $1 AND product_sku = $2 ORDER BY line_number ASC`,
        [pickListId, scannedSku]
      );
    }

    if (!candidates.length) {
      return res.status(404).json({ 
        error: `${scannedSku} is not part of this order`,
        scannedSku,
        isKitComponentScan
      });
    }

    const item = candidates[0];
    if (item.status === 'PICKED') return res.status(400).json({ error: 'Already picked' });

    // If this is a kit item and we're trying to scan a component
    if (isKitComponentScan && item.is_kit) {
      // For kits, we accept the component scan and record it
      // The picker must scan all components to complete the kit pick
      const remainingQty = item.quantity_required - item.quantity_picked;
      const qty = Number.isInteger(quantity) && quantity > 0 ? quantity : remainingQty;
      if (qty > remainingQty) {
        return res.status(400).json({ error: `Only ${remainingQty} remaining — reduce the quantity` });
      }

      let locationId: string | null = null;
      if (location_code) {
        const loc = await query(`SELECT id FROM warehouse_locations WHERE location_code = $1`, [location_code.toUpperCase()]);
        locationId = loc.rows[0]?.id ?? null;
      }

      await query(
        `INSERT INTO pick_scans (pick_list_id, pick_list_item_id, quantity, location_id, scanned_barcode, performed_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [pickListId, item.id, qty, locationId, scanned_barcode, toUuidOrNull(req.user?.id)]
      );
      if (locationId) {
        await query(`UPDATE pick_list_items SET picked_from_location_id = $1 WHERE id = $2`, [locationId, item.id]);
      }

      const { item: updatedItem, allPicked } = await recomputePickItem(pickListId, item.id);

      res.json({ 
        success: true, 
        all_picked: allPicked, 
        item: updatedItem,
        note: `Kit component ${scannedSku} scanned. Scan remaining components to complete this kit.`
      });
    } else if (item.is_kit) {
      // Trying to scan the parent kit SKU directly - not allowed
      return res.status(400).json({ 
        error: `This is a kit product. You must scan its individual components instead.`,
        components: item.kit_components || [],
        instruction: 'Scan each component SKU separately to complete this pick.'
      });
    } else {
      // Regular non-kit item
      const remainingQty = item.quantity_required - item.quantity_picked;
      const qty = Number.isInteger(quantity) && quantity > 0 ? quantity : remainingQty;
      if (qty > remainingQty) {
        return res.status(400).json({ error: `Only ${remainingQty} remaining — reduce the quantity` });
      }

      let locationId: string | null = null;
      if (location_code) {
        const loc = await query(`SELECT id FROM warehouse_locations WHERE location_code = $1`, [location_code.toUpperCase()]);
        locationId = loc.rows[0]?.id ?? null;
      }

      await query(
        `INSERT INTO pick_scans (pick_list_id, pick_list_item_id, quantity, location_id, scanned_barcode, performed_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [pickListId, item.id, qty, locationId, scanned_barcode, toUuidOrNull(req.user?.id)]
      );
      if (locationId) {
        await query(`UPDATE pick_list_items SET picked_from_location_id = $1 WHERE id = $2`, [locationId, item.id]);
      }

      const { item: updatedItem, allPicked } = await recomputePickItem(pickListId, item.id);

      res.json({ success: true, all_picked: allPicked, item: updatedItem });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Pick failed' });
  }
});

/** POST /api/mobile/pick-lists/:id/items/:itemId/pick — scan to pick a quantity (defaults to all remaining) */
router.post('/pick-lists/:id/items/:itemId/pick', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { location_code, scanned_barcode, quantity } = req.body;
    const { id: pickListId, itemId } = req.params;

    const item = await query(
      `SELECT * FROM pick_list_items WHERE id = $1 AND pick_list_id = $2`,
      [itemId, pickListId]
    );
    if (!item.rows[0]) return res.status(404).json({ error: 'Item not found' });
    if (item.rows[0].status === 'PICKED') return res.status(400).json({ error: 'Already picked' });

    const remainingQty = item.rows[0].quantity_required - item.rows[0].quantity_picked;
    const qty = Number.isInteger(quantity) && quantity > 0 ? quantity : remainingQty;
    if (qty > remainingQty) {
      return res.status(400).json({ error: `Only ${remainingQty} remaining — reduce the quantity` });
    }

    // Verify the scanned barcode matches the expected SKU
    if (scanned_barcode) {
      const bm = await query(
        `SELECT product_sku FROM barcode_mappings WHERE barcode = $1 AND is_active = true LIMIT 1`,
        [scanned_barcode]
      );
      if (bm.rows[0] && bm.rows[0].product_sku !== item.rows[0].product_sku) {
        return res.status(400).json({ error: `Wrong item scanned — expected ${item.rows[0].product_sku}` });
      }
    }

    // Resolve location_id
    let locationId: string | null = null;
    if (location_code) {
      const loc = await query(`SELECT id FROM warehouse_locations WHERE location_code = $1`, [location_code.toUpperCase()]);
      locationId = loc.rows[0]?.id ?? null;
    }

    await query(
      `INSERT INTO pick_scans (pick_list_id, pick_list_item_id, quantity, location_id, scanned_barcode, performed_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [pickListId, itemId, qty, locationId, scanned_barcode ?? null, toUuidOrNull(req.user?.id)]
    );
    if (locationId) {
      await query(`UPDATE pick_list_items SET picked_from_location_id = $1 WHERE id = $2`, [locationId, itemId]);
    }

    const { item: updatedItem, allPicked } = await recomputePickItem(pickListId, itemId);

    res.json({ success: true, all_picked: allPicked, item: updatedItem });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Pick failed' });
  }
});

/** GET /api/mobile/pick-lists/:id/scans — full scan history for the list (newest first) */
router.get('/pick-lists/:id/scans', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(`
      SELECT ps.id, ps.pick_list_item_id, ps.quantity, ps.scanned_barcode, ps.created_at,
             pli.product_sku, pli.colour_code,
             l.location_code,
             wp.product_title, wp.colour_name
      FROM pick_scans ps
      JOIN pick_list_items pli ON pli.id = ps.pick_list_item_id
      LEFT JOIN warehouse_locations l ON l.id = ps.location_id
      LEFT JOIN wms_products wp ON wp.variant_sku = pli.product_sku
      WHERE ps.pick_list_id = $1
      ORDER BY ps.created_at DESC
    `, [req.params.id]);
    res.json({ scans: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load scan history' });
  }
});

/** PATCH /api/mobile/pick-lists/:id/scans/:scanId — correct a scan's quantity */
router.patch('/pick-lists/:id/scans/:scanId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { quantity } = req.body;
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ error: 'quantity must be a positive integer' });
    }
    const scan = await query(
      `SELECT * FROM pick_scans WHERE id = $1 AND pick_list_id = $2`,
      [req.params.scanId, req.params.id]
    );
    if (!scan.rows[0]) return res.status(404).json({ error: 'Scan not found' });

    const item = await query(`SELECT quantity_required FROM pick_list_items WHERE id = $1`, [scan.rows[0].pick_list_item_id]);
    const otherScans = await query(
      `SELECT COALESCE(SUM(quantity),0)::int AS qty FROM pick_scans WHERE pick_list_item_id = $1 AND id != $2`,
      [scan.rows[0].pick_list_item_id, req.params.scanId]
    );
    const maxAllowed = item.rows[0].quantity_required - otherScans.rows[0].qty;
    if (quantity > maxAllowed) {
      return res.status(400).json({ error: `Quantity would exceed the ${item.rows[0].quantity_required} required — max ${maxAllowed}` });
    }

    await query(`UPDATE pick_scans SET quantity = $1, updated_at = NOW() WHERE id = $2`, [quantity, req.params.scanId]);
    const { item: updatedItem, allPicked } = await recomputePickItem(req.params.id, scan.rows[0].pick_list_item_id);
    res.json({ success: true, item: updatedItem, all_picked: allPicked });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to update scan' });
  }
});

/** DELETE /api/mobile/pick-lists/:id/scans/:scanId — remove a single scan */
router.delete('/pick-lists/:id/scans/:scanId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const scan = await query(
      `SELECT * FROM pick_scans WHERE id = $1 AND pick_list_id = $2`,
      [req.params.scanId, req.params.id]
    );
    if (!scan.rows[0]) return res.status(404).json({ error: 'Scan not found' });

    await query(`DELETE FROM pick_scans WHERE id = $1`, [req.params.scanId]);
    const { item: updatedItem, allPicked } = await recomputePickItem(req.params.id, scan.rows[0].pick_list_item_id);
    res.json({ success: true, item: updatedItem, all_picked: allPicked });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to delete scan' });
  }
});

/** POST /api/mobile/pick-lists/:id/reset — clear all scans and start the list again */
router.post('/pick-lists/:id/reset', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const pl = await query(`SELECT id FROM pick_lists WHERE id = $1`, [req.params.id]);
    if (!pl.rows[0]) return res.status(404).json({ error: 'Pick list not found' });

    await query(`DELETE FROM pick_scans WHERE pick_list_id = $1`, [req.params.id]);
    await query(
      `UPDATE pick_list_items SET quantity_picked = 0, status = 'PENDING', picked_from_location_id = NULL, updated_at = NOW() WHERE pick_list_id = $1`,
      [req.params.id]
    );
    await query(`UPDATE pick_lists SET status = 'PENDING', updated_at = NOW() WHERE id = $1`, [req.params.id]);

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to reset pick list' });
  }
});

/**
 * GET /api/mobile/inventory — searchable SKU + bay location list
 * ?q= search by SKU or product name (case-insensitive, partial match)
 * Returns items grouped by SKU+colour with all bay locations aggregated
 */
router.get('/inventory', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const search = ((req.query.q as string) ?? '').trim();
    const params: any[] = [];
    let whereClause = 'WHERE wi.quantity > 0';

    if (search) {
      params.push(`%${search}%`);
      whereClause += ` AND (wi.product_sku ILIKE $1 OR wp.product_title ILIKE $1 OR wp.colour_name ILIKE $1)`;
    }

    const result = await query(`
      SELECT
        wi.product_sku                                                      AS sku,
        wi.colour_code,
        COALESCE(wp.colour_name, wi.colour_code)                            AS colour_name,
        COALESCE(wp.product_title, wi.product_sku)                          AS product_name,
        wp.variant_thumbnail                                                AS thumbnail,
        SUM(wi.quantity)::int                                               AS total_qty,
        SUM(wi.quantity_available)::int                                     AS available_qty,
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'location', wl.location_code,
            'bay', wl.bay_code,
            'qty', wi.quantity,
            'available', wi.quantity_available
          ) ORDER BY wi.quantity DESC
        ) AS locations
      FROM warehouse_inventory wi
      JOIN warehouse_locations wl ON wl.id = wi.location_id
      LEFT JOIN wms_products wp ON wp.variant_sku = wi.product_sku
      ${whereClause}
      GROUP BY wi.product_sku, wi.colour_code, wp.colour_name, wp.product_title, wp.variant_thumbnail
      ORDER BY COALESCE(wp.product_title, wi.product_sku), wi.colour_code NULLS LAST
      LIMIT 200
    `, params);

    res.json({ items: result.rows, total: result.rows.length, query: search });
  } catch (err: any) {
    console.error('Mobile inventory error:', err);
    res.status(500).json({ error: 'Failed to load inventory' });
  }
});

export default router;
