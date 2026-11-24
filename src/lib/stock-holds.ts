/**
 * Assigns stock on hand to open orders, oldest first. A purchase order counts as paid.
 * A scan may take one unit of a SKU only while this order still has some of its count left.
 * Samples are ignored. Each part of a kit is reserved to that order, even when another part is not in stock.
 * Units already picked or scanned stay with that order.
 * A kit in the bin counts as its components. A 5-pack of trays is five singles, and those singles
 * fill either singles or another pack. The same units are not promised twice.
 * This does not change quantity_reserved or the pay-when-sold ledger.
 */
import { getPool, query } from '../db/index.js';
import { computeBoxHolds } from './box-holds.js';

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
  /** Force-added: served before every other order, so it takes unpicked stock from newer ones. */
  forced?: boolean;
}

export interface PlannedHold { itemId: string; sku: string; qty: number }

/** Move unpicked stock from one open order onto another. Already picked units stay where they are. */
export interface HoldClaim { itemId: string; fromItemId: string; sku: string; qty: number }

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

function demandFor(line: HoldDemand, sku: string, per: number): number {
  if (line.parts.length) return Math.max(0, line.required - line.picked) * per;
  return Math.max(0, line.required * per - taken(line, sku, per));
}

/** 227P5-000 is five 227P1-000. Customers order either the single or the pack. */
export function trayPackParts(sku: string): HoldPart[] {
  const match = /^(.+)P5-000$/i.exec(sku);
  if (!match) return [];
  return [{ sku: `${match[1]}P1-000`, per: 5 }];
}

/**
 * How many of this line the order has been given.
 * A kit is limited by its shortest part. A pack of five is covered by five singles.
 */
export function lineCovered(sku: string, parts: HoldPart[], held: Map<string, number>): number {
  const used = parts.length ? parts : trayPackParts(sku);
  if (!used.length) return held.get(sku) ?? 0;
  return Math.min(...used.map((part) => Math.floor((held.get(part.sku) ?? 0) / part.per)));
}

/** A pack in a bin is five singles. Those singles are not also kept as a separate pack. */
export function applyKitStock(onHand: Map<string, number>, kits: { sku: string; parts: HoldPart[] }[]): Map<string, number> {
  const free = new Map(onHand);
  for (const kit of kits) {
    if (!kit.parts.length) continue;
    const qty = free.get(kit.sku) ?? 0;
    if (qty <= 0) continue;
    free.set(kit.sku, 0);
    for (const part of kit.parts) free.set(part.sku, (free.get(part.sku) ?? 0) + qty * part.per);
  }
  return free;
}

/** Pure assignment. `onHand` is the physical quantity still in the warehouse. Claims are satisfied before older orders. */
export function planHolds(lines: HoldDemand[], onHand: Map<string, number>, claims: HoldClaim[] = []): PlannedHold[] {
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

  const byId = new Map(lines.map((line) => [line.itemId, line]));
  const grant = new Map<string, number>();
  const claimKey = (itemId: string, sku: string) => `${itemId}\n${sku}`;
  for (const claim of claims) {
    const donor = byId.get(claim.fromItemId);
    const receiver = byId.get(claim.itemId);
    const sku = claim.sku;
    const qty = Math.max(0, Math.round(claim.qty));
    if (!donor || !receiver || !sku || qty <= 0 || donor.itemId === receiver.itemId) continue;
    const donorPart = donor.parts.find((part) => part.sku === sku);
    const receiverPart = receiver.parts.find((part) => part.sku === sku);
    const donorPer = donorPart ? donorPart.per : (!donor.parts.length && donor.sku === sku ? 1 : 0);
    const receiverPer = receiverPart ? receiverPart.per : (!receiver.parts.length && receiver.sku === sku ? 1 : 0);
    if (!donorPer || !receiverPer) continue;
    const fromKey = `from:${claimKey(donor.itemId, sku)}`;
    const toKey = claimKey(receiver.itemId, sku);
    const usedFrom = grant.get(fromKey) ?? 0;
    const usedTo = grant.get(toKey) ?? 0;
    const room = Math.max(0, demandFor(donor, sku, donorPer) - usedFrom);
    const receiverRoom = Math.max(0, demandFor(receiver, sku, receiverPer) - usedTo);
    const give = Math.min(qty, room, receiverRoom, Math.max(0, free.get(sku) ?? 0));
    if (give <= 0) continue;
    grant.set(fromKey, usedFrom + give);
    grant.set(toKey, usedTo + give);
    free.set(sku, (free.get(sku) ?? 0) - give);
  }

  const ordered = [...lines].sort((a, b) => Number(!!b.forced) - Number(!!a.forced) || a.orderedAt - b.orderedAt || a.pickListNumber.localeCompare(b.pickListNumber) || a.lineNumber - b.lineNumber);
  const holds: PlannedHold[] = [];
  for (const line of ordered) {
    if (line.parts.length) {
      for (const part of line.parts) {
        const have = taken(line, part.sku, part.per);
        const granted = grant.get(claimKey(line.itemId, part.sku)) ?? 0;
        const extra = Math.min(Math.max(0, line.required * part.per - have - granted), free.get(part.sku) ?? 0);
        const qty = have + extra + granted;
        if (qty > 0) holds.push({ itemId: line.itemId, sku: part.sku, qty });
        free.set(part.sku, (free.get(part.sku) ?? 0) - extra);
      }
    } else {
      const have = taken(line, line.sku, 1);
      const granted = grant.get(claimKey(line.itemId, line.sku)) ?? 0;
      const extra = Math.min(Math.max(0, line.required - have - granted), free.get(line.sku) ?? 0);
      const qty = have + extra + granted;
      if (qty > 0) holds.push({ itemId: line.itemId, sku: line.sku, qty });
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
            pli.is_custom, wp.kit_components, (pli.forced_at IS NOT NULL) AS forced,
            pl.pick_list_number,
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
        AND (pl.payment_status IN ('captured', 'partially_refunded') OR COALESCE(pl.purchase_order_number, '') <> '')
        AND pli.quantity_required > 0
        AND NOT pli.is_custom
        AND pli.product_sku NOT ILIKE '%SAMPLE%'`
  );

  const lines: HoldDemand[] = demand.rows.map((row: any) => {
    const stored = kitParts(row.product_sku, row.kit_components);
    return {
      itemId: row.item_id,
      orderedAt: new Date(row.ordered_at).getTime(),
      pickListNumber: row.pick_list_number || '',
      lineNumber: Number(row.line_number) || 0,
      sku: row.product_sku,
      required: Number(row.quantity_required) || 0,
      picked: Number(row.quantity_picked) || 0,
      parts: stored.length ? stored : trayPackParts(row.product_sku),
      scanned: new Map<string, number>(),
      forced: Boolean(row.forced),
    };
  });
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
  for (const sku of [...skus]) {
    const single = /^(.+)P1-000$/i.exec(sku);
    if (single) skus.add(`${single[1]}P5-000`);
    for (const part of trayPackParts(sku)) skus.add(part.sku);
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
  const packs = [...onHand.keys()]
    .map((sku) => ({ sku, parts: trayPackParts(sku) }))
    .filter((kit) => kit.parts.length > 0 && (onHand.get(kit.sku) ?? 0) > 0);
  const withKits = applyKitStock(onHand, packs);

  const claims: HoldClaim[] = [];
  if (lines.length) {
    const claimed = await query(
      `SELECT pick_list_item_id, from_pick_list_item_id, sku, qty
         FROM stock_preempts
        WHERE pick_list_item_id = ANY($1::uuid[])
          AND from_pick_list_item_id = ANY($1::uuid[])`,
      [lines.map((line) => line.itemId)]
    );
    for (const row of claimed.rows) {
      claims.push({
        itemId: row.pick_list_item_id,
        fromItemId: row.from_pick_list_item_id,
        sku: row.sku,
        qty: Number(row.qty) || 0,
      });
    }
  }

  const holds = planHolds(lines, withKits, claims);
  const unique = new Map<string, PlannedHold>();
  for (const hold of holds) {
    const key = `${hold.itemId}\0${hold.sku}`;
    const existing = unique.get(key);
    if (!existing || hold.qty > existing.qty) unique.set(key, hold);
  }
  const rows = [...unique.values()];
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(842461)');
    await client.query('DELETE FROM order_stock_holds');
    if (rows.length) {
      await client.query(
        `INSERT INTO order_stock_holds (pick_list_item_id, sku, qty)
         SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::int[])
         ON CONFLICT (pick_list_item_id, sku) DO UPDATE SET qty = EXCLUDED.qty`,
        [rows.map((hold) => hold.itemId), rows.map((hold) => hold.sku), rows.map((hold) => hold.qty)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  await computeBoxHolds();
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
  // A failed rebuild must not fail the scan. The phone stops the whole queue on a server error.
  return chain;
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
    `SELECT pl.is_sandbox, pl.status, pli.product_sku, pli.is_custom, wp.kit_components,
            EXISTS (
              SELECT 1 FROM collection_bookings cb
               WHERE cb.pick_list_id = pl.id
                 AND cb.status <> 'cancelled'
                 AND COALESCE(cb.direction, 'outbound') <> 'return'
            ) AS booked
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
  // Booking marks the order shipped before the scanner has uploaded its picks, which drops it out of
  // the assignment. The picks were already made. Record them instead of refusing them.
  if (row.booked || row.status === 'DISPATCHED') return null;
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
