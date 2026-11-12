import { query } from '../db/index.js';

export const PICK_LIST_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'PICKED',
  'PACKING',
  'PACKED',
  'LABEL_PRINTED',
  'AWAITING_STOCK',
  'DISPATCHED',
  'CANCELLED',
] as const;

export type PickListStatus = (typeof PICK_LIST_STATUSES)[number];

export function actorName(user?: { email?: string; id?: string } | null): string {
  return user?.email || user?.id || 'unknown';
}

/** An outbound collection is a shipment. The order leaves To pick, Picking and Picked. */
export async function shipBookedPickList(pickListId: string, actor: string): Promise<void> {
  const current = await query(`SELECT status FROM pick_lists WHERE id = $1`, [pickListId]);
  const status = current.rows[0]?.status as string | undefined;
  if (!status || status === 'DISPATCHED' || status === 'CANCELLED') return;
  await recordPickListEvents({
    ids: [pickListId],
    actor,
    action: 'status',
    summary: 'Shipped — collection booked',
    status: 'DISPATCHED',
  });
}

export async function recordPickListEvents(input: {
  ids: string[];
  actor: string;
  action: string;
  summary: string;
  status?: PickListStatus;
}) {
  const ids = [...new Set(input.ids.filter(Boolean))];
  if (!ids.length) return;

  const sets = [
    'last_event_at = NOW()',
    'last_event_by = $2',
    'last_event_summary = $3',
    'updated_at = NOW()',
  ];
  const params: any[] = [ids, input.actor, input.summary];
  if (input.status) {
    sets.push(`status = $4`);
    params.push(input.status);
    if (input.status === 'LABEL_PRINTED') sets.push('label_printed_at = COALESCE(label_printed_at, NOW())');
    if (input.status === 'DISPATCHED') sets.push('dispatched_at = COALESCE(dispatched_at, NOW())');
  }

  await query(`UPDATE pick_lists SET ${sets.join(', ')} WHERE id = ANY($1::uuid[])`, params);
  await query(
    `INSERT INTO pick_list_events (pick_list_id, actor, action, summary)
     SELECT id, $2, $3, $4 FROM unnest($1::uuid[]) AS id`,
    [ids, input.actor, input.action, input.summary],
  );
}

/** A cancelled collection is not a shipment. Move the order back to Picked when nothing is still booked. */
export async function reopenDispatchedPickList(pickListId: string, actor: string): Promise<boolean> {
  const open = await query(
    `SELECT 1 FROM collection_bookings
      WHERE pick_list_id = $1
        AND status <> 'cancelled'
        AND COALESCE(direction, 'outbound') <> 'return'
      LIMIT 1`,
    [pickListId],
  );
  if (open.rows.length) return false;
  const updated = await query(
    `UPDATE pick_lists SET dispatched_at = NULL WHERE id = $1 AND status = 'DISPATCHED' RETURNING id`,
    [pickListId],
  );
  if (!updated.rows.length) return false;
  await recordPickListEvents({
    ids: [pickListId],
    actor,
    action: 'status',
    summary: 'Collection cancelled — back to picked',
    status: 'PICKED',
  });
  return true;
}
