import { query } from '../db/index.js';

const LEAVE_ALONE = ['PACKING', 'PACKED', 'LABEL_PRINTED', 'DISPATCHED', 'CANCELLED'];

/**
 * A scan or a picked line means the order is in Picking.
 * Refreshing the list must not put it back on To pick.
 * Packing, booked and shipped orders are left on the status they already have.
 */
export async function promotePickList(pickListId: string): Promise<{ allPicked: boolean }> {
  const current = await query(`SELECT status FROM pick_lists WHERE id = $1`, [pickListId]);
  const now = current.rows[0]?.status as string | undefined;
  const counts = await query(
    `SELECT
       COUNT(*) FILTER (WHERE NOT COALESCE(is_archived, false))::int AS lines,
       COUNT(*) FILTER (WHERE NOT COALESCE(is_archived, false) AND status = 'PICKED')::int AS picked,
       COUNT(*) FILTER (WHERE NOT COALESCE(is_archived, false) AND quantity_picked > 0)::int AS started,
       (SELECT COUNT(*)::int FROM pick_scans WHERE pick_list_id = $1) AS scans
     FROM pick_list_items
     WHERE pick_list_id = $1`,
    [pickListId],
  );
  const lines = Number(counts.rows[0]?.lines) || 0;
  const picked = Number(counts.rows[0]?.picked) || 0;
  const startedLines = Number(counts.rows[0]?.started) || 0;
  const scans = Number(counts.rows[0]?.scans) || 0;
  const allPicked = lines > 0 && picked === lines;
  const started = scans > 0 || startedLines > 0;
  if (!started || (now && LEAVE_ALONE.includes(now))) return { allPicked };

  let next = allPicked ? 'PICKED' : 'IN_PROGRESS';
  if (next === 'PICKED') {
    const booking = await query(
      `SELECT 1 FROM collection_bookings
        WHERE pick_list_id = $1 AND status <> 'cancelled' AND COALESCE(direction, 'outbound') <> 'return'
        LIMIT 1`,
      [pickListId],
    );
    if (booking.rows.length) next = 'LABEL_PRINTED';
  }
  if (next === now) return { allPicked };

  await query(
    `UPDATE pick_lists
        SET status = $1,
            completed_at = CASE WHEN $1 IN ('PICKED', 'LABEL_PRINTED') THEN COALESCE(completed_at, NOW()) ELSE completed_at END,
            label_printed_at = CASE WHEN $1 = 'LABEL_PRINTED' THEN COALESCE(label_printed_at, NOW()) ELSE label_printed_at END,
            updated_at = NOW()
      WHERE id = $2 AND status IN ('PENDING', 'IN_PROGRESS', 'PICKED')`,
    [next, pickListId],
  );
  return { allPicked };
}
