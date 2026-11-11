import { query } from '../db/index.js';
import { COLOUR_NAMES, componentDisplaySku, extractColourCode } from './colour-names.js';

type CatalogueProduct = {
  variant_sku: string
  product_title?: string
  is_kit?: boolean
  kit_components?: { sku?: string; required_quantity?: number }[]
  colour_name?: string
  colour_code?: string
  variant_thumbnail?: string
  product_thumbnail?: string
}

function colourLabel(sku: string, meta?: { colour_code?: string; colour_name?: string }) {
  const code = (meta?.colour_code || extractColourCode(sku) || '').toLowerCase()
  const colourName = meta?.colour_name || COLOUR_NAMES[code] || ''
  const colour = code && colourName && colourName.toLowerCase() !== code
    ? `${colourName} (${code})`
    : (colourName || code || '')
  return { code, colour }
}

function withCatalogue<T extends { sku: string; title?: string; thumbnail?: string | null; colour?: string; colour_code?: string | null }>(item: T, product?: CatalogueProduct): T {
  if (!product) return item
  const { code, colour } = colourLabel(item.sku, product)
  return {
    ...item,
    title: product.product_title || item.title,
    colour_code: code || item.colour_code || null,
    colour: colour || item.colour,
    thumbnail: product.variant_thumbnail || product.product_thumbnail || item.thumbnail || null,
  }
}

/** Replace kit lines with the parent plus the pieces to pick. The same expansion Pick Lists v2 uses. */
export async function expandKitPicksByList<T extends { sku: string; quantity_required: number; quantity_picked: number }>(groups: T[][]): Promise<T[][]> {
  const skus = [...new Set(groups.flat().map(i => i.sku).filter(Boolean))];
  if (!skus.length) return groups;
  const kits = await query(
    `SELECT DISTINCT ON (variant_sku) variant_sku, product_title, is_kit, kit_components,
            colour_name, colour_code, variant_thumbnail, product_thumbnail
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
    const lookup = [...new Set([...componentSkus].flatMap(sku => [sku, componentDisplaySku(sku)]))];
    const found = await query(
      `SELECT DISTINCT ON (variant_sku) variant_sku, product_title, colour_name, colour_code, variant_thumbnail, product_thumbnail
       FROM wms_products WHERE variant_sku = ANY($1::text[])
       ORDER BY variant_sku, is_archived`,
      [lookup]
    );
    for (const row of found.rows) info.set(row.variant_sku, row);
  }
  const expanded = groups.map(items => items.flatMap(item => {
    const kit = bySku.get(item.sku) as CatalogueProduct | undefined;
    const parts = (kit?.is_kit && Array.isArray(kit.kit_components) ? kit.kit_components : [])
      .filter(c => c?.sku && c.sku !== item.sku);
    if (!parts.length) return [withCatalogue(item, kit)];
    const header = { ...withCatalogue(item, kit), kit_header: true, title: kit?.product_title || (item as { title?: string }).title };
    return [header, ...parts.map(c => {
      const meta = info.get(c.sku as string) || info.get(componentDisplaySku(c.sku as string));
      const per = Number(c.required_quantity) || 1;
      const { code, colour } = colourLabel(c.sku as string, meta);
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

  const pickSkus = [...new Set(expanded.flat().filter((item: { kit_header?: boolean; sku?: string }) => !item.kit_header && item.sku).map((item) => item.sku as string))];
  const lookup = [...new Set(pickSkus.flatMap((sku) => [sku, componentDisplaySku(sku)]))];
  const stockBySku = new Map<string, { available_stock: number; location_code: string | null }>();
  if (lookup.length) {
    const stock = await query(
      `SELECT wi.product_sku,
              COALESCE(SUM(wi.quantity), 0)::int AS available_stock,
              (ARRAY_AGG(wl.location_code ORDER BY wi.quantity DESC NULLS LAST))[1] AS location_code
       FROM warehouse_inventory wi
       LEFT JOIN warehouse_locations wl ON wl.id = wi.location_id
       WHERE wi.product_sku = ANY($1::text[])
       GROUP BY wi.product_sku`,
      [lookup]
    );
    for (const row of stock.rows) {
      stockBySku.set(row.product_sku, {
        available_stock: Number(row.available_stock) || 0,
        location_code: row.location_code || null,
      });
    }
  }

  return expanded.map((items) => items.map((item) => {
    if ((item as { kit_header?: boolean }).kit_header) return { ...item, available_stock: null };
    const stock = stockBySku.get(item.sku) || stockBySku.get(componentDisplaySku(item.sku));
    return {
      ...item,
      available_stock: stock?.available_stock ?? 0,
      location_code: (item as { location_code?: string | null }).location_code || stock?.location_code || null,
    };
  }));
}
