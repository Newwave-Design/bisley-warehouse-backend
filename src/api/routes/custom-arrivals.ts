/**
 * Custom order lines and whether their part has arrived.
 *
 * GET  /api/custom-arrivals         — open custom lines with a part code: ARRIVED, PARTIAL or WAITING
 * POST /api/custom-arrivals/rematch — run the match now (it also runs after each check-in and on a timer)
 */
import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { customPartCode, isChargeTitle } from './supplier-reorders.js';
import { matchCustomArrivals } from '../../lib/custom-arrivals.js';

const router = express.Router();

router.get('/', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT pli.id, pli.item_title, pli.quantity_required, pli.quantity_picked,
              pl.pick_list_number, pl.customer_name, pl.status, pl.created_at,
              COALESCE(a.qty, 0)::int AS arrived, a.sku AS arrived_sku
         FROM pick_list_items pli
         JOIN pick_lists pl ON pl.id = pli.pick_list_id
         LEFT JOIN custom_line_arrivals a ON a.pick_list_item_id = pli.id AND a.consumed_at IS NULL
        WHERE pli.is_custom = true AND NOT COALESCE(pli.is_archived, false) AND NOT COALESCE(pli.is_sandbox, false)
          AND NOT pl.is_sandbox AND NOT COALESCE(pl.is_archived, false)
          AND pl.status NOT IN ('DISPATCHED', 'CANCELLED')
          AND pli.quantity_picked < pli.quantity_required
        ORDER BY pl.created_at ASC, pli.line_number ASC`,
    );
    const lines = [];
    for (const r of result.rows) {
      const title = String(r.item_title || '').trim();
      if (!title || isChargeTitle(title)) continue;
      const code = customPartCode(title);
      if (!code) continue;
      const needed = (Number(r.quantity_required) || 0) - (Number(r.quantity_picked) || 0);
      const arrived = Number(r.arrived) || 0;
      lines.push({
        id: r.id,
        order: r.pick_list_number,
        customer: r.customer_name,
        title,
        code,
        needed,
        arrived,
        state: arrived >= needed ? 'ARRIVED' : arrived > 0 ? 'PARTIAL' : 'WAITING',
      });
    }
    res.json({ lines });
  } catch (err) {
    console.error('Custom arrivals error:', err);
    res.status(500).json({ error: 'Failed to load custom items' });
  }
});

router.post('/rematch', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ success: true, ...(await matchCustomArrivals()) });
  } catch (err) {
    console.error('Custom arrivals match error:', err);
    res.status(500).json({ error: 'Failed to match parts to orders' });
  }
});

export default router;
