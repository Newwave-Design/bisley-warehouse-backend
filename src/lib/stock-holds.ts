/**
 * Assigns stock on hand to open paid orders, oldest first.
 * A scan may take one unit of a SKU only while this order still has some of its count left.
 * Samples are ignored. A kit is assigned its parts, and only in complete kits, so one part is not trapped.
 * Units already picked or scanned stay with that order.
 * This does not change quantity_reserved or the pay-when-sold ledger.
 */
import { getPool, query } from '../db/index.js';

export interface HoldPart { sku: string; per: number }

export interface HoldDemand {
  itemId: string;
  orderedAt: number;
  pickListNumber: string;
  lineNumber: number;
  sku: string;
  required: number;
  picked: number;
  parts: HoldPart[];
  scanned: Map<string, number>;
}

export interface PlannedHold { itemId: string; sku: string; qty: number }

const SAMPLE = /SAMPLE/i;

export function kitParts(parentSku: string, raw: unknown): HoldPart[] {
  const parts = Array.isArray(raw) ? raw : [];
  const merged = new Map<string, number>();
  for (const part of parts) {
    const sku = part?.sku ? String(part.sku) : '';
    if (!sku || sku === parentSku || SAMPLE.test(sku)) continue;
    merged.set(sku, (merged.get(sku) ?? 0) + Math.max(1, Number(part.required_quantity) || 1));
  }
  return [...merged].map(([sku, per]) => ({ sku, per }));
}

function taken(line: HoldDemand, sku: string, per: number): number {
  return Math.max(line.picked * per, line.scanned.get(sku) ?? 0);
}

/** Pure assignment. `onHand` is the physical quantity still in the warehouse. */
export function planHolds(lines: HoldDemand[], onHand: Map<string, number>): PlannedHold[] {
  const committed = new Map<string, number>();
  const add = (sku: string, qty: number) => committed.set(sku, (committed.get(sku) ?? 0) + qty);
  for (const line of lines) {
    if (line.parts.length) {
      for (const part of line.parts) add(part.sku, taken(line, part.sku, part.per));
    } else {
      add(line.sku, taken(line, line.sku, 1));
    }
  }

  const free = new Map<string, number>();
  for (const sku of new Set([...onHand.keys(), ...committed.keys()])) {
    free.set(sku, Math.max(0, (onHand.get(sku) ?? 0) - (committed.get(sku) ?? 0)));
  }

  const ordered = [...lines].sort((a, b) => a.orderedAt - b.orderedAt || a.pickListNumber.localeCompare(b.pickListNumber) || a.lineNumber - b.lineNumber);
  const holds: PlannedHold[] = [];
  for (const line of ordered) {
    if (line.parts.length) {
      let extra = Math.max(0, line.required - line.picked);
      for (const part of line.parts) extra = Math.min(extra, Math.floor((free.get(part.sku) ?? 0) / part.per));
      for (const part of line.parts) {
        const qty = taken(line, part.sku, part.per) + extra * part.per;
        if (qty > 0) holds.push({ itemId: line.itemId, sku: part.sku, qty });
        free.set(part.sku, (free.get(part.sku) ?? 0) - extra * part.per);
      }
    } else {
      const have = taken(line, line.sku, 1);
      const extra = Math.min(Math.max(0, line.required - have), free.get(line.sku) ?? 0);
      if (have + extra > 0) holds.push({ itemId: line.itemId, sku: line.sku, qty: have + extra });
      free.set(line.sku, (free.get(line.sku) ?? 0) - extra);
    }
  }
  return holds;
}

let chain: Promise<void> = Promise.resolve();
let lastDone = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

async function computeHolds(): Promise<void> {
  const demand = await query(
    `SELECT pli.id AS item_id, pli.line_number, pli.product_sku, pli.quantity_required, pli.quantity_picked,
            pli.is_custom, wp.kit_components,
            pl.pick_list_number, COALESCE(parent.created_at, pl.created_at) AS ordered_at
       FROM pick_list_items pli
       JOIN pick_lists pl ON pl.id = pli.pick_list_id
       LEFT JOIN pick_lists parent ON parent.id = pl.parent_pick_list_id
       LEFT JOIN LATERAL (
         SELECT kit_components FROM wms_products WHERE variant_sku = pli.product_sku ORDER BY is_archived LIMIT 1
       ) wp ON true
      WHERE NOT pl.is_sandbox AND NOT COALESCE(pli.is_sandbox, false)
        AND NOT pli.is_archived AND NOT pl.is_archived
        AND pl.status NOT IN ('DISPATCHED', 'CANCELLED')
        AND (pl.payment_status IN ('captured', 'partially_refunded') OR COALESCE(pl.purchase_order_number, '') <> '')
        AND pli.quantity_required > 0
        AND NOT pli.is_custom
        AND pli.product_sku NOT ILIKE '%SAMPLE%'`
  );

  const lines: HoldDemand[] = demand.rows.map((row: any) => ({
    itemId: row.item_id,
    orderedAt: new Date(row.ordered_at).getTime(),
    pickListNumber: row.pick_list_number || '',
    lineNumber: Number(row.line_number) || 0,
    sku: row.product_sku,
    required: Number(row.quantity_required) || 0,
    picked: Number(row.quantity_picked) || 0,
    parts: kitParts(row.product_sku, row.kit_components),
    scanned: new Map<string, number>(),
  }));
  const byId = new Map(lines.map((line) => [line.itemId, line]));

  if (lines.length) {
    const scans = await query(
      `SELECT ps.pick_list_item_id,
              COALESCE(ps.component_sku, bm.product_sku, ps.scanned_barcode) AS sku,
              SUM(ps.quantity)::int AS qty
         FROM pick_scans ps
         LEFT JOIN barcode_mappings bm ON bm.barcode = ps.scanned_barcode AND bm.is_active = true
        WHERE ps.pick_list_item_id = ANY($1::uuid[])
        GROUP BY ps.pick_list_item_id, 2`,
      [lines.map((line) => line.itemId)]
    );
    for (const row of scans.rows) {
      const line = byId.get(row.pick_list_item_id);
      if (line && row.sku) line.scanned.set(row.sku, Number(row.qty) || 0);
    }
  }

  const skus = new Set<string>();
  for (const line of lines) {
    if (line.parts.length) for (const part of line.parts) skus.add(part.sku);
    else skus.add(line.sku);
    for (const sku of line.scanned.keys()) skus.add(sku);
  }
  const onHand = new Map<string, number>();
  if (skus.size) {
    const stock = await query(
      `SELECT product_sku, COALESCE(SUM(quantity), 0)::int AS qty
         FROM warehouse_inventory WHERE product_sku = ANY($1::text[]) GROUP BY product_sku`,
      [[...skus]]
    );
    for (const row of stock.rows) onHand.set(row.product_sku, Number(row.qty) || 0);
  }

  const holds = planHolds(lines, onHand);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM order_stock_holds');
    if (holds.length) {
      await client.query(
        `INSERT INTO order_stock_holds (pick_list_item_id, sku, qty)
         SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::int[])`,
        [holds.map((hold) => hold.itemId), holds.map((hold) => hold.sku), holds.map((hold) => hold.qty)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Rebuilds the holds. A recent rebuild is reused unless force is set. */
export function ensureStockHolds(force = false): Promise<void> {
  const run = chain.then(async () => {
    if (!force && Date.now() - lastDone < 5000) return;
    await computeHolds();
    lastDone = Date.now();
  });
  chain = run.catch((err) => {
    console.warn('[stock-holds]', err instanceof Error ? err.message : err);
  });
  return run;
}

/** Rebuild shortly after stock or an order changes. Repeated calls collapse into one rebuild. */
export function scheduleStockHolds(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void ensureStockHolds(true);
  }, 500);
}

export interface PickRefusal {
  pickListId: string;
  itemId: string;
  sku: string;
  /** Units of this SKU already scanned or picked on the line, before this scan. */
  already: number;
  take: number;
}

/** Null when the scan is allowed. A message when this order has no count left for the SKU. */
export async function refuseUnassignedPick(input: PickRefusal): Promise<string | null> {
  if (input.take <= 0) return null;
  const list = await query(
    `SELECT pl.is_sandbox, pl.status, pli.product_sku, pli.is_custom, wp.kit_components
       FROM pick_lists pl
       JOIN pick_list_items pli ON pli.pick_list_id = pl.id AND pli.id = $2
       LEFT JOIN LATERAL (
         SELECT kit_components FROM wms_products WHERE variant_sku = pli.product_sku ORDER BY is_archived LIMIT 1
       ) wp ON true
      WHERE pl.id = $1`,
    [input.pickListId, input.itemId]
  );
  const row = list.rows[0];
  if (!row || row.is_sandbox || row.is_custom || SAMPLE.test(row.product_sku || '')) return null;
  const parts = kitParts(row.product_sku, row.kit_components);
  if (parts.length && !parts.some((part) => part.sku === input.sku)) return null;

  await ensureStockHolds();
  const hold = await query(
    `SELECT qty FROM order_stock_holds WHERE pick_list_item_id = $1 AND sku = $2`,
    [input.itemId, input.sku]
  );
  const allowed = Number(hold.rows[0]?.qty) || 0;
  if (input.already + input.take <= allowed) return null;

  const older = await query(
    `SELECT pl.pick_list_number, pl.customer_name
       FROM order_stock_holds h
       JOIN pick_list_items pli ON pli.id = h.pick_list_item_id
       JOIN pick_lists pl ON pl.id = pli.pick_list_id
      WHERE h.sku = $1 AND h.pick_list_item_id <> $2 AND h.qty > 0
      ORDER BY COALESCE(pl.created_at, NOW()), pl.pick_list_number
      LIMIT 1`,
    [input.sku, input.itemId]
  );
  const who = older.rows[0];
  const held = who
    ? ` It is held for ${who.pick_list_number}${who.customer_name ? ` (${who.customer_name})` : ''}.`
    : '';
  const left = allowed - input.already;
  if (left <= 0) return `No ${input.sku} is assigned to this order.${held}`;
  return `Only ${left} ${input.sku} left on this order.${held}`;
}
