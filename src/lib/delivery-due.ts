/**
 * Delivery due window per pick list, counted from the order date.
 *   Standard      3-6 weeks: every coloured line (and kit part) is an approved colour AND in stock.
 *   Non-standard  4-8 weeks: any line in a non-approved colour, or short of stock.
 * Traffic light: green = before the window, amber = inside it, red = after it. Finished lists get no light.
 * Stock is read live from warehouse_inventory, so a list moves bracket as stock arrives or runs out.
 */
import { query } from '../db/index.js';
import { COLOUR_NAMES, extractColourCode } from './colour-names.js';

export const STANDARD_WEEKS = { min: 3, max: 6 };
export const NON_STANDARD_WEEKS = { min: 4, max: 8 };

/** Approved colours (storefront list) plus the desktop finishes; Emerald (da8) is special-order only. */
const APPROVED_COLOUR_CODES = new Set([
  'bx6', 'ag8', 'av1', 'cj6', 'bc6', 'ba5', 'ab9', 'bn6', 'cb2', 'aa3', 'cd1', 'bz2', 'av4',
  '001', '018', '562', '998',
]);

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
}

/** Null when the SKU carries no colour (nothing to approve). */
function colourOf(sku: string): string | null {
  const code = extractColourCode(sku);
  if (code) return code;
  const finish = /-(\d{3})$/.exec(sku)?.[1];
  return finish && APPROVED_COLOUR_CODES.has(finish) ? finish : null;
}

const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

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
  const items = await query(
    `SELECT pli.pick_list_id, pli.product_sku, pli.quantity_required - COALESCE(pli.quantity_picked, 0) AS remaining,
            wp.kit_components,
            COALESCE((SELECT SUM(quantity) FROM warehouse_inventory WHERE product_sku = pli.product_sku), 0)::int AS stock
       FROM pick_list_items pli
       LEFT JOIN LATERAL (SELECT kit_components FROM wms_products WHERE variant_sku = pli.product_sku LIMIT 1) wp ON true
      WHERE pli.pick_list_id = ANY($1::uuid[]) AND pli.is_archived = false`,
    [pickListIds]
  );

  const componentSkus = new Set<string>();
  for (const it of items.rows) {
    for (const c of kitParts(it)) componentSkus.add(c.sku);
  }
  const componentStock = new Map<string, number>();
  if (componentSkus.size > 0) {
    const r = await query(
      `SELECT product_sku, COALESCE(SUM(quantity), 0)::int AS qty FROM warehouse_inventory WHERE product_sku = ANY($1::text[]) GROUP BY product_sku`,
      [[...componentSkus]]
    );
    for (const row of r.rows) componentStock.set(row.product_sku, row.qty);
  }

  const itemsByList = new Map<string, any[]>();
  for (const it of items.rows) {
    if (!itemsByList.has(it.pick_list_id)) itemsByList.set(it.pick_list_id, []);
    itemsByList.get(it.pick_list_id)!.push(it);
  }

  const today = utcDay(new Date());
  for (const pl of lists.rows) {
    const reasons: string[] = [];
    const note = (msg: string) => { if (!reasons.includes(msg)) reasons.push(msg); };

    for (const it of itemsByList.get(pl.id) ?? []) {
      if (/SAMPLE/i.test(it.product_sku)) continue; // colour samples don't hold up delivery
      const parts = kitParts(it);
      const skus = parts.length > 0 ? [it.product_sku, ...parts.map(p => p.sku)] : [it.product_sku];

      for (const sku of skus) {
        const code = colourOf(sku);
        if (code && !APPROVED_COLOUR_CODES.has(code)) note(`Non-approved colour: ${COLOUR_NAMES[code] ?? code} (${sku})`);
      }

      const remaining = Number(it.remaining);
      if (remaining > 0) {
        const short = parts.length > 0
          ? parts.some(p => (componentStock.get(p.sku) ?? 0) < p.required_quantity * remaining)
          : it.stock < remaining;
        if (short) note(`Not fully in stock: ${it.product_sku}`);
      }
    }

    const standard = reasons.length === 0;
    const weeks = standard ? STANDARD_WEEKS : NON_STANDARD_WEEKS;
    const orderDay = utcDay(new Date(pl.order_date));
    const start = orderDay + weeks.min * 7 * DAY_MS;
    const end = orderDay + weeks.max * 7 * DAY_MS;
    const light = FINISHED_STATUSES.has(pl.status) ? null : today < start ? 'green' : today <= end ? 'amber' : 'red';

    out[pl.id] = {
      basis: standard ? 'standard' : 'non_standard',
      weeks_min: weeks.min,
      weeks_max: weeks.max,
      earliest: iso(start),
      latest: iso(end),
      light,
      reasons,
    };
  }
  return out;
}

/** Kit parts only when there is more than the item itself. */
function kitParts(item: any): { sku: string; required_quantity: number }[] {
  const parts = Array.isArray(item.kit_components) ? item.kit_components : [];
  if (parts.length === 0 || (parts.length === 1 && parts[0].sku === item.product_sku)) return [];
  return parts.map((p: any) => ({ sku: String(p.sku), required_quantity: Number(p.required_quantity) || 1 }));
}
