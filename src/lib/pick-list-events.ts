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
