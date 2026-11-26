/**
 * One hand-off from the customer desk: everything the desk knows about an enquiry, keyed on the enquiry id.
 * Sending it again updates the same case. The desk reads the case back to show where it stands in the warehouse.
 *
 * A damage complaint with no case yet becomes a damage case. A return or refund links to the case the order already has
 * (the return request or the refund makes that case); if there is none yet, nothing is made and the desk is told so.
 */
import { query } from '../db/index.js';
import { createDamageComplaint, deskNote, deskReasonLabel } from './return-desk-mirror.js';
import { isWants, suggestFault, evidenceChecklist } from './return-fault.js';
import { returnKind } from './return-kind.js';

export interface DeskCaseInput {
  pickListId: string;
  kind: 'damage' | 'return' | 'refund';
  reason?: string;
  note?: string;
  ref?: string;
  requestedBy?: string;
  wants?: string;
  reportedAt?: string;
}

export class DeskCaseError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const STATUS_WORDS: Record<string, string> = {
  due_back: 'Due back', to_inspect: 'To inspect', to_decide: 'To decide', to_refund: 'To refund', claim: 'Claim', closed: 'Closed',
};

async function findCase(caseId: string, pickListId?: string) {
  const byCase = await query(`SELECT * FROM return_authorizations WHERE desk_case_id = $1 OR legacy_key = $2 ORDER BY created_at DESC LIMIT 1`, [caseId, `desk-case:${caseId}`]);
  if (byCase.rows[0] || !pickListId) return byCase.rows[0] || null;
  const open = await query(
    `SELECT * FROM return_authorizations
      WHERE pick_list_id = $1 AND COALESCE(desk_status, 'due_back') <> 'closed' AND (desk_case_id IS NULL OR desk_case_id = $2)
      ORDER BY created_at DESC LIMIT 1`,
    [pickListId, caseId]
  );
  return open.rows[0] || null;
}

function validDate(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function upsertDeskCase(caseId: string, input: DeskCaseInput) {
  const id = String(caseId || '').trim().slice(0, 60);
  if (!id) throw new DeskCaseError(400, 'The enquiry id is missing.');
  if (!input.pickListId) throw new DeskCaseError(400, 'pick_list_id is required.');
  if (!['damage', 'return', 'refund'].includes(input.kind)) throw new DeskCaseError(400, 'kind must be damage, return or refund.');
  const order = await query(`SELECT id FROM pick_lists WHERE id = $1`, [input.pickListId]);
  if (!order.rows[0]) throw new DeskCaseError(404, 'Order not found in the warehouse.');

  let ra = await findCase(id, input.pickListId);
  if (!ra && input.kind === 'damage') {
    await createDamageComplaint(input.pickListId, { caseId: id, reason: input.reason, note: input.note, ref: input.ref, requestedBy: input.requestedBy });
    ra = await findCase(id, input.pickListId);
  }
  if (!ra) return { linked: false as const, message: 'No return or damage case on this order yet. The return request or refund will make one.' };

  const label = deskReasonLabel(input.reason);
  const note = deskNote({ ref: input.ref, note: input.note, requestedBy: input.requestedBy });
  await query(
    `UPDATE return_authorizations
        SET desk_case_id = COALESCE(desk_case_id, $2),
            desk_ref = COALESCE($3, desk_ref),
            desk_requested_by = COALESCE($4, desk_requested_by),
            customer_wants = COALESCE($5, customer_wants),
            damage_reported_at = COALESCE(damage_reported_at, $6::timestamp),
            return_reason = CASE WHEN $7::text IS NOT NULL AND COALESCE(return_reason, 'Customer return') IN ('Customer return', 'Other') THEN $7 ELSE return_reason END,
            notes = CASE
              WHEN $8::text = '' THEN notes
              WHEN COALESCE(notes, '') = '' OR notes ~* '^(Asked for on the customer desk|Brought over|undefined|Damage reported on the customer desk)' THEN $8
              WHEN position($8 in notes) > 0 THEN notes
              ELSE left(notes || E'\\n' || $8, 1500) END,
            updated_at = NOW()
      WHERE id = $1`,
    [ra.id, id, input.ref || null, input.requestedBy || null, isWants(input.wants) ? input.wants : null, validDate(input.reportedAt), label, note]
  );
  return { linked: true as const, ...(await deskCaseStatus(id)) };
}

/** Where the case stands, for the desk: status, fault, claims and photos. */
export async function deskCaseStatus(caseId: string) {
  const ra = await findCase(String(caseId || '').trim());
  if (!ra) return { found: false as const };
  const claims = await query(`SELECT id, kind, COALESCE(status, 'open') AS status, created_at, updated_at FROM return_claims WHERE return_authorization_id = $1 ORDER BY created_at`, [ra.id]);
  const photos = await query(`SELECT COALESCE(photo_kind, 'item') AS kind FROM return_desk_photos WHERE return_authorization_id = $1`, [ra.id]);
  const items = await query(`SELECT item_condition FROM return_items WHERE return_authorization_id = $1`, [ra.id]);
  const kinds = photos.rows.map((row: { kind: string }) => row.kind);
  return {
    found: true as const,
    id: ra.id,
    rma: ra.rma_number,
    kind: returnKind({ ...ra, items: items.rows }),
    status: ra.desk_status || 'due_back',
    status_label: STATUS_WORDS[ra.desk_status || 'due_back'] || 'Open',
    reason: ra.return_reason,
    outcome: ra.outcome || null,
    customer_wants: ra.customer_wants || null,
    fault: ra.fault || null,
    fault_note: ra.fault_note || null,
    fault_hint: ra.fault ? null : suggestFault({ reason: ra.return_reason, courier_problem: ra.courier_problem, notes: ra.notes }),
    claims: claims.rows,
    photos: photos.rows.length,
    evidence: evidenceChecklist({ photoKinds: kinds, reportedAt: ra.damage_reported_at, tracking: ra.tracking_number, fault: ra.fault }),
    refunded: !!ra.refunded_at,
    delivered_at: ra.delivered_at || null,
    delivered_signed_by: ra.delivered_signed_by || null,
    updated_at: ra.updated_at,
  };
}
