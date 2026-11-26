/**
 * Purchase orders. Anyone on staff can raise one. A PO approver (permission approve_purchase_orders) approves it
 * before it can go to the supplier. Every line is a real catalogue SKU; an unknown SKU is added as a hidden item.
 */
import express, { Response } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { getEffectivePermission } from '../../lib/permissions.js';
import { getPool, query } from '../../db/index.js';
import {
  allowSelfApproval, approvalDecision, canMove, cleanLines, linesEditable, poTotal, PO_STATUSES, type PoStatus,
} from '../../lib/purchase-orders.js';
import { createHiddenItem, resolveLineSkus } from '../../lib/po-sku.js';

const router = express.Router();
router.use(authMiddleware);

type Db = { query: (text: string, params?: any[]) => Promise<any> };

async function who(req: AuthRequest): Promise<{ id: string | undefined; name: string }> {
  const id = req.user?.id;
  if (id && id !== '1') {
    const r = await query(`SELECT name FROM warehouse_users WHERE id = $1`, [id]);
    if (r.rows[0]?.name) return { id, name: r.rows[0].name };
  }
  return { id, name: req.user?.email || 'unknown' };
}

async function event(db: Db, poId: string, actor: string, action: string, summary: string) {
  await db.query(
    `INSERT INTO purchase_order_events (purchase_order_id, actor, action, summary) VALUES ($1,$2,$3,$4)`,
    [poId, actor, action, summary],
  );
}

async function loadPo(db: Db, id: string) {
  const po = await db.query(
    `SELECT p.*, s.name AS supplier_name, s.email AS supplier_email
       FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = $1`,
    [id],
  );
  if (!po.rows[0]) return null;
  const lines = await db.query(
    `SELECT l.*, w.product_title FROM purchase_order_lines l
       LEFT JOIN LATERAL (SELECT product_title FROM wms_products WHERE LOWER(variant_sku) = LOWER(l.product_sku) AND is_archived = false LIMIT 1) w ON true
      WHERE l.purchase_order_id = $1 ORDER BY l.line_number`,
    [id],
  );
  return { ...po.rows[0], lines: lines.rows, total: poTotal(lines.rows) };
}

async function replaceLines(db: Db, poId: string, lines: { sku: string; quantity: number; unit_price: number; description: string | null }[], skus: Map<string, string>) {
  await db.query(`DELETE FROM purchase_order_lines WHERE purchase_order_id = $1`, [poId]);
  let n = 0;
  for (const l of lines) {
    n += 1;
    await db.query(
      `INSERT INTO purchase_order_lines (purchase_order_id, line_number, product_sku, description, quantity_ordered, unit_price)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [poId, n, skus.get(l.sku) ?? l.sku, l.description, l.quantity, l.unit_price],
    );
  }
}

/** Check lines, make any new hidden items, return what to store. Sends the error response itself on failure. */
async function prepareLines(raw: unknown, res: Response) {
  const { lines, errors } = cleanLines(raw);
  if (errors.length) { res.status(400).json({ error: errors.join('. '), errors }); return null; }
  const resolved = await resolveLineSkus(lines);
  if (!resolved.ok) { res.status(400).json({ error: resolved.errors.join('. '), errors: resolved.errors }); return null; }
  const created: string[] = [];
  for (const item of resolved.toCreate) {
    const made = await createHiddenItem(item.sku, item.title);
    if (!made.ok) { res.status(502).json({ error: `Could not add ${item.sku} as a new item: ${made.error}` }); return null; }
    created.push(item.sku);
  }
  return { lines, skus: resolved.skus, created };
}

// ---- reads -----------------------------------------------------------------------------------------

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const status = String(req.query.status || '').toUpperCase();
    const params: any[] = [];
    let where = '';
    if (status && (PO_STATUSES as string[]).includes(status)) { params.push(status); where = 'WHERE p.status = $1'; }
    const r = await query(
      `SELECT p.id, p.po_number, p.status, p.expected_date, p.created_by_name, p.approved_by_name, p.created_at, p.sent_at,
              s.name AS supplier_name,
              COALESCE(SUM(l.quantity_ordered * l.unit_price), 0)::numeric(14,2) AS total,
              COUNT(l.id)::int AS line_count
         FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id
         LEFT JOIN purchase_order_lines l ON l.purchase_order_id = p.id
         ${where} GROUP BY p.id, s.name ORDER BY p.created_at DESC LIMIT 300`,
      params,
    );
    res.json({ purchase_orders: r.rows });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to list purchase orders' }); }
});

/** Suppliers to choose from. Open to any staff, since anyone can raise a PO. */
router.get('/suppliers', async (_req: AuthRequest, res: Response) => {
  try {
    const r = await query(`SELECT id, name, email FROM suppliers ORDER BY LOWER(COALESCE(name, email))`);
    res.json({ suppliers: r.rows });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to load suppliers' }); }
});

/** Add a supplier. An email that already exists returns the existing supplier unchanged. */
router.post('/suppliers', async (req: AuthRequest, res: Response) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim();
    if (!name) return res.status(400).json({ error: 'Enter the supplier name' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid supplier email' });
    const existing = await query(`SELECT id, name, email FROM suppliers WHERE LOWER(email) = LOWER($1)`, [email]);
    if (existing.rows[0]) return res.json({ supplier: existing.rows[0], existed: true });
    const made = await query(`INSERT INTO suppliers (name, email) VALUES ($1,$2) RETURNING id, name, email`, [name, email]);
    res.status(201).json({ supplier: made.rows[0], existed: false });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to add supplier' }); }
});

/** Is this SKU in the catalogue? The form uses it to ask for a name when it is not. */
router.get('/sku/:sku', async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `SELECT variant_sku, product_title FROM wms_products WHERE LOWER(variant_sku) = LOWER($1) AND is_archived = false LIMIT 1`,
      [String(req.params.sku).trim()],
    );
    res.json(r.rows[0] ? { exists: true, sku: r.rows[0].variant_sku, title: r.rows[0].product_title } : { exists: false });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Lookup failed' }); }
});

/** Open PO quantity per SKU: what is on order and still to arrive. For the desk and the dashboard. */
router.get('/on-order', async (req: AuthRequest, res: Response) => {
  try {
    const skus = String(req.query.skus || '').split(',').map((s) => s.trim()).filter(Boolean);
    const r = await query(
      `SELECT l.product_sku, SUM(l.quantity_ordered - l.quantity_received)::int AS on_order, MIN(p.expected_date) AS next_due
         FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.purchase_order_id
        WHERE p.status IN ('SENT','PART_RECEIVED') AND l.quantity_ordered > l.quantity_received
          AND ($1::text[] IS NULL OR LOWER(l.product_sku) = ANY (SELECT LOWER(x) FROM unnest($1::text[]) x))
        GROUP BY l.product_sku ORDER BY l.product_sku`,
      [skus.length ? skus : null],
    );
    res.json({ on_order: r.rows });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to read on-order stock' }); }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const po = await loadPo({ query }, req.params.id);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    const events = await query(`SELECT actor, action, summary, created_at FROM purchase_order_events WHERE purchase_order_id = $1 ORDER BY created_at DESC`, [req.params.id]);
    res.json({ purchase_order: po, events: events.rows });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to load purchase order' }); }
});

// ---- create and edit -------------------------------------------------------------------------------

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body || {};
    const supplier = await query(`SELECT id, name FROM suppliers WHERE id = $1`, [body.supplier_id]).catch(() => ({ rows: [] as any[] }));
    if (!supplier.rows[0]) return res.status(400).json({ error: 'Choose a supplier' });
    const prepared = await prepareLines(body.lines, res);
    if (!prepared) return;
    const me = await who(req);
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const seq = await client.query(`SELECT nextval('purchase_order_number_seq') AS n`);
      const poNumber = `PO-${seq.rows[0].n}`;
      const ins = await client.query(
        `INSERT INTO purchase_orders (po_number, supplier_id, expected_date, delivery_address, notes, created_by, created_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [poNumber, body.supplier_id, body.expected_date || null, body.delivery_address || null, body.notes || null,
         me.id && me.id !== '1' ? me.id : null, me.name],
      );
      const id = ins.rows[0].id;
      await replaceLines(client, id, prepared.lines, prepared.skus);
      await event(client, id, me.name, 'created', `Created ${poNumber} with ${prepared.lines.length} line(s)${prepared.created.length ? `; new hidden item(s): ${prepared.created.join(', ')}` : ''}`);
      await client.query('COMMIT');
      res.status(201).json({ purchase_order: await loadPo({ query }, id), new_items: prepared.created });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally { client.release(); }
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to create purchase order' }); }
});

router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const po = await loadPo({ query }, req.params.id);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (!linesEditable(po.status)) return res.status(409).json({ error: `A ${po.status.toLowerCase().replace('_', ' ')} purchase order can no longer be edited` });
    const body = req.body || {};
    let prepared: Awaited<ReturnType<typeof prepareLines>> = null;
    if (body.lines !== undefined) { prepared = await prepareLines(body.lines, res); if (!prepared) return; }
    const me = await who(req);
    const backToApproval = po.status === 'APPROVED';
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE purchase_orders SET
            supplier_id = COALESCE($2, supplier_id),
            expected_date = CASE WHEN $3::boolean THEN $4::date ELSE expected_date END,
            delivery_address = CASE WHEN $5::boolean THEN $6 ELSE delivery_address END,
            notes = CASE WHEN $7::boolean THEN $8 ELSE notes END,
            status = CASE WHEN $9::boolean THEN 'AWAITING_APPROVAL' ELSE status END,
            approved_by = CASE WHEN $9::boolean THEN NULL ELSE approved_by END,
            approved_by_name = CASE WHEN $9::boolean THEN NULL ELSE approved_by_name END,
            approved_at = CASE WHEN $9::boolean THEN NULL ELSE approved_at END,
            updated_at = NOW()
          WHERE id = $1`,
        [req.params.id, body.supplier_id || null,
         'expected_date' in body, body.expected_date || null,
         'delivery_address' in body, body.delivery_address || null,
         'notes' in body, body.notes || null,
         backToApproval],
      );
      if (prepared) await replaceLines(client, req.params.id, prepared.lines, prepared.skus);
      await event(client, req.params.id, me.name, 'edited', backToApproval ? 'Edited after approval, needs approving again' : 'Edited');
      await client.query('COMMIT');
      res.json({ purchase_order: await loadPo({ query }, req.params.id), new_items: prepared?.created ?? [] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally { client.release(); }
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to update purchase order' }); }
});

// ---- status changes --------------------------------------------------------------------------------

/** Move a PO to a new status. `apply` is a fixed SET fragment that may use $4, $5... for `values`. */
async function move(req: AuthRequest, res: Response, to: PoStatus, apply: string, summary: string, values: any[] = []) {
  const po = await loadPo({ query }, req.params.id);
  if (!po) { res.status(404).json({ error: 'Purchase order not found' }); return null; }
  if (!canMove(po.status, to)) {
    res.status(409).json({ error: `A ${po.status.toLowerCase().replace('_', ' ')} purchase order cannot become ${to.toLowerCase().replace('_', ' ')}` });
    return null;
  }
  const me = await who(req);
  const upd = await query(
    `UPDATE purchase_orders SET status = $2, ${apply}, updated_at = NOW() WHERE id = $1 AND status = $3 RETURNING id`,
    [req.params.id, to, po.status, ...values],
  );
  if (!upd.rows[0]) { res.status(409).json({ error: 'This purchase order just changed, reload and try again' }); return null; }
  await event({ query }, req.params.id, me.name, to.toLowerCase(), summary);
  return { po, me };
}

router.post('/:id/submit', async (req: AuthRequest, res: Response) => {
  try {
    const po = await loadPo({ query }, req.params.id);
    if (po && po.status === 'DRAFT' && po.lines.length === 0) return res.status(400).json({ error: 'Add at least one line first' });
    const done = await move(req, res, 'AWAITING_APPROVAL', 'submitted_at = NOW()', 'Submitted for approval');
    if (done) res.json({ purchase_order: await loadPo({ query }, req.params.id) });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to submit' }); }
});

router.post('/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    const po = await loadPo({ query }, req.params.id);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    const me = await who(req);
    const decision = approvalDecision({
      hasPermission: await getEffectivePermission(req.user?.id, 'approve_purchase_orders'),
      approverId: req.user?.id,
      creatorId: po.created_by,
      allowSelf: allowSelfApproval(),
    });
    if (!decision.ok) return res.status(403).json({ error: decision.reason });
    const done = await move(
      req, res, 'APPROVED',
      'approved_by = $4::uuid, approved_by_name = $5, approved_at = NOW()',
      `Approved by ${me.name}`,
      [me.id && me.id !== '1' ? me.id : null, me.name],
    );
    if (done) res.json({ purchase_order: await loadPo({ query }, req.params.id) });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to approve' }); }
});

/** An approver sends it back to the creator to change. */
router.post('/:id/reject', async (req: AuthRequest, res: Response) => {
  try {
    if (!(await getEffectivePermission(req.user?.id, 'approve_purchase_orders'))) return res.status(403).json({ error: 'Only a PO approver can send a purchase order back' });
    const reason = String(req.body?.reason || '').trim();
    const done = await move(req, res, 'DRAFT', 'submitted_at = NULL', `Sent back to draft${reason ? `: ${reason}` : ''}`);
    if (done) res.json({ purchase_order: await loadPo({ query }, req.params.id) });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to send back' }); }
});

/** Marks it as sent to the supplier. Only an approved PO can be sent. */
router.post('/:id/sent', async (req: AuthRequest, res: Response) => {
  try {
    const done = await move(req, res, 'SENT', 'sent_at = NOW()', 'Marked as sent to the supplier');
    if (done) res.json({ purchase_order: await loadPo({ query }, req.params.id) });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to mark as sent' }); }
});

router.post('/:id/cancel', async (req: AuthRequest, res: Response) => {
  try {
    const po = await loadPo({ query }, req.params.id);
    if (po && po.lines.some((l: any) => l.quantity_received > 0)) return res.status(409).json({ error: 'Some of this order has arrived, close it instead of cancelling' });
    const reason = String(req.body?.reason || '').trim();
    const done = await move(req, res, 'CANCELLED', 'cancelled_at = NOW()', `Cancelled${reason ? `: ${reason}` : ''}`);
    if (done) res.json({ purchase_order: await loadPo({ query }, req.params.id) });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to cancel' }); }
});

router.post('/:id/close', async (req: AuthRequest, res: Response) => {
  try {
    const done = await move(req, res, 'CLOSED', 'closed_at = NOW()', 'Closed');
    if (done) res.json({ purchase_order: await loadPo({ query }, req.params.id) });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to close' }); }
});

export default router;
