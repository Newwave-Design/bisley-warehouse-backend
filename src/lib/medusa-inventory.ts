import { query } from '../db/index.js';
import { logWarning } from './logger.js';
import { medusaKeyHeader, shopStockTarget } from './shop-stock.js';
import { assignStockedToOlderOrders } from './assign-arrived-stock.js';

/**
 * Shared Medusa inventory update helper.
 * Used by receiving.ts (on stock) and inventory-sync.ts (on demand).
 *
 * Env vars:
 *   MEDUSA_API_BASE_URL      — defaults to https://bisley-shop.medusajs.app
 *   MEDUSA_SECRET_API_KEY    — API token for authenticated requests
 *   MEDUSA_LOCATION_ID       — stocking location, defaults to Ovara
 */

const MEDUSA_URL = process.env.MEDUSA_API_BASE_URL || 'https://bisley-shop.medusajs.app';
const MEDUSA_API_KEY = process.env.MEDUSA_SECRET_API_KEY;
const LOCATION_ID = process.env.MEDUSA_LOCATION_ID || 'sloc_01KY7PZB8JRYF31JPJ6EYQD8DJ';

export function getMedusaHeaders(): Record<string, string> {
  if (!MEDUSA_API_KEY) throw new Error('MEDUSA_SECRET_API_KEY env var is not set');
  return {
    'Authorization': medusaKeyHeader(MEDUSA_API_KEY),
    'Content-Type': 'application/json',
  };
}

export async function getMedusaToken(): Promise<string> {
  if (!MEDUSA_API_KEY) throw new Error('MEDUSA_SECRET_API_KEY env var is not set');
  return MEDUSA_API_KEY;
}

import { pooledTrayQty, trayMate } from './tray-pool.js';

/** Warehouse totals for a SKU. An insert tray also counts its other form (single <-> 5-pack) as one pool. */
export async function warehouseTotals(sku: string): Promise<{ available: number; onhand: number; n: number }> {
  const mate = trayMate(sku);
  const r = await query(
    `SELECT product_sku, COALESCE(SUM(quantity_available), 0)::int AS available, COALESCE(SUM(quantity), 0)::int AS onhand, COUNT(*)::int AS n
     FROM warehouse_inventory WHERE product_sku = ANY($1::text[]) GROUP BY product_sku`,
    [mate ? [sku, mate] : [sku]],
  );
  const own = r.rows.find((x: any) => x.product_sku === sku);
  const other = r.rows.find((x: any) => x.product_sku === mate);
  return {
    available: pooledTrayQty(sku, Number(own?.available ?? 0), Number(other?.available ?? 0)),
    onhand: pooledTrayQty(sku, Number(own?.onhand ?? 0), Number(other?.onhand ?? 0)),
    n: Number(own?.n ?? 0) + Number(other?.n ?? 0),
  };
}

/**
 * Make Medusa sell exactly the warehouse's free stock (stock not reserved to any existing order).
 * wmsQty is the warehouse FREE quantity. Medusa subtracts its own reservations from the stocked quantity, so the stocked
 * quantity written is what can be sold plus those reservations (see shop-stock.ts). The result's newQty is what the shop
 * can now sell.
 */
export async function syncSkuToMedusa(
  sku: string,
  wmsQty: number
): Promise<{ ok: boolean; newQty?: number; error?: string }> {
  try {
    const headers = getMedusaHeaders();

    // Find the inventory item for this SKU
    const searchRes = await fetch(
      `${MEDUSA_URL}/admin/inventory-items?sku=${encodeURIComponent(sku)}&fields=id,sku,location_levels.id,location_levels.location_id,location_levels.reserved_quantity`,
      { headers }
    );
    if (!searchRes.ok) return { ok: false, error: `Medusa stock read failed (${searchRes.status})` };
    const searchData = await searchRes.json() as any;
    const item = searchData.inventory_items?.[0];
    if (!item) return { ok: false, error: `No Medusa inventory item for SKU ${sku}` };

    const level = item.location_levels?.find((l: any) => l.location_id === LOCATION_ID)
      ?? item.location_levels?.[0];
    if (!level) return { ok: false, error: `No location level for SKU ${sku}` };

    // Stocked quantity = what can be sold + Medusa's own reservations, so stocked minus reserved is what can be sold.
    const totals = await warehouseTotals(sku);
    const target = shopStockTarget({
      free: wmsQty,
      onhand: totals.n > 0 ? totals.onhand : null,
      medusaReserved: Number(level.reserved_quantity) || 0,
    });

    // Update stocked_quantity
    const updateRes = await fetch(
      `${MEDUSA_URL}/admin/inventory-items/${item.id}/location-levels/${level.location_id}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ stocked_quantity: target.stocked }),
      }
    );

    if (!updateRes.ok) {
      const err = await updateRes.json() as any;
      return { ok: false, error: err.message ?? `HTTP ${updateRes.status}` };
    }

    // When stock first arrives (qty transitions 0→positive), clear stocked=false on
    // any variant linked to this inventory item so swatches become visible on the PDP.
    if (target.sellable > 0) {
      await activateVariantsForInventoryItem(item.id);
    }

    return { ok: true, newQty: target.sellable };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/** Read this SKU's warehouse free stock and make Medusa sell exactly that (stock not reserved to any existing order). */
export async function pushAvailableStock(skus: string[]): Promise<string[]> {
  const errors: string[] = [];
  const floored: string[] = [];
  const missing: string[] = [];
  const wanted = skus.map((value) => String(value || '').trim()).filter(Boolean);
  // A tray single and its 5-pack share one pool, so a change to one changes what the other can sell.
  for (const sku of [...wanted]) { const mate = trayMate(sku); if (mate) wanted.push(mate); }
  for (const sku of [...new Set(wanted)]) {
    const available = (await warehouseTotals(sku)).available;
    if (!Number.isInteger(available)) {
      errors.push(`${sku}: warehouse free stock was not a whole number, so Medusa was left unchanged`);
      continue;
    }
    if (available < 0) floored.push(`${sku} (${available})`);
    const result = await syncSkuToMedusa(sku, Math.max(0, available));
    if (!result.ok && result.error?.startsWith('No Medusa inventory item')) missing.push(sku);
    else if (!result.ok) errors.push(`${sku}: ${result.error}`);
  }
  if (floored.length || missing.length) {
    await logWarning('INVENTORY_SYNC', 'Warehouse free stock could not be copied exactly into Medusa', {
      floored_at_zero: floored,
      no_medusa_item: missing,
    });
  }
  return [...errors, ...missing.map((sku) => `No Medusa inventory item for SKU ${sku}`)];
}

async function medusaLevelsAtOvara(): Promise<Map<string, { stocked: number; reserved: number }>> {
  const headers = getMedusaHeaders();
  const levels = new Map<string, { stocked: number; reserved: number }>();
  let offset = 0;
  while (true) {
    const res = await fetch(
      `${MEDUSA_URL}/admin/inventory-items?limit=100&offset=${offset}&fields=id,sku,location_levels.location_id,location_levels.stocked_quantity,location_levels.reserved_quantity`,
      { headers },
    );
    if (!res.ok) throw new Error(`Medusa stock read failed (${res.status}); no stock was written`);
    const data = await res.json() as { inventory_items?: { sku?: string; location_levels?: { location_id: string; stocked_quantity?: number; reserved_quantity?: number }[] }[]; count?: number };
    for (const item of data.inventory_items ?? []) {
      if (!item.sku) continue;
      const level = item.location_levels?.find((entry) => entry.location_id === LOCATION_ID);
      if (level) {
        const now = levels.get(item.sku) ?? { stocked: 0, reserved: 0 };
        levels.set(item.sku, { stocked: now.stocked + (level.stocked_quantity ?? 0), reserved: now.reserved + (level.reserved_quantity ?? 0) });
      }
    }
    offset += 100;
    if (offset >= (data.count ?? 0) || !(data.inventory_items ?? []).length) break;
  }
  if (levels.size === 0) throw new Error('Medusa stock read returned nothing; no stock was written');
  return levels;
}

/**
 * Make Medusa sell exactly the warehouse's free stock, for every SKU where it does not.
 * The number written is always worked out again from the warehouse (free stock and on hand) and Medusa's own reservations
 * (see shop-stock.ts). A negative free count sells nothing. A SKU with no Medusa item is logged and left alone.
 * A failure to read Medusa, or to write a SKU, is logged where the team can see it, never swallowed.
 */
export async function reconcileAvailableStock(): Promise<{ checked: number; updated: number; floored: number; missing: number; failed: number }> {
  // Stock goes to the oldest open order first. Do that before reading what is free, so a unit owed to an older order
  // (including a made-to-order one waiting for its stock) can never be offered to the shop.
  await assignStockedToOlderOrders().catch((error) => logWarning('INVENTORY_SYNC', 'Older orders could not be given their stock before the shop sync', { error: error instanceof Error ? error.message : String(error) }));
  const rows = await query(
    `SELECT product_sku AS sku, COALESCE(SUM(quantity_available), 0)::int AS available, COALESCE(SUM(quantity), 0)::int AS onhand FROM warehouse_inventory GROUP BY product_sku`,
  );
  // Insert-tray singles and 5-packs are one pool, so each is checked against what it can sell as that form.
  const ownRows = new Map<string, { available: number; onhand: number }>(rows.rows.map((r: any) => [r.sku, { available: Number(r.available), onhand: Number(r.onhand) }]));
  for (const row of rows.rows) {
    const mate = trayMate(row.sku);
    if (!mate) continue;
    const other = ownRows.get(mate);
    row.available = pooledTrayQty(row.sku, Number(ownRows.get(row.sku)?.available ?? 0), other?.available ?? 0);
    row.onhand = pooledTrayQty(row.sku, Number(ownRows.get(row.sku)?.onhand ?? 0), other?.onhand ?? 0);
  }
  let levels: Map<string, { stocked: number; reserved: number }>;
  try {
    levels = await medusaLevelsAtOvara();
  } catch (error) {
    await logWarning('INVENTORY_SYNC', 'The shop stock sync could not read Medusa, so nothing was updated', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  let updated = 0;
  let floored = 0;
  let missing = 0;
  const failures: string[] = [];
  for (const row of rows.rows) {
    const available = Number(row.available);
    if (!Number.isInteger(available)) continue;
    if (available < 0) floored += 1;
    const current = levels.get(row.sku);
    if (current === undefined) {
      if (available !== 0 || Number(row.onhand) !== 0) missing += 1;
      continue;
    }
    const target = shopStockTarget({ free: available, onhand: Number(row.onhand), medusaReserved: current.reserved });
    if (current.stocked === target.stocked) continue;
    const result = await pushAvailableStock([row.sku]);
    if (!result.length) updated += 1;
    else failures.push(...result);
  }
  if (floored || missing || failures.length) {
    await logWarning('INVENTORY_SYNC', failures.length ? 'The shop stock sync could not update some SKUs' : 'Scheduled stock sync could not copy every warehouse SKU exactly', {
      negative_free_sold_as_zero: floored,
      no_medusa_item: missing,
      failed: failures.length,
      first_failures: failures.slice(0, 10),
      updated,
    });
  }
  return { checked: rows.rows.length, updated, floored, missing, failed: failures.length };
}

/** No-op: variant visibility is now driven purely by inventory_quantity. Kept for call-site compatibility. */
async function activateVariantsForInventoryItem(_inventoryItemId: string): Promise<void> {
  // Swatch visibility = manage_inventory && qty === 0 && !allow_backorder → hidden.
  // Setting qty > 0 via syncSkuToMedusa is sufficient; no metadata patching needed.
}
