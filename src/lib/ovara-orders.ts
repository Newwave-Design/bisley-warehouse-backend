/**
 * Ovara's year-to-date order sheet uses part-colour-description.
 * Shop SKUs use the same part, with a few finish codes renamed (oak, white, walnut, plywood)
 * and self-colour parts stored without a -000 suffix.
 */
export function shopSkuForOvaraCode(raw: string, known: Set<string>): string {
  const parts = String(raw).trim().toLowerCase().split('-');
  const part = parts[0] || '';
  const colour = parts[1] || '';
  const exact = `${part}-${colour}`;
  const hyphenated = exact.replace(/\//g, '-');
  const dotted = hyphenated
    .replace(/(\d+s)\.(\d+)-([a-z0-9]+)$/, '$1-$3$2')
    .replace(/(\d+s)\.([a-z]+)-([a-z0-9]+)$/, '$1-$3$2');
  if (part.startsWith('mdtp') && known.has(`${part}-plywood`)) return `${part}-plywood`;
  for (const candidate of [dotted, hyphenated, exact]) {
    if (known.has(candidate)) return candidate;
  }
  const renamed = colour === '018' ? 'oak' : colour === '562' ? 'white' : colour === '998' ? 'walnut' : '';
  if (renamed && known.has(`${part}-${renamed}`)) return `${part}-${renamed}`;
  if (colour === '000') return part;
  if (dotted !== hyphenated) return dotted;
  if (part === 'pdwmdl83') return part;
  return hyphenated;
}

/** File quantity for this shop SKU, including a self-colour code stored with or without -000. */
export function orderedQuantity(ordered: Map<string, number>, sku: string): number {
  const key = sku.toLowerCase();
  const twin = key.endsWith('-000') ? key.slice(0, -4) : `${key}-000`;
  return (ordered.get(key) ?? 0) + (ordered.get(twin) ?? 0);
}

/**
 * Ordered units that cover this sold SKU.
 * A five-pack order covers single-tray sales at five singles per pack, after the pack's own sales.
 */
export function orderedCover(ordered: Map<string, number>, soldBySku: Map<string, number>, sku: string): number {
  const direct = orderedQuantity(ordered, sku);
  if (!/p1-/i.test(sku)) return direct;
  const pack = sku.replace(/p1-/i, 'p5-');
  const packOrdered = orderedQuantity(ordered, pack);
  const packSold = soldBySku.get(pack.toLowerCase()) ?? 0;
  return direct + Math.max(0, packOrdered - packSold) * 5;
}
