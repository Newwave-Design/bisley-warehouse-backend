/**
 * Order payment status: paid orders reach the pick queue and dispatch.
 * An order with a customer purchase order number does too, because those are paid after delivery.
 *
 * pick_lists.payment_status mirrors Medusa's order.payment_status ('captured' = paid). It is set when the order arrives
 * (with a few quick re-checks, because card payments can be captured moments after the order is placed) and refreshed
 * for every unpaid, open pick list by refreshUnpaidPickLists() on a schedule. Sandbox lists are always treated as paid.
 */
import { query } from '../db/index.js';
import { medusaGet } from './medusa-client.js';
import { scheduleAllocationRun } from './allocation.js';

export const PAID_STATUSES = ['captured', 'partially_refunded'] as const;

/** SQL condition: the pick list (alias) is paid, has a purchase order, or is a sandbox list. */
export function paidSql(alias = 'pl'): string {
  return `(${alias}.is_sandbox OR ${alias}.payment_status IN ('captured', 'partially_refunded') OR COALESCE(${alias}.purchase_order_number, '') <> '')`;
}

export function isPaid(pickList: { is_sandbox?: boolean; payment_status?: string | null; purchase_order_number?: string | null }): boolean {
  return !!pickList.is_sandbox || !!String(pickList.purchase_order_number || '').trim() || PAID_STATUSES.includes(pickList.payment_status as any);
}

export function purchaseOrderOf(metadata: Record<string, unknown> | null | undefined): string | null {
  const value = metadata?.purchase_order_number;
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : null;
}

async function fetchStatuses(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 40) {
    const batch = ids.slice(i, i + 40);
    const qs = batch.map((id) => `id=${encodeURIComponent(id)}`).join('&');
    const data = await medusaGet(`/admin/orders?${qs}&limit=${batch.length}&fields=id,payment_status,metadata`);
    for (const o of data?.orders ?? []) if (o.payment_status) out.set(o.id, o.payment_status);
    for (const o of data?.orders ?? []) {
      const po = purchaseOrderOf(o.metadata);
      if (po) await storePurchaseOrder(o.id, po);
    }
  }
  // The list hides archived orders, so look up whatever is still missing one by one
  for (const id of ids) {
    if (out.has(id)) continue;
    const data = await medusaGet(`/admin/orders/${encodeURIComponent(id)}?fields=id,payment_status,metadata`);
    if (data?.order?.payment_status) out.set(id, data.order.payment_status);
    const po = purchaseOrderOf(data?.order?.metadata);
    if (po) await storePurchaseOrder(id, po);
  }
  return out;
}

/** Store a Medusa payment status on the order's pick lists (including split children). Returns true if it changed. */
export async function storePaymentStatus(orderId: string, status: string): Promise<boolean> {
  const match = `(medusa_order_id = $1 OR left(medusa_order_id, length($1) + 3) = $1 || '-BO')`;
  const changed = await query(`SELECT 1 FROM pick_lists WHERE ${match} AND payment_status IS DISTINCT FROM $2 LIMIT 1`, [orderId, status]);
  await query(`UPDATE pick_lists SET payment_status = $2, payment_checked_at = NOW() WHERE ${match}`, [orderId, status]);
  if (changed.rows.length) scheduleAllocationRun(`payment status of order ${orderId} is now ${status}`);
  return changed.rows.length > 0;
}

async function storePurchaseOrder(orderId: string, purchaseOrder: string): Promise<void> {
  const match = `(medusa_order_id = $1 OR left(medusa_order_id, length($1) + 3) = $1 || '-BO')`;
  await query(
    `UPDATE pick_lists SET purchase_order_number = $2, updated_at = NOW()
     WHERE ${match} AND COALESCE(purchase_order_number, '') = ''`,
    [orderId, purchaseOrder],
  );
}

/** Look up the given Medusa orders and store their payment status on the matching pick lists (including split children). */
export async function refreshPaymentStatus(orderIds: string[]): Promise<{ checked: number; nowPaid: string[] }> {
  const ids = [...new Set(orderIds)].filter(Boolean);
  if (!ids.length) return { checked: 0, nowPaid: [] };
  const statuses = await fetchStatuses(ids);
  const nowPaid: string[] = [];
  for (const [id, status] of statuses) {
    if (await storePaymentStatus(id, status) && (PAID_STATUSES as readonly string[]).includes(status)) nowPaid.push(id);
  }
  return { checked: statuses.size, nowPaid };
}

/** Re-check every open, real pick list that is not yet known to be paid. */
export async function refreshUnpaidPickLists(): Promise<{ checked: number; nowPaid: string[] }> {
  const r = await query(
    `SELECT DISTINCT split_part(medusa_order_id, '-', 1) AS id FROM pick_lists
     WHERE NOT is_sandbox AND NOT is_archived AND status NOT IN ('DISPATCHED', 'CANCELLED')
       AND (payment_status IS NULL OR payment_status NOT IN ('captured', 'partially_refunded'))
       AND (payment_checked_at IS NULL OR payment_checked_at < NOW() - INTERVAL '2 minutes')
       AND medusa_order_id LIKE 'order\\_%'`
  );
  return refreshPaymentStatus(r.rows.map((x: any) => x.id));
}

const RECHECK_DELAYS_MS = [5_000, 20_000, 60_000, 300_000];

/** Right after an order is placed: check now, then a few more times until it shows as paid. */
export function watchPayment(orderId: string): void {
  const attempt = (n: number) => {
    setTimeout(async () => {
      try {
        const { nowPaid } = await refreshPaymentStatus([orderId]);
        if (nowPaid.length) return;
        const row = await query(`SELECT payment_status FROM pick_lists WHERE medusa_order_id = $1`, [orderId]);
        if (row.rows[0] && (PAID_STATUSES as readonly string[]).includes(row.rows[0].payment_status)) return;
      } catch (err) {
        console.warn(`[payment-status] check failed for ${orderId}:`, err instanceof Error ? err.message : err);
      }
      if (n + 1 < RECHECK_DELAYS_MS.length) attempt(n + 1);
    }, RECHECK_DELAYS_MS[n]);
  };
  attempt(0);
}

/** Called when a pick list is created: record the payment status now and keep re-checking while it is unpaid. */
export async function checkPaymentOnPlacement(orderId: string): Promise<void> {
  try {
    await refreshPaymentStatus([orderId]);
    const row = await query(`SELECT payment_status FROM pick_lists WHERE medusa_order_id = $1`, [orderId]);
    if (row.rows[0] && (PAID_STATUSES as readonly string[]).includes(row.rows[0].payment_status)) return;
  } catch (err) {
    console.warn(`[payment-status] first check failed for ${orderId}:`, err instanceof Error ? err.message : err);
  }
  watchPayment(orderId);
}
