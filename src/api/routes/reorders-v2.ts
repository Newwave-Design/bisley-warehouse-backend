/**
 * Re-orders v2 — the buying list.
 *
 * Rows come from the same paid-order calculation as Supplier Re-orders. A row counts as already sent
 * when the current spreadsheet log has it, or when someone marks it sent to Chris here. Nothing is emailed.
 * Run rates are every SKU on those paid orders, plus any SKU with stock on hand that has never sold.
 * Already bought is the buy quantity of lines on the Supplier Re-orders Sent tab:
 * a send to Bisley that has a sent date. Not-sent rows and the separate supplier-orders list are not included.
 * Do-not-reorder is stored against the buy SKU and hides later sales of that SKU from the buying list.
 * It can only be set when that SKU has stock on hand. Clearing the flag is always allowed.
 *
 * GET  /api/reorders-v2           — lines, run rates, and flags for the CMS
 * GET  /api/reorders-v2/export    — the same figures as JSON for the assistant
 * POST /api/reorders-v2/sent      — { lines: [{ pick_list_item_id, sku }] } mark sent to Chris
 * POST /api/reorders-v2/unsent    — clear that mark
 * POST /api/reorders-v2/trigger   — { sku, trigger_quantity } set or clear the reorder trigger
 */
import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, requirePermission, AuthRequest } from '../../middleware/auth.js';
import { buildLines, type ReorderLine } from './supplier-reorders.js';

const router = express.Router();
router.use(authMiddleware);
router.use(requirePermission('manage_orders'));

const DAY_MS = 24 * 60 * 60 * 1000;

interface SentRow { pick_list_item_id: string; sku: string; sent_at: Date; sent_to: string; supplier_name: string | null }
interface MarkRow { pick_list_item_id: string; sku: string; sent_to_chris_at: Date; sent_to_chris_by: string | null }

async function loadState() {
  const [lines, sent, marks, flags, stock, costs] = await Promise.all([
    buildLines(),
    query(`
      SELECT DISTINCT ON (l.pick_list_item_id, l.sku)
             l.pick_list_item_id, l.sku, s.sent_at, s.sent_to, sp.name AS supplier_name
      FROM supplier_reorder_send_lines l
      JOIN supplier_reorder_sends s ON s.id = l.send_id
      JOIN suppliers sp ON sp.id = s.supplier_id
      ORDER BY l.pick_list_item_id, l.sku, s.sent_at DESC
    `),
    query(`SELECT pick_list_item_id, sku, sent_to_chris_at, sent_to_chris_by FROM reorder_v2_line_marks WHERE sent_to_chris_at IS NOT NULL`),
    query(`SELECT sku, trigger_quantity FROM reorder_v2_sku_flags WHERE trigger_quantity IS NOT NULL`),
    query(`SELECT product_sku, COALESCE(SUM(quantity), 0)::int AS qty FROM warehouse_inventory GROUP BY product_sku`),
    query(`SELECT variant_sku, MAX(unit_cost_gbp)::float AS unit_cost_gbp FROM wms_products WHERE unit_cost_gbp IS NOT NULL GROUP BY variant_sku`),
  ]);
  const sentByKey = new Map<string, SentRow>(sent.rows.map((r: SentRow) => [`${r.pick_list_item_id}|${r.sku}`, r]));
  const markByKey = new Map<string, MarkRow>(marks.rows.map((r: MarkRow) => [`${r.pick_list_item_id}|${r.sku}`, r]));
  const triggers = new Map<string, number>(flags.rows.map((r: { sku: string; trigger_quantity: number }) => [r.sku, Number(r.trigger_quantity)]));
  const onHand = new Map<string, number>(stock.rows.map((r: { product_sku: string; qty: number }) => [r.product_sku, r.qty]));
  const unitCost = new Map<string, number>(costs.rows.map((r: { variant_sku: string; unit_cost_gbp: number }) => [r.variant_sku, Number(r.unit_cost_gbp)]));
  return { lines, sentByKey, markByKey, triggers, onHand, unitCost };
}

function buySku(l: ReorderLine): string {
  return l.order_sku && l.order_sku !== 'CUSTOM' ? l.order_sku : l.sku;
}

function needsReorder(onHand: number, trigger: number | null): boolean {
  return trigger != null && onHand <= trigger;
}

function presentLine(l: ReorderLine, state: Awaited<ReturnType<typeof loadState>>) {
  const previous = state.sentByKey.get(l.key) ?? state.sentByKey.get(`${l.pick_list_item_id}|CUSTOM`);
  const mark = state.markByKey.get(l.key) ?? state.markByKey.get(`${l.pick_list_item_id}|CUSTOM`);
  const buy = buySku(l);
  const onHand = state.onHand.get(l.sku) ?? 0;
  const trigger = state.triggers.get(buy) ?? state.triggers.get(l.sku) ?? null;
  return {
    key: l.key,
    pick_list_item_id: l.pick_list_item_id,
    sku: l.sku,
    order_sku: l.order_sku,
    buy_sku: buy,
    title: l.title,
    colour: l.colour,
    supplier_sku: l.supplier_sku,
    supplier_colour: l.supplier_colour,
    quantity: l.quantity,
    sold_quantity: l.sold_quantity,
    note: l.note,
    pick_list_number: l.pick_list_number,
    ordered_at: l.ordered_at,
    previously_sent_at: previous ? new Date(previous.sent_at).toISOString() : null,
    previously_sent_to: previous?.sent_to ?? null,
    sent_to_chris_at: mark ? new Date(mark.sent_to_chris_at).toISOString() : null,
    sent_to_chris_by: mark?.sent_to_chris_by ?? null,
    sent_to_bisley: !!(previous?.sent_at && /bisley/i.test(previous.supplier_name || previous.sent_to || '')),
    trigger_quantity: trigger,
    needs_reorder: needsReorder(onHand, trigger),
    on_hand: onHand,
  };
}

async function runRates(lines: ReorderLine[], state: Awaited<ReturnType<typeof loadState>>) {
  const now = Date.now();
  const recent = now - 30 * DAY_MS;
  const week = now - 7 * DAY_MS;
  const groups = new Map<string, {
    sku: string; title: string; colour: string; sold_skus: Set<string>
    sold_units: number; buy_units: number; orders: Set<string>
    first: number; last: number; sold_30d: number; sold_7d: number; unsent_buy_units: number; already_bought: number
  }>();

  for (const l of lines) {
    const sku = buySku(l);
    const row = presentLine(l, state);
    const g = groups.get(sku) ?? {
      sku, title: l.title, colour: l.colour, sold_skus: new Set<string>(),
      sold_units: 0, buy_units: 0, orders: new Set<string>(),
      first: Infinity, last: 0, sold_30d: 0, sold_7d: 0, unsent_buy_units: 0, already_bought: 0,
    };
    g.sold_skus.add(l.sku);
    g.sold_units += l.sold_quantity;
    g.buy_units += l.quantity;
    g.orders.add(l.pick_list_number);
    const at = new Date(l.ordered_at).getTime();
    if (at < g.first) g.first = at;
    if (at > g.last) g.last = at;
    if (at >= recent) g.sold_30d += l.sold_quantity;
    if (at >= week) g.sold_7d += l.sold_quantity;
    if (!row.previously_sent_at && !row.sent_to_chris_at) g.unsent_buy_units += l.quantity;
    if (row.sent_to_bisley) g.already_bought += l.quantity;
    if (l.title) g.title = l.title;
    groups.set(sku, g);
  }

  const sold = [...groups.values()].map(g => {
    const days = Math.max(1, (now - g.first) / DAY_MS);
    const perWeek = g.sold_units / (days / 7);
    const recentWeekly = g.sold_30d > 0 ? g.sold_30d / (30 / 7) : perWeek;
    const onHand = [...g.sold_skus].reduce((sum, sku) => sum + (state.onHand.get(sku) ?? 0), 0);
    return {
      sku: g.sku,
      title: g.title,
      colour: g.colour,
      sold_units: g.sold_units,
      buy_units: g.buy_units,
      orders: g.orders.size,
      first_sold: new Date(g.first).toISOString(),
      last_sold: new Date(g.last).toISOString(),
      per_week: Math.round(perWeek * 10) / 10,
      sold_30d: g.sold_30d,
      sold_7d: g.sold_7d,
      on_hand: onHand,
      unit_cost_gbp: state.unitCost.get(g.sku) ?? null,
      trigger_quantity: state.triggers.get(g.sku) ?? null,
      needs_reorder: needsReorder(onHand, state.triggers.get(g.sku) ?? null),
      already_bought: g.already_bought,
      cover_weeks: recentWeekly > 0 ? Math.round((onHand / recentWeekly) * 10) / 10 : null,
      unsent_buy_units: g.unsent_buy_units,
    };
  });

  const seen = new Set<string>();
  for (const g of groups.values()) {
    seen.add(g.sku);
    for (const sku of g.sold_skus) seen.add(sku);
  }
  const unsold = [...state.onHand.entries()].filter(([sku, qty]) => qty > 0 && !seen.has(sku));
  const info = new Map<string, { title: string; colour: string }>();
  if (unsold.length) {
    const found = await query(
      `SELECT DISTINCT ON (variant_sku) variant_sku, product_title, colour_name, colour_code
       FROM wms_products WHERE variant_sku = ANY($1)
       ORDER BY variant_sku, is_archived`,
      [unsold.map(([sku]) => sku)]
    );
    for (const row of found.rows) {
      info.set(row.variant_sku, {
        title: row.product_title || row.variant_sku,
        colour: row.colour_name || row.colour_code || '',
      });
    }
  }
  for (const [sku, onHand] of unsold) {
    const meta = info.get(sku);
    sold.push({
      sku,
      title: meta?.title || sku,
      colour: meta?.colour || '',
      sold_units: 0,
      buy_units: 0,
      orders: 0,
      first_sold: null,
      last_sold: null,
      per_week: 0,
      sold_30d: 0,
      sold_7d: 0,
      on_hand: onHand,
      unit_cost_gbp: state.unitCost.get(sku) ?? null,
      trigger_quantity: state.triggers.get(sku) ?? null,
      needs_reorder: needsReorder(onHand, state.triggers.get(sku) ?? null),
      already_bought: 0,
      cover_weeks: null,
      unsent_buy_units: 0,
    });
  }

  return sold.sort((a, b) => b.per_week - a.per_week || b.sold_units - a.sold_units || a.sku.localeCompare(b.sku));
}

async function payload() {
  const state = await loadState();
  const lines = state.lines.map(l => presentLine(l, state));
  const toBuy = lines.filter(l => !l.previously_sent_at && !l.sent_to_chris_at);
  const runRatesRows = await runRates(state.lines, state);
  return {
    generated_at: new Date().toISOString(),
    lines,
    to_buy: toBuy,
    run_rates: runRatesRows,
    counts: {
      to_buy: toBuy.length,
      sent_to_chris: lines.filter(l => l.sent_to_chris_at).length,
      previously_sent: lines.filter(l => l.previously_sent_at).length,
      needs_reorder: runRatesRows.filter(r => r.needs_reorder).length,
    },
  };
}

function actor(req: AuthRequest): string {
  return req.user?.email || 'unknown';
}

function linePairs(body: any): { pick_list_item_id: string; sku: string }[] {
  const rows = Array.isArray(body?.lines) ? body.lines : [];
  return rows
    .map((l: any) => ({ pick_list_item_id: String(l.pick_list_item_id || ''), sku: String(l.sku || '') }))
    .filter(l => l.pick_list_item_id && l.sku);
}

router.get('/export', async (_req: AuthRequest, res: Response) => {
  try {
    const data = await payload();
    res.json({
      generated_at: data.generated_at,
      to_buy: data.to_buy,
      sent_to_chris: data.lines.filter(l => l.sent_to_chris_at),
      triggers: data.run_rates.filter(r => r.trigger_quantity != null).map(r => ({
        sku: r.sku,
        trigger_quantity: r.trigger_quantity,
        on_hand: r.on_hand,
        needs_reorder: r.needs_reorder,
      })),
      run_rates: data.run_rates,
    });
  } catch (err: any) {
    console.error('[reorders-v2] export failed:', err);
    res.status(500).json({ error: 'Failed to export the buying list' });
  }
});

router.get('/', async (_req: AuthRequest, res: Response) => {
  try {
    res.json(await payload());
  } catch (err: any) {
    console.error('[reorders-v2] list failed:', err);
    res.status(500).json({ error: 'Failed to load the buying list' });
  }
});

router.post('/sent', async (req: AuthRequest, res: Response) => {
  try {
    const lines = linePairs(req.body);
    if (!lines.length) return res.status(400).json({ error: 'Choose at least one line' });
    for (const l of lines) {
      await query(
        `INSERT INTO reorder_v2_line_marks (pick_list_item_id, sku, sent_to_chris_at, sent_to_chris_by)
         VALUES ($1::uuid, $2, NOW(), $3)
         ON CONFLICT (pick_list_item_id, sku)
         DO UPDATE SET sent_to_chris_at = NOW(), sent_to_chris_by = EXCLUDED.sent_to_chris_by`,
        [l.pick_list_item_id, l.sku, actor(req)]
      );
    }
    res.json({ updated: lines.length });
  } catch (err: any) {
    console.error('[reorders-v2] mark sent failed:', err);
    res.status(500).json({ error: 'Failed to mark lines sent to Chris' });
  }
});

router.post('/unsent', async (req: AuthRequest, res: Response) => {
  try {
    const lines = linePairs(req.body);
    if (!lines.length) return res.status(400).json({ error: 'Choose at least one line' });
    for (const l of lines) {
      await query(
        `DELETE FROM reorder_v2_line_marks WHERE pick_list_item_id = $1::uuid AND sku = $2`,
        [l.pick_list_item_id, l.sku]
      );
    }
    res.json({ updated: lines.length });
  } catch (err: any) {
    console.error('[reorders-v2] clear sent failed:', err);
    res.status(500).json({ error: 'Failed to clear the sent mark' });
  }
});

router.post('/trigger', async (req: AuthRequest, res: Response) => {
  try {
    const sku = String(req.body?.sku || '').trim();
    if (!sku) return res.status(400).json({ error: 'SKU is required' });
    const raw = req.body?.trigger_quantity;
    const trigger = raw === null || raw === undefined || raw === '' ? null : Number(raw);
    if (trigger !== null && (!Number.isInteger(trigger) || trigger < 0)) {
      return res.status(400).json({ error: 'Trigger quantity must be a whole number, or blank' });
    }
    await query(
      `INSERT INTO reorder_v2_sku_flags (sku, trigger_quantity, updated_at, updated_by)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (sku) DO UPDATE SET trigger_quantity = EXCLUDED.trigger_quantity, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [sku, trigger, actor(req)]
    );
    res.json({ sku, trigger_quantity: trigger });
  } catch (err: any) {
    console.error('[reorders-v2] trigger failed:', err);
    res.status(500).json({ error: 'Failed to save the trigger quantity' });
  }
});

export default router;
