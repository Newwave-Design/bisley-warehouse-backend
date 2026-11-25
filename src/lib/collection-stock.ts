/**
 * Takes warehouse stock off when an APC collection is booked.
 * A later dispatch skips lines that already have a DISPATCH movement, so the same units are not removed twice.
 */
import { getPool, query } from '../db/index.js';
import { scheduleAllocationRun } from './allocation.js';
import { applyDispatchStock } from './dispatch-stock.js';
import { syncSkuToMedusa } from './medusa-inventory.js';
import { bookingSkusIncludingTraySingles } from './tray-stock.js';
import { consumeBoxesForShipments } from './packaging-usage.js';
import { isPaid } from './payment-status.js';

async function actorId(preferred?: string | null): Promise<string | null> {
  const given = String(preferred || '').trim();
  if (/^[0-9a-f-]{36}$/i.test(given)) return given;
  const found = await query(
    `SELECT id FROM warehouse_users WHERE status = 'ACTIVE' ORDER BY created_at NULLS LAST LIMIT 1`,
  );
  return found.rows[0]?.id ?? null;
}

async function pushStock(skus: string[]): Promise<void> {
  for (const sku of skus) {
    const total = await query(
      `SELECT SUM(quantity) as qty, SUM(quantity_reserved) as reserved FROM warehouse_inventory WHERE product_sku = $1`,
      [sku],
    );
    const available = Math.max(0, parseInt(total.rows[0]?.qty ?? '0', 10) - parseInt(total.rows[0]?.reserved ?? '0', 10));
    const result = await syncSkuToMedusa(sku, available);
    // A kit is sold as the parent. Its body and handle pack are warehouse parts, not shop inventory.
    if (!result.ok && !result.error?.startsWith('No Medusa inventory item')) {
      console.warn(`Booked collection stock sync failed for ${sku}: ${result.error}`);
    }
  }
}

/** Removes the picked stock when an order is marked shipped. Lines already taken are left alone. */
export async function takeStockForShippedLists(pickListIds: string[], preferredActor?: string | null): Promise<void> {
  const userId = await actorId(preferredActor);
  if (!userId) return;
  const changed = new Set<string>();
  let took = false;
  for (const pickListId of [...new Set(pickListIds.filter(Boolean))]) {
    const found = await query(
      `SELECT id, medusa_order_id, is_sandbox, is_return, payment_status, purchase_order_number
       FROM pick_lists WHERE id = $1 AND NOT is_archived`,
      [pickListId],
    );
    const list = found.rows[0];
    if (!list || list.is_sandbox || !isPaid(list)) continue;
    const client = await getPool().connect();
    let skus: string[] = [];
    try {
      await client.query('BEGIN');
      const result = await applyDispatchStock(client, list, userId);
      await consumeBoxesForShipments(client, [pickListId], userId);
      await client.query('COMMIT');
      skus = result.syncSkus;
      took = true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (skus.length && !list.is_return) for (const sku of skus) changed.add(sku);
  }
  if (!took) return;
  if (changed.size) await pushStock([...changed]);
  scheduleAllocationRun(`pick lists marked shipped`);
}

/** Removes the picked stock for one booked order. Safe to call again. */
export async function takeStockForBookedCollection(pickListId: string, preferredActor?: string | null): Promise<void> {
  const userId = await actorId(preferredActor);
  if (!userId) return;
  const found = await query(
    `SELECT pl.id, pl.medusa_order_id, pl.is_sandbox, pl.is_return, pl.payment_status, pl.purchase_order_number,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT cb.sku), NULL) AS skus
     FROM pick_lists pl
     JOIN collection_bookings cb ON cb.pick_list_id = pl.id AND cb.status <> 'cancelled' AND COALESCE(cb.direction, 'outbound') <> 'return' AND (cb.courier <> 'SGK' OR cb.sent_at IS NOT NULL)
     WHERE pl.id = $1 AND NOT pl.is_archived
     GROUP BY pl.id`,
    [pickListId],
  );
  const list = found.rows[0];
  if (!list || list.is_sandbox || !isPaid(list)) return;
  const picked = await query(
    `SELECT product_sku, quantity_picked FROM pick_list_items WHERE pick_list_id = $1 AND quantity_picked > 0`,
    [pickListId],
  );
  const skus = bookingSkusIncludingTraySingles(
    list.skus as string[],
    picked.rows.map((row) => ({ sku: String(row.product_sku), quantity: Number(row.quantity_picked) || 0 })),
  );
  if (!skus.length) return;

  const client = await getPool().connect();
  let changed: string[] = [];
  try {
    await client.query('BEGIN');
    const result = await applyDispatchStock(client, list, userId, skus);
    await client.query('COMMIT');
    changed = result.syncSkus;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (!changed.length) return;
  if (!list.is_return) await pushStock(changed);
  scheduleAllocationRun(`collection booked for pick list ${pickListId}`);
}

/** Puts booked stock back when the collection is cancelled, so a rebook can take it off again. */
export async function returnStockForCancelledCollection(pickListId: string, waybill: string, preferredActor?: string | null): Promise<void> {
  const userId = await actorId(preferredActor);
  if (!userId || !waybill) return;
  const items = await query(
    `SELECT pli.id
     FROM pick_list_items pli
     JOIN collection_bookings cb
       ON cb.pick_list_id = pli.pick_list_id AND cb.sku = pli.product_sku AND COALESCE(cb.direction, 'outbound') <> 'return'
     WHERE pli.pick_list_id = $1 AND cb.waybill = $2 AND cb.status = 'cancelled'`,
    [pickListId, waybill],
  );
  const itemIds = items.rows.map((row) => row.id);
  if (!itemIds.length) return;

  const client = await getPool().connect();
  const changed = new Set<string>();
  try {
    await client.query('BEGIN');
    const nets = await client.query(
      `SELECT pick_list_item_id, product_sku, location_id, SUM(quantity)::int AS qty
       FROM warehouse_movements
       WHERE pick_list_item_id = ANY($1::uuid[])
       GROUP BY pick_list_item_id, product_sku, location_id
       HAVING SUM(quantity) < 0`,
      [itemIds],
    );
    for (const row of nets.rows) {
      const putBack = -parseInt(row.qty, 10);
      if (putBack <= 0) continue;
      if (row.location_id) {
        const updated = await client.query(
          `UPDATE warehouse_inventory
           SET quantity = quantity + $1,
               quantity_reserved = quantity_reserved + $1,
               updated_at = NOW()
           WHERE location_id = $2 AND product_sku = $3`,
          [putBack, row.location_id, row.product_sku],
        );
        if (!updated.rowCount) {
          await client.query(
            `INSERT INTO warehouse_inventory (location_id, product_sku, quantity, quantity_reserved)
             VALUES ($1, $2, $3, $3)`,
            [row.location_id, row.product_sku, putBack],
          );
        }
      }
      await client.query(
        `INSERT INTO warehouse_movements
           (movement_type, location_id, product_sku, quantity, notes, performed_by, pick_list_item_id)
         VALUES ('RETURN', $1, $2, $3, 'Collection cancelled', $4, $5)`,
        [row.location_id, row.product_sku, putBack, userId, row.pick_list_item_id],
      );
      changed.add(row.product_sku);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (!changed.size) return;
  const list = await query(`SELECT is_return FROM pick_lists WHERE id = $1`, [pickListId]);
  if (!list.rows[0]?.is_return) await pushStock([...changed]);
  scheduleAllocationRun(`collection cancelled for pick list ${pickListId}`);
}

/** Removes stock for every open booked collection that has not already been taken. */
export async function takeStockForOpenCollections(): Promise<void> {
  const found = await query(
    `SELECT DISTINCT pl.id
     FROM pick_lists pl
     JOIN collection_bookings cb ON cb.pick_list_id = pl.id AND cb.status <> 'cancelled' AND COALESCE(cb.direction, 'outbound') <> 'return' AND (cb.courier <> 'SGK' OR cb.sent_at IS NOT NULL)
     WHERE NOT pl.is_archived AND NOT pl.is_sandbox`,
  );
  for (const row of found.rows) {
    await takeStockForBookedCollection(row.id);
  }
}
