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
import { kitParts, trayPackParts } from './stock-holds.js';

interface KitComponent { sku: string; required_quantity?: number }

export interface DispatchShortfall { sku: string; short: number }

export interface DispatchStockResult { syncSkus: string[]; shortfalls: DispatchShortfall[] }

export async function applyDispatchStock(
  client: PoolClient,
  pickList: { id: string; medusa_order_id: string | null },
  userId: string,
  onlySkus?: string[],
): Promise<DispatchStockResult> {
  const items = (await client.query(
    `SELECT pli.id, pli.product_sku, pli.quantity_picked, pli.picked_from_location_id, pli.is_custom,
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

  if (!items.length) return { syncSkus: [], shortfalls: [] };

  const syncSkus = new Set<string>();
  const shortfalls: DispatchShortfall[] = [];
  const wanted = onlySkus?.length ? new Set(onlySkus) : null;
  const alreadyTaken = new Set(
    (await client.query(
      `SELECT pick_list_item_id FROM warehouse_movements
       WHERE pick_list_item_id = ANY($1::uuid[])
       GROUP BY pick_list_item_id
       HAVING SUM(quantity) < 0`,
      [items.map((item) => item.id)],
    )).rows.map((row) => row.pick_list_item_id),
  );

  for (const item of items) {
    const picked = parseInt(item.quantity_picked, 10);
    if (!item.product_sku || !picked) continue;
    if (wanted && !wanted.has(item.product_sku)) {
      const componentSkus = Array.isArray(item.kit_components)
        ? item.kit_components.map((part) => part?.sku).filter((sku): sku is string => Boolean(sku))
        : [];
      // A wooden-handle Home Filer is booked as the cabinet and the handles, not the parent kit code.
      if (!componentSkus.some((sku) => wanted.has(sku))) continue;
    }
    if (alreadyTaken.has(item.id)) continue;

    // Custom (no SKU) lines carry no stock: record the sale so Stock Sold can list it
    if (item.is_custom) {
      await client.query(
        `INSERT INTO warehouse_movements (movement_type, location_id, product_sku, quantity, notes, performed_by, order_id, pick_list_item_id)
         VALUES ('DISPATCH', NULL, $1, $2, 'Custom item', $3, $4, $5)`,
        [item.product_sku, -picked, userId, pickList.medusa_order_id, item.id]
      );
      continue;
    }

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
        const holders = (await client.query(
          `SELECT variant_sku, kit_components FROM wms_products
            WHERE NOT COALESCE(is_archived, false)
              AND jsonb_typeof(kit_components) = 'array'
              AND kit_components::text LIKE $1`,
          [`%${sku}%`],
        )).rows;
        const single = /^(.+)P1-000$/i.exec(sku);
        if (single) holders.push({ variant_sku: `${single[1]}P5-000`, kit_components: [{ sku, required_quantity: 5 }] });
        const packs = holders.flatMap((holder) => {
          const part = kitParts(holder.variant_sku, holder.kit_components).find((item) => item.sku === sku);
          return part ? [{ packSku: holder.variant_sku as string, size: part.per }] : [];
        });
        for (const pack of packs) {
          if (remaining <= 0) break;
          const packRows = (await client.query(
            `SELECT id, location_id, quantity FROM warehouse_inventory
             WHERE product_sku = $1 AND quantity > 0
             ORDER BY quantity DESC
             FOR UPDATE`,
            [pack.packSku],
          )).rows;
          for (const row of packRows) {
            if (remaining <= 0) break;
            const available = Math.max(0, parseInt(row.quantity, 10));
            const open = Math.min(available, Math.ceil(remaining / pack.size));
            if (open <= 0) continue;
            const yielded = open * pack.size;
            const used = Math.min(remaining, yielded);
            await client.query(
              `UPDATE warehouse_inventory
               SET quantity = quantity - $1, quantity_reserved = GREATEST(quantity_reserved - $1, 0), updated_at = NOW()
               WHERE id = $2`,
              [open, row.id],
            );
            const singles = await client.query(
              `UPDATE warehouse_inventory SET quantity = quantity + $1, updated_at = NOW()
               WHERE id = (
                 SELECT id FROM warehouse_inventory
                 WHERE location_id = $2 AND product_sku = $3
                 ORDER BY quantity DESC LIMIT 1
               )
               RETURNING id, location_id`,
              [yielded, row.location_id, sku],
            );
            const singleRow = singles.rows[0] ?? (await client.query(
              `INSERT INTO warehouse_inventory (location_id, product_sku, quantity)
               VALUES ($1, $2, $3)
               RETURNING id, location_id`,
              [row.location_id, sku, yielded],
            )).rows[0];
            await client.query(
              `UPDATE warehouse_inventory SET quantity = quantity - $1, updated_at = NOW() WHERE id = $2`,
              [used, singleRow.id],
            );
            const opened = `${kitNote ? kitNote + '; ' : ''}Opened into ${sku}`;
            await client.query(
              `INSERT INTO warehouse_movements (movement_type, location_id, product_sku, quantity, notes, performed_by, order_id)
               VALUES ('ADJUST', $1, $2, $3, $4, $5, $6), ('ADJUST', $7, $8, $9, $4, $5, $6)`,
              [row.location_id, pack.packSku, -open, opened, userId, pickList.medusa_order_id, singleRow.location_id, sku, yielded],
            );
            await client.query(
              `INSERT INTO warehouse_movements (movement_type, location_id, product_sku, quantity, notes, performed_by, order_id, pick_list_item_id)
               VALUES ('DISPATCH', $1, $2, $3, $4, $5, $6, $7)`,
              [singleRow.location_id, sku, -used, kitNote, userId, pickList.medusa_order_id, item.id],
            );
            remaining -= used;
            syncSkus.add(pack.packSku);
            syncSkus.add(sku);
          }
        }
      }

      const madeOf = trayPackParts(sku);
      if (remaining > 0 && madeOf.length === 1) {
        const part = madeOf[0];
        const singleRows = (await client.query(
          `SELECT id, location_id, quantity FROM warehouse_inventory
           WHERE product_sku = $1 AND quantity > 0
           ORDER BY quantity DESC
           FOR UPDATE`,
          [part.sku],
        )).rows;
        const available = singleRows.reduce((sum, row) => sum + Math.max(0, parseInt(row.quantity, 10)), 0);
        const packsFromSingles = Math.min(remaining, Math.floor(available / part.per));
        let take = packsFromSingles * part.per;
        for (const row of singleRows) {
          if (take <= 0) break;
          const used = Math.min(take, Math.max(0, parseInt(row.quantity, 10)));
          if (used <= 0) continue;
          await client.query(
            `UPDATE warehouse_inventory
             SET quantity = quantity - $1, quantity_reserved = GREATEST(quantity_reserved - $1, 0), updated_at = NOW()
             WHERE id = $2`,
            [used, row.id],
          );
          await client.query(
            `INSERT INTO warehouse_movements (movement_type, location_id, product_sku, quantity, notes, performed_by, order_id, pick_list_item_id)
             VALUES ('DISPATCH', $1, $2, $3, $4, $5, $6, $7)`,
            [row.location_id, part.sku, -used, `${kitNote ? kitNote + '; ' : ''}Singles for ${sku}`, userId, pickList.medusa_order_id, item.id],
          );
          take -= used;
          syncSkus.add(part.sku);
        }
        remaining -= packsFromSingles;
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
