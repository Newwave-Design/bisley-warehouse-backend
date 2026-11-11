/**
 * Packaging re-order.
 * A pack is due when the stock on hand will not cover the 4 weeks it takes to arrive.
 * Weekly use comes from orders that have shipped. Intake is what was booked in.
 * Orders is what shipped orders have taken off so far. On hand is intake minus those orders.
 * Orders that have not shipped are counted separately, and only when their packaging has not already been taken off.
 */
import type { PoolClient } from 'pg';
import { query } from '../db/index.js';

type Sql = PoolClient | { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export const PACKAGING_LEAD_WEEKS = 4;

const CONTAINERS = new Set(['box', 'sleeve', 'tray']);
const SOLVED_METHODS = new Set(['own_box', 'pallet_wrap', 'pack_to_fit']);

export interface ReorderAdviceInput {
  stock: number;
  weekly: number;
  waiting: number;
}

export interface ReorderAdvice {
  weeksLeft: number | null;
  orderNow: boolean;
  orderQty: number;
  orderInDays: number | null;
}

/** How many to buy so today's count covers the lead time, or the orders still to ship. */
export function packagingReorder(input: ReorderAdviceInput, leadWeeks = PACKAGING_LEAD_WEEKS): ReorderAdvice {
  const stock = Number(input.stock) || 0;
  const weekly = Math.max(0, Number(input.weekly) || 0);
  const waiting = Math.max(0, Number(input.waiting) || 0);
  const cover = weekly * leadWeeks;
  const weeksLeft = weekly > 0 ? stock / weekly : null;
  const shortOfLead = weekly > 0 && stock <= cover;
  const shortOfWaiting = stock < waiting;
  const orderNow = shortOfLead || shortOfWaiting;
  const leadGap = Math.ceil(cover - stock);
  const waitingGap = Math.ceil(waiting - stock);
  return {
    weeksLeft,
    orderNow,
    orderQty: orderNow ? Math.max(0, leadGap, waitingGap) : 0,
    orderInDays: !orderNow && weeksLeft != null ? Math.max(0, Math.round((weeksLeft - leadWeeks) * 7)) : null,
  };
}

export function weeklyFromShipments(used: number, firstAt: Date, now: Date): number {
  const days = (now.getTime() - firstAt.getTime()) / 86_400_000;
  const weeks = Math.max(days / 7, 1);
  return Math.max(0, used) / weeks;
}

export function weeklyFromPlan(unitsPerMonth: number): number {
  if (!unitsPerMonth || unitsPerMonth <= 0) return 0;
  return unitsPerMonth / (52 / 12);
}

interface BomLine {
  type: string;
}

interface Bom {
  sku: string;
  productCode: string;
  method: string;
  lines: BomLine[];
}

function matchCode(sku: string, codes: { code: string }[]): string {
  let best = '';
  for (const row of codes) {
    const code = row.code;
    if (!code) continue;
    if ((sku === code || sku.startsWith(`${code}-`)) && code.length > best.length) best = code;
  }
  return best;
}

function matchBom(sku: string, boms: Bom[]): Bom | null {
  const exact = boms.find((bom) => bom.sku && bom.sku === sku);
  if (exact) return exact;
  let best: Bom | null = null;
  let length = -1;
  for (const bom of boms) {
    const code = bom.productCode;
    if (!code) continue;
    if ((sku === code || sku.startsWith(`${code}-`)) && code.length > length) {
      best = bom;
      length = code.length;
    }
  }
  return best;
}

/** A family has packaging when any part has a box, sleeve, tray, or a method that needs no bought pack. */
export function familyHasPackaging(skus: string[], hasSolution: (sku: string) => boolean): boolean {
  const list = skus.map((sku) => sku.trim().toUpperCase()).filter(Boolean);
  if (!list.length) return false;
  return list.some((sku) => hasSolution(sku));
}

const OPEN_PARTS = `
  WITH units AS (
    SELECT pl.id AS pick_list_id, pli.id AS item_id,
           upper(pli.product_sku) AS sold_sku,
           COALESCE(NULLIF(pli.item_title, ''), NULLIF(wp.product_title, ''), '') AS title,
           CASE WHEN pli.quantity_picked > 0 THEN pli.quantity_picked ELSE pli.quantity_required END AS line_qty,
           wp.is_kit, wp.kit_components
    FROM pick_lists pl
    JOIN pick_list_items pli ON pli.pick_list_id = pl.id
    LEFT JOIN LATERAL (
      SELECT is_kit, kit_components, product_title FROM wms_products
      WHERE variant_sku = pli.product_sku AND NOT is_archived
      LIMIT 1
    ) wp ON true
    WHERE pl.status NOT IN ('DISPATCHED', 'CANCELLED')
      AND NOT COALESCE(pl.is_sandbox, false)
      AND NOT COALESCE(pl.is_archived, false)
      AND NOT COALESCE(pl.is_return, false)
      AND NOT COALESCE(pli.is_archived, false)
      AND NOT COALESCE(pli.is_custom, false)
      AND upper(COALESCE(pli.product_sku, '')) <> ''
      AND upper(pli.product_sku) NOT LIKE '%SAMPLE%'
      AND CASE WHEN pli.quantity_picked > 0 THEN pli.quantity_picked ELSE pli.quantity_required END > 0
      AND NOT EXISTS (
        SELECT 1 FROM packaging_stock_movements m
        WHERE m.pick_list_id = pl.id
          AND m.movement_type = 'pack_usage'
          AND m.extra->>'source' = 'shipment'
      )
  ),
  parts AS (
    SELECT u.item_id, u.pick_list_id, u.sold_sku, u.title, u.line_qty AS sold_qty,
           upper(sd.component_sku) AS sku
    FROM units u
    JOIN sale_demand sd ON sd.pick_list_item_id = u.item_id AND NOT COALESCE(sd.is_custom, false)
    UNION ALL
    SELECT u.item_id, u.pick_list_id, u.sold_sku, u.title, u.line_qty, upper(comp.sku)
    FROM units u
    CROSS JOIN LATERAL jsonb_to_recordset(u.kit_components) AS comp(sku text, required_quantity numeric)
    WHERE COALESCE(u.is_kit, false)
      AND jsonb_typeof(u.kit_components) = 'array'
      AND jsonb_array_length(u.kit_components) > 0
      AND NOT EXISTS (
        SELECT 1 FROM sale_demand sd
        WHERE sd.pick_list_item_id = u.item_id AND NOT COALESCE(sd.is_custom, false)
      )
    UNION ALL
    SELECT u.item_id, u.pick_list_id, u.sold_sku, u.title, u.line_qty, u.sold_sku
    FROM units u
    WHERE NOT EXISTS (
      SELECT 1 FROM sale_demand sd
      WHERE sd.pick_list_item_id = u.item_id AND NOT COALESCE(sd.is_custom, false)
    )
      AND NOT (
        COALESCE(u.is_kit, false)
        AND jsonb_typeof(u.kit_components) = 'array'
        AND jsonb_array_length(u.kit_components) > 0
      )
  )
  SELECT item_id, pick_list_id, sold_sku, title, sold_qty::int AS sold_qty,
         json_agg(DISTINCT sku) AS skus
  FROM parts
  WHERE COALESCE(sku, '') <> '' AND sku NOT LIKE '%SAMPLE%'
  GROUP BY item_id, pick_list_id, sold_sku, title, sold_qty
`;

const WAITING = `
  WITH units AS (
    SELECT pli.id AS item_id,
           CASE WHEN pli.quantity_picked > 0 THEN pli.quantity_picked ELSE pli.quantity_required END AS line_qty,
           upper(pli.product_sku) AS product_sku, wp.is_kit, wp.kit_components
    FROM pick_lists pl
    JOIN pick_list_items pli ON pli.pick_list_id = pl.id
    LEFT JOIN LATERAL (
      SELECT is_kit, kit_components FROM wms_products
      WHERE variant_sku = pli.product_sku AND NOT is_archived
      LIMIT 1
    ) wp ON true
    WHERE pl.status NOT IN ('DISPATCHED', 'CANCELLED')
      AND NOT COALESCE(pl.is_sandbox, false)
      AND NOT COALESCE(pl.is_archived, false)
      AND NOT COALESCE(pl.is_return, false)
      AND NOT COALESCE(pli.is_archived, false)
      AND NOT COALESCE(pli.is_custom, false)
      AND upper(COALESCE(pli.product_sku, '')) NOT LIKE '%SAMPLE%'
      AND CASE WHEN pli.quantity_picked > 0 THEN pli.quantity_picked ELSE pli.quantity_required END > 0
      AND NOT EXISTS (
        SELECT 1 FROM packaging_stock_movements m
        WHERE m.pick_list_id = pl.id
          AND m.movement_type = 'pack_usage'
          AND m.extra->>'source' = 'shipment'
      )
  ),
  parts AS (
    SELECT upper(sd.component_sku) AS sku, (u.line_qty * sd.per_unit_qty)::numeric AS qty
    FROM units u
    JOIN sale_demand sd ON sd.pick_list_item_id = u.item_id AND NOT COALESCE(sd.is_custom, false)
    UNION ALL
    SELECT upper(comp.sku), (u.line_qty * COALESCE(comp.required_quantity, 1))::numeric
    FROM units u
    CROSS JOIN LATERAL jsonb_to_recordset(u.kit_components) AS comp(sku text, required_quantity numeric)
    WHERE COALESCE(u.is_kit, false)
      AND jsonb_typeof(u.kit_components) = 'array'
      AND jsonb_array_length(u.kit_components) > 0
      AND NOT EXISTS (
        SELECT 1 FROM sale_demand sd
        WHERE sd.pick_list_item_id = u.item_id AND NOT COALESCE(sd.is_custom, false)
      )
    UNION ALL
    SELECT u.product_sku, u.line_qty
    FROM units u
    WHERE NOT EXISTS (
      SELECT 1 FROM sale_demand sd
      WHERE sd.pick_list_item_id = u.item_id AND NOT COALESCE(sd.is_custom, false)
    )
      AND NOT (
        COALESCE(u.is_kit, false)
        AND jsonb_typeof(u.kit_components) = 'array'
        AND jsonb_array_length(u.kit_components) > 0
      )
  )
  SELECT i.id AS packaging_item_id, ROUND(SUM(p.qty * l.qty))::int AS qty
  FROM parts p
  JOIN LATERAL (
    SELECT b.id AS bom_id
    FROM packaging_boms b
    WHERE b.is_active AND b.option_rank = 1
      AND (
        upper(b.sku) = p.sku
        OR (b.sku IS NULL AND b.product_code IS NOT NULL AND (p.sku = upper(b.product_code) OR p.sku LIKE upper(b.product_code) || '-%'))
      )
    ORDER BY (b.sku IS NOT NULL) DESC, length(b.product_code) DESC NULLS LAST
    LIMIT 1
  ) chosen ON true
  JOIN packaging_bom_lines l ON l.bom_id = chosen.bom_id
  JOIN packaging_items i ON i.id = l.packaging_item_id AND i.is_active
  WHERE COALESCE(p.sku, '') <> ''
  GROUP BY i.id
`;

function addDays(now: Date, days: number): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
  return next.toISOString().slice(0, 10);
}

export async function loadPackagingReorder(db: Sql = { query }, now = new Date(), search = '') {
  const [items, usage, movements, waiting, boms, specs, families] = await Promise.all([
    db.query(
      `SELECT id, code, name, item_type, stock_on_hand, stocked,
              COALESCE(NULLIF(extra->>'units_month', ''), '0')::numeric AS units_month
       FROM packaging_items
       WHERE is_active`,
    ),
    db.query(
      `SELECT m.packaging_item_id AS id, SUM(-m.qty)::numeric AS used,
              MIN(pl.created_at) AS first_at
       FROM packaging_stock_movements m
       JOIN pick_lists pl ON pl.id = m.pick_list_id AND pl.status = 'DISPATCHED'
       WHERE m.movement_type = 'pack_usage' AND m.extra->>'source' = 'shipment'
       GROUP BY m.packaging_item_id`,
    ),
    db.query(
      `SELECT packaging_item_id AS id,
              COALESCE(SUM(qty) FILTER (WHERE movement_type = 'receipt'), 0)::int AS intake,
              COALESCE(SUM(-qty) FILTER (
                WHERE movement_type = 'pack_usage' AND extra->>'source' = 'shipment'
              ), 0)::int AS on_orders
       FROM packaging_stock_movements
       GROUP BY packaging_item_id`,
    ),
    db.query(WAITING),
    db.query(
      `SELECT upper(COALESCE(b.sku, '')) AS sku, upper(COALESCE(b.product_code, '')) AS product_code,
              lower(COALESCE(b.method, '')) AS method,
              COALESCE(json_agg(json_build_object('type', lower(i.item_type))) FILTER (WHERE i.id IS NOT NULL), '[]') AS lines
       FROM packaging_boms b
       LEFT JOIN packaging_bom_lines l ON l.bom_id = b.id
       LEFT JOIN packaging_items i ON i.id = l.packaging_item_id
       WHERE b.is_active AND b.option_rank = 1
       GROUP BY b.id`,
    ),
    db.query(
      `SELECT upper(product_code) AS product_code, lower(COALESCE(method, '')) AS method
       FROM packaging_product_specs WHERE is_active AND product_code IS NOT NULL`,
    ),
    db.query(OPEN_PARTS),
  ]);

  const usedById = new Map<string, { used: number; firstAt: Date | null }>();
  let earliest: Date | null = null;
  for (const row of usage.rows) {
    const firstAt = row.first_at ? new Date(row.first_at) : null;
    usedById.set(row.id, { used: Number(row.used) || 0, firstAt });
    if (firstAt && (!earliest || firstAt < earliest)) earliest = firstAt;
  }
  const movedById = new Map<string, { intake: number; onOrders: number }>();
  for (const row of movements.rows) {
    movedById.set(row.id, { intake: Number(row.intake) || 0, onOrders: Number(row.on_orders) || 0 });
  }
  const waitingById = new Map<string, number>();
  for (const row of waiting.rows) waitingById.set(row.packaging_item_id, Number(row.qty) || 0);

  const packs = [];
  for (const item of items.rows) {
    const used = usedById.get(item.id);
    const planned = weeklyFromPlan(Number(item.units_month) || 0);
    const shippedWeekly = used && earliest ? weeklyFromShipments(used.used, earliest, now) : 0;
    const weekly = shippedWeekly > 0 ? shippedWeekly : planned;
    const advice = packagingReorder({
      stock: Number(item.stock_on_hand) || 0,
      weekly,
      waiting: waitingById.get(item.id) || 0,
    });
    const stock = Number(item.stock_on_hand) || 0;
    const moved = movedById.get(item.id) || { intake: 0, onOrders: 0 };
    const waitingQty = waitingById.get(item.id) || 0;
    const tracked = ['box', 'sleeve', 'tray', 'foam'].includes(String(item.item_type || ''));
    if (!tracked && !(used && used.used > 0)) continue;
    if (item.stocked === false && !(used && used.used > 0) && waitingQty === 0) continue;
    if (stock === 0 && weekly === 0 && waitingQty === 0) continue;
    packs.push({
      code: item.code,
      name: item.name || item.code,
      item_type: item.item_type,
      intake: moved.intake,
      on_orders: moved.onOrders,
      stock_on_hand: stock,
      per_week: Math.round(weekly * 10) / 10,
      rate_from: shippedWeekly > 0 ? 'shipped' : planned > 0 ? 'planned' : 'none',
      weeks_left: advice.weeksLeft == null ? null : Math.round(advice.weeksLeft * 10) / 10,
      waiting: waitingQty,
      order_qty: advice.orderQty,
      order_now: advice.orderNow,
      order_by: advice.orderInDays == null ? null : addDays(now, advice.orderInDays),
    });
  }
  const needle = search.trim().toLowerCase();
  const visible = packs.filter((row) => !needle || `${row.code} ${row.name} ${row.item_type}`.toLowerCase().includes(needle));
  visible.sort((a, b) => Number(b.order_now) - Number(a.order_now) || (a.weeks_left ?? 999) - (b.weeks_left ?? 999) || String(a.code).localeCompare(String(b.code)));

  const catalogue: Bom[] = boms.rows.map((row) => ({
    sku: String(row.sku || ''),
    productCode: String(row.product_code || ''),
    method: String(row.method || ''),
    lines: Array.isArray(row.lines) ? row.lines : [],
  }));
  const specMethods = new Map<string, string>();
  const specCodes: { code: string }[] = [];
  for (const row of specs.rows) {
    const code = String(row.product_code || '');
    if (!code || specMethods.has(code)) continue;
    specMethods.set(code, String(row.method || ''));
    specCodes.push({ code });
  }
  const hasSolution = (sku: string) => {
    const bom = matchBom(sku, catalogue);
    if (bom?.lines.some((line) => CONTAINERS.has(String(line.type || '')))) return true;
    const method = bom?.method || specMethods.get(matchCode(sku, specCodes)) || '';
    return SOLVED_METHODS.has(method);
  };

  const missing = new Map<string, { product_code: string; title: string; qty: number; orders: Set<string> }>();
  for (const row of families.rows) {
    const skus = (Array.isArray(row.skus) ? row.skus : []).map((sku: unknown) => String(sku || '').toUpperCase());
    if (familyHasPackaging(skus.length ? skus : [row.sold_sku], hasSolution)) continue;
    const code = matchCode(String(row.sold_sku || ''), specCodes) || String(row.sold_sku || '');
    const current = missing.get(code);
    const qty = Number(row.sold_qty) || 0;
    if (!current) missing.set(code, { product_code: code, title: String(row.title || code), qty, orders: new Set([row.pick_list_id]) });
    else {
      current.qty += qty;
      current.orders.add(row.pick_list_id);
      if (!current.title && row.title) current.title = String(row.title);
    }
  }
  const unpackaged = [...missing.values()]
    .map((row) => ({ product_code: row.product_code, title: row.title, qty: row.qty, orders: row.orders.size }))
    .filter((row) => !needle || `${row.product_code} ${row.title}`.toLowerCase().includes(needle))
    .sort((a, b) => b.orders - a.orders || b.qty - a.qty || a.product_code.localeCompare(b.product_code));

  return {
    lead_weeks: PACKAGING_LEAD_WEEKS,
    since: earliest ? earliest.toISOString().slice(0, 10) : null,
    due: visible.filter((row) => row.order_now),
    covered: visible.filter((row) => !row.order_now),
    unpackaged,
  };
}
