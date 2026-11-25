/**
 * Check-in API Routes — Phase 3: Receiving
 *
 * GET    /api/checkin/lookup?q=           — Look up barcode or NW code → product info
 * GET    /api/checkin/sessions              — List sessions
 * POST   /api/checkin/sessions              — Start new session
 * GET    /api/checkin/sessions/:id          — Session detail + items
 * POST   /api/checkin/sessions/:id/scan     — Add scanned item
 * PATCH  /api/checkin/sessions/:id/items/:itemId — Update scanned qty
 * DELETE /api/checkin/sessions/:id/items/:itemId — Remove item
 * POST   /api/checkin/sessions/:id/reset    — Clear all scanned items, keep session open
 * POST   /api/checkin/sessions/:id/compare  — Generate discrepancy report vs order
 * POST   /api/checkin/sessions/:id/complete — Finalise session
 */

import express, { Response } from 'express';
import { stockInUnits, getHoldingLocation, resolveColourCode, asSingleInsertTray } from './stock-in.js';
import { query, getPool } from '../../db/index.js';
import { toUuidOrNull } from './mobile.js';
import { failedScansFor } from '../../lib/failed-scans.js';
import { scheduleStockHolds } from '../../lib/stock-holds.js';
import { COLOUR_NAMES, extractColourCode } from '../../lib/colour-names.js';
import { unblockBackorderedPickLists } from './pick-lists.js';
import { authMiddleware, requirePermission, AuthRequest } from '../../middleware/auth.js';
import { deliveryNoteForSession, openDeliveryNote } from '../../lib/delivery-notes.js';
import { pushAvailableStock } from '../../lib/medusa-inventory.js';
import { assignStockedToOlderOrders } from '../../lib/assign-arrived-stock.js';
import { resolveScan } from '../../lib/resolve-scan.js';
import { matchCustomArrivalsQuietly } from '../../lib/custom-arrivals.js';

async function enrichCheckinItems(items: any[]) {
  const keys = [...new Set(items.flatMap((i) => [i.medusa_sku, i.nw_code].filter(Boolean)))]
  if (!keys.length) return items
  const products = await query(
    `SELECT variant_sku, nw_code, colour_code, colour_name, product_title
     FROM wms_products
     WHERE variant_sku = ANY($1::text[]) OR nw_code = ANY($1::text[])`,
    [keys],
  )
  const bySku = new Map<string, any>()
  const byNw = new Map<string, any>()
  for (const p of products.rows) {
    if (p.variant_sku) bySku.set(p.variant_sku, p)
    if (p.nw_code) byNw.set(p.nw_code, p)
  }
  // A SKU that is not in the catalogue can still be known: Bisley's barcode list, or a SKU typed on the scanner.
  // Those carry their own description, so they are not "unmatched".
  const mapped = await query(
    `SELECT DISTINCT ON (upper(product_sku)) upper(product_sku) AS key, product_name, colour_code, colour_name
       FROM barcode_mappings
      WHERE is_active = true AND upper(product_sku) = ANY($1::text[])
      ORDER BY upper(product_sku), (product_name IS NULL), updated_at DESC`,
    [keys.map((k) => String(k).toUpperCase())],
  )
  const byMapped = new Map<string, any>(mapped.rows.map((r: any) => [r.key, r]))
  return items.map((i) => {
    const p = bySku.get(i.medusa_sku) || bySku.get(i.nw_code) || byNw.get(i.nw_code)
    const m = p ? null : byMapped.get(String(i.medusa_sku || '').toUpperCase()) || byMapped.get(String(i.nw_code || '').toUpperCase())
    const sku = i.medusa_sku || p?.variant_sku || i.nw_code || ''
    const mappedColour = m?.colour_code && m.colour_code !== '000' ? m.colour_code : ''
    const code = (p?.colour_code || extractColourCode(sku) || mappedColour || '').toLowerCase()
    const colourName = COLOUR_NAMES[code] || p?.colour_name || m?.colour_name || i.colour || ''
    return {
      ...i,
      sku,
      colour_code: code || null,
      colour_name: colourName,
      description: p?.product_title || m?.product_name || i.nw_code || sku,
      unmatched: !p && !m,
    }
  })
}

const router = express.Router();

// Barcode / NW code lookup — resolves a scan input to product info
router.get('/lookup', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const q = (req.query.q as string || '').trim().toUpperCase();
    if (!q) return res.status(400).json({ error: 'q parameter required' });

    // 1. Check barcode_mappings (EAN / Supercode barcode → product)
    const barcode = await query(
      `SELECT bm.product_sku as nw_code, bm.colour_name as colour, bm.product_name, bm.colour_code,
              wp.metadata, wp.product_handle, wp.variant_thumbnail, wp.variant_sku AS medusa_sku,
              COALESCE(wp.variant_width_mm, wp.width_mm) AS width_mm,
              COALESCE(wp.variant_height_mm, wp.height_mm) AS height_mm,
              COALESCE(wp.variant_depth_mm, wp.depth_mm) AS depth_mm
       FROM barcode_mappings bm
       LEFT JOIN wms_products wp ON wp.variant_sku = bm.product_sku
       WHERE bm.barcode = $1 AND bm.is_active = true LIMIT 1`,
      [q]
    );
    if (barcode.rows[0]) {
      const row = barcode.rows[0];
      const tray = await asSingleInsertTray(row.medusa_sku || row.nw_code);
      if (tray) {
        return res.json({
          source: 'barcode',
          ...row,
          nw_code: tray.sku,
          medusa_sku: tray.sku,
          product_name: tray.title || row.product_name,
          colour: tray.colour_name || row.colour,
          colour_code: tray.colour_code || row.colour_code,
        });
      }
      return res.json({ source: 'barcode', ...row });
    }

    // 2. Check sku_mappings by NW code (LEGACY/PAUSED - table is expected to be empty
    // until Genero is connected; barcode_mappings above is the live path)
    const mapping = await query(
      `SELECT sm.nw_code, sm.product_name, sm.family, sm.colour, sm.medusa_sku,
              wp.metadata, wp.product_handle, wp.variant_thumbnail,
              COALESCE(wp.variant_width_mm, wp.width_mm) AS width_mm,
              COALESCE(wp.variant_height_mm, wp.height_mm) AS height_mm,
              COALESCE(wp.variant_depth_mm, wp.depth_mm) AS depth_mm
       FROM sku_mappings sm
       LEFT JOIN wms_products wp ON wp.variant_sku = sm.medusa_sku
       WHERE UPPER(sm.nw_code) = $1 LIMIT 1`,
      [q]
    );
    if (mapping.rows[0]) {
      return res.json({ source: 'nw_code', ...mapping.rows[0] });
    }

    // 3. Try NW stocking items (may have multiple colours — return all)
    const stockingItems = await query(
      `SELECT DISTINCT nw_code, family, colour FROM nw_stocking_items WHERE UPPER(nw_code) = $1 ORDER BY colour`,
      [q]
    );
    if (stockingItems.rows.length > 0) {
      return res.json({ source: 'stocking', nw_code: q, colours: stockingItems.rows.map(r => r.colour) });
    }

    return res.status(404).json({ error: 'Not found', query: q });
  } catch (err) {
    res.status(500).json({ error: 'Lookup failed' });
  }
});
router.get('/sessions', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(`
      SELECT s.*,
        o.order_number,
        COUNT(ci.id) as items_scanned,
        COALESCE(SUM(ci.quantity_scanned), 0) as total_units_scanned,
        COUNT(cd.id) as discrepancy_count
      FROM checkin_sessions s
      LEFT JOIN supplier_orders o ON o.id = s.order_id
      LEFT JOIN checkin_items ci ON ci.session_id = s.id AND ci.removed_at IS NULL
      LEFT JOIN checkin_discrepancies cd ON cd.session_id = s.id
      GROUP BY s.id, o.order_number
      ORDER BY s.created_at DESC
      LIMIT 50
    `);
    res.json({ sessions: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// Start new session
router.post('/sessions', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { order_id, delivery_id, delivery_note_id, notes } = req.body;
    if (delivery_note_id) {
      const opened = await openDeliveryNote(delivery_note_id, (req as any).user?.email || 'warehouse');
      if (!opened) return res.status(404).json({ error: 'Delivery note not found' });
      return res.status(201).json(opened);
    }
    const result = await query(
      `INSERT INTO checkin_sessions (order_id, notes, started_by, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *`,
      [order_id || null, notes || null, (req as any).user?.email || 'warehouse']
    );

    // Link the session to a delivery record if provided
    if (delivery_id) {
      await query(
        `UPDATE genero_deliveries SET checkin_session_id=$1, status='ARRIVED', last_updated=NOW() WHERE id=$2`,
        [result.rows[0].id, delivery_id]
      );
    }

    // If linked to an order, mark it as being received
    if (order_id) {
      await query(
        `UPDATE supplier_orders SET status = 'PARTIALLY_RECEIVED', updated_at = NOW() WHERE id = $1 AND status = 'DISPATCHED'`,
        [order_id]
      );
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// Session detail
router.get('/sessions/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const session = await query(`
      SELECT s.*, o.order_number, o.id as order_id
      FROM checkin_sessions s
      LEFT JOIN supplier_orders o ON o.id = s.order_id
      WHERE s.id = $1
    `, [req.params.id]);

    if (!session.rows[0]) return res.status(404).json({ error: 'Session not found' });

    const items = await query(
      `SELECT * FROM checkin_items WHERE session_id = $1 AND removed_at IS NULL ORDER BY scanned_at DESC`,
      [req.params.id]
    );
    const enrichedItems = await enrichCheckinItems(items.rows);

    const discrepancies = await query(
      `SELECT * FROM checkin_discrepancies WHERE session_id = $1 ORDER BY discrepancy_type, nw_code`,
      [req.params.id]
    );

    // Expected quantities from the linked order, if any — lets the UI show a live
    // "scanned / expected" count per code as the user scans, without running Compare.
    const delivery_note = await deliveryNoteForSession(session.rows[0].delivery_note_id);
    let order_line_items: any[] = [];
    if (delivery_note) {
      order_line_items = delivery_note.lines.map((line) => ({
        nw_code: line.sku, colour: null, quantity_ordered: line.quantity, medusa_sku: line.sku, quantity_received: line.received,
      }));
    } else if (session.rows[0].order_id) {
      const lines = await query(
        `SELECT nw_code, colour, quantity_ordered, medusa_sku FROM order_line_items WHERE order_id = $1`,
        [session.rows[0].order_id]
      );
      order_line_items = lines.rows;
    }

    res.json({ ...session.rows[0], items: enrichedItems, discrepancies: discrepancies.rows, order_line_items, delivery_note, failed_scans: await failedScansFor('STOCK_IN', req.params.id) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

// Scan an item
router.post('/sessions/:id/scan', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { nw_code, colour: bodyColour, quantity_scanned = 1, notes, quantity_is_units = false } = req.body;

    if (!nw_code) return res.status(400).json({ error: 'nw_code required' });

    let code = String(nw_code).trim();
    let colour = bodyColour as string | undefined;
    const mappedBarcode = await query(
      `SELECT product_sku FROM barcode_mappings WHERE barcode = $1 AND is_active = true LIMIT 1`,
      [code.toUpperCase()]
    );
    const tray = await asSingleInsertTray(mappedBarcode.rows[0]?.product_sku || code);
    let medusa_sku: string | null = null;
    if (tray) {
      code = tray.sku;
      medusa_sku = tray.sku;
      if (!colour && tray.colour_name) colour = tray.colour_name;
    } else {
      const mapping = await query(`SELECT medusa_sku FROM sku_mappings WHERE nw_code = $1`, [code]);
      medusa_sku = mapping.rows[0]?.medusa_sku || null;
    }
    const units = stockInUnits(code, null, Number(quantity_scanned), quantity_is_units === true);

    // Check session is open
    const session = await query(`SELECT status FROM checkin_sessions WHERE id = $1`, [req.params.id]);
    if (!session.rows[0]) return res.status(404).json({ error: 'Session not found' });
    if (session.rows[0].status === 'COMPLETE') return res.status(400).json({ error: 'Session is complete' });

    // Check if this nw_code+colour already scanned — if so, increment
    const existing = await query(
      `SELECT id, quantity_scanned FROM checkin_items WHERE session_id = $1 AND nw_code = $2 AND LOWER(colour) = LOWER($3) AND removed_at IS NULL`,
      [req.params.id, code, colour || '']
    );

    let item;
    if (existing.rows[0]) {
      const result = await query(
        `UPDATE checkin_items SET quantity_scanned = quantity_scanned + $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [units, existing.rows[0].id]
      );
      item = result.rows[0];
    } else {
      const result = await query(
        `INSERT INTO checkin_items (session_id, nw_code, colour, medusa_sku, quantity_scanned, notes, scanned_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) RETURNING *`,
        [req.params.id, code, colour || null, medusa_sku, units, notes || null]
      );
      item = result.rows[0];
    }

    res.json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record scan' });
  }
});

// Update scanned quantity
router.patch('/sessions/:id/items/:itemId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { quantity_scanned, notes } = req.body;
    const result = await query(
      `UPDATE checkin_items SET quantity_scanned = $1, notes = $2 WHERE id = $3 AND session_id = $4 RETURNING *`,
      [quantity_scanned, notes || null, req.params.itemId, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Item not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// Remove item
router.delete('/sessions/:id/items/:itemId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    await query(`DELETE FROM checkin_items WHERE id = $1 AND session_id = $2`, [req.params.itemId, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove item' });
  }
});

// Point an unknown scan at a real product. Works after the goods are already scanned, including a saved session.
router.post('/sessions/:id/items/:itemId/reconcile', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const code = String(req.body?.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Enter the product code' });
    const resolved = await resolveScan(code);
    if (!resolved?.matched) {
      return res.status(400).json({ error: 'That code is not a product yet. The scan stays as it is.' });
    }

    const found = await query(
      `SELECT * FROM checkin_items WHERE id = $1 AND session_id = $2 AND removed_at IS NULL`,
      [req.params.itemId, req.params.id],
    );
    const item = found.rows[0];
    if (!item) return res.status(404).json({ error: 'Scan not found' });

    const oldSku = item.medusa_sku || item.nw_code;
    const newSku = resolved.medusa_sku || resolved.sku;
    await query(
      `UPDATE checkin_items
          SET nw_code = $1, medusa_sku = $2, colour = COALESCE($3, colour), updated_at = NOW()
        WHERE id = $4`,
      [resolved.nw_code || newSku, newSku, resolved.colour_name, item.id],
    );

    const session = await query(`SELECT status, started_by FROM checkin_sessions WHERE id = $1`, [req.params.id]);
    if (session.rows[0]?.status === 'COMPLETE' && oldSku && oldSku !== newSku) {
      const holding = await getHoldingLocation();
      const colour = await resolveColourCode(newSku, resolved.colour_code);
      const actor = toUuidOrNull(req.user?.id) || toUuidOrNull(session.rows[0].started_by);
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE warehouse_inventory
              SET quantity = GREATEST(quantity - $1, 0), updated_at = NOW()
            WHERE location_id = $2 AND product_sku = $3`,
          [item.quantity_scanned, holding, oldSku],
        );
        await client.query(
          `INSERT INTO warehouse_inventory (location_id, product_sku, colour_code, quantity, liability_status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'Bisley', NOW(), NOW())
           ON CONFLICT (location_id, product_sku, COALESCE(colour_code, ''))
           DO UPDATE SET quantity = warehouse_inventory.quantity + EXCLUDED.quantity, updated_at = NOW()`,
          [holding, newSku, colour, item.quantity_scanned],
        );
        if (actor) {
          await client.query(
            `INSERT INTO warehouse_movements (movement_type, location_id, product_sku, colour_code, quantity, notes, performed_by, checkin_session_id)
             VALUES ('RECEIVE', $1, $2, $3, $4, $5, $6, $7)`,
            [holding, newSku, colour, item.quantity_scanned, `Reconciled from ${oldSku}`, actor, req.params.id],
          );
        }
        await client.query('COMMIT');
      } catch (moveErr) {
        await client.query('ROLLBACK');
        throw moveErr;
      } finally {
        client.release();
      }
      await assignStockedToOlderOrders([oldSku, newSku]);
      const syncErrors = await pushAvailableStock([oldSku, newSku]);
      if (syncErrors.length) console.error(`[checkin] Medusa sync failed: ${syncErrors.join('; ')}`);
    }

    res.json({ success: true, sku: newSku, product_name: resolved.product_name });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to reconcile scan';
    res.status(500).json({ error: message });
  }
});

// Reset — clear every scanned item and discrepancy, keep the session open to start again
router.post('/sessions/:id/reset', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const session = await query(`SELECT status FROM checkin_sessions WHERE id = $1`, [req.params.id]);
    if (!session.rows[0]) return res.status(404).json({ error: 'Session not found' });
    if (session.rows[0].status === 'COMPLETE') return res.status(400).json({ error: 'Session is complete' });

    await query(`DELETE FROM checkin_items WHERE session_id = $1`, [req.params.id]);
    await query(`DELETE FROM checkin_discrepancies WHERE session_id = $1`, [req.params.id]);
    await query(`UPDATE checkin_sessions SET status = 'OPEN', updated_at = NOW() WHERE id = $1`, [req.params.id]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset session' });
  }
});

// Compare scanned vs order — generates discrepancy report
router.post('/sessions/:id/compare', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const session = await query(`SELECT * FROM checkin_sessions WHERE id = $1`, [req.params.id]);
    if (!session.rows[0]) return res.status(404).json({ error: 'Session not found' });
    const { order_id } = session.rows[0];

    // Clear old discrepancies for this session
    await query(`DELETE FROM checkin_discrepancies WHERE session_id = $1`, [req.params.id]);

    // Get scanned items
    const scanned = await query(`SELECT * FROM checkin_items WHERE session_id = $1 AND removed_at IS NULL`, [req.params.id]);
    const scannedMap = new Map<string, number>();
    scanned.rows.forEach(i => scannedMap.set(`${i.nw_code}|${(i.colour || '').toLowerCase()}`, i.quantity_scanned));

    const discrepancies = [];

    if (order_id) {
      // Get ordered items
      const ordered = await query(`SELECT * FROM order_line_items WHERE order_id = $1`, [order_id]);

      for (const line of ordered.rows) {
        const key = `${line.nw_code}|${(line.colour || '').toLowerCase()}`;
        const received = scannedMap.get(key) || 0;
        scannedMap.delete(key); // Remove matched items

        if (received < line.quantity_ordered) {
          discrepancies.push({
            session_id: req.params.id, order_id,
            nw_code: line.nw_code, colour: line.colour, medusa_sku: line.medusa_sku,
            quantity_ordered: line.quantity_ordered, quantity_received: received,
            discrepancy_type: received === 0 ? 'MISSING' : 'SHORT',
          });
        } else if (received > line.quantity_ordered) {
          discrepancies.push({
            session_id: req.params.id, order_id,
            nw_code: line.nw_code, colour: line.colour, medusa_sku: line.medusa_sku,
            quantity_ordered: line.quantity_ordered, quantity_received: received,
            discrepancy_type: 'OVERAGE',
          });
        }
      }

      // Remaining in scannedMap = unexpected items not on order
      for (const [key, qty] of scannedMap) {
        const [nw_code, colour] = key.split('|');
        discrepancies.push({
          session_id: req.params.id, order_id,
          nw_code, colour, medusa_sku: null,
          quantity_ordered: 0, quantity_received: qty,
          discrepancy_type: 'UNEXPECTED',
        });
      }
    }

    // Insert all discrepancies
    for (const d of discrepancies) {
      await query(
        `INSERT INTO checkin_discrepancies (session_id, order_id, nw_code, colour, medusa_sku, quantity_ordered, quantity_received, discrepancy_type, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'FLAGGED', NOW(), NOW())`,
        [d.session_id, d.order_id, d.nw_code, d.colour, d.medusa_sku, d.quantity_ordered, d.quantity_received, d.discrepancy_type]
      );
    }

    await query(`UPDATE checkin_sessions SET status = 'COMPARING', updated_at = NOW() WHERE id = $1`, [req.params.id]);

    res.json({
      discrepancies: discrepancies.length,
      missing: discrepancies.filter(d => d.discrepancy_type === 'MISSING').length,
      short: discrepancies.filter(d => d.discrepancy_type === 'SHORT').length,
      overage: discrepancies.filter(d => d.discrepancy_type === 'OVERAGE').length,
      unexpected: discrepancies.filter(d => d.discrepancy_type === 'UNEXPECTED').length,
      items: discrepancies,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compare' });
  }
});

// Complete session — finalises, marks order received, populates requires_location_queue
router.post('/sessions/:id/complete', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const session = await query(`SELECT * FROM checkin_sessions WHERE id = $1`, [req.params.id]);
    if (!session.rows[0]) return res.status(404).json({ error: 'Session not found' });

    if (session.rows[0].status === 'COMPLETE') {
      return res.status(400).json({ error: 'Session is already complete' });
    }

    const holdingLocationId = await getHoldingLocation();
    const userId = toUuidOrNull(req.user?.id);
    const items = await query(`SELECT * FROM checkin_items WHERE session_id = $1 AND removed_at IS NULL`, [req.params.id]);
    const prepared: { sku: string; colourCode: string; qty: number; item: any }[] = [];
    for (const item of items.rows) {
      const sku = item.medusa_sku || item.nw_code;
      prepared.push({ sku, colourCode: await resolveColourCode(sku, item.colour), qty: item.quantity_scanned, item });
    }

    const client = await getPool().connect();
    const syncedSkus = new Set<string>();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT status FROM checkin_sessions WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (locked.rows[0]?.status === 'COMPLETE') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Session is already complete' });
      }
      for (const p of prepared) {
        await client.query(
          `INSERT INTO warehouse_inventory (location_id, product_sku, colour_code, quantity, liability_status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'Bisley', NOW(), NOW())
           ON CONFLICT (location_id, product_sku, COALESCE(colour_code, ''))
           DO UPDATE SET quantity = warehouse_inventory.quantity + $4, updated_at = NOW()`,
          [holdingLocationId, p.sku, p.colourCode, p.qty]
        );
        if (userId) {
          await client.query(
            `INSERT INTO warehouse_movements (movement_type, location_id, product_sku, colour_code, quantity, notes, performed_by, checkin_session_id)
             VALUES ('RECEIVE', $1, $2, $3, $4, 'Checked in to holding bay', $5, $6)`,
            [holdingLocationId, p.sku, p.colourCode, p.qty, userId, req.params.id]
          );
        }
        await client.query(
          `INSERT INTO requires_location_queue (session_id, order_id, nw_code, colour, medusa_sku, quantity, location_id, status, assigned_by, assigned_at, stocked_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'STOCKED', $8, NOW(), NOW(), NOW(), NOW())`,
          [req.params.id, session.rows[0].order_id, p.item.nw_code, p.item.colour, p.item.medusa_sku, p.qty, holdingLocationId, req.user?.email || 'warehouse']
        );
        syncedSkus.add(p.sku);
      }
      await client.query(
        `UPDATE checkin_sessions SET status = 'COMPLETE', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [req.params.id]
      );
      if (session.rows[0].order_id) {
        await client.query(
          `UPDATE supplier_orders SET status = 'RECEIVED', received_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [session.rows[0].order_id]
        );
      }
      await client.query('COMMIT');
    } catch (stockErr) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw stockErr;
    } finally {
      client.release();
    }

    if (syncedSkus.size) await unblockBackorderedPickLists([...syncedSkus]);
    const syncErrors = syncedSkus.size ? await pushAvailableStock([...syncedSkus]) : [];
    if (syncErrors.length) console.error(`[checkin] Medusa sync failed: ${syncErrors.join('; ')}`);
    scheduleStockHolds();
    // After the holds rebuild (which runs 0.5s from now), set aside any arrived custom parts for their orders
    setTimeout(() => matchCustomArrivalsQuietly('check-in'), 4000);

    const summary = await query(
      `SELECT COUNT(*) as items, SUM(quantity_scanned) as units FROM checkin_items WHERE session_id = $1 AND removed_at IS NULL`,
      [req.params.id]
    );

    res.json({ success: true, queued_for_location: prepared.length, ...summary.rows[0], sync_errors: syncErrors.length ? syncErrors : undefined });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to complete session' });
  }
});

/** DELETE /api/checkin/sessions/:id — abandon/cancel an open session */
router.delete('/sessions/:id', authMiddleware, requirePermission('manage_operations'), async (req: AuthRequest, res: Response) => {
  try {
    const session = await query(`SELECT status FROM checkin_sessions WHERE id = $1`, [req.params.id]);
    if (!session.rows[0]) return res.status(404).json({ error: 'Session not found' });
    if (session.rows[0].status === 'COMPLETE') {
      return res.status(400).json({ error: 'Cannot abandon a completed session' });
    }
    await query(
      `UPDATE checkin_sessions SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to abandon session' });
  }
});

export default router;
