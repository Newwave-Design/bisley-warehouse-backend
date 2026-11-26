/**
 * After stocking in, reserve newly arrived units to older open orders before anything is treated as available.
 * Available is on shelf minus reserved. That is the figure compared with Medusa's stocked quantity.
 * Bonded stock goes through the same reservation check before any of it is treated as available.
 * Nothing is reserved beyond the units that are actually free.
 */
import { getPool, query } from '../db/index.js';
import { kitParts, scheduleStockHolds } from './stock-holds.js';

export interface ArrivalLine {
  itemId: string;
  pickListId: string;
  orderedAt: number;
  pickListNumber: string;
  lineNumber: number;
  sku: string;
  needed: number;
  status: string;
}

export interface ShelfStock {
  sku: string;
  shelf: number;
  reserved: number;
  bonded: boolean;
}

export interface ReservationAdd { sku: string; add: number }

function byAge(a: ArrivalLine, b: ArrivalLine): number {
  return a.orderedAt - b.orderedAt || a.pickListNumber.localeCompare(b.pickListNumber) || a.lineNumber - b.lineNumber;
}

/** Units still free once older orders have taken what they are short. Never more than shelf minus reserved. */
export function planReservations(lines: ArrivalLine[], shelves: ShelfStock[]): ReservationAdd[] {
  const bySku = new Map<string, ArrivalLine[]>();
  for (const line of lines) {
    const group = bySku.get(line.sku) ?? [];
    group.push(line);
    bySku.set(line.sku, group);
  }
  const adds: ReservationAdd[] = [];
  for (const shelf of shelves) {
    const available = Math.max(0, shelf.shelf - shelf.reserved);
    if (available <= 0) continue;
    let already = Math.max(0, shelf.reserved);
    let free = available;
    let add = 0;
    for (const line of [...(bySku.get(shelf.sku) ?? [])].sort(byAge)) {
      const covered = Math.min(Math.max(0, line.needed), already);
      already -= covered;
      const give = Math.min(Math.max(0, line.needed - covered), free);
      free -= give;
      add += give;
    }
    if (add > 0) adds.push({ sku: shelf.sku, add });
  }
  return adds;
}

/** Shop-available units after the reservation check. Bonded stock uses the same rule. */
export function availableAfterReservation(shelf: number, reserved: number): number {
  return Math.max(0, shelf - reserved);
}

/** An awaiting order is covered only when older orders have taken their shelf units first. */
export function coveredAwaitingLists(lines: ArrivalLine[], shelfBySku: Map<string, number>): string[] {
  const bySku = new Map<string, ArrivalLine[]>();
  for (const line of lines) {
    const group = bySku.get(line.sku) ?? [];
    group.push(line);
    bySku.set(line.sku, group);
  }
  const got = new Map<string, number>();
  for (const [sku, group] of bySku) {
    let left = Math.max(0, shelfBySku.get(sku) ?? 0);
    for (const line of [...group].sort(byAge)) {
      const give = Math.min(Math.max(0, line.needed), left);
      got.set(`${line.itemId}\0${line.sku}`, give);
      left -= give;
    }
  }
  const byList = new Map<string, ArrivalLine[]>();
  for (const line of lines) {
    if (line.status !== 'AWAITING_STOCK') continue;
    const group = byList.get(line.pickListId) ?? [];
    group.push(line);
    byList.set(line.pickListId, group);
  }
  const ids: string[] = [];
  for (const [id, group] of byList) {
    if (group.length && group.every((line) => (got.get(`${line.itemId}\0${line.sku}`) ?? 0) >= line.needed)) ids.push(id);
  }
  return ids;
}

const OPEN_LINES = `
  SELECT pli.id AS item_id, pli.pick_list_id, pli.line_number, pli.product_sku, pli.quantity_required,
         pl.pick_list_number, pl.status, wp.kit_components,
         CASE WHEN COALESCE(pl.is_return, false) THEN pl.created_at
              ELSE COALESCE(parent.created_at, pl.created_at) END AS ordered_at
    FROM pick_list_items pli
    JOIN pick_lists pl ON pl.id = pli.pick_list_id
    LEFT JOIN pick_lists parent ON parent.id = pl.parent_pick_list_id
    LEFT JOIN LATERAL (
      SELECT kit_components FROM wms_products WHERE variant_sku = pli.product_sku ORDER BY is_archived LIMIT 1
    ) wp ON true
   WHERE NOT pl.is_sandbox AND NOT COALESCE(pli.is_sandbox, false)
     AND NOT pli.is_archived AND NOT pl.is_archived
     AND pl.status NOT IN ('DISPATCHED', 'CANCELLED')
     AND (pl.payment_status IN ('captured', 'partially_refunded') OR COALESCE(pl.purchase_order_number, '') <> '' OR COALESCE(pl.is_return, false))
     AND pli.quantity_required > 0
     AND NOT pli.is_custom
     AND pli.product_sku NOT ILIKE '%SAMPLE%'`

function toLines(rows: any[], only?: Set<string>): ArrivalLine[] {
  const lines: ArrivalLine[] = [];
  for (const row of rows) {
    const needed = Number(row.quantity_required) || 0;
    const parts = kitParts(row.product_sku, row.kit_components);
    const pieces = parts.length ? parts.map((part) => ({ sku: part.sku, needed: needed * part.per })) : [{ sku: row.product_sku as string, needed }];
    for (const piece of pieces) {
      if (only && !only.has(piece.sku)) continue;
      lines.push({
        itemId: row.item_id,
        pickListId: row.pick_list_id,
        orderedAt: new Date(row.ordered_at).getTime(),
        pickListNumber: row.pick_list_number || '',
        lineNumber: Number(row.line_number) || 0,
        sku: piece.sku,
        needed: piece.needed,
        status: row.status,
      });
    }
  }
  return lines;
}

async function addReserved(client: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }, sku: string, qty: number): Promise<void> {
  let left = qty;
  const rows = await client.query(
    `SELECT id, quantity, quantity_reserved FROM warehouse_inventory
      WHERE product_sku = $1
      ORDER BY (quantity - quantity_reserved) DESC
      FOR UPDATE`,
    [sku],
  );
  for (const row of rows.rows) {
    if (left <= 0) break;
    const room = Math.max(0, Number(row.quantity) - Number(row.quantity_reserved));
    const take = Math.min(left, room);
    if (take <= 0) continue;
    await client.query(
      `UPDATE warehouse_inventory SET quantity_reserved = quantity_reserved + $1, updated_at = NOW() WHERE id = $2`,
      [take, row.id],
    );
    left -= take;
  }
}

/**
 * Reserve free units of the given SKUs to older open orders.
 * With no SKU list, every open order is checked. Returns how many units were newly reserved.
 * Does not write Medusa. Callers that send a shop quantity must call this first.
 */
export async function assignStockedToOlderOrders(skus?: string[]): Promise<number> {
  const only = skus?.length ? new Set(skus.filter(Boolean)) : undefined;
  if (skus && !only?.size) return 0;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(842462)');
    const demand = await client.query(OPEN_LINES);
    const lines = toLines(demand.rows, only);
    const skuList = [...new Set(lines.map((line) => line.sku))];
    if (!skuList.length) {
      await client.query('COMMIT');
      return 0;
    }
    const stock = await client.query(
      `SELECT product_sku, COALESCE(SUM(quantity), 0)::int AS shelf, COALESCE(SUM(quantity_reserved), 0)::int AS reserved
         FROM warehouse_inventory WHERE product_sku = ANY($1::text[]) GROUP BY product_sku`,
      [skuList],
    );
    const bondedRows = await client.query(
      `SELECT DISTINCT soi.product_sku
         FROM supplier_order_items soi
         JOIN supplier_orders so ON so.id = soi.supplier_order_id
        WHERE so.order_number IN ('OV010-504108', 'OV010-504206')
          AND soi.product_sku = ANY($1::text[])`,
      [skuList],
    );
    const bonded = new Set(bondedRows.rows.map((row: { product_sku: string }) => row.product_sku));
    const shelves: ShelfStock[] = stock.rows.map((row: { product_sku: string; shelf: number; reserved: number }) => ({
      sku: row.product_sku,
      shelf: Number(row.shelf) || 0,
      reserved: Number(row.reserved) || 0,
      bonded: bonded.has(row.product_sku),
    }));
    const adds = planReservations(lines, shelves);
    for (const add of adds) await addReserved(client, add.sku, add.add);
    await client.query('COMMIT');
    const units = adds.reduce((sum, add) => sum + add.add, 0);
    if (units > 0) {
      console.log(`[arrived-stock] Reserved ${units} unit(s) to older orders`);
      scheduleStockHolds();
    }
    return units;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Awaiting lists whose lines are covered once older orders have taken the shelf. */
export async function awaitingListsCovered(skus: string[]): Promise<string[]> {
  if (!skus.length) return [];
  const candidates = await query(
    `SELECT DISTINCT pl.id
       FROM pick_lists pl
       JOIN pick_list_items pli ON pli.pick_list_id = pl.id
      WHERE pl.status = 'AWAITING_STOCK' AND NOT pl.is_archived AND NOT pli.is_archived
        AND pli.product_sku = ANY($1::text[])`,
    [skus],
  );
  const ids = candidates.rows.map((row: { id: string }) => row.id);
  if (!ids.length) return [];
  const demand = await query(
    `${OPEN_LINES} AND (
       pl.id = ANY($1::uuid[])
       OR pli.product_sku IN (
         SELECT product_sku FROM pick_list_items WHERE pick_list_id = ANY($1::uuid[]) AND NOT is_archived
       )
     )`,
    [ids],
  );
  const lines = toLines(demand.rows);
  const skuList = [...new Set(lines.map((line) => line.sku))];
  if (!skuList.length) return [];
  const stock = await query(
    `SELECT product_sku, COALESCE(SUM(quantity), 0)::int AS shelf
       FROM warehouse_inventory WHERE product_sku = ANY($1::text[]) GROUP BY product_sku`,
    [skuList],
  );
  const shelfBySku = new Map<string, number>(stock.rows.map((row: { product_sku: string; shelf: number }) => [row.product_sku, Number(row.shelf) || 0]));
  return coveredAwaitingLists(lines, shelfBySku).filter((id) => ids.includes(id));
}
