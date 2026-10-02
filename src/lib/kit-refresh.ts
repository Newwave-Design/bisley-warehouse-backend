/**
 * Refresh kit definitions (is_kit / kit_components) in wms_products for specific SKUs straight from Medusa.
 * Pick lists read kit components from wms_products, which is otherwise only updated by the full catalogue sync,
 * so after kits are edited in Medusa this applies them to a pick list immediately. Touches nothing but the
 * two kit columns, and only for the SKUs asked for (a handful of small Medusa requests, never a full pull).
 */
import { query } from '../db/index.js';
import { medusaGet } from './medusa-client.js';

export interface KitComponent { sku: string; required_quantity: number }
export interface KitChange { sku: string; before: KitComponent[]; after: KitComponent[] }
export interface KitRefreshResult { checked: number; changed: KitChange[]; not_found: string[] }

const sameKit = (a: KitComponent[], b: KitComponent[]) => {
  const norm = (k: KitComponent[]) => JSON.stringify([...k].map(c => [c.sku, Number(c.required_quantity)]).sort());
  return norm(a) === norm(b);
};

export async function refreshKitsForSkus(skus: string[], opts: { dryRun?: boolean } = {}): Promise<KitRefreshResult> {
  const unique = [...new Set(skus.filter(Boolean))];
  const rows = (await query(
    `SELECT variant_sku, medusa_product_id, medusa_variant_id, kit_components FROM wms_products WHERE variant_sku = ANY($1::text[])`,
    [unique]
  )).rows;

  const result: KitRefreshResult = { checked: 0, changed: [], not_found: unique.filter(s => !rows.some(r => r.variant_sku === s)) };
  if (!rows.length) return result;

  // One Medusa request per product (variants + their inventory-item links)
  const linksByVariant = new Map<string, { inventory_item_id: string; required_quantity: number }[]>();
  for (const productId of new Set(rows.map(r => r.medusa_product_id))) {
    const data = await medusaGet(`/admin/products/${encodeURIComponent(productId)}?fields=id,*variants,*variants.inventory_items`);
    if (!data?.product) throw new Error(`Medusa product ${productId} not found: ${JSON.stringify(data).slice(0, 160)}`);
    for (const v of data.product.variants ?? []) {
      linksByVariant.set(v.id, (v.inventory_items ?? []).map((l: any) => ({
        inventory_item_id: l.inventory_item_id, required_quantity: Number(l.required_quantity) || 1,
      })));
    }
  }

  // Resolve component inventory-item ids to SKUs
  const itemIds = [...new Set([...linksByVariant.values()].flat().map(l => l.inventory_item_id))];
  const itemSku = new Map<string, string>();
  for (let i = 0; i < itemIds.length; i += 50) {
    const slice = itemIds.slice(i, i + 50);
    const data = await medusaGet(`/admin/inventory-items?limit=50&fields=id,sku&${slice.map(id => `id[]=${encodeURIComponent(id)}`).join('&')}`);
    for (const it of data?.inventory_items ?? []) if (it.sku) itemSku.set(it.id, it.sku);
  }

  for (const row of rows) {
    const links = linksByVariant.get(row.medusa_variant_id);
    if (!links) { result.not_found.push(row.variant_sku); continue; }
    result.checked++;

    const after: KitComponent[] = links
      .map(l => ({ sku: itemSku.get(l.inventory_item_id) ?? '', required_quantity: l.required_quantity }))
      .filter(c => c.sku);
    const isKit = links.length > 1;
    const before: KitComponent[] = Array.isArray(row.kit_components) ? row.kit_components : [];
    // Same shape the full catalogue sync writes: every inventory link, is_kit only when there are several
    if (sameKit(before, after)) continue;

    if (!opts.dryRun) {
      await query(
        `UPDATE wms_products SET is_kit = $1, kit_components = $2::jsonb, updated_at = NOW() WHERE medusa_variant_id = $3`,
        [isKit, JSON.stringify(after), row.medusa_variant_id]
      );
    }
    result.changed.push({ sku: row.variant_sku, before, after });
  }
  return result;
}
