import { query } from '../db/index.js';
import { fulfillPickListsInMedusa } from './medusa-fulfillment.js';
import { recordPickListEvents } from './pick-list-events.js';

const PICKED = ['PICKED', 'PACKING', 'PACKED', 'LABEL_PRINTED'];

function londonToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function collectionDay(raw: string | null): string {
  const value = String(raw || '').trim();
  const slash = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (slash) {
    const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
    return `${year}-${slash[2].padStart(2, '0')}-${slash[1].padStart(2, '0')}`;
  }
  const iso = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : '';
}

let running = false;

/** Picked orders whose APC collection day is today (or already past) become shipped. */
export async function shipCollectionsDueToday(): Promise<string[]> {
  if (running) return [];
  running = true;
  try {
    const today = londonToday();
    const found = await query(
      `SELECT pl.id, cb.collection_date
       FROM pick_lists pl
       JOIN collection_bookings cb ON cb.pick_list_id = pl.id AND cb.status <> 'cancelled'
       WHERE pl.status = ANY($1::text[])
         AND NOT pl.is_archived`,
      [PICKED],
    );
    const ids = [...new Set(
      (found.rows as { id: string; collection_date: string | null }[])
        .filter((row) => {
          const day = collectionDay(row.collection_date);
          return day !== '' && day <= today;
        })
        .map((row) => row.id),
    )];
    if (!ids.length) return [];
    await query(
      `UPDATE pick_lists pl
       SET tracking_number = cb.waybill, carrier = 'APC', updated_at = NOW()
       FROM (
         SELECT DISTINCT ON (pick_list_id) pick_list_id, waybill
         FROM collection_bookings
         WHERE status <> 'cancelled' AND COALESCE(waybill, '') <> ''
         ORDER BY pick_list_id, created_at DESC
       ) cb
       WHERE pl.id = cb.pick_list_id AND pl.id = ANY($1::uuid[])`,
      [ids],
    );
    await recordPickListEvents({
      ids,
      actor: 'system',
      action: 'status',
      summary: 'Shipped — collection is today',
      status: 'DISPATCHED',
    });
    await fulfillPickListsInMedusa(ids);
    console.log(`[collections] Shipped ${ids.length} order(s) booked for collection today`);
    return ids;
  } finally {
    running = false;
  }
}
