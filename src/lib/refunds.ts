/**
 * Refunds for a shop order. The amount is decided by a person; the shop's payment provider moves the money.
 * Every refund is its own row, so an order can have several part refunds and each one shows who asked and what the shop said.
 * A row is `issued` only after the shop confirms. A failed call stays as `failed` and nothing is counted as refunded.
 */
import { query } from '../db/index.js';
import { medusaGet, medusaPost } from './medusa-client.js';
import { rootMedusaOrderId } from './order-values.js';

export const REFUND_REASONS = ['damaged', 'faulty', 'wrong_item', 'missing_part', 'change_of_mind', 'lost', 'late', 'goodwill', 'other'] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export class RefundError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface RefundPosition {
  paid: number;
  refunded: number;
  left: number;
  currency: string;
  payments: { id: string; left: number }[];
}

const pence = (value: unknown) => Math.round((Number(value) || 0) * 100);
const pounds = (value: number) => Math.round(value) / 100;

/** What was captured, what has been refunded and what can still be refunded, read live from the shop. */
export async function refundPosition(medusaOrderId: string): Promise<RefundPosition> {
  const id = rootMedusaOrderId(medusaOrderId);
  const data = await medusaGet(
    `/admin/orders/${encodeURIComponent(id)}?fields=id,currency_code,*payment_collections,*payment_collections.payments,*payment_collections.payments.refunds`
  );
  const order = data?.order;
  if (!order) throw new RefundError(404, 'The shop does not have this order');
  let paid = 0;
  let refunded = 0;
  const payments: { id: string; left: number }[] = [];
  for (const collection of order.payment_collections || []) {
    for (const payment of collection.payments || []) {
      if (!payment.captured_at || payment.canceled_at) continue;
      const taken = pence(payment.amount);
      const back = (Array.isArray(payment.refunds) ? payment.refunds : []).reduce((sum: number, row: any) => sum + pence(row?.amount), 0);
      paid += taken;
      refunded += back;
      payments.push({ id: String(payment.id), left: pounds(taken - back) });
    }
  }
  return { paid: pounds(paid), refunded: pounds(refunded), left: pounds(paid - refunded), currency: String(order.currency_code || 'gbp').toUpperCase(), payments };
}

export function checkRefundRequest(input: { amount: unknown; reason: unknown; note?: unknown }): { amount: number; reason: RefundReason; note: string } {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new RefundError(400, 'Enter an amount greater than zero');
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) throw new RefundError(400, 'The amount can have at most two decimal places');
  const reason = String(input.reason || '') as RefundReason;
  if (!(REFUND_REASONS as readonly string[]).includes(reason)) throw new RefundError(400, 'Choose a reason for the refund');
  const note = String(input.note || '').trim();
  if ((reason === 'goodwill' || reason === 'other') && note.length < 5) throw new RefundError(400, 'Say why, in a few words, for a goodwill or other refund');
  return { amount: pounds(Math.round(amount * 100)), reason, note };
}

const queues = new Map<string, Promise<unknown>>();

/** One refund at a time per order, so two clicks cannot both pass the limit check. */
function inOrder<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) || Promise.resolve()).catch(() => undefined).then(run);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => undefined);
  return next;
}

export interface RefundRow {
  id: string;
  pick_list_id: string | null;
  return_authorization_id: string | null;
  amount_gbp: string;
  reason: string;
  note: string | null;
  includes_shipping: boolean;
  status: 'proposed' | 'pending' | 'issued' | 'failed' | 'rejected';
  requested_by: string | null;
  approved_by: string | null;
  shop_error: string | null;
  created_at: string;
  issued_at: string | null;
}

export async function listRefunds(pickListId: string): Promise<RefundRow[]> {
  const rows = await query(
    `SELECT id, pick_list_id, return_authorization_id, amount_gbp, reason, note, includes_shipping, status, requested_by, approved_by, shop_error, created_at, issued_at
     FROM order_refunds WHERE pick_list_id = $1 ORDER BY created_at DESC`,
    [pickListId]
  );
  return rows.rows as RefundRow[];
}

interface Checked {
  pick: { id: string };
  orderId: string;
  position: RefundPosition;
  payment: { id: string; left: number };
}

/** The checks every refund passes before money can move: the order, a replacement, the amount left, one payment that covers it. */
async function checkAgainstOrder(pickListId: string, request: { amount: number; reason: RefundReason }): Promise<Checked> {
  const list = await query(`SELECT id, medusa_order_id FROM pick_lists WHERE id = $1`, [pickListId]);
  const pick = list.rows[0];
  if (!pick) throw new RefundError(404, 'Order not found');
  if (!pick.medusa_order_id || !String(pick.medusa_order_id).startsWith('order_')) {
    throw new RefundError(400, 'This warehouse order has no shop order to refund against');
  }
  const orderId = rootMedusaOrderId(String(pick.medusa_order_id));
  const replacing = await query(
    `SELECT sku FROM return_requests WHERE pick_list_id = $1 AND outcome = 'replace' AND status <> 'cancelled'`,
    [pick.id]
  );
  if (replacing.rows.length && request.reason !== 'goodwill') {
    throw new RefundError(409, `A replacement is open for ${replacing.rows.map((row: { sku: string }) => row.sku).join(', ')}. Refunding as well would pay the customer twice. Cancel the replacement first, or refund the difference as goodwill.`);
  }
  const position = await refundPosition(orderId);
  if (request.amount > position.left + 1e-9) {
    throw new RefundError(400, `The most that can still be refunded is £${position.left.toFixed(2)} (paid £${position.paid.toFixed(2)}, refunded £${position.refunded.toFixed(2)})`);
  }
  const payment = position.payments.filter(row => row.left + 1e-9 >= request.amount).sort((a, b) => a.left - b.left)[0];
  if (!payment) throw new RefundError(400, 'No single payment on this order can cover that amount. Refund it in two parts.');
  return { pick, orderId, position, payment };
}

/** Sends one stored refund row to the shop and records what the shop said. Money moves only here. */
async function payRow(row: RefundRow, checked: Checked, approver: string): Promise<{ refund: RefundRow; position: RefundPosition }> {
  await query(`UPDATE order_refunds SET status = 'pending', medusa_payment_id = $2, approved_by = $3 WHERE id = $1`, [row.id, checked.payment.id, approver]);
  try {
    await medusaPost(`/admin/payments/${encodeURIComponent(checked.payment.id)}/refund`, {
      amount: Number(row.amount_gbp),
      note: [row.reason.replace(/_/g, ' '), row.note].filter(Boolean).join(': ').slice(0, 250),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The shop did not accept the refund';
    await query(`UPDATE order_refunds SET status = 'failed', shop_error = $2 WHERE id = $1`, [row.id, message.slice(0, 1000)]);
    throw new RefundError(502, `The shop did not refund it: ${message}`);
  }
  const done = await query(`UPDATE order_refunds SET status = 'issued', issued_at = NOW(), shop_error = NULL WHERE id = $1 RETURNING *`, [row.id]);
  return { refund: done.rows[0] as RefundRow, position: await refundPosition(checked.orderId).catch(() => checked.position) };
}

/** A person refunds now: stored and paid in one go. The person is also the approver. */
export async function issueRefund(input: {
  pickListId: string;
  amount: unknown;
  reason: unknown;
  note?: unknown;
  includesShipping?: boolean;
  returnAuthorizationId?: string | null;
  actor: string;
  /** The same key twice is the same refund. A retried click returns the first result. */
  idempotencyKey?: string | null;
}): Promise<{ refund: RefundRow; position: RefundPosition; repeated: boolean }> {
  const request = checkRefundRequest(input);
  const list = await query(`SELECT medusa_order_id FROM pick_lists WHERE id = $1`, [input.pickListId]);
  if (!list.rows[0]) throw new RefundError(404, 'Order not found');
  const orderId = rootMedusaOrderId(String(list.rows[0].medusa_order_id || ''));
  const key = input.idempotencyKey ? String(input.idempotencyKey).slice(0, 80) : null;

  return inOrder(orderId, async () => {
    if (key) {
      const found = await query(`SELECT * FROM order_refunds WHERE idempotency_key = $1`, [key]);
      if (found.rows[0]) return { refund: found.rows[0] as RefundRow, position: await refundPosition(orderId), repeated: true };
    }
    const checked = await checkAgainstOrder(input.pickListId, request);
    const created = await query(
      `INSERT INTO order_refunds (pick_list_id, return_authorization_id, medusa_order_id, medusa_payment_id, amount_gbp, reason, note, includes_shipping, status, requested_by, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10) RETURNING *`,
      [checked.pick.id, input.returnAuthorizationId || null, orderId, checked.payment.id, request.amount, request.reason, request.note || null, !!input.includesShipping, input.actor, key]
    );
    const paid = await payRow(created.rows[0] as RefundRow, checked, input.actor);
    return { ...paid, repeated: false };
  });
}

/** The bot, or anyone who may not pay, asks for a refund. Nothing moves; an admin approves or declines it on the desk. */
export async function proposeRefund(input: {
  pickListId: string;
  amount: unknown;
  reason: unknown;
  note?: unknown;
  includesShipping?: boolean;
  actor: string;
  idempotencyKey?: string | null;
}): Promise<{ refund: RefundRow; repeated: boolean }> {
  const request = checkRefundRequest(input);
  if (request.note.length < 5) throw new RefundError(400, 'A proposed refund needs a note saying why');
  const key = input.idempotencyKey ? String(input.idempotencyKey).slice(0, 80) : null;
  if (key) {
    const found = await query(`SELECT * FROM order_refunds WHERE idempotency_key = $1`, [key]);
    if (found.rows[0]) return { refund: found.rows[0] as RefundRow, repeated: true };
  }
  const checked = await checkAgainstOrder(input.pickListId, request);
  const open = await query(`SELECT id FROM order_refunds WHERE pick_list_id = $1 AND status = 'proposed'`, [checked.pick.id]);
  if (open.rows.length >= 3) throw new RefundError(409, 'Three refunds are already waiting for approval on this order. Wait for the team to decide them.');
  const created = await query(
    `INSERT INTO order_refunds (pick_list_id, medusa_order_id, medusa_payment_id, amount_gbp, reason, note, includes_shipping, status, requested_by, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'proposed',$8,$9) RETURNING *`,
    [checked.pick.id, checked.orderId, checked.payment.id, request.amount, request.reason, request.note, !!input.includesShipping, input.actor, key]
  );
  return { refund: created.rows[0] as RefundRow, repeated: false };
}

export async function proposedRefunds(pickListIds: string[]): Promise<Record<string, RefundRow[]>> {
  const rows = await query(
    `SELECT id, pick_list_id, amount_gbp, reason, note, includes_shipping, status, requested_by, created_at
     FROM order_refunds WHERE pick_list_id = ANY($1::uuid[]) AND status = 'proposed' ORDER BY created_at`,
    [pickListIds]
  );
  const byId: Record<string, RefundRow[]> = {};
  for (const row of rows.rows as RefundRow[]) (byId[row.pick_list_id as string] ||= []).push(row);
  return byId;
}

/** An admin decides a proposal. Approving re-checks the order now, because it may have changed since the proposal, then pays. */
export async function decideRefund(refundId: string, decision: 'approve' | 'reject', actor: string, reason?: string): Promise<{ refund: RefundRow; position: RefundPosition | null }> {
  const found = await query(`SELECT * FROM order_refunds WHERE id = $1`, [refundId]);
  const row = found.rows[0] as (RefundRow & { medusa_order_id: string }) | undefined;
  if (!row) throw new RefundError(404, 'Refund not found');
  return inOrder(rootMedusaOrderId(row.medusa_order_id), async () => {
    const fresh = await query(`SELECT * FROM order_refunds WHERE id = $1`, [refundId]);
    const current = fresh.rows[0] as RefundRow;
    if (current.status !== 'proposed') throw new RefundError(409, `This refund was already ${current.status === 'issued' ? 'paid' : current.status}`);
    if (decision === 'reject') {
      const done = await query(
        `UPDATE order_refunds SET status = 'rejected', approved_by = $2, shop_error = $3, issued_at = NULL WHERE id = $1 RETURNING *`,
        [refundId, actor, reason ? String(reason).slice(0, 250) : null]
      );
      return { refund: done.rows[0] as RefundRow, position: null };
    }
    const checked = await checkAgainstOrder(String(current.pick_list_id), { amount: Number(current.amount_gbp), reason: current.reason as RefundReason });
    return payRow(current, checked, actor);
  });
}
