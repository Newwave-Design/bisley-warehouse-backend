/**
 * Stock Sold V2 - "pay when sold". Runs alongside the original Stock Sold report and changes nothing in the live flows.
 *
 * Weekly statements (Monday to Sunday, UK time) of units that were sold from stock we hold, plus returns, a running stock view
 * that ties back to what is on hand, opening adjustments and a full audit trail. See lib/allocation.ts for how units are counted.
 *
 * GET  /api/stock-sold-v2/weeks                        - every week with units and OPEN/LOCKED status
 * GET  /api/stock-sold-v2/weeks/:weekStart             - one week's statement (weekStart is the Monday), with the orders behind each line
 * GET  /api/stock-sold-v2/weeks/:weekStart/export      - the statement as .xlsx (?detail=true adds an Orders sheet); the download is logged
 * POST /api/stock-sold-v2/weeks/:weekStart/lock        - fix a finished week (system_admin)
 * GET  /api/stock-sold-v2/running                      - per SKU: received, sold, free stock, on hand and any difference
 * GET/POST /api/stock-sold-v2/adjustments              - opening balances and corrections (POST: system_admin)
 * GET  /api/stock-sold-v2/returns[?status=]            - returns list; POST creates one against an order line
 * GET  /api/stock-sold-v2/returns/search-orders?q=     - find an order and its returnable lines
 * POST /api/stock-sold-v2/returns/:id/decide           - { status: FAULTY | DAMAGED | RESELL, notes }
 * POST /api/stock-sold-v2/returns/:id/reported         - mark a faulty return as reported to Bisley
 * GET  /api/stock-sold-v2/audit[/export]               - the audit trail (filter by sku, order, week, table, action, source, dates)
 * POST /api/stock-sold-v2/recalculate                  - run the allocation now (system_admin)
 */

import express, { Response } from 'express';
import XLSX from 'xlsx';
import { query } from '../../db/index.js';
import { authMiddleware, requirePermission, AuthRequest } from '../../middleware/auth.js';
import { safeCell } from './supplier-reorders.js';
import { toUuidOrNull } from './mobile.js';
import { loadPools, bisleyFree, ownedFree, runAllocation, scheduleAllocationRun } from '../../lib/allocation.js';
import { buildWeek, listWeeks, lockWeek, LockError } from '../../lib/settlement.js';
import { withAudit, logAuditEvent, actorOf } from '../../lib/audit.js';
import { isMonday } from '../../lib/weeks.js';

const router = express.Router();
const READ = [authMiddleware, requirePermission('manage_orders')];
const ADMIN = [authMiddleware, requirePermission('system_admin')];
const RETURN_STATUSES = ['AWAITING', 'FAULTY', 'DAMAGED', 'RESELL'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const fail = (res: Response, err: unknown, what: string) => {
  console.error(`[stock-sold-v2] ${what}:`, err);
  return res.status(500).json({ error: `Failed to ${what}` });
};

/* ---------- Weekly statements ---------- */

router.get('/weeks', ...READ, async (_req: AuthRequest, res: Response) => {
  try { res.json({ weeks: await listWeeks() }); } catch (err) { fail(res, err, 'load weeks'); }
});

router.get('/weeks/:weekStart', ...READ, async (req: AuthRequest, res: Response) => {
  if (!isMonday(req.params.weekStart)) return res.status(400).json({ error: 'weekStart must be a Monday (YYYY-MM-DD)' });
  try { res.json(await buildWeek({ query }, req.params.weekStart)); } catch (err) { fail(res, err, 'build the statement'); }
});

router.get('/weeks/:weekStart/export', ...READ, async (req: AuthRequest, res: Response) => {
  if (!isMonday(req.params.weekStart)) return res.status(400).json({ error: 'weekStart must be a Monday (YYYY-MM-DD)' });
  try {
    const st = await buildWeek({ query }, req.params.weekStart);
    const aoa: (string | number)[][] = [['Week commencing', 'SKU', 'Title', 'Colour', 'Full SKU', 'Quantity', 'Note']];
    for (const r of st.rows) aoa.push([st.week_start, safeCell(r.supplier_sku), safeCell(r.title), safeCell(r.colour), safeCell(r.full_sku), r.quantity, safeCell(r.note)]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 16 }, { wch: 22 }, { wch: 50 }, { wch: 14 }, { wch: 30 }, { wch: 10 }, { wch: 55 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Statement');
    if (String(req.query.detail) === 'true') {
      const d: (string | number)[][] = [['Line', 'Order', 'Medusa order', 'Quantity', 'Ordered', 'Status']];
      for (const r of st.rows) for (const s of r.sources) d.push([safeCell(r.full_sku || r.title), safeCell(s.pick_list_number ?? ''), safeCell(s.medusa_order_id ?? ''), s.quantity, s.ordered_at ? s.ordered_at.slice(0, 10) : '', s.status]);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(d), 'Orders');
    }
    const buffer: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    await logAuditEvent({
      table_name: 'statement', action: 'EXPORT', actor: actorOf(req), week_start: st.week_start,
      reason: `Downloaded statement for week commencing ${st.week_start} (${st.status}): ${st.rows.length} lines, ${st.total} units`,
      new_row: { rows: st.rows.map((r) => ({ full_sku: r.full_sku, title: r.title, quantity: r.quantity })), total: st.total, status: st.status },
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="bisley-stock-sold-week-${st.week_start}.xlsx"`);
    res.send(buffer);
  } catch (err) { fail(res, err, 'build the spreadsheet'); }
});

router.post('/weeks/:weekStart/lock', ...ADMIN, async (req: AuthRequest, res: Response) => {
  if (!isMonday(req.params.weekStart)) return res.status(400).json({ error: 'weekStart must be a Monday (YYYY-MM-DD)' });
  const actor = actorOf(req);
  try {
    const st = await withAudit({ actor, source: 'lock', reason: `Locked week commencing ${req.params.weekStart}` },
      (client) => lockWeek(client, req.params.weekStart, actor, req.body?.force === true));
    res.json(st);
  } catch (err) {
    if (err instanceof LockError) return res.status(err.status).json({ error: err.message });
    fail(res, err, 'lock the week');
  }
});

/* ---------- Running stock ---------- */

router.get('/running', ...READ, async (req: AuthRequest, res: Response) => {
  try {
    const pools = await loadPools({ query });
    const onHand = new Map<string, number>((await query(`SELECT product_sku AS sku, SUM(quantity)::int AS q FROM warehouse_inventory GROUP BY product_sku`)).rows.map((r: any) => [r.sku, Number(r.q)]));
    const skus = new Set<string>([...pools.keys(), ...[...onHand.entries()].filter(([, q]) => q !== 0).map(([s]) => s)]);
    const titles = new Map<string, string>((await query(`SELECT DISTINCT ON (variant_sku) variant_sku, product_title FROM wms_products WHERE variant_sku = ANY($1) ORDER BY variant_sku, is_archived`, [[...skus]])).rows.map((r: any) => [r.variant_sku, r.product_title]));
    let rows = [...skus].map((sku) => {
      const p = pools.get(sku) ?? { received: 0, payable: 0, releasedPaid: 0, ownedActive: 0, resell: 0, activeQty: 0, activeNotShipped: 0 };
      const free = bisleyFree(p), owned = ownedFree(p), oh = onHand.get(sku) ?? 0;
      return {
        sku, title: titles.get(sku) ?? '', received: p.received, sold_payable: p.payable, returned_resell: p.resell,
        bisley_free: free, owned_free: owned, sold_not_shipped: p.activeNotShipped, on_hand: oh,
        difference: oh - (free + owned + p.activeNotShipped),
      };
    });
    const q = String(req.query.q ?? '').trim().toLowerCase();
    if (q) rows = rows.filter((r) => r.sku.toLowerCase().includes(q) || r.title.toLowerCase().includes(q));
    if (String(req.query.diff) === 'true') rows = rows.filter((r) => r.difference !== 0);
    rows.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference) || a.sku.localeCompare(b.sku));
    res.json({
      rows,
      totals: rows.reduce((t, r) => ({ received: t.received + r.received, sold_payable: t.sold_payable + r.sold_payable, on_hand: t.on_hand + r.on_hand, difference: t.difference + r.difference }), { received: 0, sold_payable: 0, on_hand: 0, difference: 0 }),
      differing_skus: rows.filter((r) => r.difference !== 0).length,
    });
  } catch (err) { fail(res, err, 'load running stock'); }
});

/* ---------- Adjustments ---------- */

router.get('/adjustments', ...READ, async (_req: AuthRequest, res: Response) => {
  try { res.json({ adjustments: (await query(`SELECT id, sku, qty, kind, reason, created_by, created_at FROM stock_adjustments ORDER BY created_at DESC LIMIT 500`)).rows }); }
  catch (err) { fail(res, err, 'load adjustments'); }
});

router.post('/adjustments', ...ADMIN, async (req: AuthRequest, res: Response) => {
  const { sku, qty, kind, reason } = req.body ?? {};
  if (typeof sku !== 'string' || !sku.trim() || sku.length > 100) return res.status(400).json({ error: 'sku is required' });
  if (!Number.isInteger(qty) || qty === 0 || Math.abs(qty) > 100000) return res.status(400).json({ error: 'qty must be a non-zero whole number' });
  if (!['OPENING', 'ADJUSTMENT'].includes(kind)) return res.status(400).json({ error: 'kind must be OPENING or ADJUSTMENT' });
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 500) return res.status(400).json({ error: 'a reason is required' });
  const actor = actorOf(req);
  try {
    const row = await withAudit({ actor, source: 'adjustment', reason: reason.trim() }, async (client) =>
      (await client.query(`INSERT INTO stock_adjustments (sku, qty, kind, reason, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, sku, qty, kind, reason, created_by, created_at`, [sku.trim(), qty, kind, reason.trim(), actor])).rows[0]);
    scheduleAllocationRun(`${kind.toLowerCase()} ${qty > 0 ? '+' : ''}${qty} ${sku.trim()}`);
    res.status(201).json(row);
  } catch (err) { fail(res, err, 'save the adjustment'); }
});

/* ---------- Returns ---------- */

router.get('/returns', ...READ, async (req: AuthRequest, res: Response) => {
  const status = String(req.query.status ?? 'ALL').toUpperCase();
  if (status !== 'ALL' && !RETURN_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const rows = (await query(
      `SELECT r.id, r.pick_list_id, r.pick_list_item_id, r.medusa_order_id, r.sku, r.quantity, r.status, r.reason, r.notes,
              r.created_by, r.created_at, r.decided_by, r.decided_at, r.reported_to_bisley_at,
              pl.pick_list_number, pl.customer_name,
              (SELECT product_title FROM wms_products WHERE variant_sku = r.sku ORDER BY is_archived LIMIT 1) AS title
       FROM stock_returns r LEFT JOIN pick_lists pl ON pl.id = r.pick_list_id
       WHERE ($1 = 'ALL' OR r.status = $1) ORDER BY r.created_at DESC LIMIT 500`, [status])).rows;
    const counts = (await query(`SELECT status, COUNT(*)::int AS n FROM stock_returns GROUP BY status`)).rows;
    res.json({ returns: rows, counts: Object.fromEntries(counts.map((c: any) => [c.status, c.n])) });
  } catch (err) { fail(res, err, 'load returns'); }
});

async function returnableLines(pickListId: string) {
  const items = (await query(
    `SELECT pli.id, pli.product_sku, pli.quantity_required, pli.is_custom, pli.item_title, wp.is_kit, wp.kit_components
     FROM pick_list_items pli
     LEFT JOIN LATERAL (SELECT is_kit, kit_components FROM wms_products WHERE variant_sku = pli.product_sku ORDER BY is_archived LIMIT 1) wp ON true
     WHERE pli.pick_list_id = $1 AND NOT pli.is_archived AND NOT pli.is_custom ORDER BY pli.line_number`, [pickListId])).rows;
  const frozen = (await query(`SELECT pick_list_item_id, component_sku, per_unit_qty FROM sale_demand WHERE pick_list_item_id = ANY($1::uuid[])`, [items.map((i: any) => i.id)])).rows;
  const returned = (await query(`SELECT pick_list_item_id, sku, SUM(quantity)::int AS q FROM stock_returns WHERE pick_list_id = $1 GROUP BY 1, 2`, [pickListId])).rows;
  const retMap = new Map(returned.map((r: any) => [`${r.pick_list_item_id}|${r.sku}`, r.q]));
  const lines: { pick_list_item_id: string; sku: string; title: string; ordered: number; returned: number }[] = [];
  const skus = new Set<string>();
  const parts: { id: string; sku: string; per: number; q: number }[] = [];
  for (const it of items) {
    const f = frozen.filter((x: any) => x.pick_list_item_id === it.id);
    const comps = f.length ? f.map((x: any) => ({ sku: x.component_sku, per: x.per_unit_qty }))
      : (it.is_kit && Array.isArray(it.kit_components) && it.kit_components.length ? it.kit_components.map((c: any) => ({ sku: c.sku, per: Number(c.required_quantity) || 1 })) : [{ sku: it.product_sku, per: 1 }]);
    for (const c of comps) { parts.push({ id: it.id, sku: c.sku, per: c.per, q: it.quantity_required }); skus.add(c.sku); }
  }
  const titles = new Map<string, string>((await query(`SELECT DISTINCT ON (variant_sku) variant_sku, product_title, colour_name FROM wms_products WHERE variant_sku = ANY($1) ORDER BY variant_sku, is_archived`, [[...skus]])).rows.map((r: any) => [r.variant_sku, [r.product_title, r.colour_name].filter(Boolean).join(' - ')]));
  for (const p of parts) lines.push({ pick_list_item_id: p.id, sku: p.sku, title: titles.get(p.sku) ?? p.sku, ordered: p.q * p.per, returned: retMap.get(`${p.id}|${p.sku}`) ?? 0 });
  return lines;
}

router.get('/returns/search-orders', ...READ, async (req: AuthRequest, res: Response) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.json({ orders: [] });
  try {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const lists = (await query(
      `SELECT id, pick_list_number, medusa_order_id, customer_name, status, created_at FROM pick_lists
       WHERE NOT is_sandbox AND (pick_list_number ILIKE $1 OR medusa_order_id ILIKE $1 OR customer_name ILIKE $1 OR customer_email ILIKE $1)
       ORDER BY created_at DESC LIMIT 8`, [like])).rows;
    const orders = [];
    for (const l of lists) orders.push({ ...l, lines: await returnableLines(l.id) });
    res.json({ orders });
  } catch (err) { fail(res, err, 'search orders'); }
});

router.post('/returns', ...READ, async (req: AuthRequest, res: Response) => {
  const { pick_list_item_id, sku, quantity, reason } = req.body ?? {};
  if (typeof pick_list_item_id !== 'string' || typeof sku !== 'string') return res.status(400).json({ error: 'pick_list_item_id and sku are required' });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) return res.status(400).json({ error: 'quantity must be a whole number of at least 1' });
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) return res.status(400).json({ error: 'reason is too long' });
  const actor = actorOf(req);
  try {
    const item = (await query(`SELECT pli.pick_list_id, pl.medusa_order_id FROM pick_list_items pli JOIN pick_lists pl ON pl.id = pli.pick_list_id WHERE pli.id = $1`, [pick_list_item_id])).rows[0];
    if (!item) return res.status(404).json({ error: 'Order line not found' });
    const line = (await returnableLines(item.pick_list_id)).find((l) => l.pick_list_item_id === pick_list_item_id && l.sku === sku);
    if (!line) return res.status(400).json({ error: 'That SKU is not on this order line' });
    if (quantity > line.ordered - line.returned) return res.status(400).json({ error: `Only ${line.ordered - line.returned} can still be returned on this line` });
    const row = await withAudit({ actor, source: 'returns', reason: 'Return recorded' }, async (client) =>
      (await client.query(
        `INSERT INTO stock_returns (pick_list_id, pick_list_item_id, medusa_order_id, sku, quantity, reason, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [item.pick_list_id, pick_list_item_id, item.medusa_order_id, sku, quantity, reason?.trim() || null, actor])).rows[0]);
    res.status(201).json(row);
  } catch (err) { fail(res, err, 'record the return'); }
});

router.post('/returns/:id/decide', ...READ, async (req: AuthRequest, res: Response) => {
  const { status, notes } = req.body ?? {};
  if (!['FAULTY', 'DAMAGED', 'RESELL'].includes(status)) return res.status(400).json({ error: 'status must be FAULTY, DAMAGED or RESELL' });
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > 500)) return res.status(400).json({ error: 'notes is too long' });
  const actor = actorOf(req);
  const userId = toUuidOrNull(req.user?.id);
  if (status === 'RESELL' && !userId) return res.status(400).json({ error: 'A real user login is required to put stock back' });
  try {
    const out = await withAudit({ actor, source: 'returns', reason: `Return marked ${status}` }, async (client) => {
      const r = (await client.query(`SELECT * FROM stock_returns WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!r) return { code: 404, body: { error: 'Return not found' } };
      if (r.status !== 'AWAITING') return { code: 409, body: { error: `This return is already marked ${r.status}` } };
      let movementId: string | null = null;
      if (status === 'RESELL') {
        const loc = (await client.query(`SELECT id FROM warehouse_locations WHERE location_code = 'RECEIVING' LIMIT 1`)).rows[0];
        if (!loc) return { code: 500, body: { error: 'The RECEIVING location does not exist' } };
        const colour = (await client.query(`SELECT colour_code FROM wms_products WHERE variant_sku = $1 AND colour_code IS NOT NULL ORDER BY is_archived LIMIT 1`, [r.sku])).rows[0]?.colour_code?.slice(0, 20) ?? null;
        await client.query(
          `INSERT INTO warehouse_inventory (location_id, product_sku, colour_code, quantity, liability_status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'Bisley', NOW(), NOW())
           ON CONFLICT (location_id, product_sku, COALESCE(colour_code, '')) DO UPDATE SET quantity = warehouse_inventory.quantity + $4, updated_at = NOW()`,
          [loc.id, r.sku, colour, r.quantity]);
        movementId = (await client.query(
          `INSERT INTO warehouse_movements (movement_type, location_id, product_sku, colour_code, quantity, notes, performed_by, order_id)
           VALUES ('RETURN_RESELL', $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [loc.id, r.sku, colour, r.quantity, `Returned stock put back (not a new receipt)`, userId, r.medusa_order_id])).rows[0].id;
      }
      const upd = (await client.query(
        `UPDATE stock_returns SET status = $2, notes = COALESCE($3, notes), decided_by = $4, decided_at = NOW(), movement_id = $5 WHERE id = $1 RETURNING *`,
        [r.id, status, notes?.trim() || null, actor, movementId])).rows[0];
      return { code: 200, body: upd };
    });
    if (out.code === 200) scheduleAllocationRun(`return ${status.toLowerCase()} ${req.params.id}`);
    res.status(out.code).json(out.body);
  } catch (err) { fail(res, err, 'save the decision'); }
});

router.post('/returns/:id/reported', ...READ, async (req: AuthRequest, res: Response) => {
  const actor = actorOf(req);
  try {
    const row = await withAudit({ actor, source: 'returns', reason: 'Faulty return reported to Bisley' }, async (client) =>
      (await client.query(`UPDATE stock_returns SET reported_to_bisley_at = NOW() WHERE id = $1 AND status = 'FAULTY' AND reported_to_bisley_at IS NULL RETURNING *`, [req.params.id])).rows[0]);
    if (!row) return res.status(409).json({ error: 'Only an unreported faulty return can be marked as reported' });
    res.json(row);
  } catch (err) { fail(res, err, 'mark the return as reported'); }
});

/* ---------- Audit trail ---------- */

function auditFilter(q: any): { where: string; params: any[] } | null {
  const conds: string[] = [];
  const params: any[] = [];
  const add = (sql: string, v: any) => { params.push(v); conds.push(sql.replace('$#', `$${params.length}`)); };
  if (q.sku) add(`sku ILIKE $#`, `%${String(q.sku).trim()}%`);
  if (q.order) add(`(pick_list_number ILIKE $# OR medusa_order_id ILIKE $#)`, `%${String(q.order).trim()}%`);
  if (q.week) { if (!DATE_RE.test(String(q.week))) return null; add(`week_start = $#::date`, q.week); }
  if (q.table) add(`table_name = $#`, String(q.table));
  if (q.action) add(`action = $#`, String(q.action).toUpperCase());
  if (q.source) add(`source = $#`, String(q.source));
  if (q.actor) add(`actor ILIKE $#`, `%${String(q.actor).trim()}%`);
  if (q.from) { if (!DATE_RE.test(String(q.from))) return null; add(`at >= $#::date`, q.from); }
  if (q.to) { if (!DATE_RE.test(String(q.to))) return null; add(`at < $#::date + 1`, q.to); }
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

const AUDIT_COLS = `id, at, table_name, action, row_id, sku, pick_list_number, medusa_order_id, week_start::text AS week_start,
  qty_delta, payable_delta, owned_delta, old_row, new_row, actor, source, reason`;

router.get('/audit', ...READ, async (req: AuthRequest, res: Response) => {
  const f = auditFilter(req.query);
  if (!f) return res.status(400).json({ error: 'Invalid date filter' });
  const limit = Math.min(Math.max(parseInt(String(req.query.limit)) || 100, 1), 500);
  const offset = Math.max(parseInt(String(req.query.offset)) || 0, 0);
  try {
    const rows = (await query(`SELECT ${AUDIT_COLS} FROM stock_sold_audit ${f.where} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`, f.params)).rows;
    const total = (await query(`SELECT COUNT(*)::int AS n FROM stock_sold_audit ${f.where}`, f.params)).rows[0].n;
    res.json({ rows, total, limit, offset });
  } catch (err) { fail(res, err, 'load the audit trail'); }
});

router.get('/audit/export', ...READ, async (req: AuthRequest, res: Response) => {
  const f = auditFilter(req.query);
  if (!f) return res.status(400).json({ error: 'Invalid date filter' });
  try {
    const rows = (await query(`SELECT ${AUDIT_COLS} FROM stock_sold_audit ${f.where} ORDER BY id DESC LIMIT 20000`, f.params)).rows;
    const aoa: (string | number)[][] = [['When', 'Table', 'Action', 'SKU', 'Order', 'Medusa order', 'Week', 'Qty change', 'Payable change', 'Own stock change', 'Who', 'Source', 'Reason']];
    for (const r of rows) aoa.push([new Date(r.at).toISOString(), r.table_name, r.action, safeCell(r.sku ?? ''), safeCell(r.pick_list_number ?? ''), safeCell(r.medusa_order_id ?? ''), r.week_start ?? '', r.qty_delta ?? '', r.payable_delta ?? '', r.owned_delta ?? '', safeCell(r.actor ?? ''), r.source ?? '', safeCell(r.reason ?? '')]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 24 }, { wch: 18 }, { wch: 9 }, { wch: 22 }, { wch: 20 }, { wch: 30 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 28 }, { wch: 12 }, { wch: 60 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Audit trail');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="stock-sold-audit-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
  } catch (err) { fail(res, err, 'build the audit spreadsheet'); }
});

router.post('/recalculate', ...ADMIN, async (req: AuthRequest, res: Response) => {
  try { res.json(await runAllocation(`manual recalculation by ${actorOf(req)}`)); } catch (err) { fail(res, err, 'recalculate'); }
});

export default router;
