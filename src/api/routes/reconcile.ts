/**
 * Desk reconciliation: where stock, typed SKUs and custom order lines that did not line up get sorted out.
 *
 * GET  /api/reconcile/overview        — spare parts on the shelf, custom lines still waiting, typed SKUs to check, recent moves
 * GET  /api/reconcile/shelf?q=        — search the shelf for a SKU or description (for the pickers)
 * POST /api/reconcile/move            — move free stock of one SKU to another SKU in the same bay (logged, undoable)
 * POST /api/reconcile/undo/:id        — reverse a move
 * POST /api/reconcile/assign          — set a shelf SKU aside for any open custom line, whatever its spelling
 * POST /api/reconcile/unassign        — undo that
 * POST /api/reconcile/remap           — check a typed SKU: re-point its barcode, optionally with the stock received under it
 */
import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, requirePermission, AuthRequest } from '../../middleware/auth.js';
import { toUuidOrNull } from './mobile.js';
import { scheduleStockHolds } from '../../lib/stock-holds.js';
import { pushAvailableStock } from '../../lib/medusa-inventory.js';
import { assignStockedToOlderOrders } from '../../lib/assign-arrived-stock.js';
import { unblockBackorderedPickLists } from './pick-lists.js';
import { customLinesWithState, linkCustomArrival, matchCustomArrivals, unlinkCustomArrival } from '../../lib/custom-arrivals.js';
import {
  ReconcileError, inTransaction, moveStockBetweenSkus, reconcileOverview, remapBarcode, searchShelf, undoReconciliation,
} from '../../lib/sku-reconcile.js';

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(res: Response, err: unknown, what: string) {
  if (err instanceof ReconcileError) return res.status(err.status).json({ error: err.message });
  console.error(`[reconcile] ${what}:`, err instanceof Error ? err.message : err);
  return res.status(500).json({ error: `Could not ${what}` });
}

/** After stock changed under these SKUs: shop quantities, holds on catalogue orders, and custom parts. Never fails the request. */
async function afterStockChange(skus: string[]) {
  try {
    const catalogue = await query(
      `SELECT variant_sku FROM wms_products WHERE upper(variant_sku) = ANY($1::text[]) AND NOT COALESCE(is_archived, false)`,
      [skus.map((s) => s.toUpperCase())],
    );
    const shop = catalogue.rows.map((r: { variant_sku: string }) => r.variant_sku);
    if (shop.length) {
      await assignStockedToOlderOrders(shop);
      await unblockBackorderedPickLists(shop);
      const errors = await pushAvailableStock(shop);
      if (errors.length) console.error(`[reconcile] Medusa sync failed: ${errors.join('; ')}`);
    }
    scheduleStockHolds();
  } catch (err) {
    console.warn('[reconcile] follow-up failed:', err instanceof Error ? err.message : err);
  }
  try { await matchCustomArrivals(); } catch (err) { console.warn('[reconcile] custom match failed:', err instanceof Error ? err.message : err); }
}

router.get('/overview', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const [overview, lines] = await Promise.all([reconcileOverview({ query }), customLinesWithState({ query })]);
    res.json({ ...overview, lines });
  } catch (err) {
    fail(res, err, 'load reconciliation');
  }
});

router.get('/shelf', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    res.json({ items: await searchShelf({ query }, String(req.query.q ?? '')) });
  } catch (err) {
    fail(res, err, 'search the shelf');
  }
});

router.post('/move', authMiddleware, requirePermission('manage_inventory'), async (req: AuthRequest, res: Response) => {
  try {
    const locationId = req.body?.location_id ? String(req.body.location_id) : null;
    if (locationId && !UUID.test(locationId)) return res.status(400).json({ error: 'Bad bay id' });
    const out = await inTransaction(undefined, (db) => moveStockBetweenSkus(db, {
      fromSku: String(req.body?.from_sku ?? ''), toSku: String(req.body?.to_sku ?? ''), quantity: Number(req.body?.quantity),
      locationId, reason: req.body?.reason ? String(req.body.reason) : null,
      userId: toUuidOrNull(req.user?.id), email: req.user?.email ?? null,
    }));
    console.log(`[reconcile] ${req.user?.email} moved ${out.quantity} from ${out.fromSku} to ${out.toSku} (${out.id})`);
    await afterStockChange([out.fromSku, out.toSku]);
    res.json({ success: true, ...out });
  } catch (err) {
    fail(res, err, 'move the stock');
  }
});

router.post('/undo/:id', authMiddleware, requirePermission('manage_inventory'), async (req: AuthRequest, res: Response) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const out = await undoReconciliation(req.params.id, toUuidOrNull(req.user?.id), req.user?.email ?? null);
    console.log(`[reconcile] ${req.user?.email} undid ${req.params.id}`);
    await afterStockChange([out.fromSku, out.toSku]);
    res.json({ success: true, ...out });
  } catch (err) {
    fail(res, err, 'undo that');
  }
});

router.post('/assign', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const itemId = String(req.body?.item_id ?? '');
    if (!UUID.test(itemId)) return res.status(400).json({ error: 'Bad line id' });
    const out = await linkCustomArrival(itemId, String(req.body?.sku ?? ''));
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    console.log(`[reconcile] ${req.user?.email} set ${req.body?.sku} aside for line ${itemId}`);
    res.json({ success: true });
  } catch (err) {
    fail(res, err, 'set the part aside');
  }
});

router.post('/unassign', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const itemId = String(req.body?.item_id ?? '');
    if (!UUID.test(itemId)) return res.status(400).json({ error: 'Bad line id' });
    await unlinkCustomArrival(itemId);
    res.json({ success: true });
  } catch (err) {
    fail(res, err, 'release the part');
  }
});

/** Checking a barcode needs no special permission; moving stock with it needs the same one as the move itself. */
function requirePermissionWhen(when: (req: AuthRequest) => boolean, key: string) {
  const check = requirePermission(key);
  return (req: AuthRequest, res: Response, next: express.NextFunction) => (when(req) ? check(req, res, next) : next());
}

router.post('/remap', authMiddleware, requirePermissionWhen((req) => Number(req.body?.move_quantity) > 0, 'manage_inventory'), async (req: AuthRequest, res: Response) => {
  try {
    const moveQuantity = Math.max(0, Math.trunc(Number(req.body?.move_quantity) || 0));
    const out = await remapBarcode({
      barcode: String(req.body?.barcode ?? ''), sku: req.body?.sku ? String(req.body.sku) : null, moveQuantity,
      userId: toUuidOrNull(req.user?.id), email: req.user?.email ?? null,
    });
    if (out.moved) await afterStockChange([out.moved.fromSku, out.moved.toSku]);
    res.json({ success: true, sku: out.sku, moved: out.moved });
  } catch (err) {
    fail(res, err, 'check that barcode');
  }
});

export default router;
