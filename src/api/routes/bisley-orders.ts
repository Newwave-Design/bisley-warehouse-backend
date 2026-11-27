/**
 * Bisley orders: the record of every weekly reorder workbook sent to Bisley (see lib/bisley-orders.ts).
 *
 * GET    /api/bisley-orders                 sheets, stock on order with estimated arrival, weekly timeline, bonded balance
 * POST   /api/bisley-orders/upload          the workbook as the body (xlsx); headers X-Sent-At (ISO), X-File-Name, X-Sent-To, X-Ref
 * POST   /api/bisley-orders/sheets          { ref, sent_at, cut_off?, sent_to?, bisley_ref?, booked_for?, note?, lines: [{ kind, sku, quantity, unit_cost_gbp?, line_cost_gbp?, note? }] }
 * PATCH  /api/bisley-orders/sheets/:id      { bisley_ref?, booked_for?, delivered_at?, note? }  (null clears)
 * DELETE /api/bisley-orders/sheets/:id      removes a sheet recorded by mistake
 */
import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, requirePermission, AuthRequest } from '../../middleware/auth.js';
import { bisleyOrdersOverview, ensureBisleyOrders, parseWorkbook, saveSheet, type SheetLine } from '../../lib/bisley-orders.js';

const router = express.Router();
router.use(authMiddleware);
router.use(requirePermission('manage_orders'));

const actor = (req: AuthRequest) => req.user?.email || 'unknown';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function header(req: AuthRequest, name: string): string | null {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  try { return decodeURIComponent(String(value)).trim() || null; } catch { return String(value).trim() || null; }
}

function sentAt(raw: unknown): string | null {
  const ms = Date.parse(String(raw ?? ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function refFor(sent: string, cutOff: string | null): string {
  return `Weekly reorder sent ${sent.slice(0, 10)}${cutOff ? ` (${cutOff.replace(/\s+/g, ' ').slice(0, 120)})` : ''}`;
}

function cleanLines(raw: unknown): SheetLine[] | string {
  if (!Array.isArray(raw) || !raw.length) return 'Send at least one line';
  if (raw.length > 2000) return 'Too many lines';
  const out: SheetLine[] = [];
  for (const row of raw as Record<string, unknown>[]) {
    const kind = row.kind === 'bonded' ? 'bonded' : row.kind === 'order' ? 'order' : null;
    const sku = String(row.sku ?? '').trim();
    const quantity = Math.trunc(Number(row.quantity));
    if (!kind || !sku || sku.length > 120 || !Number.isFinite(quantity) || quantity <= 0) return `Bad line for "${sku}"`;
    const money = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    out.push({ kind, sku, quantity, unit_cost_gbp: money(row.unit_cost_gbp), line_cost_gbp: money(row.line_cost_gbp), note: row.note ? String(row.note).slice(0, 500) : null });
  }
  return out;
}

router.get('/', async (_req: AuthRequest, res: Response) => {
  try {
    res.json(await bisleyOrdersOverview());
  } catch (err) {
    console.error('[bisley-orders] overview failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Could not load the Bisley orders' });
  }
});

router.post('/upload', express.raw({ type: () => true, limit: '10mb' }), async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) return res.status(400).json({ error: 'Attach the workbook' });
    const sent = sentAt(header(req, 'x-sent-at'));
    if (!sent) return res.status(400).json({ error: 'Say when the workbook was sent' });
    let parsed;
    try {
      parsed = parseWorkbook(body);
    } catch {
      return res.status(400).json({ error: 'That file could not be read as a spreadsheet' });
    }
    if (!parsed.lines.length) return res.status(400).json({ error: 'No order or bonded lines found. The sheets need a SKU column and a Reorder qty or Qty sold column.' });
    const ref = header(req, 'x-ref') || refFor(sent, parsed.cut_off);
    const saved = await saveSheet({
      ref,
      sent_at: sent,
      cut_off: parsed.cut_off,
      sent_to: header(req, 'x-sent-to'),
      file_name: header(req, 'x-file-name'),
      source: 'upload',
      lines: parsed.lines,
    }, actor(req));
    res.json({ ...saved, ref, sheets: parsed.sheets });
  } catch (err) {
    console.error('[bisley-orders] upload failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Could not save the workbook' });
  }
});

router.post('/sheets', async (req: AuthRequest, res: Response) => {
  try {
    const sent = sentAt(req.body?.sent_at);
    if (!sent) return res.status(400).json({ error: 'sent_at is required' });
    const lines = cleanLines(req.body?.lines);
    if (typeof lines === 'string') return res.status(400).json({ error: lines });
    const booked = req.body?.booked_for ? String(req.body.booked_for) : null;
    if (booked && !DATE.test(booked)) return res.status(400).json({ error: 'booked_for must be YYYY-MM-DD' });
    const cutOff = req.body?.cut_off ? String(req.body.cut_off).slice(0, 200) : null;
    const ref = String(req.body?.ref || '').trim().slice(0, 200) || refFor(sent, cutOff);
    const saved = await saveSheet({
      ref,
      sent_at: sent,
      cut_off: cutOff,
      sent_to: req.body?.sent_to ? String(req.body.sent_to).slice(0, 255) : null,
      bisley_ref: req.body?.bisley_ref ? String(req.body.bisley_ref).slice(0, 100) : null,
      booked_for: booked,
      source: req.body?.source ? String(req.body.source).slice(0, 40) : 'manual',
      note: req.body?.note ? String(req.body.note).slice(0, 2000) : null,
      lines,
    }, actor(req));
    res.json({ ...saved, ref });
  } catch (err) {
    console.error('[bisley-orders] save failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Could not save the sheet' });
  }
});

router.patch('/sheets/:id', async (req: AuthRequest, res: Response) => {
  try {
    await ensureBisleyOrders();
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const field of ['booked_for', 'delivered_at'] as const) {
      if (!(field in (req.body ?? {}))) continue;
      const v = req.body[field];
      if (v !== null && v !== '' && !DATE.test(String(v))) return res.status(400).json({ error: `${field} must be YYYY-MM-DD` });
      values.push(v === '' ? null : v);
      sets.push(`${field} = $${values.length}`);
    }
    for (const field of ['bisley_ref', 'note'] as const) {
      if (!(field in (req.body ?? {}))) continue;
      const v = req.body[field];
      values.push(v === null || v === '' ? null : String(v).slice(0, field === 'note' ? 2000 : 100));
      sets.push(`${field} = $${values.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
    values.push(req.params.id);
    const result = await query(
      `UPDATE bisley_order_sheets SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length}::uuid RETURNING id`,
      values,
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Sheet not found' });
    res.json({ updated: true });
  } catch (err) {
    console.error('[bisley-orders] update failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Could not update the sheet' });
  }
});

router.delete('/sheets/:id', requirePermission('manage_financials'), async (req: AuthRequest, res: Response) => {
  try {
    await ensureBisleyOrders();
    const result = await query(`DELETE FROM bisley_order_sheets WHERE id = $1::uuid RETURNING ref`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Sheet not found' });
    res.json({ deleted: result.rows[0].ref });
  } catch (err) {
    console.error('[bisley-orders] delete failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Could not delete the sheet' });
  }
});

export default router;
