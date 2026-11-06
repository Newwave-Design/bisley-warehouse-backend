/**
 * Delivery due window per pick list, counted from the order date.
 *   Stock assigned  2-4 weeks from 9 Oct 2026, matching the shop. Orders before that day were promised 4-6 weeks.
 *   Nothing assigned  the shop's out-of-stock promise: palette 1 colours 4-6 weeks, every other colour 6-8 weeks.
 * A list with several short lines uses the longest of those windows.
 * Traffic light: green = more than 3 days before the last date, amber = within 3 days of it, red = after it (late).
 * Finished lists get no light.
 */
import { query } from '../db/index.js';
import { extractColourCode } from './colour-names.js';
import { ensureStockHolds, kitParts } from './stock-holds.js';

export const STANDARD_WEEKS = { min: 2, max: 4 };
/** In-stock promise on orders placed before 9 Oct 2026. */
export const STANDARD_WEEKS_BEFORE = { min: 4, max: 6 };
const STOCKED_PROMISE_CHANGE = Date.UTC(2026, 9, 9);
/** Shop backorder copy. Palette 1 is the shorter batch; anything else uses palette 2. */
export const PALETTE_1_WEEKS = { min: 4, max: 6 };
export const PALETTE_2_WEEKS = { min: 6, max: 8 };
const PALETTE_1 = new Set([
  'ba5', 'ab9', 'av6', 'cj6', 'av5', 'ag8', 'bx6', 'ay7',
  'an7', 'bc6', 'av7', 'av4', 'arn', 'an9', 'aa3', 'av1', 'ay8',
]);

/** In-stock window for an order placed on this UTC day. */
export function stockedWeeks(orderDay: number): { min: number; max: number } {
  return orderDay < STOCKED_PROMISE_CHANGE ? STANDARD_WEEKS_BEFORE : STANDARD_WEEKS;
}

const FINISHED_STATUSES = new Set(['DISPATCHED', 'CANCELLED']);
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DeliveryDue {
  basis: 'standard' | 'non_standard';
  weeks_min: number;
  weeks_max: number;
  /** YYYY-MM-DD */
  earliest: string;
  latest: string;
  light: 'green' | 'amber' | 'red' | null;
  reasons: string[];
  /** Every remaining line has stock assigned to this order. Samples are ignored. */
  in_stock: boolean;
}

type Weeks = { min: number; max: number };

/** Out-of-stock window the shop shows for this SKU's colour. */
export function backorderWeeks(sku: string): Weeks {
  const code = extractColourCode(sku);
  return code && PALETTE_1.has(code) ? PALETTE_1_WEEKS : PALETTE_2_WEEKS;
}

function longer(a: Weeks, b: Weeks): Weeks {
  if (a.max !== b.max) return a.max > b.max ? a : b;
  return a.min >= b.min ? a : b;
}

const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const londonDay = (d: Date) => {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d).split('-').map(Number);
  return Date.UTC(year, month - 1, day);
};
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Orange on the last date and the 3 days before it. Red once that date has passed. */
export function dueLight(today: number, latest: number): 'green' | 'amber' | 'red' {
  const daysToLatest = Math.round((latest - today) / DAY_MS);
  if (daysToLatest < 0) return 'red';
  if (daysToLatest <= 3) return 'amber';
  return 'green';
}

export async function getDeliveryDues(pickListIds: string[]): Promise<Record<string, DeliveryDue>> {
  const out: Record<string, DeliveryDue> = {};
  if (pickListIds.length === 0) return out;

  // Split-off lists inherit the original order date, not the split date
  const lists = await query(
    `SELECT pl.id, pl.status, COALESCE(parent.created_at, pl.created_at) AS order_date
       FROM pick_lists pl LEFT JOIN pick_lists parent ON parent.id = pl.parent_pick_list_id
      WHERE pl.id = ANY($1::uuid[])`,
    [pickListIds]
  );
  await ensureStockHolds();
  const items = await query(
    `SELECT pli.id, pli.pick_list_id, pli.product_sku, pli.quantity_required,
            pli.quantity_required - COALESCE(pli.quantity_picked, 0) AS remaining,
            wp.kit_components
       FROM pick_list_items pli
       LEFT JOIN LATERAL (SELECT kit_components FROM wms_products WHERE variant_sku = pli.product_sku LIMIT 1) wp ON true
      WHERE pli.pick_list_id = ANY($1::uuid[]) AND pli.is_archived = false`,
    [pickListIds]
  );
  const holds = new Map<string, Map<string, number>>();
  const itemIds = items.rows.map((row: any) => row.id);
  if (itemIds.length) {
    const held = await query(
      `SELECT pick_list_item_id, sku, qty FROM order_stock_holds WHERE pick_list_item_id = ANY($1::uuid[])`,
      [itemIds]
    );
    for (const row of held.rows) {
      if (!holds.has(row.pick_list_item_id)) holds.set(row.pick_list_item_id, new Map());
      holds.get(row.pick_list_item_id)!.set(row.sku, Number(row.qty) || 0);
    }
  }

  const itemsByList = new Map<string, any[]>();
  for (const it of items.rows) {
    if (!itemsByList.has(it.pick_list_id)) itemsByList.set(it.pick_list_id, []);
    itemsByList.get(it.pick_list_id)!.push(it);
  }

  const today = utcDay(new Date());
  for (const pl of lists.rows) {
    const reasons: string[] = [];
    let inStock = true;
    let shortWindow: Weeks | null = null;
    const note = (msg: string) => { if (!reasons.includes(msg)) reasons.push(msg); };

    for (const it of itemsByList.get(pl.id) ?? []) {
      if (/SAMPLE/i.test(it.product_sku)) continue;
      if (Number(it.remaining) <= 0) continue;
      const parts = kitParts(it.product_sku, it.kit_components);
      const assigned = holds.get(it.id) ?? new Map<string, number>();
      const required = Number(it.quantity_required) || 0;
      const shortSkus = parts.length
        ? parts.filter((part) => (assigned.get(part.sku) ?? 0) < part.per * required).map((part) => part.sku)
        : ((assigned.get(it.product_sku) ?? 0) < required ? [it.product_sku] : []);
      if (!shortSkus.length) continue;
      inStock = false;
      let lineWindow = backorderWeeks(shortSkus[0]);
      for (const sku of shortSkus) lineWindow = longer(lineWindow, backorderWeeks(sku));
      shortWindow = shortWindow ? longer(shortWindow, lineWindow) : lineWindow;
      const got = parts.length
        ? Math.min(...parts.map((part) => Math.floor((assigned.get(part.sku) ?? 0) / part.per)))
        : (assigned.get(it.product_sku) ?? 0);
      note(got > 0
        ? `Only ${got} of ${required} assigned: ${it.product_sku} (${lineWindow.min}-${lineWindow.max} weeks)`
        : `No stock assigned: ${it.product_sku} (${lineWindow.min}-${lineWindow.max} weeks)`);
    }

    const standard = shortWindow === null;
    const orderDay = utcDay(new Date(pl.order_date));
    const weeks = shortWindow ?? stockedWeeks(londonDay(new Date(pl.order_date)));
    const start = orderDay + weeks.min * 7 * DAY_MS;
    const end = orderDay + weeks.max * 7 * DAY_MS;
    const light = FINISHED_STATUSES.has(pl.status) ? null : dueLight(today, end);

    out[pl.id] = {
      basis: standard ? 'standard' : 'non_standard',
      weeks_min: weeks.min,
      weeks_max: weeks.max,
      earliest: iso(start),
      latest: iso(end),
      light,
      reasons,
      in_stock: inStock,
    };
  }
  return out;
}
