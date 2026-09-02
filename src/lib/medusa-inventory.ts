/**
 * Shared Medusa inventory update helper.
 * Used by receiving.ts (on stock) and inventory-sync.ts (on demand).
 *
 * Env vars:
 *   MEDUSA_API_BASE_URL   — defaults to https://bisley-shop.medusajs.app
 *   MEDUSA_ADMIN_EMAIL    — admin login
 *   MEDUSA_ADMIN_PASSWORD — admin password
 *   MEDUSA_LOCATION_ID    — stocking location, defaults to European Warehouse
 */

const MEDUSA_URL = process.env.MEDUSA_API_BASE_URL || 'https://bisley-shop.medusajs.app';
const MEDUSA_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || 'matt@ovara.co.uk';
const MEDUSA_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD;
const LOCATION_ID = process.env.MEDUSA_LOCATION_ID || 'sloc_01KY792H831KT3TKH4CYPF7FT9';

let _token: string | null = null;
let _tokenExpiry = 0;

export async function getMedusaToken(): Promise<string> {
  if (_token && Date.now() < _tokenExpiry) return _token;
  if (!MEDUSA_PASSWORD) throw new Error('MEDUSA_ADMIN_PASSWORD env var is not set');
  const res = await fetch(`${MEDUSA_URL}/auth/user/emailpass`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: MEDUSA_EMAIL, password: MEDUSA_PASSWORD }),
  });
  const data = await res.json() as any;
  if (!data.token) throw new Error('Medusa auth failed');
  _token = data.token;
  _tokenExpiry = Date.now() + 50 * 60 * 1000;
  return data.token;
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
    const token = await getMedusaToken();

    // Find the inventory item for this SKU
    const searchRes = await fetch(
      `${MEDUSA_URL}/admin/inventory-items?sku=${encodeURIComponent(sku)}&fields=id,sku,location_levels.id,location_levels.location_id`,
      { headers: { Authorization: `Bearer ${token}` } }
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
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
      await activateVariantsForInventoryItem(token, item.id);
    }

    return { ok: true, newQty: wmsQty };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/** No-op: variant visibility is now driven purely by inventory_quantity. Kept for call-site compatibility. */
async function activateVariantsForInventoryItem(_token: string, _inventoryItemId: string): Promise<void> {
  // Swatch visibility = manage_inventory && qty === 0 && !allow_backorder → hidden.
  // Setting qty > 0 via syncSkuToMedusa is sufficient; no metadata patching needed.
}
