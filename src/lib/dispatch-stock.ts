/**
 * Dispatch stock movement: turns a dispatched pick list into per-SKU stock decrements and ledger rows.
 *
 * Purpose: kit lines are expanded to their components (kits hold no stock of their own), stock is taken from the
 *   bay the item was picked from first and then from any other bay, and every unit sold is recorded as a negative
 *   DISPATCH row in warehouse_movements - including units for which no stock was on hand - so sold counts are never lost.
 * Inputs:  a pg client already inside a transaction, the pick list row, and the acting user's id (UUID).
 * Output:  SKUs whose WMS totals changed (to push to Medusa) and any shortfalls (units sold with no WMS stock to take).
 * Used by: PATCH /api/pick-lists/:pickListId/dispatch
 */
import type { PoolClient } from 'pg';

interface KitComponent { sku: string; required_quantity?: number }

export interface DispatchShortfall { sku: string; short: number }

export interface DispatchStockResult { syncSkus: string[]; shortfalls: DispatchShortfall[] }

export async function applyDispatchStock(
  client: PoolClient,
  pickList: { id: string; medusa_order_id: string | null },
  userId: string,
): Promise<DispatchStockResult> {
  const items = (await client.query(
    `SELECT pli.id, pli.product_sku, pli.quantity_picked, pli.picked_from_location_id,
            wp.is_kit, wp.kit_components, wp.unit_cost_gbp AS sku_unit_cost_gbp, wp.price_gbp AS product_price_gbp,
            (SELECT wi.liability_status FROM warehouse_inventory wi
              WHERE wi.product_sku = pli.product_sku AND wi.location_id = pli.picked_from_location_id LIMIT 1) AS inv_liability_status
     FROM pick_list_items pli
     LEFT JOIN LATERAL (
       SELECT is_kit, kit_components, unit_cost_gbp, price_gbp FROM wms_products
       WHERE variant_sku = pli.product_sku ORDER BY is_archived ASC LIMIT 1
     ) wp ON true
     WHERE pli.pick_list_id = $1 AND pli.quantity_picked > 0`,
    [pickList.id],
  )).rows;

  const syncSkus = new Set<string>();
  const shortfalls: DispatchShortfall[] = [];

  for (const item of items) {
    const picked = parseInt(item.quantity_picked, 10);
    if (!item.product_sku || !picked) continue;

    const components: KitComponent[] = item.is_kit && Array.isArray(item.kit_components) ? item.kit_components : [];
    const parts = new Map<string, number>();
    if (components.length) {
      for (const c of components) parts.set(c.sku, (parts.get(c.sku) ?? 0) + picked * (Number(c.required_quantity) || 1));
    } else {
      parts.set(item.product_sku, picked);
    }
    const kitNote = components.length ? `Kit ${item.product_sku} x${picked}` : null;

    for (const [sku, qty] of parts) {
      const rows = (await client.query(
        `SELECT id, location_id, quantity FROM warehouse_inventory
         WHERE product_sku = $1
         ORDER BY (location_id = $2::uuid) DESC NULLS LAST, quantity DESC
         FOR UPDATE`,
        [sku, item.picked_from_location_id ?? null],
      )).rows;

      let remaining = qty;
      for (const row of rows) {
        const take = Math.min(remaining, Math.max(0, parseInt(row.quantity, 10)));
        if (take <= 0) continue;
        await client.query(
          `UPDATE warehouse_inventory
           SET quantity = quantity - $1, quantity_reserved = GREATEST(quantity_reserved - $1, 0), updated_at = NOW()
           WHERE id = $2`,
          [take, row.id],
        );
        await client.query(
          `INSERT INTO warehouse_movements (movement_type, location_id, product_sku, quantity, notes, performed_by, order_id, pick_list_item_id)
           VALUES ('DISPATCH', $1, $2, $3, $4, $5, $6, $7)`,
          [row.location_id, sku, -take, kitNote, userId, pickList.medusa_order_id, item.id],
        );
        remaining -= take;
        syncSkus.add(sku);
        if (remaining === 0) break;
      }

      if (remaining > 0) {
        await client.query(
          `INSERT INTO warehouse_movements (movement_type, location_id, product_sku, quantity, notes, performed_by, order_id, pick_list_item_id)
           VALUES ('DISPATCH', NULL, $1, $2, $3, $4, $5, $6)`,
          [sku, -remaining, `${kitNote ? kitNote + '; ' : ''}no WMS stock on hand for ${remaining}`, userId, pickList.medusa_order_id, item.id],
        );
        shortfalls.push({ sku, short: remaining });
      }
    }

    await client.query(
      `UPDATE pick_list_items
       SET unit_cost_gbp = $1, unit_price_gbp = $2, liability_status = $3, updated_at = NOW()
       WHERE id = $4`,
      [item.sku_unit_cost_gbp ?? null, item.product_price_gbp ?? null, item.inv_liability_status ?? 'Bisley', item.id],
    );
  }

  return { syncSkus: [...syncSkus], shortfalls };
}
