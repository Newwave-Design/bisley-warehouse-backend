import { query } from '../db/index.js';
import { scheduleAllocationRun } from './allocation.js';

const SHIPPED = new Set(['DISPATCHED', 'PACKED', 'LABEL_PRINTED']);

export class UnsplitError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type ListRow = {
  id: string;
  pick_list_number: string;
  medusa_order_id: string;
  status: string;
  parent_pick_list_id: string | null;
  customer_name: string | null;
};

export function isShippedStatus(status: string) {
  return SHIPPED.has(status);
}

/** The two halves of a backorder split, or null when this list was not split that way. */
export async function findSplitPair(id: string): Promise<{ keeper: ListRow; spare: ListRow } | null> {
  const selfResult = await query(`SELECT * FROM pick_lists WHERE id = $1 AND NOT COALESCE(is_archived, false)`, [id]);
  const self = selfResult.rows[0] as ListRow | undefined;
  if (!self) return null;

  let other: ListRow | undefined;
  const ownId = String(self.medusa_order_id || '');
  if (self.parent_pick_list_id && /-BO/i.test(ownId)) {
    const parent = await query(`SELECT * FROM pick_lists WHERE id = $1 AND NOT COALESCE(is_archived, false)`, [self.parent_pick_list_id]);
    other = parent.rows[0];
  }
  if (!other) {
    const child = await query(
      `SELECT * FROM pick_lists
        WHERE parent_pick_list_id = $1 AND medusa_order_id LIKE '%-BO%' AND NOT COALESCE(is_archived, false)
        ORDER BY created_at DESC LIMIT 1`,
      [self.id]
    );
    other = child.rows[0];
  }
  if (!other) {
    const match = String(self.pick_list_number || '').match(/^(PL-\d{8}-\d+)-([12])$/i);
    if (match) {
      const sibling = `${match[1]}-${match[2] === '1' ? '2' : '1'}`;
      const found = await query(`SELECT * FROM pick_lists WHERE pick_list_number = $1 AND NOT COALESCE(is_archived, false)`, [sibling]);
      other = found.rows[0];
    }
  }
  if (!other || other.id === self.id) return null;

  const otherIsChild = /-BO/i.test(String(other.medusa_order_id || '')) || other.parent_pick_list_id === self.id;
  const selfIsChild = /-BO/i.test(ownId) || self.parent_pick_list_id === other.id;
  const keeper = selfIsChild && !otherIsChild ? other : otherIsChild && !selfIsChild ? self : (self.parent_pick_list_id ? other : self);
  const spare = keeper.id === self.id ? other : self;
  return { keeper, spare };
}

export async function splitPairView(id: string) {
  const pair = await findSplitPair(id);
  if (!pair) return { split: false as const };
  const shipped = isShippedStatus(pair.keeper.status) || isShippedStatus(pair.spare.status);
  const booked = await hasBooking(pair.keeper.id, pair.spare.id);
  const lines = await query(
    `SELECT product_sku, item_title, quantity_required, quantity_picked
       FROM pick_list_items
      WHERE pick_list_id = $1 AND NOT COALESCE(is_archived, false)
      ORDER BY line_number`,
    [pair.spare.id === id ? pair.keeper.id : pair.spare.id]
  );
  const other = pair.spare.id === id ? pair.keeper : pair.spare;
  return {
    split: true as const,
    canUnsplit: !shipped && !booked,
    reason: shipped ? 'shipped' as const : booked ? 'booked' as const : null,
    other: {
      id: other.id,
      pick_list_number: other.pick_list_number,
      status: other.status,
      customer_name: other.customer_name,
      lines: lines.rows.map((line) => ({
        sku: line.product_sku,
        title: line.item_title || line.product_sku,
        qty: Number(line.quantity_required) || 0,
        picked: Number(line.quantity_picked) || 0,
      })),
    },
  };
}

async function hasBooking(left: string, right: string) {
  const found = await query(
    `SELECT 1 FROM collection_bookings
      WHERE pick_list_id = ANY($1::uuid[]) AND status <> 'cancelled'
      LIMIT 1`,
    [[left, right]]
  );
  return found.rows.length > 0;
}

export async function unsplitPickList(id: string) {
  const pair = await findSplitPair(id);
  if (!pair) throw new UnsplitError(404, 'This order is not split');
  const { keeper, spare } = pair;
  if (isShippedStatus(keeper.status) || isShippedStatus(spare.status)) {
    throw new UnsplitError(409, 'A shipped part cannot be joined back');
  }
  if (await hasBooking(keeper.id, spare.id)) {
    throw new UnsplitError(409, 'A collection is already booked on one part');
  }

  const spareItems = await query(
    `SELECT * FROM pick_list_items WHERE pick_list_id = $1 AND NOT COALESCE(is_archived, false) ORDER BY line_number`,
    [spare.id]
  );
  const keeperItems = await query(
    `SELECT * FROM pick_list_items WHERE pick_list_id = $1 AND NOT COALESCE(is_archived, false)`,
    [keeper.id]
  );
  let nextLine = keeperItems.rows.reduce((max, row) => Math.max(max, Number(row.line_number) || 0), 0) + 1;

  for (const item of spareItems.rows) {
    const match = keeperItems.rows.find((row) =>
      row.product_sku === item.product_sku &&
      row.medusa_order_line_item_id &&
      row.medusa_order_line_item_id === item.medusa_order_line_item_id
    );
    if (match) {
      await query(
        `UPDATE pick_list_items
            SET quantity_required = quantity_required + $1,
                quantity_picked = quantity_picked + $2,
                updated_at = NOW()
          WHERE id = $3`,
        [Number(item.quantity_required) || 0, Number(item.quantity_picked) || 0, match.id]
      );
      await query(
        `UPDATE pick_scans SET pick_list_id = $1, pick_list_item_id = $2, updated_at = NOW() WHERE pick_list_item_id = $3`,
        [keeper.id, match.id, item.id]
      );
      await query(`UPDATE pick_list_items SET is_archived = true, updated_at = NOW() WHERE id = $1`, [item.id]);
    } else {
      await query(
        `UPDATE pick_list_items SET pick_list_id = $1, line_number = $2, updated_at = NOW() WHERE id = $3`,
        [keeper.id, nextLine++, item.id]
      );
      await query(`UPDATE pick_scans SET pick_list_id = $1, updated_at = NOW() WHERE pick_list_item_id = $2`, [keeper.id, item.id]);
    }

    const qty = Number(item.quantity_required) || 0;
    const reorder = await query(
      `SELECT id, qty_to_order, supplier_order_id
         FROM pending_reorders
        WHERE sku = $1 AND origin_pick_list_id = $2 AND source = 'BACKORDER' AND status IN ('PENDING', 'DELAYED')
        ORDER BY created_at DESC LIMIT 1`,
      [item.product_sku, keeper.id]
    );
    const row = reorder.rows[0];
    if (row) {
      const left = Number(row.qty_to_order) - qty;
      if (left <= 0) {
        await query(`UPDATE pending_reorders SET status = 'CANCELLED', qty_to_order = 0, updated_at = NOW() WHERE id = $1`, [row.id]);
      } else {
        await query(`UPDATE pending_reorders SET qty_to_order = $1, updated_at = NOW() WHERE id = $2`, [left, row.id]);
      }
      if (row.supplier_order_id) {
        await query(
          `UPDATE supplier_order_items
              SET quantity_ordered = GREATEST(quantity_ordered - $1, 0), updated_at = NOW()
            WHERE supplier_order_id = $2 AND product_sku = $3`,
          [qty, row.supplier_order_id, item.product_sku]
        );
      }
    }
  }

  const stamp = String(spare.id).slice(0, 8);
  await query(
    `UPDATE pick_lists
        SET is_archived = true,
            archived_at = NOW(),
            status = 'CANCELLED',
            planned_at = NULL,
            pick_list_number = LEFT(pick_list_number || '-M' || $2, 50),
            medusa_order_id = LEFT(medusa_order_id || '-merged', 100),
            updated_at = NOW()
      WHERE id = $1`,
    [spare.id, stamp]
  );

  const baseNumber = String(keeper.pick_list_number || '').replace(/-(?:1|2|B)$/i, '');
  const status = 'PENDING';
  await query(
    `UPDATE pick_lists
        SET pick_list_number = $2,
            planned_at = NULL,
            status = $3,
            updated_at = NOW()
      WHERE id = $1`,
    [keeper.id, baseNumber, status]
  );

  scheduleAllocationRun(`pick list ${keeper.id} joined back from a split`);
  return { id: keeper.id, pick_list_number: baseNumber, status };
}
