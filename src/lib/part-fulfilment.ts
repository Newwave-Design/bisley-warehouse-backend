/**
 * Part fulfilment moves scanned goods onto their own pick list so a collection can be
 * booked for those goods only. The rest stay on the original list. A normal line can
 * split by quantity (2 of 10 cabinets). An inventory kit never splits: it moves only
 * when the whole kit is scanned, otherwise it stays in To pick. This does not raise a reorder.
 */
import { getPool } from '../db/index.js';
import { scheduleAllocationRun } from './allocation.js';
import { rootMedusaOrderId } from './order-values.js';
import { recordPickListEvents } from './pick-list-events.js';
import { kitParts, scheduleStockHolds } from './stock-holds.js';

const OPENABLE = ['PENDING', 'IN_PROGRESS', 'PICKED', 'PACKING', 'PACKED', 'LABEL_PRINTED'];

export type PartLine = {
  id: string;
  product_sku: string;
  quantity_required: number;
  quantity_picked: number;
  status: string;
  is_kit?: boolean;
};

export type QtySplit = { id: string; sku: string; picked: number; keep: number };

export type PartFulfilPlan =
  | { action: 'book' }
  | { action: 'blocked'; message: string; partial_skus: string[] }
  | {
      action: 'prompt';
      message: string;
      ready_count: number;
      waiting_count: number;
      ready_skus: string[];
      waiting_skus: string[];
      ready_ids: string[];
      qty_splits: QtySplit[];
    };

export class PartFulfilError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function isInventoryKit(sku: string, raw: unknown): boolean {
  return kitParts(sku, raw).length > 0;
}

function qtyLabel(sku: string, qty: number): string {
  return qty > 1 ? `${sku} ×${qty}` : sku;
}

/** A kit moves only when it is fully scanned. Any other line can move the quantity already scanned. */
export function planPartFulfilment(items: PartLine[]): PartFulfilPlan {
  const readyIds: string[] = [];
  const qtySplits: QtySplit[] = [];
  const readyLabels: string[] = [];
  const waitingLabels: string[] = [];

  for (const item of items) {
    const required = Number(item.quantity_required) || 0;
    if (required <= 0) continue;
    const picked = Math.max(0, Number(item.quantity_picked) || 0);
    const sku = item.product_sku;
    if (item.is_kit) {
      if (picked >= required) {
        readyIds.push(item.id);
        readyLabels.push(qtyLabel(sku, required));
      } else {
        waitingLabels.push(qtyLabel(sku, required));
      }
      continue;
    }
    if (picked >= required) {
      readyIds.push(item.id);
      readyLabels.push(qtyLabel(sku, required));
    } else if (picked > 0) {
      qtySplits.push({ id: item.id, sku, picked, keep: required - picked });
      readyLabels.push(qtyLabel(sku, picked));
      waitingLabels.push(qtyLabel(sku, required - picked));
    } else {
      waitingLabels.push(qtyLabel(sku, required));
    }
  }

  const moving = readyIds.length + qtySplits.length;
  if (moving > 0 && waitingLabels.length > 0) {
    return {
      action: 'prompt',
      ready_count: moving,
      waiting_count: waitingLabels.length,
      ready_skus: readyLabels,
      waiting_skus: waitingLabels,
      ready_ids: readyIds,
      qty_splits: qtySplits,
      message: `${moving} scanned ${moving === 1 ? 'part' : 'parts'} can be booked. ${waitingLabels.length} ${waitingLabels.length === 1 ? 'part stays' : 'parts stay'} in To pick.`,
    };
  }
  return { action: 'book' };
}

type Header = {
  id: string;
  medusa_order_id: string;
  pick_list_number: string;
  status: string;
  customer_name: string | null;
  customer_email: string | null;
  shipping_method_name: string | null;
  shipping_method_code: string | null;
  shipping_address: unknown;
  is_sandbox: boolean;
  is_archived: boolean;
  payment_status: string | null;
  payment_checked_at: string | null;
  purchase_order_number: string | null;
  created_at: string;
};

async function loadHeader(client: { query: Function }, pickListId: string, lock: boolean): Promise<Header | null> {
  const header = await client.query(
    `SELECT id, medusa_order_id, pick_list_number, status, customer_name, customer_email,
            shipping_method_name, shipping_method_code, shipping_address, is_sandbox, is_archived,
            payment_status, payment_checked_at, purchase_order_number, created_at
       FROM pick_lists WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [pickListId],
  );
  return header.rows[0] || null;
}

type StoredLine = PartLine & {
  line_number: number;
  colour_code: string | null;
  is_sandbox: boolean;
  medusa_order_line_item_id: string | null;
  medusa_variant_id: string | null;
  medusa_product_id: string | null;
  is_custom: boolean;
  item_title: string | null;
  created_at: string;
};

async function loadPartLines(client: { query: Function }, pickListId: string, lock: boolean): Promise<StoredLine[]> {
  const items = await client.query(
    `SELECT pli.id, pli.product_sku, pli.quantity_required, pli.quantity_picked, pli.status, pli.line_number,
            pli.colour_code, pli.is_sandbox, pli.medusa_order_line_item_id, pli.medusa_variant_id, pli.medusa_product_id,
            pli.is_custom, pli.item_title, pli.created_at,
            (SELECT wp.kit_components FROM wms_products wp
              WHERE wp.variant_sku = pli.product_sku
              ORDER BY wp.is_archived
              LIMIT 1) AS kit_components
       FROM pick_list_items pli
      WHERE pli.pick_list_id = $1 AND NOT COALESCE(pli.is_archived, false)
      ORDER BY pli.line_number
      ${lock ? 'FOR UPDATE OF pli' : ''}`,
    [pickListId],
  );
  return items.rows.map((row: any) => ({
    id: row.id,
    product_sku: row.product_sku,
    quantity_required: Number(row.quantity_required) || 0,
    quantity_picked: Number(row.quantity_picked) || 0,
    status: row.status,
    is_kit: isInventoryKit(row.product_sku, row.kit_components),
    line_number: Number(row.line_number) || 1,
    colour_code: row.colour_code || null,
    is_sandbox: !!row.is_sandbox,
    medusa_order_line_item_id: row.medusa_order_line_item_id || null,
    medusa_variant_id: row.medusa_variant_id || null,
    medusa_product_id: row.medusa_product_id || null,
    is_custom: !!row.is_custom,
    item_title: row.item_title || null,
    created_at: row.created_at,
  }));
}

async function bookedAlready(client: { query: Function }, pickListId: string): Promise<boolean> {
  const booking = await client.query(
    `SELECT 1 FROM collection_bookings WHERE pick_list_id = $1 AND status <> 'cancelled' AND COALESCE(direction, 'outbound') <> 'return' LIMIT 1`,
    [pickListId],
  );
  return booking.rows.length > 0;
}

export async function inspectPartFulfilment(pickListId: string): Promise<PartFulfilPlan> {
  const client = await getPool().connect();
  try {
    const header = await loadHeader(client, pickListId, false);
    if (!header) throw new PartFulfilError(404, 'Pick list not found');
    if (header.is_archived || !OPENABLE.includes(header.status)) return { action: 'book' };
    if (await bookedAlready(client, pickListId)) return { action: 'book' };
    return planPartFulfilment(await loadPartLines(client, pickListId, false));
  } finally {
    client.release();
  }
}

function choosePartNumber(base: string, taken: Set<string>): string {
  if (!taken.has(`${base}-P`)) return `${base}-P`;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-P${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new PartFulfilError(409, 'Could not give the collected part its own pick list number');
}

export async function confirmPartFulfilment(pickListId: string, actor: string): Promise<
  | { action: 'book' }
  | { action: 'split'; child_id: string; child_pick_list_number: string; parent_pick_list_number: string }
> {
  const client = await getPool().connect();
  let released = false;
  try {
    await client.query('BEGIN');
    const header = await loadHeader(client, pickListId, true);
    if (!header) throw new PartFulfilError(404, 'Pick list not found');
    if (header.is_archived) throw new PartFulfilError(400, 'That pick list is archived');
    if (!OPENABLE.includes(header.status)) throw new PartFulfilError(400, `Cannot part fulfil a pick list with status ${header.status}`);
    if (await bookedAlready(client, pickListId)) {
      throw new PartFulfilError(400, 'This order already has a collection. Cancel it before part fulfilling.');
    }

    const stored = await loadPartLines(client, pickListId, true);
    const plan = planPartFulfilment(stored);
    if (plan.action === 'blocked') throw new PartFulfilError(400, plan.message);
    if (plan.action !== 'prompt') {
      await client.query('COMMIT');
      return { action: 'book' };
    }

    const root = rootMedusaOrderId(header.medusa_order_id);
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`.slice(-6).toUpperCase();
    const childOrderId = `${root}-PF${suffix}`;
    const numbers = await client.query(
      `SELECT pick_list_number FROM pick_lists WHERE pick_list_number LIKE $1`,
      [`${header.pick_list_number}-P%`],
    );
    const childNumber = choosePartNumber(header.pick_list_number, new Set(numbers.rows.map((row: { pick_list_number: string }) => row.pick_list_number)));

    const child = await client.query(
      `INSERT INTO pick_lists (
         medusa_order_id, pick_list_number, status, parent_pick_list_id,
         customer_name, customer_email, shipping_method_name, shipping_method_code, shipping_address,
         is_sandbox, notes, created_at, updated_at, started_at, completed_at,
         payment_status, payment_checked_at, purchase_order_number
       ) VALUES (
         $1, $2, 'PICKED', $3,
         $4, $5, $6, $7, $8::jsonb,
         $9, $10, $11, NOW(), NOW(), NOW(),
         $12, $13, $14
       ) RETURNING id`,
      [
        childOrderId,
        childNumber,
        header.id,
        header.customer_name,
        header.customer_email,
        header.shipping_method_name,
        header.shipping_method_code,
        JSON.stringify(header.shipping_address || {}),
        header.is_sandbox,
        `Part fulfilment of ${header.pick_list_number}. These are the scanned lines. The rest stay on the original pick list.`,
        header.created_at,
        header.payment_status,
        header.payment_checked_at,
        header.purchase_order_number,
      ],
    );
    const childId = child.rows[0].id as string;

    const byId = new Map(stored.map((row) => [row.id, row]));
    let lineNumber = 1;
    const movedIds = [...plan.ready_ids, ...plan.qty_splits.map((split) => split.id)];
    for (const id of plan.ready_ids) {
      await client.query(
        `UPDATE pick_list_items SET pick_list_id = $1, line_number = $2, updated_at = NOW() WHERE id = $3`,
        [childId, lineNumber, id],
      );
      lineNumber += 1;
    }
    for (const split of plan.qty_splits) {
      const row = byId.get(split.id);
      if (!row) throw new PartFulfilError(409, 'A scanned line changed. Try again.');
      await client.query(
        `UPDATE pick_list_items
            SET pick_list_id = $1, line_number = $2, quantity_required = $3, quantity_picked = $3, status = 'PICKED', updated_at = NOW()
          WHERE id = $4`,
        [childId, lineNumber, split.picked, split.id],
      );
      lineNumber += 1;
      await client.query(
        `INSERT INTO pick_list_items (
           pick_list_id, line_number, product_sku, colour_code, quantity_required, quantity_picked, status, is_sandbox,
           medusa_order_line_item_id, medusa_variant_id, medusa_product_id, is_custom, item_title, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 0, 'PENDING', $6, $7, $8, $9, $10, $11, $12, NOW())`,
        [
          header.id, row.line_number, row.product_sku, row.colour_code, split.keep, row.is_sandbox,
          row.medusa_order_line_item_id, row.medusa_variant_id, row.medusa_product_id, row.is_custom, row.item_title, row.created_at,
        ],
      );
    }
    await client.query(
      `UPDATE pick_scans SET pick_list_id = $1 WHERE pick_list_item_id = ANY($2::uuid[])`,
      [childId, movedIds],
    );
    await client.query(
      `UPDATE sale_allocations SET pick_list_id = $1, pick_list_number = $2 WHERE pick_list_item_id = ANY($3::uuid[])`,
      [childId, childNumber, movedIds],
    );
    const stillPicking = await client.query(
      `SELECT 1 FROM pick_list_items
        WHERE pick_list_id = $1 AND NOT COALESCE(is_archived, false)
          AND (COALESCE(quantity_picked, 0) > 0 OR status = 'PICKING')
        LIMIT 1`,
      [header.id],
    );
    await client.query(
      `UPDATE pick_lists SET status = $2, updated_at = NOW() WHERE id = $1`,
      [header.id, stillPicking.rows.length ? 'IN_PROGRESS' : 'PENDING'],
    );
    await client.query('COMMIT');
    client.release();
    released = true;

    const summary = `Part fulfilled. ${plan.ready_count} scanned ${plan.ready_count === 1 ? 'line' : 'lines'} moved to ${childNumber}.`;
    await recordPickListEvents({ ids: [header.id], actor, action: 'part_fulfil', summary }).catch((error) => {
      console.warn('[part-fulfilment] parent event was not saved', error instanceof Error ? error.message : error);
    });
    await recordPickListEvents({
      ids: [childId],
      actor,
      action: 'part_fulfil',
      summary: `Collected part of ${header.pick_list_number}.`,
    }).catch((error) => {
      console.warn('[part-fulfilment] child event was not saved', error instanceof Error ? error.message : error);
    });
    scheduleAllocationRun(`pick list ${header.pick_list_number} part fulfilled onto ${childNumber}`);
    scheduleStockHolds();

    return {
      action: 'split',
      child_id: childId,
      child_pick_list_number: childNumber,
      parent_pick_list_number: header.pick_list_number,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((error as { code?: string }).code === '23505') {
      throw new PartFulfilError(409, 'Could not split that order. Try again.');
    }
    throw error;
  } finally {
    if (!released) client.release();
  }
}
