/**
 * Re-orders v2 — the buying list.
 *
 * Rows come from the same paid-order calculation as Supplier Re-orders. A row counts as already sent
 * when the current spreadsheet log has it, or when someone marks it sent to Chris here. Nothing is emailed.
 * Run rates are every SKU on those paid orders, plus any SKU with stock on hand that has never sold.
 * Sold is every paid sale. Ordered is everything bought from Ovara, including opening stock, plus later amounts marked sent.
 * Still to buy is sold minus that ordered quantity. A five-pack already ordered covers single-tray sales at five each.
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
import { orderedCover, orderedQuantity, volumeFilerSku } from '../../lib/ovara-orders.js';

const router = express.Router();
router.use(authMiddleware);
router.use(requirePermission('manage_orders'));

const DAY_MS = 24 * 60 * 60 * 1000;

interface SentRow { pick_list_item_id: string; sku: string; sent_at: Date; sent_to: string; supplier_name: string | null }
interface MarkRow { pick_list_item_id: string; sku: string; sent_to_chris_at: Date; sent_to_chris_by: string | null }

async function loadState() {
  const [lines, sent, marks, reordered, flags, stock, costs, bonded, orderedRows, coverRows] = await Promise.all([
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
    query(`SELECT sku, SUM(quantity)::int AS qty FROM supplier_reorder_send_lines GROUP BY sku`),
    query(`SELECT sku, trigger_quantity FROM reorder_v2_sku_flags WHERE trigger_quantity IS NOT NULL`),
    query(`SELECT product_sku, COALESCE(SUM(quantity), 0)::int AS qty FROM warehouse_inventory GROUP BY product_sku`),
    query(`SELECT variant_sku, MAX(unit_cost_gbp)::float AS unit_cost_gbp FROM wms_products WHERE unit_cost_gbp IS NOT NULL GROUP BY variant_sku`),
    query(`
      SELECT DISTINCT soi.product_sku
      FROM supplier_order_items soi
      JOIN supplier_orders so ON so.id = soi.supplier_order_id
      WHERE so.order_number IN ('OV010-504108', 'OV010-504206')
        AND EXISTS (
          SELECT 1 FROM warehouse_inventory wi
          WHERE wi.product_sku = soi.product_sku
          GROUP BY wi.product_sku
          HAVING SUM(wi.quantity) > 0
        )
    `),
    query(`SELECT LOWER(sku) AS sku, (quantity + extra)::int AS qty FROM reorder_v2_ordered`),
    query(`SELECT pick_list_item_id, LOWER(sku) AS sku, units FROM reorder_v2_sale_covers`),
  ]);
  const sentByKey = new Map<string, SentRow>(sent.rows.map((r: SentRow) => [`${r.pick_list_item_id}|${r.sku}`, r]));
  const markByKey = new Map<string, MarkRow>(marks.rows.map((r: MarkRow) => [`${r.pick_list_item_id}|${r.sku}`, r]));
  const triggers = new Map<string, number>(flags.rows.map((r: { sku: string; trigger_quantity: number }) => [r.sku, Number(r.trigger_quantity)]));
  const reorderedBySku = new Map<string, number>(reordered.rows.map((r: { sku: string; qty: number }) => [r.sku, Number(r.qty)]));
  const onHand = new Map<string, number>(stock.rows.map((r: { product_sku: string; qty: number }) => [r.product_sku, r.qty]));
  const unitCost = new Map<string, number>(costs.rows.map((r: { variant_sku: string; unit_cost_gbp: number }) => [r.variant_sku, Number(r.unit_cost_gbp)]));
  const bondedSkus = new Set<string>(bonded.rows.map((r: { product_sku: string }) => r.product_sku));
  const ordered = new Map<string, number>();
  for (const r of orderedRows.rows as { sku: string; qty: number }[]) {
    const sku = volumeFilerSku(r.sku);
    ordered.set(sku, (ordered.get(sku) ?? 0) + Number(r.qty));
  }
  const saleCovers = new Map<string, number>(coverRows.rows.map((r: { pick_list_item_id: string; sku: string; units: number }) => [`${r.pick_list_item_id}|${r.sku}`, Number(r.units)]));
  return { lines, sentByKey, markByKey, triggers, onHand, unitCost, bondedSkus, reorderedBySku, ordered, saleCovers };
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
    customer_name: l.customer_name,
    ordered_at: l.ordered_at,
    previously_sent_at: previous ? new Date(previous.sent_at).toISOString() : null,
    previously_sent_to: previous?.sent_to ?? null,
    sent_to_chris_at: mark ? new Date(mark.sent_to_chris_at).toISOString() : null,
    sent_to_chris_by: mark?.sent_to_chris_by ?? null,
    sent_to_bisley: !!(previous?.sent_at && /bisley/i.test(previous.supplier_name || previous.sent_to || '')),
    trigger_quantity: trigger,
    needs_reorder: needsReorder(onHand, trigger),
    on_hand: onHand,
    bonded: state.bondedSkus.has(buy) || state.bondedSkus.has(l.sku),
  };
}

function soldBySku(lines: ReorderLine[]): Map<string, number> {
  const sold = new Map<string, number>();
  for (const l of lines) {
    const sku = volumeFilerSku(l.sku);
    if (sku === 'custom' || sku.includes('sample')) continue;
    sold.set(sku, (sold.get(sku) ?? 0) + l.sold_quantity);
  }
  return sold;
}

async function runRates(lines: ReorderLine[], state: Awaited<ReturnType<typeof loadState>>) {
  const now = Date.now();
  const recent = now - 30 * DAY_MS;
  const week = now - 7 * DAY_MS;
  const sold = soldBySku(lines);
  const groups = new Map<string, {
    sku: string; title: string; colour: string; sold_skus: Set<string>
    sold_units: number; buy_units: number; orders: Set<string>
    first: number; last: number; sold_30d: number; sold_7d: number; unsent_buy_units: number; marked_units: number
  }>();

  for (const l of lines) {
    const sku = buySku(l);
    const g = groups.get(sku) ?? {
      sku, title: l.title, colour: l.colour, sold_skus: new Set<string>(),
      sold_units: 0, buy_units: 0, orders: new Set<string>(),
      first: Infinity, last: 0, sold_30d: 0, sold_7d: 0, unsent_buy_units: 0, marked_units: 0,
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
    if (l.title) g.title = l.title;
    groups.set(sku, g);
  }

  let earliest = Infinity;
  for (const g of groups.values()) if (g.first < earliest) earliest = g.first;
  const allTimeDays = Number.isFinite(earliest) ? Math.max(1, (now - earliest) / DAY_MS) : 1;

  const soldRates = [...groups.values()].map(g => {
    const perWeek = g.sold_units / (allTimeDays / 7);
    const recentWeekly = g.sold_30d > 0 ? g.sold_30d / (30 / 7) : perWeek;
    const onHand = [...g.sold_skus].reduce((sum, sku) => sum + (state.onHand.get(sku) ?? 0), 0);
    let orderedUnits = 0;
    let still = 0;
    const soldKeys = new Set([...g.sold_skus].map(sku => sku.toLowerCase()));
    const groupSkus = new Set([...groups.keys()].map(sku => sku.toLowerCase()));
    for (const sku of g.sold_skus) {
      if (sku.toLowerCase() === 'custom' || sku.toLowerCase().includes('sample')) continue;
      const canon = volumeFilerSku(sku);
      if (g.sku.toLowerCase() !== canon && groupSkus.has(canon)) continue;
      orderedUnits += orderedQuantity(state.ordered, canon);
      if (/p1-/i.test(sku)) {
        const pack = sku.replace(/p1-/i, 'p5-').toLowerCase();
        if (!soldKeys.has(pack)) orderedUnits += orderedQuantity(state.ordered, pack);
      }
      still += Math.max(0, (sold.get(canon) ?? 0) - orderedCover(state.ordered, sold, canon));
    }
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
      already_bought: orderedUnits,
      cover_weeks: recentWeekly > 0 ? Math.round((onHand / recentWeekly) * 10) / 10 : null,
      unsent_buy_units: still,
      bonded: state.bondedSkus.has(g.sku) || [...g.sold_skus].some((sku) => state.bondedSkus.has(sku)),
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
    soldRates.push({
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
      already_bought: orderedQuantity(state.ordered, sku),
      cover_weeks: null,
      unsent_buy_units: 0,
      bonded: state.bondedSkus.has(sku),
    });
  }

  const onlyReordered = [...state.reorderedBySku.keys()].filter((sku) => !seen.has(sku));
  if (onlyReordered.length) {
    const found = await query(
      `SELECT DISTINCT ON (variant_sku) variant_sku, product_title, colour_name, colour_code
       FROM wms_products WHERE variant_sku = ANY($1)
       ORDER BY variant_sku, is_archived`,
      [onlyReordered]
    );
    const named = new Map(found.rows.map((row: { variant_sku: string; product_title: string; colour_name: string; colour_code: string }) => [row.variant_sku, row]));
    for (const sku of onlyReordered) {
      const meta = named.get(sku);
      soldRates.push({
        sku,
        title: meta?.product_title || sku,
        colour: meta?.colour_name || meta?.colour_code || '',
        sold_units: 0,
        buy_units: 0,
        orders: 0,
        first_sold: null,
        last_sold: null,
        per_week: 0,
        sold_30d: 0,
        sold_7d: 0,
        on_hand: state.onHand.get(sku) ?? 0,
        unit_cost_gbp: state.unitCost.get(sku) ?? null,
        trigger_quantity: state.triggers.get(sku) ?? null,
        needs_reorder: needsReorder(state.onHand.get(sku) ?? 0, state.triggers.get(sku) ?? null),
        already_bought: orderedQuantity(state.ordered, sku),
        cover_weeks: null,
        unsent_buy_units: 0,
        bonded: state.bondedSkus.has(sku),
      });
    }
  }

  return soldRates.sort((a, b) => b.per_week - a.per_week || b.sold_units - a.sold_units || a.sku.localeCompare(b.sku));
}

function toBuyRows(lines: ReorderLine[], state: Awaited<ReturnType<typeof loadState>>) {
  const sold = soldBySku(lines);
  const bySku = new Map<string, ReorderLine[]>();
  for (const l of lines) {
    const sku = volumeFilerSku(l.sku);
    if (!sold.has(sku)) continue;
    const list = bySku.get(sku) ?? [];
    list.push(l);
    bySku.set(sku, list);
  }
  const rows = [];
  for (const [sku, group] of bySku) {
    let pool = orderedCover(state.ordered, sold, sku);
    const oldest = [...group].sort((a, b) => new Date(a.ordered_at).getTime() - new Date(b.ordered_at).getTime());
    for (const l of oldest) {
      let open = l.sold_quantity;
      const specific = state.saleCovers.get(`${l.pick_list_item_id}|${l.sku.toLowerCase()}`) ?? 0;
      open -= Math.min(open, specific);
      const fromPool = Math.min(open, pool);
      open -= fromPool;
      pool -= fromPool;
      const presented = presentLine(l, state);
      for (let i = 0; i < open; i++) {
        rows.push({
          ...presented,
          key: `buy:${l.pick_list_item_id}:${sku}:${i}`,
          sku: l.sku,
          order_sku: l.sku,
          buy_sku: l.sku,
          quantity: 1,
          sold_quantity: l.sold_quantity,
          ordered_quantity: orderedCover(state.ordered, sold, sku),
          sent_to_chris_at: null,
          sources: [],
        });
      }
    }
  }
  return rows.sort((a, b) => new Date(a.ordered_at).getTime() - new Date(b.ordered_at).getTime() || a.sku.localeCompare(b.sku));
}

async function payload() {
  const state = await loadState();
  const lines = state.lines.map(l => presentLine(l, state));
  const toBuy = toBuyRows(state.lines, state);
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

function covers(body: any): { pick_list_item_id: string; sku: string; quantity: number }[] {
  const rows = Array.isArray(body?.covers) ? body.covers : [];
  return rows
    .map((c: any) => ({
      pick_list_item_id: String(c.pick_list_item_id || ''),
      sku: String(c.sku || '').trim().toLowerCase(),
      quantity: Number(c.quantity),
    }))
    .filter(c => c.pick_list_item_id && c.sku && Number.isInteger(c.quantity) && c.quantity > 0);
}

function adjustments(body: any): { sku: string; quantity: number }[] {
  const rows = Array.isArray(body?.adjustments) ? body.adjustments : [];
  return rows
    .map((a: any) => ({ sku: String(a.sku || '').trim().toLowerCase(), quantity: Number(a.quantity) }))
    .filter(a => a.sku && Number.isInteger(a.quantity) && a.quantity > 0);
}

router.post('/sent', async (req: AuthRequest, res: Response) => {
  try {
    const lines = linePairs(req.body);
    const adds = adjustments(req.body);
    const chosen = covers(req.body);
    if (!lines.length && !adds.length && !chosen.length) return res.status(400).json({ error: 'Choose at least one line' });
    for (const l of lines) {
      await query(
        `INSERT INTO reorder_v2_line_marks (pick_list_item_id, sku, sent_to_chris_at, sent_to_chris_by)
         VALUES ($1::uuid, $2, NOW(), $3)
         ON CONFLICT (pick_list_item_id, sku)
         DO UPDATE SET sent_to_chris_at = NOW(), sent_to_chris_by = EXCLUDED.sent_to_chris_by`,
        [l.pick_list_item_id, l.sku, actor(req)]
      );
    }
    for (const a of adds) {
      await query(
        `INSERT INTO reorder_v2_ordered (sku, quantity, extra, updated_at)
         VALUES ($1, 0, $2, NOW())
         ON CONFLICT (sku) DO UPDATE SET extra = reorder_v2_ordered.extra + EXCLUDED.extra, updated_at = NOW()`,
        [a.sku, a.quantity]
      );
    }
    for (const c of chosen) {
      await query(
        `INSERT INTO reorder_v2_sale_covers (pick_list_item_id, sku, units, updated_at)
         VALUES ($1::uuid, $2, $3, NOW())
         ON CONFLICT (pick_list_item_id, sku)
         DO UPDATE SET units = reorder_v2_sale_covers.units + EXCLUDED.units, updated_at = NOW()`,
        [c.pick_list_item_id, c.sku, c.quantity]
      );
    }
    res.json({ updated: lines.length, ordered: adds.length, covers: chosen.length });
  } catch (err: any) {
    console.error('[reorders-v2] mark sent failed:', err);
    res.status(500).json({ error: 'Failed to mark lines sent to Chris' });
  }
});

router.post('/unsent', async (req: AuthRequest, res: Response) => {
  try {
    const lines = linePairs(req.body);
    if (!lines.length) return res.status(400).json({ error: 'Choose at least one line' });
    const built = await buildLines();
    for (const l of lines) {
      await query(
        `DELETE FROM reorder_v2_line_marks WHERE pick_list_item_id = $1::uuid AND sku = $2`,
        [l.pick_list_item_id, l.sku]
      );
      const match = built.find(b => b.pick_list_item_id === l.pick_list_item_id && b.sku === l.sku);
      const qty = match?.sold_quantity ?? 0;
      if (qty > 0) {
        await query(
          `UPDATE reorder_v2_ordered SET extra = GREATEST(0, extra - $2), updated_at = NOW() WHERE LOWER(sku) = LOWER($1)`,
          [l.sku, qty]
        );
      }
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
