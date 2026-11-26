/**
 * A return asked for on the customer desk or on an order goes into the older queue (return_requests).
 * The Returns screen reads return_authorizations, so each request is also put there: one return per order,
 * one line per SKU. The key is the same one scripts/bring-over-returns.mjs uses, so nothing is added twice.
 *
 * This is a copy for the Returns screen. It must never stop the request itself, so callers catch its errors.
 */
import { query } from '../db/index.js';
import { splitKitForReturn } from './return-kits.js';
import { pullDeliveryProofLater } from './delivery-proof.js';

export function mirrorKey(pickListId: string) {
  return `return_requests:${pickListId}`;
}

/** Today's next return number: one more than the highest plain number used today (never a count, which a deleted row would put back in use). */
export async function nextRmaNumber() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const top = await query(
    `SELECT COALESCE(MAX(SUBSTRING(rma_number FROM '[0-9]+$')::int), 0) AS n FROM return_authorizations WHERE rma_number ~ $1`,
    [`^RMA-${today}-[0-9]+$`]
  );
  return `RMA-${today}-${String(Number(top.rows[0].n) + 1).padStart(4, '0')}`;
}

/** Run an insert that needs a return number. Two returns made at the same moment can pick the same number: the loser takes the next one. */
export async function withRmaNumber<T>(run: (rma: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run(await nextRmaNumber());
    } catch (error) {
      const e = error as { code?: string; constraint?: string };
      if (e?.code === '23505' && String(e.constraint || '').includes('rma_number') && attempt < 5) continue;
      throw error;
    }
  }
}

/** What the customer desk knows about a return: why, what was said, which enquiry, and who asked and approved. */
export interface ReturnDetail {
  reason?: string;
  note?: string;
  ref?: string;
  requestedBy?: string;
  approvedBy?: string;
}

const DESK_REASON_LABEL: Record<string, string> = {
  damaged: 'Damaged',
  faulty: 'Faulty',
  wrong_item: 'Wrong item',
  missing_part: 'Missing part',
  change_of_mind: 'Change of mind',
  lost: 'Courier problem',
  late: 'Courier problem',
  goodwill: 'Goodwill',
  other: 'Other',
};

export function deskReasonLabel(reason?: string | null): string | null {
  return DESK_REASON_LABEL[String(reason || '').trim().toLowerCase()] || null;
}

/** One line for the Notes field: the enquiry, what it says, and who asked and approved. */
export function deskNote(detail?: ReturnDetail | null): string {
  if (!detail) return '';
  const said = [detail.ref, detail.note].map((part) => String(part || '').trim()).filter(Boolean).join(': ');
  const who = [detail.requestedBy ? `asked by ${detail.requestedBy}` : '', detail.approvedBy ? `approved by ${detail.approvedBy}` : ''].filter(Boolean).join(', ');
  return [said, who ? `[${who}]` : ''].filter(Boolean).join(' ').slice(0, 1000);
}

const PLACEHOLDER_NOTE = /^(Asked for on the customer desk|Brought over)/i;

/** Put one requested SKU on the Returns screen. Returns false when there is nothing to do (no shop order, or already closed). */
export async function mirrorRequestToDesk(pickListId: string, sku: string, detail?: ReturnDetail | null): Promise<boolean> {
  if (!pickListId || !sku) return false;
  const order = await query(`SELECT id, medusa_order_id, customer_name, customer_email FROM pick_lists WHERE id = $1`, [pickListId]);
  const pick = order.rows[0];
  if (!pick || !pick.medusa_order_id) return false;
  const key = mirrorKey(pickListId);
  const outcomeRow = await query(`SELECT outcome FROM return_requests WHERE pick_list_id = $1 AND sku = $2 AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 1`, [pickListId, sku]);
  const outcome = outcomeRow.rows[0]?.outcome || null;
  const reasonLabel = deskReasonLabel(detail?.reason);
  const note = deskNote(detail);
  let found = await query(`SELECT id, desk_status FROM return_authorizations WHERE legacy_key = $1`, [key]);
  if (!found.rows[0]) {
    const created = await withRmaNumber((rma) => query(
      `INSERT INTO return_authorizations
         (rma_number, medusa_order_id, status, redeem_to_warehouse, return_reason, customer_name, customer_email,
          notes, desk_status, how_back, hold_refund, pick_list_id, sold_stock_hold, legacy_key, outcome, desk_ref, desk_requested_by)
       VALUES ($1,$2,'AUTHORIZED', false, $3, $4,$5,$6,'due_back','post', true,$7, true,$8,$9,$10,$11)
       ON CONFLICT (legacy_key) DO NOTHING
       RETURNING id, desk_status`,
      [rma, pick.medusa_order_id, reasonLabel || 'Customer return', pick.customer_name, pick.customer_email, note || 'Asked for on the customer desk or the order', pickListId, key, outcome, detail?.ref || null, detail?.requestedBy || null]
    ));
    found = created.rows[0] ? created : await query(`SELECT id, desk_status FROM return_authorizations WHERE legacy_key = $1`, [key]);
  }
  const ra = found.rows[0];
  // A later request, or a request that was brought over earlier, fills in what the desk knows. A return that has arrived is left alone.
  if (ra && ra.desk_status === 'due_back') {
    await query(
      `UPDATE return_authorizations
          SET outcome = COALESCE($2, outcome),
              desk_ref = COALESCE($3, desk_ref),
              desk_requested_by = COALESCE($4, desk_requested_by),
              return_reason = CASE WHEN $5::text IS NOT NULL AND COALESCE(return_reason, 'Customer return') = 'Customer return' THEN $5 ELSE return_reason END,
              notes = CASE
                WHEN $6::text = '' THEN notes
                WHEN COALESCE(notes, '') = '' OR notes ~* '^(Asked for on the customer desk|Brought over|undefined)' OR notes ~ '^(CRM-[0-9]+): \\1: ' THEN $6
                WHEN position($6 in notes) > 0 THEN notes
                ELSE left(notes || E'\\n' || $6, 1500) END,
              updated_at = NOW()
        WHERE id = $1`,
      [ra.id, outcome, detail?.ref || null, detail?.requestedBy || null, reasonLabel, note]
    );
  }
  // A return that was already dealt with stays as it is. A new request after that is a new job, not a change to it.
  if (!ra || ra.desk_status === 'closed') return false;
  const line = await query(
    `SELECT COALESCE(quantity_required, 1) AS qty FROM pick_list_items
      WHERE pick_list_id = $1 AND product_sku = $2 AND NOT COALESCE(is_archived, false)
      ORDER BY line_number LIMIT 1`,
    [pickListId, sku]
  );
  // A kit comes back as its parts. Parts already on the return are left as they are.
  for (const part of await splitKitForReturn(sku, Number(line.rows[0]?.qty) || 1)) {
    const existing = await query(`SELECT id FROM return_items WHERE return_authorization_id = $1 AND product_sku = $2`, [ra.id, part.sku]);
    if (existing.rows[0]) continue;
    await query(`INSERT INTO return_items (return_authorization_id, product_sku, quantity_requested) VALUES ($1,$2,$3)`, [ra.id, part.sku, part.qty]);
  }
  return true;
}

/**
 * A request taken off the queue comes off the Returns screen too, but only while the goods have not arrived.
 * Once the return has been received or inspected, the warehouse owns it and it is left alone.
 */
export async function unmirrorRequest(pickListId: string, sku: string): Promise<void> {
  const key = mirrorKey(pickListId);
  const found = await query(`SELECT id, desk_status FROM return_authorizations WHERE legacy_key = $1`, [key]);
  const ra = found.rows[0];
  if (!ra || ra.desk_status !== 'due_back') return;
  const skus = (await splitKitForReturn(sku, 1)).map((part) => part.sku);
  await query(`DELETE FROM return_items WHERE return_authorization_id = $1 AND product_sku = ANY($2::text[]) AND item_condition IS NULL`, [ra.id, skus]);
  const left = await query(`SELECT COUNT(*)::int AS n FROM return_items WHERE return_authorization_id = $1`, [ra.id]);
  if (Number(left.rows[0].n) === 0) {
    await query(
      `UPDATE return_authorizations SET desk_status = 'closed', status = 'CANCELLED', notes = COALESCE(notes, '') || ' Request taken off the queue.', updated_at = NOW() WHERE id = $1`,
      [ra.id]
    );
  }
}

/**
 * A damage complaint on the customer desk puts a case on the Returns screen's Damage view before any return or refund exists,
 * so the damage is on record, with its photos, while the desk works out what to do. One case per desk enquiry, keyed on the enquiry id,
 * so sending it twice only returns the case that is already there. It starts at To decide.
 */
export async function createDamageComplaint(pickListId: string, complaint: { caseId: string; reason?: string; note?: string; ref?: string; requestedBy?: string }): Promise<{ rma: string; created: boolean } | null> {
  const caseId = String(complaint.caseId || '').trim().slice(0, 60);
  if (!pickListId || !caseId) return null;
  const order = await query(`SELECT id, medusa_order_id, customer_name, customer_email FROM pick_lists WHERE id = $1`, [pickListId]);
  const pick = order.rows[0];
  if (!pick || !pick.medusa_order_id) return null;
  const key = `desk-case:${caseId}`;
  const existing = await query(`SELECT rma_number FROM return_authorizations WHERE legacy_key = $1`, [key]);
  if (existing.rows[0]) return { rma: existing.rows[0].rma_number, created: false };
  const label = deskReasonLabel(complaint.reason) || 'Damaged';
  const note = deskNote({ ref: complaint.ref, note: complaint.note, requestedBy: complaint.requestedBy }) || 'Damage reported on the customer desk';
  const created = await withRmaNumber((rma) => query(
    `INSERT INTO return_authorizations
       (rma_number, medusa_order_id, status, redeem_to_warehouse, return_reason, customer_name, customer_email,
        notes, desk_status, how_back, hold_refund, pick_list_id, sold_stock_hold, legacy_key, desk_ref, desk_requested_by, desk_case_id, damage_reported_at)
     VALUES ($1,$2,'AUTHORIZED', false, $3,$4,$5,$6,'to_decide','kept', false,$7, false,$8,$9,$10,$11, NOW())
     ON CONFLICT (legacy_key) DO NOTHING
     RETURNING id, rma_number`,
    [rma, pick.medusa_order_id, label, pick.customer_name, pick.customer_email, note, pickListId, key, complaint.ref || null, complaint.requestedBy || null, caseId]
  ));
  if (created.rows[0]) {
    // The courier's delivery photo shows the box at the door: fetch it in the background so the case has it from the start.
    pullDeliveryProofLater(created.rows[0].id);
    return { rma: created.rows[0].rma_number, created: true };
  }
  const again = await query(`SELECT rma_number FROM return_authorizations WHERE legacy_key = $1`, [key]);
  return again.rows[0] ? { rma: again.rows[0].rma_number, created: false } : null;
}

const DAMAGE_REASONS: Record<string, string> = {
  damaged: 'Damaged',
  faulty: 'Faulty',
  wrong_item: 'Wrong item',
  missing_part: 'Missing part',
};

/**
 * A part refund for damage, where the customer keeps the goods, has no return behind it but still belongs on the Returns screen,
 * so damage claims and write-offs are decided in one place. The money has already gone, so the case starts at To decide
 * and closes once decided. One case per refund, keyed on the refund id.
 */
export async function mirrorDamageRefund(refund: { id: string; pick_list_id: string | null; reason: string; amount_gbp: string | number; note?: string | null; return_authorization_id?: string | null }): Promise<boolean> {
  const label = DAMAGE_REASONS[String(refund.reason)];
  if (!label || refund.return_authorization_id || !refund.pick_list_id) return false;
  const order = await query(`SELECT id, medusa_order_id, customer_name, customer_email FROM pick_lists WHERE id = $1`, [refund.pick_list_id]);
  const pick = order.rows[0];
  if (!pick || !pick.medusa_order_id) return false;
  const key = `refund:${refund.id}`;
  const note = `Part refund of £${Number(refund.amount_gbp).toFixed(2)} for ${label.toLowerCase()}, customer keeps the goods.${refund.note ? ' ' + String(refund.note) : ''}`.slice(0, 1000);
  const created = await withRmaNumber((rma) => query(
    `INSERT INTO return_authorizations
       (rma_number, medusa_order_id, status, redeem_to_warehouse, return_reason, customer_name, customer_email,
        notes, desk_status, how_back, hold_refund, pick_list_id, sold_stock_hold, legacy_key, refunded_at)
     VALUES ($1,$2,'REFUNDED', false, $3,$4,$5,$6,'to_decide','kept', false,$7, false,$8, NOW())
     ON CONFLICT (legacy_key) DO NOTHING
     RETURNING id`,
    [rma, pick.medusa_order_id, label, pick.customer_name, pick.customer_email, note, refund.pick_list_id, key]
  ));
  if (!created.rows[0]) return false;
  await query(`UPDATE order_refunds SET return_authorization_id = $2 WHERE id = $1 AND return_authorization_id IS NULL`, [refund.id, created.rows[0].id]);
  return true;
}
