/**
 * Assigns boxes on hand to open paid orders, oldest first.
 * An order already being picked keeps the boxes it is using.
 * The box stays on the shelf until the order ships. This does not change stock_on_hand.
 */
import { getPool, query } from '../db/index.js';
import { ensureForcedColumns } from './forced-columns.js';

export interface BoxDemand {
  itemId: string;
  orderedAt: number;
  pickListNumber: string;
  lineNumber: number;
  boxId: string;
  required: number;
  started: boolean;
  /** Force-added: served before every other order, started or not. */
  forced?: boolean;
}

export interface PlannedBoxHold {
  itemId: string;
  boxId: string;
  qty: number;
}

const STARTED = new Set(['IN_PROGRESS', 'PICKED', 'PACKING', 'PACKED', 'LABEL_PRINTED']);

/** Oldest order takes the boxes that are on the shelf. A started order is served before one still waiting. */
export function planBoxHolds(lines: BoxDemand[], onHand: Map<string, number>): PlannedBoxHold[] {
  const free = new Map<string, number>();
  for (const [id, qty] of onHand) free.set(id, Math.max(0, qty));

  const grant = (rows: BoxDemand[]) => {
    const holds: PlannedBoxHold[] = [];
    const ordered = [...rows].sort((a, b) => a.orderedAt - b.orderedAt || a.pickListNumber.localeCompare(b.pickListNumber) || a.lineNumber - b.lineNumber);
    for (const line of ordered) {
      const need = Math.max(0, Math.round(line.required));
      const give = Math.min(need, free.get(line.boxId) ?? 0);
      if (give <= 0) continue;
      holds.push({ itemId: line.itemId, boxId: line.boxId, qty: give });
      free.set(line.boxId, (free.get(line.boxId) ?? 0) - give);
    }
    return holds;
  };

  return [
    ...grant(lines.filter((line) => line.forced)),
    ...grant(lines.filter((line) => !line.forced && line.started)),
    ...grant(lines.filter((line) => !line.forced && !line.started)),
  ];
}

const DEMAND = `
  WITH units AS (
    SELECT pli.id AS item_id, pl.pick_list_number, pli.line_number, pl.status, (pli.forced_at IS NOT NULL) AS forced,
           CASE WHEN COALESCE(pl.is_return, false) THEN pl.created_at
                ELSE COALESCE(parent.created_at, pl.created_at) END AS ordered_at,
           CASE WHEN pli.quantity_picked > 0 THEN pli.quantity_picked ELSE pli.quantity_required END AS line_qty,
           regexp_replace(upper(pli.product_sku), '^PLINTH-', 'MDHP-') AS product_sku, wp.is_kit, wp.kit_components
    FROM pick_list_items pli
    JOIN pick_lists pl ON pl.id = pli.pick_list_id
    LEFT JOIN pick_lists parent ON parent.id = pl.parent_pick_list_id
    LEFT JOIN LATERAL (
      SELECT is_kit, kit_components FROM wms_products
      WHERE variant_sku = pli.product_sku AND NOT is_archived
      LIMIT 1
    ) wp ON true
    WHERE NOT pl.is_sandbox AND NOT COALESCE(pli.is_sandbox, false)
      AND NOT pli.is_archived AND NOT COALESCE(pl.is_archived, false)
      AND NOT COALESCE(pl.is_return, false)
      AND pl.status NOT IN ('DISPATCHED', 'CANCELLED')
      AND (pl.payment_status IN ('captured', 'partially_refunded') OR COALESCE(pl.purchase_order_number, '') <> '' OR pli.forced_at IS NOT NULL)
      AND pli.quantity_required > 0
      AND NOT COALESCE(pli.is_custom, false)
      AND pli.product_sku NOT ILIKE '%SAMPLE%'
      AND NOT EXISTS (
        SELECT 1 FROM packaging_stock_movements m
        WHERE m.pick_list_id = pl.id
          AND m.movement_type = 'pack_usage'
          AND m.extra->>'source' = 'shipment'
      )
  ),
  parts AS (
    SELECT u.item_id, u.pick_list_number, u.line_number, u.status, u.ordered_at, u.forced,
           regexp_replace(upper(sd.component_sku), '^PLINTH-', 'MDHP-') AS sku, (u.line_qty * sd.per_unit_qty)::numeric AS qty
    FROM units u
    JOIN sale_demand sd ON sd.pick_list_item_id = u.item_id AND NOT COALESCE(sd.is_custom, false)
    UNION ALL
    SELECT u.item_id, u.pick_list_number, u.line_number, u.status, u.ordered_at, u.forced,
           regexp_replace(upper(comp.sku), '^PLINTH-', 'MDHP-'), (u.line_qty * COALESCE(comp.required_quantity, 1))::numeric
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
    SELECT u.item_id, u.pick_list_number, u.line_number, u.status, u.ordered_at, u.forced,
           u.product_sku, u.line_qty
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
  SELECT p.item_id, p.pick_list_number, p.line_number, p.status, p.ordered_at, bool_or(p.forced) AS forced,
         box.packaging_item_id, ROUND(SUM(p.qty * box.per))::int AS qty
  FROM parts p
  JOIN LATERAL (
    SELECT i.id AS packaging_item_id, l.qty AS per
    FROM packaging_boms b
    JOIN packaging_bom_lines l ON l.bom_id = b.id
    JOIN packaging_items i ON i.id = l.packaging_item_id AND i.item_type = 'box' AND i.is_active
    WHERE b.is_active AND b.option_rank = 1
      AND (
        upper(b.sku) = p.sku
        OR (b.sku IS NULL AND b.product_code IS NOT NULL AND (p.sku = upper(b.product_code) OR p.sku LIKE upper(b.product_code) || '-%'))
      )
    ORDER BY (b.sku IS NOT NULL) DESC, length(b.product_code) DESC NULLS LAST
    LIMIT 1
  ) box ON true
  WHERE COALESCE(p.sku, '') <> '' AND p.sku NOT LIKE '%SAMPLE%'
  GROUP BY p.item_id, p.pick_list_number, p.line_number, p.status, p.ordered_at, box.packaging_item_id
`;

async function ensureBoxHoldTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS order_box_holds (
      pick_list_item_id UUID NOT NULL REFERENCES pick_list_items(id) ON DELETE CASCADE,
      packaging_item_id UUID NOT NULL REFERENCES packaging_items(id) ON DELETE CASCADE,
      qty INT NOT NULL CHECK (qty > 0),
      PRIMARY KEY (pick_list_item_id, packaging_item_id)
    )
  `);
}

/** Rewrites which open order holds each box. */
export async function computeBoxHolds(): Promise<void> {
  await ensureForcedColumns();
  await ensureBoxHoldTable();
  const demand = await query(DEMAND);
  const lines: BoxDemand[] = demand.rows
    .filter((row: { qty?: number }) => Number(row.qty) > 0)
    .map((row: any) => ({
      itemId: row.item_id,
      orderedAt: new Date(row.ordered_at).getTime(),
      pickListNumber: row.pick_list_number || '',
      lineNumber: Number(row.line_number) || 0,
      boxId: row.packaging_item_id,
      required: Number(row.qty) || 0,
      started: STARTED.has(String(row.status || '')),
      forced: Boolean(row.forced),
    }));

  const boxIds = [...new Set(lines.map((line) => line.boxId))];
  const onHand = new Map<string, number>();
  if (boxIds.length) {
    const stock = await query(
      `SELECT id, stock_on_hand FROM packaging_items WHERE id = ANY($1::uuid[])`,
      [boxIds],
    );
    for (const row of stock.rows) onHand.set(row.id, Number(row.stock_on_hand) || 0);
  }
  const holds = planBoxHolds(lines, onHand);

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(842462)');
    await client.query('DELETE FROM order_box_holds');
    if (holds.length) {
      await client.query(
        `INSERT INTO order_box_holds (pick_list_item_id, packaging_item_id, qty)
         SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::int[])`,
        [holds.map((hold) => hold.itemId), holds.map((hold) => hold.boxId), holds.map((hold) => hold.qty)],
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

/** Boxes held for these pick lists, keyed by line id then box code. */
export async function boxHoldsForItems(pickListIds: string[]): Promise<Record<string, Record<string, number>>> {
  if (!pickListIds.length) return {};
  await ensureBoxHoldTable();
  const rows = await query(
    `SELECT h.pick_list_item_id, i.code, h.qty
       FROM order_box_holds h
       JOIN pick_list_items pli ON pli.id = h.pick_list_item_id
       JOIN packaging_items i ON i.id = h.packaging_item_id
      WHERE pli.pick_list_id = ANY($1::uuid[])`,
    [pickListIds],
  );
  const out: Record<string, Record<string, number>> = {};
  for (const row of rows.rows) {
    const itemId = String(row.pick_list_item_id);
    const code = String(row.code || '');
    if (!code) continue;
    if (!out[itemId]) out[itemId] = {};
    out[itemId][code] = (out[itemId][code] || 0) + (Number(row.qty) || 0);
  }
  return out;
}
