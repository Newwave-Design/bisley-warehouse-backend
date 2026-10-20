// Bisley colour code -> display name, and extracting the code from a SKU (e.g. H298BNL-av1 -> av1).
export const COLOUR_NAMES: Record<string, string> = {
  av1: 'Black', aa3: 'Anthracite Grey', ba5: 'Traffic White',
  bc6: 'Bisley Blue', bn6: 'Bisley Orange', bx6: 'Olive Green',
  cb2: 'Palest Pink', cd1: 'Golden Sunflower Yellow', av4: 'Goose Grey',
  ag8: 'Regent', bz2: 'Ocean Blue', cj6: 'Natural Canvas',
  da8: 'Emerald', be2: 'Fuchsia', bh2: 'Bisley Green', bp5: 'Azure',
  ab1: 'Coral', bq4: 'Seville', ab2: 'Lilac', cj4: 'Berry',
  cj5: 'Marine Green', ab9: 'Chalk', ay8: 'Cardinal Red', bp7: 'Prussian',
  bq5: 'Dijon', ay7: 'Ocean Blue',
};

/** Extract Bisley colour code (e.g. av1, bc6) from the end of a SKU. */
export function extractColourCode(sku: string): string | null {
  const lastSeg = sku.split('-').pop() ?? '';
  const m = /([a-z]{2}\d)$/.exec(lastSeg);
  return m ? m[1] : null;
}

export function isSampleSku(sku: string | null | undefined): boolean {
  return /SAMPLE/i.test(sku || '');
}

/** Colour the warehouse actually picks for a sample swatch (not the SAMPLE SKU title). */
export function sampleColourName(item: {
  product_sku?: string | null;
  colour_code?: string | null;
  colour_name?: string | null;
  product_title?: string | null;
  item_title?: string | null;
}): string {
  const sku = item.product_sku || '';
  const code = (item.colour_code || extractColourCode(sku) || '').toLowerCase();
  if (code && COLOUR_NAMES[code]) return COLOUR_NAMES[code];
  const mapped = (item.colour_name || '').trim();
  if (mapped && !/sample/i.test(mapped)) return mapped;
  const title = String(item.product_title || item.item_title || '')
    .replace(/colour\s*samples?/ig, ' ')
    .replace(/samples?/ig, ' ')
    .replace(/[-–|/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (title) return title;
  return code ? code.toUpperCase() : (sku || 'Sample');
}

export function enrichSampleItems<T extends Record<string, any>>(items: T[]): T[] {
  for (const item of items) {
    if (!isSampleSku(item.product_sku)) continue;
    item.is_sample = true;
    item.colour_name = sampleColourName(item);
  }
  return items;
}

export function sampleColourList(items: any[] | null | undefined): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of items || []) {
    if (!isSampleSku(item?.product_sku)) continue;
    const name = sampleColourName(item);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}
