import { query } from '../db/index.js';
import { medusaGet, medusaPost } from './medusa-client.js';

/**
 * A purchase order line must be a real item. If the SKU is not in the catalogue yet, create it in Medusa as a draft
 * product that belongs to no sales channel, so it can never show on the shop or be bought, then record it in wms_products
 * so the warehouse can receive and count it straight away.
 */

const LOCATION_ID = process.env.MEDUSA_LOCATION_ID || 'sloc_01KY7PZB8JRYF31JPJ6EYQD8DJ';

export type SkuResult =
  | { ok: true; sku: string; created: boolean }
  | { ok: false; sku: string; error: string };

export async function skuExists(sku: string): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM wms_products WHERE LOWER(variant_sku) = LOWER($1) AND is_archived = false LIMIT 1`,
    [sku],
  );
  return r.rows.length > 0;
}

/** The catalogue's own spelling of a SKU, so a PO never holds a different case from the shop. */
export async function canonicalSku(sku: string): Promise<string | null> {
  const r = await query(
    `SELECT variant_sku FROM wms_products WHERE LOWER(variant_sku) = LOWER($1) AND is_archived = false LIMIT 1`,
    [sku],
  );
  return r.rows[0]?.variant_sku ?? null;
}

export async function createHiddenItem(sku: string, title: string): Promise<SkuResult> {
  try {
    // 1. Product with one variant, draft, no sales channel.
    const made = await medusaPost('/admin/products', {
      title,
      status: 'draft',
      options: [{ title: 'Default', values: ['Default'] }],
      variants: [{
        title,
        sku,
        manage_inventory: true,
        allow_backorder: false,
        options: { Default: 'Default' },
        prices: [],
      }],
      metadata: { source: 'purchase_order', hidden: true },
    });
    const product = made?.product;
    const variant = product?.variants?.[0];
    if (!product?.id || !variant?.id) return { ok: false, sku, error: 'Medusa did not return the new product' };

    // 2. Make sure it is in no sales channel, whatever the shop does by default.
    const check = await medusaGet(`/admin/products/${product.id}?fields=id,*sales_channels`);
    if ((check?.product?.sales_channels?.length ?? 0) > 0) {
      await medusaPost(`/admin/products/${product.id}`, { sales_channels: [] });
      const again = await medusaGet(`/admin/products/${product.id}?fields=id,*sales_channels`);
      if ((again?.product?.sales_channels?.length ?? 0) > 0) {
        return { ok: false, sku, error: `${sku} was created but is still in a sales channel, remove it in Medusa` };
      }
    }

    // 3. Inventory item and a stock level at the warehouse, so check-in can add stock to it.
    let itemId: string | undefined;
    const found = await medusaGet(`/admin/inventory-items?sku=${encodeURIComponent(sku)}&fields=id,sku`);
    itemId = found?.inventory_items?.[0]?.id;
    if (!itemId) {
      const item = await medusaPost('/admin/inventory-items', { sku, title, requires_shipping: true });
      itemId = item?.inventory_item?.id;
      if (!itemId) return { ok: false, sku, error: `Could not create a stock record for ${sku}` };
      // Link the variant to the item so Medusa tracks the stock for it.
      await medusaPost(`/admin/products/${product.id}/variants/${variant.id}/inventory-items`, {
        inventory_item_id: itemId, required_quantity: 1,
      });
    }
    await medusaPost(`/admin/inventory-items/${itemId}/location-levels`, {
      location_id: LOCATION_ID, stocked_quantity: 0,
    }).catch(() => undefined); // already exists is fine

    // 4. Record it in the warehouse catalogue.
    await query(
      `INSERT INTO wms_products
         (medusa_product_id, medusa_variant_id, product_title, product_handle, product_status,
          variant_sku, variant_title, manage_inventory, allow_backorder, metadata, last_synced_at)
       VALUES ($1,$2,$3,$4,'draft',$5,$3,true,false,$6::jsonb,NOW())
       ON CONFLICT (medusa_variant_id) DO UPDATE SET is_archived = false, archived_at = NULL, updated_at = NOW()`,
      [product.id, variant.id, title, product.handle ?? null, sku, JSON.stringify({ source: 'purchase_order', hidden: true })],
    );
    return { ok: true, sku, created: true };
  } catch (err) {
    return { ok: false, sku, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Every line SKU must be a real item. Returns the catalogue spelling of each SKU, creating hidden items for unknown ones
 * only when the line carries a title for it. Nothing is created if any line is invalid, so a bad order leaves no stray items.
 */
export async function resolveLineSkus(
  lines: { sku: string; new_item_title: string | null }[],
): Promise<{ ok: true; skus: Map<string, string>; toCreate: { sku: string; title: string }[] } | { ok: false; errors: string[] }> {
  const errors: string[] = [];
  const skus = new Map<string, string>();
  const toCreate: { sku: string; title: string }[] = [];
  for (const line of lines) {
    const real = await canonicalSku(line.sku);
    if (real) { skus.set(line.sku, real); continue; }
    if (!line.new_item_title) {
      errors.push(`${line.sku} is not in the catalogue. Enter a name for it to add it as a new item that stays off the shop.`);
      continue;
    }
    skus.set(line.sku, line.sku);
    toCreate.push({ sku: line.sku, title: line.new_item_title });
  }
  return errors.length ? { ok: false, errors } : { ok: true, skus, toCreate };
}
