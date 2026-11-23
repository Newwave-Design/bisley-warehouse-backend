/**
 * What is holding an order up, in the words the warehouse uses on a Plan picks row.
 * Stock comes from order_stock_holds (oldest order first). Boxes come from order_box_holds.
 * Trays and sleeves have no holds, so older open orders take the shelf stock first.
 * Read by the customer desk through POST /api/pick-lists/holdup.
 */
import { query } from '../db/index.js';
import { boxHoldsForItems } from './box-holds.js';
import { isPaid } from './payment-status.js';
import { attachPackaging } from './pick-list-packaging.js';
import { ensureStockHolds, kitParts, lineCovered } from './stock-holds.js';
import { isWorkingIsoDay } from './working-days.js';

export type HoldupStage =
  | 'planning' | 'to_pick' | 'picking' | 'picked' | 'packing' | 'packed' | 'shipped' | 'cancelled';

export interface HoldupLine {
  itemId: string;
  sku: string;
  title: string;
  required: number;
  picked: number;
  /** Units assigned to this order. Null for a line that needs no stock (custom, sample). */
  assigned: number | null;
  kitComponents?: unknown;
  packaging?: {
    method?: string | null;
    box_code?: string | null;
    items?: { code?: string; name?: string; item_type?: string; qty?: number; stock_on_hand?: number | null }[];
  } | null;
}

export interface HoldupOrder {
  id: string;
  number: string;
  status: string;
  orderedAt: number;
  plannedAt: string | null;
  deferred: boolean;
  paid: boolean;
  namedDelivery: string | null;
  flagNote: string | null;
  lines: HoldupLine[];
}

export interface PackNeed { code: string; name: string; kind: 'box' | 'tray' | 'sleeve'; qty: number }

export interface Holdup {
  stage: HoldupStage;
  stage_label: string;
  on_pick_list: boolean;
  ready: boolean;
  /** One sentence for the order card. */
  headline: string;
  waiting_on: (
    | { kind: 'payment' }
    | { kind: 'on_hold' }
    | { kind: 'stock'; sku: string; title: string; need: number; assigned: number; orders_ahead: number }
    | { kind: 'packaging'; type: 'box' | 'tray' | 'sleeve'; code: string; name: string; need: number; held: number }
    | { kind: 'named_delivery'; delivery: string; collection: string }
  )[];
  /** Older orders still to be picked that are ready now, and how many of those are already on a pick list. */
  queue: { ready_ahead: number; on_pick_list_ahead: number } | null;
  flag_note: string | null;
}

const STARTED = new Set(['IN_PROGRESS', 'PICKED', 'PACKING', 'PACKED', 'LABEL_PRINTED']);
const PACKED = new Set(['PACKED', 'LABEL_PRINTED', 'DISPATCHED']);

export function stageOf(order: Pick<HoldupOrder, 'status' | 'plannedAt'>): HoldupStage {
  switch (order.status) {
    case 'CANCELLED': return 'cancelled';
    case 'DISPATCHED': return 'shipped';
    case 'PACKED':
    case 'LABEL_PRINTED': return 'packed';
    case 'PACKING': return 'packing';
    case 'PICKED': return 'picked';
    case 'IN_PROGRESS': return 'picking';
    default: return order.plannedAt ? 'to_pick' : 'planning';
  }
}

const STAGE_LABEL: Record<HoldupStage, string> = {
  planning: 'In Plan picks, not on a pick list yet',
  to_pick: 'On the pick list',
  picking: 'Being picked',
  picked: 'Picked, waiting to be packed',
  packing: 'Being packed',
  packed: 'Packed, waiting for the courier',
  shipped: 'Shipped',
  cancelled: 'Cancelled',
};

function remaining(line: HoldupLine): number {
  return Math.max(0, line.required - line.picked);
}

function needsStock(line: HoldupLine): boolean {
  return line.assigned != null && remaining(line) > 0;
}

/** Lines short of stock for this order. A line already picked is not short. */
export function shortLines(order: HoldupOrder): HoldupLine[] {
  return order.lines.filter((line) => needsStock(line) && (line.assigned ?? 0) < remaining(line));
}

/** Boxes, trays and sleeves the order still needs. Same reading as the Plan picks box column. */
export function packNeeds(order: HoldupOrder): PackNeed[] {
  if (PACKED.has(order.status)) return [];
  const map = new Map<string, PackNeed>();
  const add = (code: string, name: string, kind: PackNeed['kind'], qty: number) => {
    if (!code || qty <= 0) return;
    const key = `${kind}:${code}`;
    const current = map.get(key) || { code, name: name || code, kind, qty: 0 };
    current.qty += qty;
    map.set(key, current);
  };
  for (const line of order.lines) {
    const pack = line.packaging;
    if (!pack || line.required <= 0) continue;
    if (pack.method === 'own_box') continue;
    const rows = pack.items || [];
    let boxed = false;
    for (const row of rows) {
      const type = String(row.item_type || '').toLowerCase();
      if (type === 'box') {
        boxed = true;
        add(String(row.code || row.name || ''), String(row.name || ''), 'box', Number(row.qty) || line.required);
      } else if (type === 'tray' || type === 'sleeve') {
        add(String(row.code || row.name || ''), String(row.name || ''), type, Number(row.qty) || line.required);
      }
    }
    if (!boxed && pack.box_code && !rows.some((row) => ['tray', 'sleeve'].includes(String(row.item_type || '').toLowerCase()))) {
      add(String(pack.box_code), String(pack.box_code), 'box', line.required);
    }
  }
  return [...map.values()];
}

/** Last working day before the delivery. Friday for a Monday delivery. */
export function collectionDayFor(delivery: string): string {
  const date = new Date(`${delivery.slice(0, 10)}T12:00:00Z`);
  for (let step = 0; step < 14; step += 1) {
    date.setUTCDate(date.getUTCDate() - 1);
    const value = date.toISOString().slice(0, 10);
    if (isWorkingIsoDay(value)) return value;
  }
  return '';
}

function niceDay(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export interface HoldupContext {
  /** Boxes held per line id then box code. */
  boxHolds: Record<string, Record<string, number>>;
  /** Trays and sleeves free for this order once older orders have taken theirs, by code. */
  freePack: (orderId: string, code: string) => number;
  /** Older open paid orders short of this SKU. */
  ordersAheadForSku: (orderId: string, sku: string) => number;
  readyAhead: number;
  onPickListAhead: number;
  today: string;
}

export function describeHoldup(order: HoldupOrder, ctx: HoldupContext): Holdup {
  const stage = stageOf(order);
  const base = {
    stage,
    stage_label: STAGE_LABEL[stage],
    on_pick_list: stage === 'to_pick' || stage === 'picking',
    flag_note: order.flagNote,
  };
  if (stage === 'shipped' || stage === 'cancelled') {
    return { ...base, ready: false, headline: STAGE_LABEL[stage], waiting_on: [], queue: null };
  }

  const waiting: Holdup['waiting_on'] = [];
  if (!order.paid) waiting.push({ kind: 'payment' });
  if (order.deferred) waiting.push({ kind: 'on_hold' });
  for (const line of shortLines(order)) {
    waiting.push({
      kind: 'stock',
      sku: line.sku,
      title: line.title,
      need: remaining(line),
      assigned: line.assigned ?? 0,
      orders_ahead: ctx.ordersAheadForSku(order.id, line.sku),
    });
  }
  for (const need of packNeeds(order)) {
    const held = need.kind === 'box'
      ? order.lines.reduce((sum, line) => sum + (ctx.boxHolds[line.itemId]?.[need.code] || 0), 0)
      : Math.min(need.qty, Math.max(0, ctx.freePack(order.id, need.code)));
    if (held < need.qty) waiting.push({ kind: 'packaging', type: need.kind, code: need.code, name: need.name, need: need.qty, held });
  }
  const collection = order.namedDelivery ? collectionDayFor(order.namedDelivery) : '';
  if (order.namedDelivery && collection && collection > ctx.today && !STARTED.has(order.status)) {
    waiting.push({ kind: 'named_delivery', delivery: order.namedDelivery, collection });
  }

  const blocking = waiting.filter((item) => item.kind !== 'named_delivery');
  const ready = blocking.length === 0;
  const queue = stage === 'planning' || stage === 'to_pick'
    ? { ready_ahead: ctx.readyAhead, on_pick_list_ahead: ctx.onPickListAhead }
    : null;
  return { ...base, ready, headline: headlineFor(stage, waiting, queue), waiting_on: waiting, queue };
}

function headlineFor(stage: HoldupStage, waiting: Holdup['waiting_on'], queue: Holdup['queue']): string {
  const first = waiting[0];
  if (first?.kind === 'payment') return 'Not paid yet, so the warehouse will not pick it.';
  if (first?.kind === 'on_hold') return 'On hold in the warehouse.';
  const stock = waiting.filter((item) => item.kind === 'stock');
  if (stock.length) {
    const item = stock[0] as Extract<Holdup['waiting_on'][number], { kind: 'stock' }>;
    const ahead = item.orders_ahead ? ` ${plural(item.orders_ahead, 'older order')} ${item.orders_ahead === 1 ? 'is' : 'are'} also waiting for it.` : '';
    const more = stock.length > 1 ? ` (and ${plural(stock.length - 1, 'other product')})` : '';
    return `Waiting for stock: ${item.sku}${more}, ${item.assigned} of ${item.need} in for this order.${ahead}`;
  }
  const pack = waiting.filter((item) => item.kind === 'packaging') as Extract<Holdup['waiting_on'][number], { kind: 'packaging' }>[];
  if (pack.length) {
    const names = pack.map((item) => (new RegExp(item.type, 'i').test(item.name) ? item.name : `${item.type} ${item.name}`)).join(', ');
    return `Stock is in. Waiting for packaging: ${names}.`;
  }
  const named = waiting.find((item) => item.kind === 'named_delivery') as Extract<Holdup['waiting_on'][number], { kind: 'named_delivery' }> | undefined;
  if (named) return `Ready. Held for named delivery on ${niceDay(named.delivery)}; it is picked for the ${niceDay(named.collection)} collection.`;
  if (stage === 'to_pick') {
    const ahead = queue?.on_pick_list_ahead ? ` ${plural(queue.on_pick_list_ahead, 'older order')} on the list come first.` : '';
    return `Ready and on the pick list.${ahead}`;
  }
  if (stage === 'planning') {
    const ahead = queue?.ready_ahead ? ` ${plural(queue.ready_ahead, 'older ready order')} ${queue.ready_ahead === 1 ? 'is' : 'are'} ahead of it.` : '';
    return `Ready to pick, not on a pick list yet.${ahead}`;
  }
  return STAGE_LABEL[stage];
}

function londonToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Hold-ups for these pick lists, worked out against every open order. */
export async function loadHoldups(ids: string[]): Promise<Record<string, Holdup>> {
  if (!ids.length) return {};
  await ensureStockHolds();

  const lists = (await query(
    `SELECT pl.id, pl.pick_list_number, pl.status, pl.created_at, pl.planned_at, pl.deferred_at,
            to_char(pl.named_delivery_on, 'YYYY-MM-DD') AS named_delivery_on,
            pl.is_sandbox, pl.payment_status, pl.purchase_order_number,
            (SELECT n.note_text FROM pick_list_notes n
              WHERE n.pick_list_id = pl.id AND n.is_flagged AND n.resolved_at IS NULL
              ORDER BY n.created_at DESC LIMIT 1) AS flag_note
       FROM pick_lists pl
      WHERE NOT pl.is_archived AND NOT pl.is_sandbox
        AND (pl.status NOT IN ('DISPATCHED', 'CANCELLED') OR pl.id = ANY($1::uuid[]))
      ORDER BY pl.created_at, pl.pick_list_number`,
    [ids],
  )).rows;
  if (!lists.length) return {};
  const listIds = lists.map((row) => row.id as string);

  const items = (await query(
    `SELECT pli.id, pli.pick_list_id, pli.product_sku AS sku, pli.item_title, pli.quantity_required, pli.quantity_picked,
            COALESCE(pli.is_custom, false) AS is_custom, wp.kit_components
       FROM pick_list_items pli
       LEFT JOIN LATERAL (
         SELECT kit_components FROM wms_products WHERE variant_sku = pli.product_sku ORDER BY is_archived LIMIT 1
       ) wp ON true
      WHERE pli.pick_list_id = ANY($1::uuid[]) AND NOT COALESCE(pli.is_archived, false) AND pli.product_sku IS NOT NULL
      ORDER BY pli.line_number`,
    [listIds],
  )).rows;
  const holds = (await query(
    `SELECT pick_list_item_id, sku, qty FROM order_stock_holds WHERE pick_list_item_id = ANY($1::uuid[])`,
    [items.map((row) => row.id)],
  )).rows;
  const held = new Map<string, Map<string, number>>();
  for (const row of holds) {
    if (!held.has(row.pick_list_item_id)) held.set(row.pick_list_item_id, new Map());
    held.get(row.pick_list_item_id)!.set(row.sku, Number(row.qty) || 0);
  }

  const grouped = new Map<string, any[]>(listIds.map((id) => [id, []]));
  for (const row of items) {
    grouped.get(row.pick_list_id)?.push({ ...row, sku: String(row.sku), quantity_required: Number(row.quantity_required) || 0 });
  }
  const packed = await attachPackaging(listIds.map((id) => grouped.get(id) || []));
  const boxHolds = await boxHoldsForItems(listIds);

  const orders: HoldupOrder[] = lists.map((list, index) => ({
    id: list.id,
    number: list.pick_list_number || '',
    status: list.status,
    orderedAt: new Date(list.created_at).getTime(),
    plannedAt: list.planned_at ? String(list.planned_at) : null,
    deferred: !!list.deferred_at,
    paid: isPaid(list),
    namedDelivery: list.named_delivery_on || null,
    flagNote: list.flag_note ? String(list.flag_note).slice(0, 300) : null,
    lines: (packed[index] || []).map((row: any) => {
      const sku = String(row.sku);
      const noStock = row.is_custom || /sample/i.test(sku);
      const parts = kitParts(sku, row.kit_components);
      return {
        itemId: row.id,
        sku,
        title: row.item_title || sku,
        required: Number(row.quantity_required) || 0,
        picked: Number(row.quantity_picked) || 0,
        assigned: noStock ? null : lineCovered(sku, parts, held.get(row.id) ?? new Map()),
        packaging: row.packaging || null,
      };
    }),
  }));

  // Open paid orders, oldest first, compete for trays and sleeves on the shelf and for the next picks.
  const open = orders.filter((order) => order.paid && !['DISPATCHED', 'CANCELLED'].includes(order.status));
  const shelf = new Map<string, number>();
  for (const order of open) {
    for (const line of order.lines) {
      for (const row of line.packaging?.items || []) {
        const type = String(row.item_type || '').toLowerCase();
        if ((type === 'tray' || type === 'sleeve') && row.code && row.stock_on_hand != null && !shelf.has(row.code)) {
          shelf.set(row.code, Number(row.stock_on_hand) || 0);
        }
      }
    }
  }
  const freeBefore = new Map<string, Map<string, number>>();
  const left = new Map(shelf);
  for (const order of open) {
    const before = new Map<string, number>();
    for (const need of packNeeds(order)) {
      if (need.kind === 'box' || !left.has(need.code)) continue;
      before.set(need.code, left.get(need.code)!);
      left.set(need.code, left.get(need.code)! - need.qty);
    }
    freeBefore.set(order.id, before);
  }

  const shortSkus = new Map<string, Set<string>>();
  for (const order of open) shortSkus.set(order.id, new Set(shortLines(order).map((line) => line.sku)));
  const today = londonToday();
  const ctxFor = (order: HoldupOrder, readyAhead: number, onPickListAhead: number): HoldupContext => ({
    boxHolds,
    freePack: (orderId, code) => freeBefore.get(orderId)?.get(code) ?? (shelf.get(code) ?? Number.POSITIVE_INFINITY),
    ordersAheadForSku: (orderId, sku) => open.filter((other) => other.id !== orderId && other.orderedAt < order.orderedAt && shortSkus.get(other.id)?.has(sku)).length,
    readyAhead,
    onPickListAhead,
    today,
  });

  let readyAhead = 0;
  let onPickListAhead = 0;
  const wanted = new Set(ids);
  const out: Record<string, Holdup> = {};
  for (const order of orders) {
    const holdup = describeHoldup(order, ctxFor(order, readyAhead, onPickListAhead));
    if (wanted.has(order.id)) out[order.id] = holdup;
    // A named delivery waits for its collection day, so it is not ahead in today's picking.
    const waitsForDay = holdup.waiting_on.some((item) => item.kind === 'named_delivery');
    if (order.paid && holdup.ready && !waitsForDay && (holdup.stage === 'planning' || holdup.stage === 'to_pick')) {
      readyAhead += 1;
      if (holdup.stage === 'to_pick') onPickListAhead += 1;
    }
  }
  return out;
}
