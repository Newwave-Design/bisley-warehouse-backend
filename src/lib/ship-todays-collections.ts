import { query } from '../db/index.js';
import { takeStockForOpenCollections } from './collection-stock.js';
import { consumeOutstandingShipmentBoxes } from './packaging-usage.js';
import { fulfillPickListsInMedusa, syncCollectionOrdersToMedusa } from './medusa-fulfillment.js';
import { recordPickListEvents } from './pick-list-events.js';
import { rememberShipmentTracking } from './shipment-tracking.js';

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

/**
 * A collection ships on its own once its day has passed.
 * A collection booked for today stays on the status the desk or scanner set,
 * so booking it does not move the order to Shipped while it is still being packed.
 * A status set after the booking is left as it was set.
 */
export function collectionShipsAutomatically(
  collectionDate: string | null,
  today: string,
  personChoseStatusAfterBooking: boolean,
): boolean {
  if (personChoseStatusAfterBooking) return false;
  const day = collectionDay(collectionDate);
  return day !== '' && day < today;
}

/** Picked orders whose collection day has passed become shipped. */
export async function shipCollectionsDueToday(): Promise<string[]> {
  if (running) return [];
  running = true;
  try {
    await takeStockForOpenCollections().catch((error) => {
      console.warn('Removing booked collection stock failed', error instanceof Error ? error.message : 'failed');
    });
    await consumeOutstandingShipmentBoxes().catch((error) => {
      console.warn('Taking shipped box stock failed', error instanceof Error ? error.message : 'failed');
    });
    const today = londonToday();
    const found = await query(
      `SELECT pl.id, cb.collection_date,
              EXISTS (
                SELECT 1 FROM pick_list_events e
                WHERE e.pick_list_id = pl.id
                  AND e.action = 'status'
                  AND e.created_at >= cb.created_at
                  AND e.summary NOT IN ('Shipped — collection is today', 'Shipped — collection day has passed')
              ) AS chosen
       FROM pick_lists pl
       JOIN collection_bookings cb ON cb.pick_list_id = pl.id AND cb.status <> 'cancelled' AND COALESCE(cb.direction, 'outbound') <> 'return'
       WHERE pl.status = ANY($1::text[])
         AND NOT pl.is_archived`,
      [PICKED],
    );
    const ids = [...new Set(
      (found.rows as { id: string; collection_date: string | null; chosen: boolean }[])
        .filter((row) => collectionShipsAutomatically(row.collection_date, today, row.chosen))
        .map((row) => row.id),
    )];
    if (ids.length) {
      await query(
        `UPDATE pick_lists pl
         SET tracking_number = COALESCE(NULLIF(btrim(pl.tracking_number), ''), cb.waybill),
             carrier = cb.courier,
             updated_at = NOW()
         FROM (
           SELECT DISTINCT ON (pick_list_id) pick_list_id, waybill, courier
           FROM collection_bookings
           WHERE status <> 'cancelled' AND COALESCE(waybill, '') <> '' AND COALESCE(direction, 'outbound') <> 'return'
           ORDER BY pick_list_id, created_at DESC
         ) cb
         WHERE pl.id = cb.pick_list_id AND pl.id = ANY($1::uuid[])`,
        [ids],
      );
    }
    const tracking = await rememberShipmentTracking().catch((error) => {
      console.warn('[tracking] Saving shipment tracking failed', error instanceof Error ? error.message : 'failed');
      return { filled: 0, waiting: 0 };
    });
    if (tracking.filled || tracking.waiting) {
      console.log(`[tracking] Saved ${tracking.filled} shipment link(s), ${tracking.waiting} still waiting`);
    }
    await syncCollectionOrdersToMedusa().catch((error) => {
      console.warn('[medusa] Updating booked and shipped orders failed', error instanceof Error ? error.message : 'failed');
    });
    if (!ids.length) return [];
    await recordPickListEvents({
      ids,
      actor: 'system',
      action: 'status',
      summary: 'Shipped — collection day has passed',
      status: 'DISPATCHED',
    });
    await consumeOutstandingShipmentBoxes().catch((error) => {
      console.warn('Taking shipped box stock failed', error instanceof Error ? error.message : 'failed');
    });
    await fulfillPickListsInMedusa(ids);
    console.log(`[collections] Shipped ${ids.length} order(s) whose collection day has passed`);
    return ids;
  } finally {
    running = false;
  }
}
