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
