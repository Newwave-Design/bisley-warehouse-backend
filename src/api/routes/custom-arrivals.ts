/**
 * Custom order lines and whether their part has arrived.
 *
 * GET  /api/custom-arrivals                — open custom lines with a part code: ARRIVED, PARTIAL or WAITING,
 *                                            with suggested shelf SKUs for a line that is still short
 * POST /api/custom-arrivals/rematch        — run the match now (it also runs after each check-in and on a timer)
 * POST /api/custom-arrivals/:id/link {sku} — a person confirms a near-miss SKU is the part for this line
 * POST /api/custom-arrivals/:id/unlink     — undo that
 */
import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { codeForLine, linkCustomArrival, matchCustomArrivals, suggestionsFor, unlinkCustomArrival } from '../../lib/custom-arrivals.js';

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT pli.id, pli.item_title, pli.quantity_required, pli.quantity_picked,
              pl.pick_list_number, pl.customer_name, pl.status, pl.created_at,
              COALESCE(a.qty, 0)::int AS arrived, a.sku AS arrived_sku, COALESCE(a.manual, false) AS manual
         FROM pick_list_items pli
         JOIN pick_lists pl ON pl.id = pli.pick_list_id
         LEFT JOIN custom_line_arrivals a ON a.pick_list_item_id = pli.id AND a.consumed_at IS NULL
        WHERE pli.is_custom = true AND NOT COALESCE(pli.is_archived, false) AND NOT COALESCE(pli.is_sandbox, false)
          AND NOT pl.is_sandbox AND NOT COALESCE(pl.is_archived, false)
          AND pl.status NOT IN ('DISPATCHED', 'CANCELLED')
          AND pli.quantity_picked < pli.quantity_required
        ORDER BY pl.created_at ASC, pli.line_number ASC`,
    );
    const lines: Array<Record<string, unknown>> = [];
    for (const r of result.rows) {
      const title = String(r.item_title || '').trim();
      const code = codeForLine(title);
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
        arrived_sku: r.arrived_sku,
        manual: Boolean(r.manual),
        state: arrived >= needed ? 'ARRIVED' : arrived > 0 ? 'PARTIAL' : 'WAITING',
      });
    }
    const short = lines.filter((l) => l.state !== 'ARRIVED') as Array<{ id: string; code: string }>;
    const suggestions = await suggestionsFor({ query }, short);
    res.json({ lines: lines.map((l) => ({ ...l, suggestions: suggestions.get(l.id as string) ?? [] })) });
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

router.post('/:id/link', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Bad line id' });
    const out = await linkCustomArrival(req.params.id, String(req.body?.sku ?? ''));
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    console.log(`[custom-arrivals] ${req.user?.email ?? 'someone'} linked ${req.body?.sku} to line ${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Custom arrivals link error:', err);
    res.status(500).json({ error: 'Failed to link the part' });
  }
});

router.post('/:id/unlink', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Bad line id' });
    await unlinkCustomArrival(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Custom arrivals unlink error:', err);
    res.status(500).json({ error: 'Failed to unlink the part' });
  }
});

export default router;
