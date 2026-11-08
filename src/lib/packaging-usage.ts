/**
 * Takes tagged packaging boxes off stock when an order ships.
 *
 * A box is tagged when the packaging catalogue's preferred bill of materials
 * lists it against the product code. Kit lines use the component that actually
 * ships (the frozen sale demand, or the current kit where that was never stored).
 * Each shipped order is applied once: a second call does not take the boxes off again.
 */
import type { PoolClient } from 'pg';
import { query } from '../db/index.js';

type Sql = PoolClient | { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export interface PackagingUsage {
  code: string;
  taken: number;
  stock_on_hand: number;
}

const CONSUME = `
  WITH units AS (
    SELECT pl.id AS pick_list_id, pl.pick_list_number, pli.id AS item_id,
           CASE WHEN pli.quantity_picked > 0 THEN pli.quantity_picked ELSE pli.quantity_required END AS line_qty,
           upper(pli.product_sku) AS product_sku, wp.is_kit, wp.kit_components
    FROM pick_lists pl
    JOIN pick_list_items pli ON pli.pick_list_id = pl.id
    LEFT JOIN LATERAL (
      SELECT is_kit, kit_components FROM wms_products
      WHERE variant_sku = pli.product_sku AND NOT is_archived
      LIMIT 1
    ) wp ON true
    WHERE pl.id = ANY($1::uuid[])
      AND pl.status = 'DISPATCHED'
      AND NOT COALESCE(pl.is_sandbox, false)
      AND NOT COALESCE(pli.is_custom, false)
      AND CASE WHEN pli.quantity_picked > 0 THEN pli.quantity_picked ELSE pli.quantity_required END > 0
  ),
  parts AS (
    SELECT u.pick_list_id, u.pick_list_number, upper(sd.component_sku) AS sku,
           (u.line_qty * sd.per_unit_qty)::numeric AS qty
    FROM units u
    JOIN sale_demand sd ON sd.pick_list_item_id = u.item_id AND NOT COALESCE(sd.is_custom, false)
    UNION ALL
    SELECT u.pick_list_id, u.pick_list_number, upper(comp.sku),
           (u.line_qty * COALESCE(comp.required_quantity, 1))::numeric
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
    SELECT u.pick_list_id, u.pick_list_number, u.product_sku, u.line_qty
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
  ),
  matched AS (
    SELECT p.pick_list_id, p.pick_list_number, box.packaging_item_id,
           ROUND(SUM(p.qty * box.per))::int AS qty
    FROM parts p
    JOIN LATERAL (
      SELECT i.id AS packaging_item_id, l.qty AS per
      FROM packaging_boms b
      JOIN packaging_bom_lines l ON l.bom_id = b.id
      JOIN packaging_items i ON i.id = l.packaging_item_id AND i.item_type = 'box'
      WHERE b.is_active AND b.option_rank = 1
        AND (
          upper(b.sku) = p.sku
          OR (b.sku IS NULL AND (p.sku = upper(b.product_code) OR p.sku LIKE upper(b.product_code) || '-%'))
        )
      ORDER BY (b.sku IS NOT NULL) DESC, length(b.product_code) DESC NULLS LAST
      LIMIT 1
    ) box ON true
    GROUP BY p.pick_list_id, p.pick_list_number, box.packaging_item_id
  ),
  inserted AS (
    INSERT INTO packaging_stock_movements
      (packaging_item_id, movement_type, qty, pick_list_id, reason, created_by, extra)
    SELECT m.packaging_item_id, 'pack_usage', -m.qty, m.pick_list_id,
           'Shipped on ' || m.pick_list_number, $2,
           jsonb_build_object('source', 'shipment', 'pick_list_number', m.pick_list_number)
    FROM matched m
    WHERE m.qty > 0
      AND NOT EXISTS (
        SELECT 1 FROM packaging_stock_movements existing
        WHERE existing.pick_list_id = m.pick_list_id
          AND existing.movement_type = 'pack_usage'
          AND existing.extra->>'source' = 'shipment'
      )
    RETURNING packaging_item_id, qty
  ),
  updated AS (
    UPDATE packaging_items i
    SET stock_on_hand = stock_on_hand + s.qty, updated_at = NOW()
    FROM (SELECT packaging_item_id, SUM(qty)::int AS qty FROM inserted GROUP BY packaging_item_id) s
    WHERE i.id = s.packaging_item_id
    RETURNING i.code, (-s.qty)::int AS taken, i.stock_on_hand
  )
  SELECT code, taken, stock_on_hand FROM updated ORDER BY code
`;

/** Reduces box stock for these shipped pick lists. Lists already recorded are left alone. */
export async function consumeBoxesForShipments(db: Sql, pickListIds: string[], createdBy?: string | null): Promise<PackagingUsage[]> {
  const ids = [...new Set(pickListIds.filter(Boolean))];
  if (!ids.length) return [];
  const result = await db.query(CONSUME, [ids, createdBy || null]);
  return result.rows as PackagingUsage[];
}

/** Every dispatched order that has not yet had its boxes taken off. */
export async function consumeOutstandingShipmentBoxes(createdBy?: string | null): Promise<PackagingUsage[]> {
  const pending = await query(
    `SELECT pl.id
     FROM pick_lists pl
     WHERE pl.status = 'DISPATCHED'
       AND NOT COALESCE(pl.is_sandbox, false)
       AND NOT EXISTS (
         SELECT 1 FROM packaging_stock_movements m
         WHERE m.pick_list_id = pl.id
           AND m.movement_type = 'pack_usage'
           AND m.extra->>'source' = 'shipment'
       )`,
  );
  return consumeBoxesForShipments({ query }, pending.rows.map((row) => row.id), createdBy);
}
