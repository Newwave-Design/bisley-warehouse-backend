/**
 * Shared Medusa inventory update helper.
 * Used by receiving.ts (on stock) and inventory-sync.ts (on demand).
 *
 * Env vars:
 *   MEDUSA_API_BASE_URL      — defaults to https://bisley-shop.medusajs.app
 *   MEDUSA_SECRET_API_KEY    — API token for authenticated requests
 *   MEDUSA_LOCATION_ID       — stocking location, defaults to European Warehouse
 */

const MEDUSA_URL = process.env.MEDUSA_API_BASE_URL || 'https://bisley-shop.medusajs.app';
const MEDUSA_API_KEY = process.env.MEDUSA_SECRET_API_KEY;
const LOCATION_ID = process.env.MEDUSA_LOCATION_ID || 'sloc_01KY792H831KT3TKH4CYPF7FT9';

function getMedusaHeaders(): Record<string, string> {
  if (!MEDUSA_API_KEY) throw new Error('MEDUSA_SECRET_API_KEY env var is not set');
  return {
    'Authorization': `Bearer ${MEDUSA_API_KEY}`,
    'Content-Type': 'application/json',
  };
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

/** No-op: variant visibility is now driven purely by inventory_quantity. Kept for call-site compatibility. */
async function activateVariantsForInventoryItem(_inventoryItemId: string): Promise<void> {
  // Swatch visibility = manage_inventory && qty === 0 && !allow_backorder → hidden.
  // Setting qty > 0 via syncSkuToMedusa is sufficient; no metadata patching needed.
}
