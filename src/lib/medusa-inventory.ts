import { query } from '../db/index.js';
import { logWarning } from './logger.js';

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

function getMedusaHeaders(): Record<string, string> {
  if (!MEDUSA_API_KEY) throw new Error('MEDUSA_SECRET_API_KEY env var is not set');
  return {
    'Authorization': `Bearer ${MEDUSA_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

export async function getMedusaToken(): Promise<string> {
  if (!MEDUSA_API_KEY) throw new Error('MEDUSA_SECRET_API_KEY env var is not set');
  return MEDUSA_API_KEY;
}

/**
 * Set the stocked_quantity of a SKU's inventory item at the warehouse location.
 * Fetches the current WMS total for that SKU and sets it in Medusa.
 * Returns the new quantity, or null if the SKU has no Medusa inventory item.
 */
export async function syncSkuToMedusa(
  sku: string,
  wmsQty: number
): Promise<{ ok: boolean; newQty?: number; error?: string }> {
  try {
    const headers = getMedusaHeaders();

    // Find the inventory item for this SKU
    const searchRes = await fetch(
      `${MEDUSA_URL}/admin/inventory-items?sku=${encodeURIComponent(sku)}&fields=id,sku,location_levels.id,location_levels.location_id`,
      { headers }
    );
    const searchData = await searchRes.json() as any;
    const item = searchData.inventory_items?.[0];
    if (!item) return { ok: false, error: `No Medusa inventory item for SKU ${sku}` };

    const level = item.location_levels?.find((l: any) => l.location_id === LOCATION_ID)
      ?? item.location_levels?.[0];
    if (!level) return { ok: false, error: `No location level for SKU ${sku}` };

    // Update stocked_quantity
    const updateRes = await fetch(
      `${MEDUSA_URL}/admin/inventory-items/${item.id}/location-levels/${level.location_id}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ stocked_quantity: wmsQty }),
      }
    );

    if (!updateRes.ok) {
      const err = await updateRes.json() as any;
      return { ok: false, error: err.message ?? `HTTP ${updateRes.status}` };
    }

    // When stock first arrives (qty transitions 0→positive), clear stocked=false on
    // any variant linked to this inventory item so swatches become visible on the PDP.
    if (wmsQty > 0) {
      await activateVariantsForInventoryItem(item.id);
    }

    return { ok: true, newQty: wmsQty };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/** Read this SKU's warehouse free stock and set Medusa's stocked quantity to it. */
export async function pushAvailableStock(skus: string[]): Promise<string[]> {
  const errors: string[] = [];
  const floored: string[] = [];
  const missing: string[] = [];
  for (const sku of [...new Set(skus.map((value) => String(value || '').trim()).filter(Boolean))]) {
    const total = await query(
      `SELECT COALESCE(SUM(quantity_available), 0)::int AS available FROM warehouse_inventory WHERE product_sku = $1`,
      [sku],
    );
    const available = Number(total.rows[0]?.available);
    if (!Number.isInteger(available)) {
      errors.push(`${sku}: warehouse free stock was not a whole number, so Medusa was left unchanged`);
      continue;
    }
    const target = Math.max(0, available);
    if (available < 0) floored.push(`${sku} (${available})`);
    const result = await syncSkuToMedusa(sku, target);
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

async function medusaStockedAtOvara(): Promise<Map<string, number>> {
  const token = await getMedusaToken();
  const qty = new Map<string, number>();
  let offset = 0;
  while (true) {
    const res = await fetch(
      `${MEDUSA_URL}/admin/inventory-items?limit=100&offset=${offset}&fields=id,sku,location_levels.location_id,location_levels.stocked_quantity`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`Medusa stock read failed (${res.status}); no stock was written`);
    const data = await res.json() as { inventory_items?: { sku?: string; location_levels?: { location_id: string; stocked_quantity?: number }[] }[]; count?: number };
    for (const item of data.inventory_items ?? []) {
      if (!item.sku) continue;
      const level = item.location_levels?.find((entry) => entry.location_id === LOCATION_ID);
      if (level) qty.set(item.sku, (qty.get(item.sku) ?? 0) + (level.stocked_quantity ?? 0));
    }
    offset += 100;
    if (offset >= (data.count ?? 0) || !(data.inventory_items ?? []).length) break;
  }
  if (qty.size === 0) throw new Error('Medusa stock read returned nothing; no stock was written');
  return qty;
}

/**
 * Set Medusa's stocked quantity to warehouse free stock for every SKU that differs.
 * The number written is always re-read from quantity_available. A negative free count
 * is stored as 0, because Medusa rejects a stocked quantity below zero. A SKU with
 * no Medusa item is logged and left alone.
 */
export async function reconcileAvailableStock(): Promise<{ checked: number; updated: number; floored: number; missing: number }> {
  const rows = await query(
    `SELECT product_sku AS sku, COALESCE(SUM(quantity_available), 0)::int AS available FROM warehouse_inventory GROUP BY product_sku`,
  );
  const medusa = await medusaStockedAtOvara();
  let updated = 0;
  let floored = 0;
  let missing = 0;
  for (const row of rows.rows) {
    const available = Number(row.available);
    if (!Number.isInteger(available)) continue;
    const target = Math.max(0, available);
    if (available < 0) floored += 1;
    const current = medusa.get(row.sku);
    if (current === undefined) {
      if (available !== 0) missing += 1;
      continue;
    }
    if (current === target) continue;
    const result = await pushAvailableStock([row.sku]);
    if (!result.length) updated += 1;
  }
  if (floored || missing) {
    await logWarning('INVENTORY_SYNC', 'Scheduled stock sync could not copy every warehouse SKU exactly', {
      floored_at_zero: floored,
      no_medusa_item: missing,
      updated,
    });
  }
  return { checked: rows.rows.length, updated, floored, missing };
}

/** No-op: variant visibility is now driven purely by inventory_quantity. Kept for call-site compatibility. */
async function activateVariantsForInventoryItem(_inventoryItemId: string): Promise<void> {
  // Swatch visibility = manage_inventory && qty === 0 && !allow_backorder → hidden.
  // Setting qty > 0 via syncSkuToMedusa is sufficient; no metadata patching needed.
}
