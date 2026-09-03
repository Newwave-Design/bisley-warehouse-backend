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
import { query } from '../../db/index.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';

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
      return res.json({ source: 'barcode', ...barcode.rows[0] });
    }

    // 2. Check sku_mappings by NW code
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
      LEFT JOIN checkin_items ci ON ci.session_id = s.id
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
    const { order_id, delivery_id, notes } = req.body;
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
      `SELECT * FROM checkin_items WHERE session_id = $1 ORDER BY scanned_at DESC`,
      [req.params.id]
    );

    const discrepancies = await query(
      `SELECT * FROM checkin_discrepancies WHERE session_id = $1 ORDER BY discrepancy_type, nw_code`,
      [req.params.id]
    );

    // Expected quantities from the linked order, if any — lets the UI show a live
    // "scanned / expected" count per code as the user scans, without running Compare.
    let order_line_items: any[] = [];
    if (session.rows[0].order_id) {
      const lines = await query(
        `SELECT nw_code, colour, quantity_ordered, medusa_sku FROM order_line_items WHERE order_id = $1`,
        [session.rows[0].order_id]
      );
      order_line_items = lines.rows;
    }

    res.json({ ...session.rows[0], items: items.rows, discrepancies: discrepancies.rows, order_line_items });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

// Scan an item
router.post('/sessions/:id/scan', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { nw_code, colour, quantity_scanned = 1, notes } = req.body;

    if (!nw_code) return res.status(400).json({ error: 'nw_code required' });

    // Check session is open
    const session = await query(`SELECT status FROM checkin_sessions WHERE id = $1`, [req.params.id]);
    if (!session.rows[0]) return res.status(404).json({ error: 'Session not found' });
    if (session.rows[0].status === 'COMPLETE') return res.status(400).json({ error: 'Session is complete' });

    // Lookup medusa_sku from mappings
    const mapping = await query(`SELECT medusa_sku FROM sku_mappings WHERE nw_code = $1`, [nw_code]);
    const medusa_sku = mapping.rows[0]?.medusa_sku || null;

    // Check if this nw_code+colour already scanned — if so, increment
    const existing = await query(
      `SELECT id, quantity_scanned FROM checkin_items WHERE session_id = $1 AND nw_code = $2 AND LOWER(colour) = LOWER($3)`,
      [req.params.id, nw_code, colour || '']
    );

    let item;
    if (existing.rows[0]) {
      const result = await query(
        `UPDATE checkin_items SET quantity_scanned = quantity_scanned + $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [quantity_scanned, existing.rows[0].id]
      );
      item = result.rows[0];
    } else {
      const result = await query(
        `INSERT INTO checkin_items (session_id, nw_code, colour, medusa_sku, quantity_scanned, notes, scanned_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) RETURNING *`,
        [req.params.id, nw_code, colour || null, medusa_sku, quantity_scanned, notes || null]
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
    const scanned = await query(`SELECT * FROM checkin_items WHERE session_id = $1`, [req.params.id]);
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

    await query(
      `UPDATE checkin_sessions SET status = 'COMPLETE', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    if (session.rows[0].order_id) {
      await query(
        `UPDATE supplier_orders SET status = 'RECEIVED', received_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [session.rows[0].order_id]
      );
    }

    // Move all scanned items to requires_location_queue
    const items = await query(`SELECT * FROM checkin_items WHERE session_id = $1`, [req.params.id]);
    for (const item of items.rows) {
      await query(
        `INSERT INTO requires_location_queue (session_id, order_id, nw_code, colour, medusa_sku, quantity, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        [req.params.id, session.rows[0].order_id, item.nw_code, item.colour, item.medusa_sku, item.quantity_scanned]
      );
    }

    const summary = await query(
      `SELECT COUNT(*) as items, SUM(quantity_scanned) as units FROM checkin_items WHERE session_id = $1`,
      [req.params.id]
    );

    res.json({ success: true, queued_for_location: items.rows.length, ...summary.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to complete session' });
  }
});

/** DELETE /api/checkin/sessions/:id — abandon/cancel an open session */
router.delete('/sessions/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
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
