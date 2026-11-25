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
import { customLinesWithState, linkCustomArrival, matchCustomArrivals, unlinkCustomArrival } from '../../lib/custom-arrivals.js';

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ lines: await customLinesWithState({ query }) });
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
