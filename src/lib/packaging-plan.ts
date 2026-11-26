/**
 * Packaging plan: which boxes, sleeves and trays open orders still need, what is on the shelf and on order,
 * how many to buy, and which orders each pack unlocks.
 *
 * Open paid orders are served oldest first. Each takes what is on the shelf, then what is on order, and
 * whatever is left is the quantity still to buy. An order that is short of a pack is blocked by it.
 * Read only. Uses the packaging each order's lines already carry (preferred carton first).
 */
import { query } from '../db/index.js';
import { isPaid } from './payment-status.js';
import { getDeliveryDues } from './delivery-due.js';
import { ensureStockHolds, kitParts, lineCovered } from './stock-holds.js';
import { attachPackaging } from './pick-list-packaging.js';
import { packNeeds, type HoldupOrder } from './order-holdup.js';

export type PackKind = 'box' | 'tray' | 'sleeve';

export interface PlanNeed { code: string; name: string; kind: PackKind; qty: number }

/** A sleeve and its matching tray. Together they are one box, so they are bought and counted as one set. */
export interface PlanPair { sleeve: { code: string; name: string }; tray: { code: string; name: string }; qty: number }

export interface PlanOrderIn {
  id: string;
  number: string;
  orderedAt: number;
  /** Latest promised delivery day, YYYY-MM-DD. */
  due: string | null;
  /** Every line still to pick has its product assigned. */
  inStock: boolean;
  needs: PlanNeed[];
  /** Sleeve and tray pairs on this order. These are not repeated in `needs`. */
  pairs?: PlanPair[];
  /** SKUs on this order with no packaging defined at all. */
  undefinedSkus: string[];
}

export interface PlanStockIn {
  code: string;
  name: string;
  kind: PackKind;
  onHand: number;
  /** SmartSuite note "Merge into Box-19": what this pack is short, the target supplies. */
  mergeInto?: string | null;
  /** Run down: use up what is left and stop buying this pack. */
  runDown?: boolean;
  unitCost?: number | null;
  /** Outer size as SmartSuite writes it, or the internal size when that is all there is. */
  size?: string | null;
  /** When the WMS copy of this pack was last refreshed. */
  sizeUpdated?: string | null;
}
export interface OnOrderIn { code: string; qty: number; dueOn: string | null }
export interface Horizon { label: string; date: string }

export interface PlanOrderRef {
  number: string;
  due: string | null;
  qty: number;
  covered: 'shelf' | 'on_order' | 'to_order';
  /** The pack the order really asked for, when this pack is standing in for it (BOX-18 taken from BOX-19). */
  via?: string;
}

export interface SetPart { code: string; on_hand: number; on_order: number; to_order: number }

export interface PlanRow {
  code: string;
  name: string;
  /** 'set' is a sleeve and its tray counted as one box. */
  kind: PackKind | 'set';
  /** For a set: the sleeve and the tray that make it. Their to_order can differ when one of them is already on the shelf. */
  parts?: { sleeve: SetPart; tray: SetPart };
  on_hand: number;
  on_order: number;
  on_order_due: string | null;
  need_total: number;
  need_by: { label: string; date: string; need: number; short: number }[];
  /** Quantity to buy after the shelf and what is on order. */
  to_order: number;
  /** Orders short of this pack now, oldest first. */
  blocked_orders: PlanOrderRef[];
  /** Orders still short after the shelf and what is on order. These are unlocked by buying `to_order`. */
  unlocked_by_buying: string[];
  /** Orders where this is the only pack missing, so buying it alone unlocks them. */
  only_blocker: string[];
  flag: 'red' | 'amber' | null;
  /** On-order stock arrives after the earliest due date of an order it covers. */
  late_on_order: boolean;
  size: string | null;
  size_updated: string | null;
  unit_cost: number | null;
  /** to_order x unit_cost. Null when the pack has no price. */
  line_cost: number | null;
  /** This pack is being merged into another. */
  merge_into: string | null;
  run_down: boolean;
  /** Demand other packs pass to this one after using their own stock. */
  merged_from: { code: string; qty: number }[];
}

export interface PlanOrderOut {
  number: string;
  due: string | null;
  in_stock: boolean;
  missing: { code: string; name: string; qty: number; status: 'on_order' | 'to_order'; via?: string }[];
  undefined_skus: string[];
  /** Packaging is complete once everything on order and to buy has arrived. */
  packaging_complete_after: boolean;
}

export interface PackagingPlan {
  generated_at: string;
  horizons: Horizon[];
  rows: PlanRow[];
  orders: PlanOrderOut[];
  setup_issues: { sku: string; orders: string[] }[];
  summary: {
    open_orders: number;
    blocked_orders: number;
    unlocked_by_buying: number;
    unlocked_and_in_stock: number;
    still_blocked_by_setup: number;
    /** Cost of the quantities to order, for packs that have a price. */
    total_cost: number;
    /** Packs to order that have no price yet. */
    rows_missing_cost: number;
  };
}

/** 24 Dec, 31 Dec, end Jan and end Feb that are still ahead of today. */
export function defaultHorizons(today: string): Horizon[] {
  const year = Number(today.slice(0, 4));
  const out: Horizon[] = [];
  for (const y of [year, year + 1]) {
    out.push({ label: '24 Dec', date: `${y}-12-24` }, { label: '31 Dec', date: `${y}-12-31` });
    out.push({ label: 'End Jan', date: `${y + 1}-01-31` }, { label: 'End Feb', date: `${y + 1}-02-28` });
  }
  const future = out.filter((h) => h.date >= today);
  const first = future.find((h) => h.label === '24 Dec');
  const start = first ? future.indexOf(first) : 0;
  return future.slice(start, start + 4);
}

export function buildPackagingPlan(input: {
  orders: PlanOrderIn[];
  stock: PlanStockIn[];
  onOrder: OnOrderIn[];
  horizons: Horizon[];
  today?: string;
}): PackagingPlan {
  const stockBy = new Map(input.stock.map((row) => [row.code, row]));
  const hand = new Map(input.stock.map((row) => [row.code, Math.max(0, row.onHand)]));
  const orderQty = new Map<string, number>();
  const orderDue = new Map<string, string | null>();
  for (const row of input.onOrder) {
    orderQty.set(row.code, (orderQty.get(row.code) || 0) + row.qty);
    const current = orderDue.get(row.code);
    if (row.dueOn && (!current || row.dueOn < current)) orderDue.set(row.code, row.dueOn);
    else if (!orderDue.has(row.code)) orderDue.set(row.code, row.dueOn);
  }
  const onHandStart = new Map(hand);
  const orderQtyStart = new Map(orderQty);
  const orders = [...input.orders].sort((a, b) => a.orderedAt - b.orderedAt || a.number.localeCompare(b.number, undefined, { numeric: true }));

  const rows = new Map<string, PlanRow>();
  const rowFor = (code: string, fallback: { name?: string; kind: PackKind }): PlanRow => {
    let row = rows.get(code);
    if (!row) {
      const known = stockBy.get(code);
      const unitCost = known?.unitCost ?? null;
      row = {
        code,
        name: known?.name || fallback.name || code,
        kind: known?.kind || fallback.kind,
        on_hand: onHandStart.get(code) ?? 0,
        on_order: orderQtyStart.get(code) || 0,
        on_order_due: orderDue.get(code) ?? null,
        need_total: 0,
        need_by: input.horizons.map((h) => ({ label: h.label, date: h.date, need: 0, short: 0 })),
        to_order: 0,
        blocked_orders: [],
        unlocked_by_buying: [],
        only_blocker: [],
        flag: null,
        late_on_order: false,
        size: known?.size ?? null,
        size_updated: known?.sizeUpdated ?? null,
        unit_cost: unitCost,
        line_cost: null,
        merge_into: known?.mergeInto && stockBy.has(known.mergeInto) ? known.mergeInto : null,
        run_down: !!known?.runDown,
        merged_from: [],
      };
      rows.set(code, row);
    }
    return row;
  };

  const setRowFor = (pair: PlanPair): PlanRow => {
    const code = `${pair.sleeve.code} + ${pair.tray.code}`;
    let row = rows.get(code);
    if (!row) {
      const sleeve = stockBy.get(pair.sleeve.code), tray = stockBy.get(pair.tray.code);
      const part = (p: { code: string }): SetPart => ({ code: p.code, on_hand: onHandStart.get(p.code) ?? 0, on_order: orderQtyStart.get(p.code) || 0, to_order: 0 });
      const cost = sleeve?.unitCost != null && tray?.unitCost != null ? sleeve.unitCost + tray.unitCost : null;
      const dues = [orderDue.get(pair.sleeve.code), orderDue.get(pair.tray.code)].filter(Boolean) as string[];
      row = {
        code,
        name: `${pair.sleeve.name || pair.sleeve.code} + ${pair.tray.name || pair.tray.code}`,
        kind: 'set',
        parts: { sleeve: part(pair.sleeve), tray: part(pair.tray) },
        on_hand: Math.min(onHandStart.get(pair.sleeve.code) ?? 0, onHandStart.get(pair.tray.code) ?? 0),
        on_order: Math.min(orderQtyStart.get(pair.sleeve.code) || 0, orderQtyStart.get(pair.tray.code) || 0),
        on_order_due: dues.sort().pop() ?? null,
        need_total: 0,
        need_by: input.horizons.map((h) => ({ label: h.label, date: h.date, need: 0, short: 0 })),
        to_order: 0,
        blocked_orders: [],
        unlocked_by_buying: [],
        only_blocker: [],
        flag: null,
        late_on_order: false,
        size: null,
        size_updated: null,
        unit_cost: cost,
        line_cost: null,
        merge_into: null,
        run_down: false,
        merged_from: [],
      };
      rows.set(code, row);
    }
    return row;
  };

  const ordersOut: PlanOrderOut[] = [];
  for (const order of orders) {
    const missing: PlanOrderOut['missing'] = [];

    /** A sleeve and tray are one box. A unit uses the sleeve and tray on the shelf, then what is on order. Anything still missing is bought as a set. */
    const servePair = (pair: PlanPair) => {
      const row = setRowFor(pair);
      row.need_total += pair.qty;
      for (const slot of row.need_by) if (order.due && order.due <= slot.date) slot.need += pair.qty;
      let fromShelf = 0, fromOrder = 0, buying = 0;
      for (let unit = 0; unit < pair.qty; unit += 1) {
        const takeShelf = (code: string) => { if ((hand.get(code) ?? 0) > 0) { hand.set(code, (hand.get(code) ?? 0) - 1); return true; } return false; };
        const takeOrder = (code: string) => { if ((orderQty.get(code) || 0) > 0) { orderQty.set(code, (orderQty.get(code) || 0) - 1); return true; } return false; };
        const sleeveShelf = takeShelf(pair.sleeve.code), trayShelf = takeShelf(pair.tray.code);
        if (sleeveShelf && trayShelf) { fromShelf += 1; continue; }
        const sleeveOk = sleeveShelf || takeOrder(pair.sleeve.code);
        const trayOk = trayShelf || takeOrder(pair.tray.code);
        if (sleeveOk && trayOk) { fromOrder += 1; continue; }
        buying += 1;
        if (!sleeveOk) row.parts!.sleeve.to_order += 1;
        if (!trayOk) row.parts!.tray.to_order += 1;
      }
      const short = fromOrder + buying;
      if (short <= 0) return;
      row.blocked_orders.push({ number: order.number, due: order.due, qty: short, covered: buying > 0 ? 'to_order' : 'on_order' });
      if (fromOrder > 0 && row.on_order_due && order.due && row.on_order_due > order.due) row.late_on_order = true;
      if (buying > 0) {
        row.to_order += buying;
        row.unlocked_by_buying.push(order.number);
        missing.push({ code: row.code, name: row.name, qty: buying, status: 'to_order' });
      } else {
        missing.push({ code: row.code, name: row.name, qty: short, status: 'on_order' });
      }
    };

    /** Serves `qty` of a pack for this order. A merged pack uses its own stock first and passes the rest to its target. */
    const serve = (need: PlanNeed, qty: number, via?: string) => {
      const row = rowFor(need.code, need);
      const addNeed = (amount: number) => {
        row.need_total += amount;
        for (const slot of row.need_by) if (order.due && order.due <= slot.date) slot.need += amount;
      };
      const fromHand = Math.min(hand.get(need.code) ?? 0, qty);
      hand.set(need.code, (hand.get(need.code) ?? 0) - fromHand);
      let short = qty - fromHand;
      if (short > 0 && !via && row.merge_into) {
        // Own stock first. What it cannot cover comes out of the box it is being merged into.
        row.need_total += fromHand;
        for (const slot of row.need_by) if (order.due && order.due <= slot.date) slot.need += fromHand;
        const target = stockBy.get(row.merge_into)!;
        const targetRow = rowFor(target.code, target);
        targetRow.merged_from.push({ code: need.code, qty: short });
        serve({ code: target.code, name: target.name, kind: target.kind, qty: short }, short, need.code);
        return;
      }
      addNeed(qty);
      if (short <= 0) return;
      const fromOrder = Math.min(orderQty.get(need.code) || 0, short);
      orderQty.set(need.code, (orderQty.get(need.code) || 0) - fromOrder);
      short -= fromOrder;
      const ref: PlanOrderRef = { number: order.number, due: order.due, qty: qty - fromHand, covered: short > 0 ? 'to_order' : 'on_order', ...(via ? { via } : {}) };
      row.blocked_orders.push(ref);
      if (fromOrder > 0 && orderDue.get(need.code) && order.due && (orderDue.get(need.code) as string) > order.due) row.late_on_order = true;
      if (short > 0) {
        row.to_order += short;
        row.unlocked_by_buying.push(order.number);
        missing.push({ code: need.code, name: row.name, qty: short, status: 'to_order', ...(via ? { via } : {}) });
      } else {
        missing.push({ code: need.code, name: row.name, qty: qty - fromHand, status: 'on_order', ...(via ? { via } : {}) });
      }
    };

    for (const need of order.needs) serve(need, need.qty);
    for (const pair of order.pairs || []) servePair(pair);
    if (missing.length) {
      ordersOut.push({
        number: order.number,
        due: order.due,
        in_stock: order.inStock,
        missing,
        undefined_skus: order.undefinedSkus,
        packaging_complete_after: true,
      });
    }
  }


  for (const out of ordersOut) {
    const buying = out.missing.filter((item) => item.status === 'to_order');
    if (buying.length === 1) rows.get(buying[0].code)?.only_blocker.push(out.number);
  }

  const christmas = input.horizons[0]?.date;
  for (const row of rows.values()) {
    const supply = row.parts
      ? Math.min((row.parts.sleeve.on_hand + row.parts.sleeve.on_order), (row.parts.tray.on_hand + row.parts.tray.on_order))
      : (onHandStart.get(row.code) ?? 0) + row.on_order;
    for (const slot of row.need_by) slot.short = Math.max(0, slot.need - supply);
    if (row.to_order > 0) {
      const earliest = row.blocked_orders.filter((ref) => ref.covered === 'to_order' && ref.due).map((ref) => ref.due as string).sort()[0];
      row.flag = christmas && earliest && earliest <= christmas ? 'red' : 'amber';
    } else if (row.late_on_order) {
      row.flag = 'amber';
    }
    row.line_cost = row.unit_cost != null && row.to_order > 0 ? Math.round(row.unit_cost * row.to_order * 100) / 100 : null;
  }

  const setup = new Map<string, Set<string>>();
  for (const order of orders) for (const sku of order.undefinedSkus) {
    if (!setup.has(sku)) setup.set(sku, new Set());
    setup.get(sku)!.add(order.number);
  }
  const setupIssues = [...setup.entries()]
    .map(([sku, set]) => ({ sku, orders: [...set] }))
    .sort((a, b) => b.orders.length - a.orders.length || a.sku.localeCompare(b.sku));

  const blockedNow = ordersOut.length;
  const buyingOrders = ordersOut.filter((out) => out.missing.some((item) => item.status === 'to_order'));
  const unlocked = buyingOrders.filter((out) => !out.undefined_skus.length);
  const sortedRows = [...rows.values()]
    .filter((row) => row.blocked_orders.length || row.on_order > 0 || row.merged_from.length || (row.merge_into && row.need_total > 0))
    .sort((a, b) => b.to_order - a.to_order || b.blocked_orders.length - a.blocked_orders.length || a.code.localeCompare(b.code));

  return {
    generated_at: new Date().toISOString(),
    horizons: input.horizons,
    rows: sortedRows,
    orders: ordersOut,
    setup_issues: setupIssues,
    summary: {
      open_orders: orders.length,
      blocked_orders: blockedNow,
      unlocked_by_buying: unlocked.length,
      unlocked_and_in_stock: unlocked.filter((out) => out.in_stock).length,
      still_blocked_by_setup: buyingOrders.length - unlocked.length,
      total_cost: Math.round(sortedRows.reduce((sum, row) => sum + (row.line_cost || 0), 0) * 100) / 100,
      rows_missing_cost: sortedRows.filter((row) => row.to_order > 0 && row.unit_cost == null).length,
    },
  };
}

function londonToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function orderNumber(pickListNumber: string): string {
  const match = String(pickListNumber || '').match(/^PL-\d{8}-0*(\d+)(?:-(\d+))?/i);
  if (!match) return pickListNumber || '';
  return match[2] ? `#${match[1]}-${match[2]}` : `#${match[1]}`;
}

const SOLVED_METHODS = new Set(['own_box', 'pallet_wrap', 'pack_to_fit']);

function lacksPackaging(line: HoldupOrder['lines'][number], hasParts: boolean): boolean {
  if (hasParts || /^custom/i.test(line.sku) || /sample/i.test(line.sku)) return false;
  const pack = line.packaging;
  if (!pack) return true;
  if ((pack.items || []).length) return false;
  return !SOLVED_METHODS.has(String(pack.method || ''));
}

/**
 * Splits out the lines that use a sleeve and a tray together. Each is one box, so it becomes a pair and its
 * sleeve and tray rows are taken off the line so they are not counted twice. Other lines are returned as they were.
 */
export function pairSleeveTray(lines: HoldupOrder['lines']): { pairs: PlanPair[]; lines: HoldupOrder['lines'] } {
  const pairs: PlanPair[] = [];
  const rest = lines.map((line) => {
    const rows = line.packaging?.items || [];
    const sleeve = rows.find((row) => String(row.item_type || '').toLowerCase() === 'sleeve' && row.code);
    const tray = rows.find((row) => String(row.item_type || '').toLowerCase() === 'tray' && row.code);
    if (!sleeve || !tray || !line.packaging) return line;
    const qty = Math.max(0, line.required - line.picked) > 0 ? (Number(sleeve.qty) || Math.max(0, line.required - line.picked)) : 0;
    if (qty > 0) pairs.push({ sleeve: { code: String(sleeve.code), name: String(sleeve.name || sleeve.code) }, tray: { code: String(tray.code), name: String(tray.name || tray.code) }, qty });
    return { ...line, packaging: { ...line.packaging, items: rows.filter((row) => !['sleeve', 'tray'].includes(String(row.item_type || '').toLowerCase())) } };
  });
  // Several lines can use the same pair on one order.
  const merged = new Map<string, PlanPair>();
  for (const pair of pairs) {
    const key = `${pair.sleeve.code}|${pair.tray.code}`;
    const have = merged.get(key);
    if (have) have.qty += pair.qty; else merged.set(key, { ...pair });
  }
  return { pairs: [...merged.values()], lines: rest };
}

/** Outer size from SmartSuite when there is one (560L 540W 790H), else the internal size as L x W x H. */
export function sizeText(row: { box_size_formula?: string | null; internal_length_mm?: number | null; internal_width_mm?: number | null; internal_height_mm?: number | null }): string | null {
  const outer = String(row.box_size_formula || '').split(',')[0].trim();
  if (outer) return outer;
  const sides = [row.internal_length_mm, row.internal_width_mm, row.internal_height_mm].map((side) => Number(side) || 0);
  return sides.every((side) => side > 0) ? `${sides[0]} x ${sides[1]} x ${sides[2]} internal` : null;
}

/** Loads open orders, shelf stock and open on-order lines, then builds the plan. */
export async function loadPackagingPlan(): Promise<PackagingPlan> {
  await ensureStockHolds();
  const lists = (await query(
    `SELECT pl.id, pl.pick_list_number, pl.status, pl.created_at, pl.planned_at, pl.deferred_at,
            to_char(pl.named_delivery_on, 'YYYY-MM-DD') AS named_delivery_on,
            pl.is_sandbox, pl.payment_status, pl.purchase_order_number
       FROM pick_lists pl
      WHERE NOT pl.is_archived AND NOT pl.is_sandbox AND NOT COALESCE(pl.is_return, false)
        AND pl.status IN ('PENDING', 'AWAITING_STOCK') AND pl.deferred_at IS NULL
      ORDER BY pl.created_at, pl.pick_list_number`,
  )).rows.filter((row) => isPaid(row));
  const listIds = lists.map((row) => row.id as string);

  const items = listIds.length ? (await query(
    `SELECT pli.id, pli.pick_list_id, pli.product_sku AS sku, pli.item_title, pli.quantity_required, pli.quantity_picked,
            COALESCE(pli.is_custom, false) AS is_custom, wp.kit_components
       FROM pick_list_items pli
       LEFT JOIN LATERAL (
         SELECT kit_components FROM wms_products WHERE variant_sku = pli.product_sku ORDER BY is_archived LIMIT 1
       ) wp ON true
      WHERE pli.pick_list_id = ANY($1::uuid[]) AND NOT COALESCE(pli.is_archived, false) AND pli.product_sku IS NOT NULL
      ORDER BY pli.line_number`,
    [listIds],
  )).rows : [];
  const holds = items.length ? (await query(
    `SELECT pick_list_item_id, sku, qty FROM order_stock_holds WHERE pick_list_item_id = ANY($1::uuid[])`,
    [items.map((row) => row.id)],
  )).rows : [];
  const held = new Map<string, Map<string, number>>();
  for (const row of holds) {
    if (!held.has(row.pick_list_item_id)) held.set(row.pick_list_item_id, new Map());
    held.get(row.pick_list_item_id)!.set(row.sku, Number(row.qty) || 0);
  }
  const grouped = new Map<string, any[]>(listIds.map((id) => [id, []]));
  for (const row of items) grouped.get(row.pick_list_id)?.push({ ...row, sku: String(row.sku), quantity_required: Number(row.quantity_required) || 0 });
  const packed = await attachPackaging(listIds.map((id) => grouped.get(id) || []));
  const dues = listIds.length ? await getDeliveryDues(listIds) : {};

  const orders: PlanOrderIn[] = lists.map((list, index) => {
    const lines = (packed[index] || []).map((row: any) => {
      const sku = String(row.sku);
      const parts = kitParts(sku, row.kit_components);
      const noStock = row.is_custom || /sample/i.test(sku);
      return {
        line: {
          itemId: row.id, sku, title: row.item_title || sku,
          required: Number(row.quantity_required) || 0, picked: Number(row.quantity_picked) || 0,
          assigned: noStock ? null : lineCovered(sku, parts, held.get(row.id) ?? new Map()),
          packaging: row.packaging || null,
        },
        hasParts: parts.length > 0,
      };
    });
    const order = { id: list.id, status: list.status } as HoldupOrder;
    order.lines = lines.map((entry) => entry.line);
    const split = pairSleeveTray(order.lines);
    const needsOrder = { ...order, lines: split.lines } as HoldupOrder;
    const remaining = (line: HoldupOrder['lines'][number]) => Math.max(0, line.required - line.picked);
    return {
      id: list.id,
      number: orderNumber(list.pick_list_number),
      orderedAt: new Date(list.created_at).getTime(),
      due: dues[list.id]?.latest || dues[list.id]?.earliest || null,
      inStock: order.lines.every((line) => line.assigned == null || remaining(line) === 0 || line.assigned >= remaining(line)),
      needs: packNeeds(needsOrder),
      pairs: split.pairs,
      undefinedSkus: [...new Set(lines.filter((entry) => remaining(entry.line) > 0 && lacksPackaging(entry.line, entry.hasParts)).map((entry) => entry.line.sku))],
    };
  });

  const stockRows = (await query(
    `SELECT code, name, item_type, stock_on_hand, unit_cost_gbp, internal_length_mm, internal_width_mm, internal_height_mm,
            extra->>'box_size_formula' AS box_size_formula, extra->>'merge_into' AS merge_into,
            COALESCE((extra->>'run_down')::boolean, false) AS run_down,
            to_char(updated_at, 'YYYY-MM-DD') AS updated_on
       FROM packaging_items
      WHERE is_active AND item_type IN ('box', 'tray', 'sleeve')`,
  )).rows;
  const stock: PlanStockIn[] = stockRows.map((row) => ({
    code: String(row.code),
    name: String(row.name || row.code),
    kind: row.item_type as PackKind,
    onHand: Number(row.stock_on_hand) || 0,
    mergeInto: row.merge_into || null,
    runDown: !!row.run_down,
    unitCost: row.unit_cost_gbp == null ? null : Number(row.unit_cost_gbp),
    size: sizeText(row),
    sizeUpdated: row.updated_on || null,
  }));
  const onOrderRows = (await query(
    `SELECT i.code, o.qty, to_char(o.due_on, 'YYYY-MM-DD') AS due_on
       FROM packaging_on_order o JOIN packaging_items i ON i.id = o.packaging_item_id
      WHERE o.status = 'open'`,
  )).rows;
  const onOrder: OnOrderIn[] = onOrderRows.map((row) => ({ code: String(row.code), qty: Number(row.qty) || 0, dueOn: row.due_on || null }));

  return buildPackagingPlan({ orders, stock, onOrder, horizons: defaultHorizons(londonToday()) });
}
