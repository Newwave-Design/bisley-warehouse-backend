/**
 * Order payment status: only paid orders reach the pick queue, Supplier Re-orders and dispatch.
 *
 * pick_lists.payment_status mirrors Medusa's order.payment_status ('captured' = paid). It is set when the order arrives
 * (with a few quick re-checks, because card payments can be captured moments after the order is placed) and refreshed
 * for every unpaid, open pick list by refreshUnpaidPickLists() on a schedule. Sandbox lists are always treated as paid.
 */
import { query } from '../db/index.js';
import { medusaGet } from './medusa-client.js';
import { scheduleAllocationRun } from './allocation.js';

export const PAID_STATUSES = ['captured', 'partially_refunded'] as const;

/** SQL condition: the pick list (alias) is paid, or is a sandbox list. */
export function paidSql(alias = 'pl'): string {
  return `(${alias}.is_sandbox OR ${alias}.payment_status IN ('captured', 'partially_refunded'))`;
}

export function isPaid(pickList: { is_sandbox?: boolean; payment_status?: string | null }): boolean {
  return !!pickList.is_sandbox || PAID_STATUSES.includes(pickList.payment_status as any);
}

async function fetchStatuses(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 40) {
    const batch = ids.slice(i, i + 40);
    const qs = batch.map((id) => `id=${encodeURIComponent(id)}`).join('&');
    const data = await medusaGet(`/admin/orders?${qs}&limit=${batch.length}&fields=id,payment_status`);
    for (const o of data?.orders ?? []) if (o.payment_status) out.set(o.id, o.payment_status);
  }
  // The list hides archived orders, so look up whatever is still missing one by one
  for (const id of ids) {
    if (out.has(id)) continue;
    const data = await medusaGet(`/admin/orders/${encodeURIComponent(id)}?fields=id,payment_status`);
    if (data?.order?.payment_status) out.set(id, data.order.payment_status);
  }
  return out;
}

/** Look up the given Medusa orders and store their payment status on the matching pick lists (including split children). */
export async function refreshPaymentStatus(orderIds: string[]): Promise<{ checked: number; nowPaid: string[] }> {
  const ids = [...new Set(orderIds)].filter(Boolean);
  if (!ids.length) return { checked: 0, nowPaid: [] };
  const statuses = await fetchStatuses(ids);
  const nowPaid: string[] = [];
  for (const [id, status] of statuses) {
    const match = `(medusa_order_id = $1 OR left(medusa_order_id, length($1) + 3) = $1 || '-BO')`;
    const changed = await query(`SELECT 1 FROM pick_lists WHERE ${match} AND payment_status IS DISTINCT FROM $2 LIMIT 1`, [id, status]);
    await query(`UPDATE pick_lists SET payment_status = $2, payment_checked_at = NOW() WHERE ${match}`, [id, status]);
    if (changed.rows.length && (PAID_STATUSES as readonly string[]).includes(status)) nowPaid.push(id);
    if (changed.rows.length) scheduleAllocationRun(`payment status of order ${id} is now ${status}`);
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
