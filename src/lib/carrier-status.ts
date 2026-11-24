/**
 * Where a booked parcel is with its carrier, for the customer desk.
 * Reads the booking (courier, service, collection day) and, for APC and DX, the carrier's own scans.
 * Read by the desk through POST /api/pick-lists/carrier-status.
 */
import { query } from '../db/index.js';
import { apcCustomerTracking, dxCustomerTracking } from './shipment-tracking.js';
import { apcScansFor, dxStatusesFor } from './carrier-progress.js';

export type CarrierStage = 'booked' | 'at_depot' | 'on_the_way' | 'out_for_delivery' | 'delivered' | 'unknown';

export interface CarrierStatus {
  courier: string;
  service: string | null;
  /** Collection day as booked (text, as stored). */
  collection: string | null;
  tracking_url: string | null;
  stage: CarrierStage;
  /** The carrier has scanned the parcel at a depot or later. */
  received_at_depot: boolean;
  delivered: boolean;
  last_event: string | null;
  events: string[];
  /** Why the scans could not be read, when they could not. */
  note: string | null;
}

const APC_DEPOT = new Set(['AT SENDING DEPOT', 'COLLECTED', 'AT HUB', 'DEPOT SORT SCAN', 'AT DELIVERY DEPOT', 'HELD AT DELIVERY DEPOT', 'OUT FOR DELIVERY', 'DELIVERED']);

/** Stage from a list of carrier scan descriptions, oldest or newest first. */
export function stageFromEvents(courier: string, events: string[]): { stage: CarrierStage; depot: boolean; delivered: boolean } {
  const text = events.map(event => event.replace(/\s+/g, ' ').trim().toUpperCase()).filter(Boolean);
  const any = (pattern: RegExp) => text.some(event => pattern.test(event));
  const delivered = any(/\bDELIVERED\b/) && !any(/NOT DELIVERED|UNDELIVERED/);
  const out = any(/OUT FOR DELIVERY|ONTO DELIVERY VEHICLE/);
  const onWay = courier === 'APC'
    ? text.some(event => ['AT HUB', 'DEPOT SORT SCAN', 'AT DELIVERY DEPOT', 'HELD AT DELIVERY DEPOT'].includes(event))
    : any(/SCAN AT (COLLECTION|DELIVERY) DEPOT/);
  const depot = delivered || out || onWay
    || (courier === 'APC' ? text.some(event => APC_DEPOT.has(event)) : any(/SCAN AT COLLECTION DEPOT/));
  const stage: CarrierStage = delivered ? 'delivered' : out ? 'out_for_delivery' : onWay ? 'on_the_way' : depot ? 'at_depot' : text.length ? 'booked' : 'unknown';
  return { stage, depot, delivered };
}

const CACHE_MS = 5 * 60_000;
const DONE_MS = 6 * 60 * 60_000;
const cache = new Map<string, { at: number; value: CarrierStatus | null }>();

interface BookingRow {
  pick_list_id: string;
  courier: string;
  service_name: string | null;
  collection_date: string | null;
  waybill: string | null;
  delivery_postcode: string | null;
  tracking_url: string | null;
}

async function read(row: BookingRow): Promise<CarrierStatus> {
  const courier = String(row.courier || '').toUpperCase();
  const waybill = String(row.waybill || '').trim();
  const postcode = String(row.delivery_postcode || '').trim();
  const link = courier === 'APC' ? apcCustomerTracking(waybill) : courier === 'DX' ? dxCustomerTracking(waybill, postcode) : null;
  const base: CarrierStatus = {
    courier,
    service: row.service_name || null,
    collection: row.collection_date || null,
    tracking_url: row.tracking_url || link?.url || null,
    stage: 'booked',
    received_at_depot: false,
    delivered: false,
    last_event: null,
    events: [],
    note: null,
  };
  if (courier !== 'APC' && courier !== 'DX') return { ...base, stage: 'unknown', note: `${courier || 'This courier'} has no tracking feed here` };
  try {
    const events = courier === 'APC'
      ? (await apcScansFor(waybill)).map(scan => scan.description)
      : await dxStatusesFor(waybill, postcode);
    if (!events.length) return { ...base, note: 'No scans yet' };
    const found = stageFromEvents(courier, events);
    return { ...base, stage: found.stage, received_at_depot: found.depot, delivered: found.delivered, events: events.slice(-8), last_event: events[events.length - 1] || null };
  } catch (error) {
    return { ...base, stage: 'unknown', note: error instanceof Error ? error.message : 'Carrier did not answer' };
  }
}

export async function loadCarrierStatus(ids: string[]): Promise<Record<string, CarrierStatus>> {
  const wanted = [...new Set(ids)].slice(0, 50);
  const result: Record<string, CarrierStatus> = {};
  const missing: string[] = [];
  const now = Date.now();
  for (const id of wanted) {
    const hit = cache.get(id);
    if (hit && now - hit.at < (hit.value?.delivered ? DONE_MS : CACHE_MS)) {
      if (hit.value) result[id] = hit.value;
    } else missing.push(id);
  }
  if (!missing.length) return result;
  const rows = await query(
    `SELECT DISTINCT ON (b.pick_list_id)
            b.pick_list_id, b.courier, b.service_name, b.collection_date, b.waybill, b.delivery_postcode, pl.tracking_url
     FROM collection_bookings b
     JOIN pick_lists pl ON pl.id = b.pick_list_id
     WHERE b.pick_list_id = ANY($1::uuid[]) AND b.status <> 'cancelled' AND COALESCE(b.direction, 'outbound') <> 'return'
     ORDER BY b.pick_list_id, b.created_at DESC`,
    [missing]
  );
  const byId = new Map<string, BookingRow>((rows.rows as BookingRow[]).map(row => [row.pick_list_id, row]));
  await Promise.all(missing.map(async id => {
    const row = byId.get(id);
    const value = row ? await read(row) : null;
    cache.set(id, { at: Date.now(), value });
    if (value) result[id] = value;
  }));
  return result;
}

export interface ReturnCollection extends CarrierStatus {
  sku: string;
  /** What the return is for: refund or replace. */
  outcome: string | null;
}

const returnCache = new Map<string, { at: number; value: ReturnCollection[] }>();

/** Collections booked to bring goods back from the customer. Same carrier scans as a delivery, read the other way round. */
export async function loadReturnCollections(ids: string[]): Promise<Record<string, ReturnCollection[]>> {
  const wanted = [...new Set(ids)].slice(0, 50);
  const result: Record<string, ReturnCollection[]> = {};
  const missing: string[] = [];
  const now = Date.now();
  for (const id of wanted) {
    const hit = returnCache.get(id);
    if (hit && now - hit.at < (hit.value.length && hit.value.every(row => row.delivered) ? DONE_MS : CACHE_MS)) {
      if (hit.value.length) result[id] = hit.value;
    } else missing.push(id);
  }
  if (!missing.length) return result;
  const rows = await query(
    `SELECT DISTINCT ON (b.pick_list_id, b.sku)
            b.pick_list_id, b.sku, b.outcome, b.courier, b.service_name, b.collection_date, b.waybill, b.delivery_postcode, NULL::text AS tracking_url
     FROM collection_bookings b
     WHERE b.pick_list_id = ANY($1::uuid[]) AND b.status <> 'cancelled' AND b.direction = 'return'
     ORDER BY b.pick_list_id, b.sku, b.created_at DESC`,
    [missing]
  );
  const grouped = new Map<string, (BookingRow & { sku: string; outcome: string | null })[]>();
  for (const row of rows.rows as (BookingRow & { sku: string; outcome: string | null })[]) {
    grouped.set(row.pick_list_id, [...(grouped.get(row.pick_list_id) || []), row]);
  }
  await Promise.all(missing.map(async id => {
    const value = await Promise.all((grouped.get(id) || []).map(async row => ({ ...(await read(row)), sku: row.sku, outcome: row.outcome || null })));
    returnCache.set(id, { at: Date.now(), value });
    if (value.length) result[id] = value;
  }));
  return result;
}
