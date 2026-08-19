/**
 * Check-in API Routes — Phase 3: Receiving
 *
 * GET    /api/checkin/sessions              — List sessions
 * POST   /api/checkin/sessions              — Start new session
 * GET    /api/checkin/sessions/:id          — Session detail + items
 * POST   /api/checkin/sessions/:id/scan     — Add scanned item
 * PATCH  /api/checkin/sessions/:id/items/:itemId — Update scanned qty
 * DELETE /api/checkin/sessions/:id/items/:itemId — Remove item
 * POST   /api/checkin/sessions/:id/compare  — Generate discrepancy report vs order
 * POST   /api/checkin/sessions/:id/complete — Finalise session
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';

const router = express.Router();

// List sessions
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
    const { order_id, notes } = req.body;
    const result = await query(
      `INSERT INTO checkin_sessions (order_id, notes, started_by, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *`,
      [order_id || null, notes || null, (req as any).user?.email || 'warehouse']
    );

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

    res.json({ ...session.rows[0], items: items.rows, discrepancies: discrepancies.rows });
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

export default router;
