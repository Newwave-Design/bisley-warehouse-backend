/**
 * Move Sessions API — handheld bay-to-bay stock moves in sessions (mirrors stock-in):
 * 1. Start session  2. Scan items (one cumulative row per SKU+colour, every scan logged)
 * 3. Review  4. Pick destination bay, tick selected items to move
 *
 * GET    /api/move-sessions/sessions                       — List sessions (?status=OPEN default, or COMPLETE / CANCELLED / ALL)
 * POST   /api/move-sessions/start-session                  — New session
 * GET    /api/move-sessions/sessions/:id                   — Session + items (with live stock bays) + scan log
 * POST   /api/move-sessions/scan                           — Scan an item into a session
 * PATCH  /api/move-sessions/sessions/:id/items/:itemId     — Edit quantity / source bay
 * DELETE /api/move-sessions/sessions/:id/items/:itemId     — Soft-remove an item (restorable)
 * POST   /api/move-sessions/sessions/:id/items/:itemId/restore
 * POST   /api/move-sessions/sessions/:id/abandon           — Cancel an open session
 * POST   /api/move-sessions/sessions/:id/move              — Move selected items to a bay; session completes when all are moved
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { failedScansFor } from '../../lib/failed-scans.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { lookupProduct, getStock, toUuidOrNull } from './mobile.js';
import { moveStockBetweenBays } from '../../lib/stock-move.js';
import { getLogger } from '../../lib/logger.js';

const router = express.Router();
const logger = getLogger('move-sessions');

const errMsg = (err: unknown) => (err instanceof Error ? err.message : JSON.stringify(err));

// Current bays holding each item, so the review screen always shows live stock
const STOCK_LOCATIONS_SQL = `(
  SELECT COALESCE(json_agg(json_build_object('location_code', l.location_code, 'quantity', wi.quantity) ORDER BY wi.quantity DESC), '[]'::json)
  FROM warehouse_inventory wi JOIN warehouse_locations l ON l.id = wi.location_id
  WHERE wi.product_sku = mi.product_sku AND (wi.colour_code = mi.colour_code OR mi.colour_code IS NULL) AND wi.quantity > 0
) AS stock_locations`;

async function getItem(itemId: string) {
  const r = await query(`SELECT mi.*, ${STOCK_LOCATIONS_SQL} FROM move_items mi WHERE mi.id = $1`, [itemId]);
  return r.rows[0];
}

router.get('/sessions', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { status = 'OPEN', limit = '30', offset = '0' } = req.query;
    const statusFilter = status === 'ALL' ? null : status;
    const result = await query(
      `SELECT s.*,
        COUNT(mi.id)::int AS items_count,
        COALESCE(SUM(mi.quantity), 0)::int AS total_units
       FROM move_sessions s
       LEFT JOIN move_items mi ON mi.session_id = s.id AND mi.removed_at IS NULL
       WHERE ($1::text IS NULL OR s.status = $1)
       GROUP BY s.id
       ORDER BY s.created_at DESC
       LIMIT $2 OFFSET $3`,
      [statusFilter, Math.min(parseInt(limit as string) || 30, 100), parseInt(offset as string) || 0]
    );
    res.json({ sessions: result.rows });
  } catch (err) {
    logger.error(`Failed to list sessions: ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

router.post('/start-session', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `INSERT INTO move_sessions (status, started_by) VALUES ('OPEN', $1) RETURNING *`,
      [req.user?.email || 'warehouse']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error(`Failed to start session: ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

router.get('/sessions/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const session = await query(`SELECT * FROM move_sessions WHERE id = $1`, [req.params.id]);
    if (!session.rows[0]) return res.status(404).json({ error: 'Session not found' });

    const items = await query(
      `SELECT mi.*, ${STOCK_LOCATIONS_SQL} FROM move_items mi WHERE mi.session_id = $1 ORDER BY mi.created_at`,
      [req.params.id]
    );
    const scans = await query(
      `SELECT id, item_id, quantity, scanned_at FROM move_scans WHERE session_id = $1 ORDER BY scanned_at DESC LIMIT 500`,
      [req.params.id]
    );
    res.json({ session: session.rows[0], items: items.rows, scans: scans.rows, failed_scans: await failedScansFor('MOVE', req.params.id) });
  } catch (err) {
    logger.error(`Failed to fetch session: ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

router.post('/scan', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { session_id, scan_input } = req.body;
    const quantity = Math.max(1, parseInt(req.body.quantity) || 1);
    if (!session_id || !scan_input) return res.status(400).json({ error: 'session_id and scan_input required' });

    const session = await query(`SELECT status FROM move_sessions WHERE id = $1`, [session_id]);
    if (!session.rows[0]) return res.status(404).json({ error: 'Session not found' });
    if (session.rows[0].status !== 'OPEN') return res.status(400).json({ error: 'Session is not open' });

    const q = String(scan_input).trim().toUpperCase();
    const found = await lookupProduct(q);
    // Partial SKU matches are too loose for a stock move — require an exact hit
    if (!found.found || (found.source === 'sku_search' && String(found.sku).toUpperCase() !== q)) {
      return res.status(404).json({ error: 'Product not found', query: q });
    }
    if (!found.stock?.total) {
      return res.status(400).json({ error: `No stock in WMS: ${found.sku}` });
    }

    const colour = found.colour_code || null;
    const existing = await query(
      `SELECT id FROM move_items
       WHERE session_id = $1 AND product_sku = $2 AND COALESCE(colour_code, '') = COALESCE($3, '')
         AND removed_at IS NULL AND moved_at IS NULL`,
      [session_id, found.sku, colour]
    );

    let itemId: string;
    if (existing.rows[0]) {
      itemId = existing.rows[0].id;
      await query(`UPDATE move_items SET quantity = quantity + $1, updated_at = NOW() WHERE id = $2`, [quantity, itemId]);
    } else {
      const inserted = await query(
        `INSERT INTO move_items (session_id, product_sku, colour_code, colour_name, product_name, quantity)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [session_id, found.sku, colour, found.colour_name || null, found.product_name || null, quantity]
      );
      itemId = inserted.rows[0].id;
    }

    const scan = await query(
      `INSERT INTO move_scans (session_id, item_id, quantity) VALUES ($1, $2, $3) RETURNING id, item_id, quantity, scanned_at`,
      [session_id, itemId, quantity]
    );
    res.json({ success: true, item: await getItem(itemId), scan: scan.rows[0] });
  } catch (err) {
    logger.error(`Move scan failed: ${errMsg(err)}`);
    res.status(500).json({ error: `Scan failed: ${errMsg(err)}` });
  }
});

router.patch('/sessions/:id/items/:itemId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const sets: string[] = [];
    const params: any[] = [];
    if (req.body.quantity !== undefined) {
      const qty = parseInt(req.body.quantity);
      if (!(qty >= 1)) return res.status(400).json({ error: 'Invalid quantity' });
      params.push(qty);
      sets.push(`quantity = $${params.length}`);
    }
    if (req.body.from_location !== undefined) {
      params.push(req.body.from_location ? String(req.body.from_location).toUpperCase() : null);
      sets.push(`from_location = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.itemId, req.params.id);
    const result = await query(
      `UPDATE move_items SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length - 1} AND session_id = $${params.length} AND removed_at IS NULL AND moved_at IS NULL
       RETURNING id`,
      params
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Item not found' });
    res.json(await getItem(req.params.itemId));
  } catch (err) {
    logger.error(`Failed to update move item: ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

router.delete('/sessions/:id/items/:itemId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    await query(
      `UPDATE move_items SET removed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND session_id = $2 AND moved_at IS NULL`,
      [req.params.itemId, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error(`Failed to remove move item: ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to remove item' });
  }
});

// Undo a removal; merges into the live row if the item was re-scanned since
router.post('/sessions/:id/items/:itemId/restore', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const session = await query(`SELECT status FROM move_sessions WHERE id = $1`, [req.params.id]);
    if (session.rows[0]?.status !== 'OPEN') return res.status(400).json({ error: 'Session is not open' });

    const removed = await query(
      `SELECT * FROM move_items WHERE id = $1 AND session_id = $2 AND removed_at IS NOT NULL`,
      [req.params.itemId, req.params.id]
    );
    const item = removed.rows[0];
    if (!item) return res.status(404).json({ error: 'Removed item not found' });

    const live = await query(
      `SELECT id FROM move_items
       WHERE session_id = $1 AND product_sku = $2 AND COALESCE(colour_code, '') = COALESCE($3, '')
         AND removed_at IS NULL AND moved_at IS NULL LIMIT 1`,
      [req.params.id, item.product_sku, item.colour_code]
    );
    if (live.rows[0]) {
      await query(`UPDATE move_items SET quantity = quantity + $1, updated_at = NOW() WHERE id = $2`, [item.quantity, live.rows[0].id]);
      await query(`UPDATE move_scans SET item_id = $1 WHERE item_id = $2`, [live.rows[0].id, item.id]);
      await query(`DELETE FROM move_items WHERE id = $1`, [item.id]);
    } else {
      await query(`UPDATE move_items SET removed_at = NULL, updated_at = NOW() WHERE id = $1`, [item.id]);
    }
    res.json({ success: true });
  } catch (err) {
    logger.error(`Failed to restore move item: ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to restore item' });
  }
});

router.post('/sessions/:id/abandon', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `UPDATE move_sessions SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1 AND status = 'OPEN' RETURNING id`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(400).json({ error: 'Session not found or not open' });
    res.json({ success: true });
  } catch (err) {
    logger.error(`Failed to abandon move session: ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to abandon session' });
  }
});

/**
 * POST /sessions/:id/move { item_ids: string[], to_location: string }
 * Per item: source is the item's chosen bay, else the fullest bays first (never the destination).
 * Each item succeeds or fails on its own; the session completes once every live item has moved.
 */
router.post('/sessions/:id/move', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { item_ids, to_location } = req.body;
    if (!Array.isArray(item_ids) || !item_ids.length || !to_location) {
      return res.status(400).json({ error: 'item_ids and to_location required' });
    }
    const to = String(to_location).toUpperCase();

    const session = await query(`SELECT status FROM move_sessions WHERE id = $1`, [req.params.id]);
    if (!session.rows[0]) return res.status(404).json({ error: 'Session not found' });
    if (session.rows[0].status !== 'OPEN') return res.status(400).json({ error: 'Session is not open' });

    const bay = await query(`SELECT 1 FROM warehouse_locations WHERE location_code = $1`, [to]);
    if (!bay.rows[0]) return res.status(404).json({ error: `Bay ${to} not found` });

    const items = await query(
      `SELECT * FROM move_items
       WHERE session_id = $1 AND id = ANY($2::uuid[]) AND removed_at IS NULL AND moved_at IS NULL
       ORDER BY created_at`,
      [req.params.id, item_ids]
    );
    const userId = toUuidOrNull(req.user?.id);
    const results: any[] = [];

    for (const item of items.rows) {
      const moves: any[] = [];
      let remaining: number = item.quantity;
      try {
        const bays = (await getStock(item.product_sku, item.colour_code)).locations.filter((l: any) => l.quantity > 0);
        const candidates = bays
          .filter((l: any) => !item.from_location || l.location_code.toUpperCase() === item.from_location.toUpperCase())
          .filter((l: any) => l.location_code.toUpperCase() !== to);
        if (!candidates.length) {
          throw new Error(bays.some((l: any) => l.location_code.toUpperCase() === to) ? `Already in ${to}` : 'No stock to move');
        }
        const available = candidates.reduce((s: number, l: any) => s + l.quantity, 0);
        if (available < item.quantity) throw new Error(`Only ${available} available outside ${to}`);

        for (const c of candidates) {
          if (remaining <= 0) break;
          const take = Math.min(c.quantity, remaining);
          const r = await moveStockBetweenBays({
            fromCode: c.location_code, toCode: to, sku: item.product_sku,
            colourCode: item.colour_code, quantity: take, userId,
          });
          moves.push({ from_location: c.location_code, quantity: take, movement_in: r.movement_in, movement_out: r.movement_out });
          remaining -= take;
        }

        await query(
          `UPDATE move_items SET moved_at = NOW(), to_location = $1, move_log = $2::jsonb, updated_at = NOW() WHERE id = $3`,
          [to, JSON.stringify(moves), item.id]
        );
        results.push({ item_id: item.id, ok: true, moves });
      } catch (err) {
        // Part of the quantity may already have moved — keep the row consistent with what's left
        if (moves.length && remaining > 0) {
          await query(`UPDATE move_items SET quantity = $1, updated_at = NOW() WHERE id = $2`, [remaining, item.id]);
        }
        results.push({ item_id: item.id, ok: false, error: errMsg(err), moves });
      }
    }

    const left = await query(
      `SELECT COUNT(*)::int AS c FROM move_items WHERE session_id = $1 AND removed_at IS NULL AND moved_at IS NULL`,
      [req.params.id]
    );
    let sessionStatus = 'OPEN';
    if (left.rows[0].c === 0 && results.some(r => r.ok)) {
      await query(`UPDATE move_sessions SET status = 'COMPLETE', completed_at = NOW(), updated_at = NOW() WHERE id = $1`, [req.params.id]);
      sessionStatus = 'COMPLETE';
    }

    logger.info(`[move-sessions] Session ${req.params.id}: moved ${results.filter(r => r.ok).length}/${results.length} items to ${to}`);
    res.json({ results, session_status: sessionStatus });
  } catch (err) {
    logger.error(`Move failed: ${errMsg(err)}`);
    res.status(500).json({ error: `Move failed: ${errMsg(err)}` });
  }
});

export default router;
