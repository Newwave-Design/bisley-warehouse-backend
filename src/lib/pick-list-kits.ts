import { query } from '../db/index.js';
import { COLOUR_NAMES, extractColourCode } from './colour-names.js';

/** Replace kit lines with the parent plus the pieces to pick. The same expansion Pick Lists v2 uses. */
export async function expandKitPicksByList<T extends { sku: string; quantity_required: number; quantity_picked: number }>(groups: T[][]): Promise<T[][]> {
  const skus = [...new Set(groups.flat().map(i => i.sku).filter(Boolean))];
  if (!skus.length) return groups;
  const kits = await query(
    `SELECT DISTINCT ON (variant_sku) variant_sku, is_kit, kit_components
     FROM wms_products WHERE variant_sku = ANY($1::text[])
     ORDER BY variant_sku, is_archived`,
    [skus]
  );
  const bySku = new Map(kits.rows.map((r: { variant_sku: string }) => [r.variant_sku, r]));
  const componentSkus = new Set<string>();
  for (const row of kits.rows as { variant_sku: string; is_kit: boolean; kit_components: { sku?: string }[] }[]) {
    if (!row.is_kit || !Array.isArray(row.kit_components)) continue;
    for (const c of row.kit_components) {
      if (c?.sku && c.sku !== row.variant_sku) componentSkus.add(c.sku);
    }
  }
  const info = new Map<string, { product_title: string; colour_name: string; colour_code: string; variant_thumbnail: string; product_thumbnail: string }>();
  if (componentSkus.size) {
    const found = await query(
      `SELECT DISTINCT ON (variant_sku) variant_sku, product_title, colour_name, colour_code, variant_thumbnail, product_thumbnail
       FROM wms_products WHERE variant_sku = ANY($1::text[])
       ORDER BY variant_sku, is_archived`,
      [[...componentSkus]]
    );
    for (const row of found.rows) info.set(row.variant_sku, row);
  }
  return groups.map(items => items.flatMap(item => {
    const kit = bySku.get(item.sku) as { is_kit?: boolean; kit_components?: { sku?: string; required_quantity?: number }[] } | undefined;
    const parts = (kit?.is_kit && Array.isArray(kit.kit_components) ? kit.kit_components : [])
      .filter(c => c?.sku && c.sku !== item.sku);
    if (!parts.length) return [item];
    const header = { ...item, kit_header: true };
    return [header, ...parts.map(c => {
      const meta = info.get(c.sku as string);
      const per = Number(c.required_quantity) || 1;
      const code = (meta?.colour_code || extractColourCode(c.sku as string) || '').toLowerCase();
      const colourName = meta?.colour_name || COLOUR_NAMES[code] || '';
      const colour = code && colourName && colourName.toLowerCase() !== code
        ? `${colourName} (${code})`
        : (colourName || code || '');
      return {
        ...item,
        title: meta?.product_title || c.sku,
        sku: c.sku,
        colour_code: code || null,
        colour,
        quantity_required: item.quantity_required * per,
        quantity_picked: item.quantity_picked * per,
        thumbnail: meta?.variant_thumbnail || meta?.product_thumbnail || null,
        kit_part: true,
        kit_parent_sku: item.sku,
      };
    })];
  }));
}
