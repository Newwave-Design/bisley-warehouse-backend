/**
 * Which open custom order lines a part that has arrived should go to. Pure: no database.
 * Oldest order first, never more than the units free, never more than the line still needs.
 *
 * Codes are compared after tidying the separators people type differently (space, "/", ":", "_" and "-" are the
 * same, a trailing "-001" is dropped, case is ignored). Nothing looser than that is ever linked automatically:
 * PFBBSPSFP1 and PFBBSPSFP10 are different parts. Near misses are only suggested, for a person to confirm.
 */

export interface CustomLine {
  itemId: string;
  orderedAt: number;
  pickListNumber: string;
  lineNumber: number;
  /** The part code read from the line's title. */
  code: string;
  /** Units still to supply: ordered minus picked. */
  needed: number;
}

/** Units of one stocked SKU that no catalogue order has claimed. */
export interface FreeStock {
  sku: string;
  free: number;
}

export interface CustomArrival {
  itemId: string;
  /** The SKU as stocked, so the shelf can be found again. */
  sku: string;
  qty: number;
  manual: boolean;
}

export interface PinnedLink {
  itemId: string;
  sku: string;
}

export interface PartSuggestion {
  sku: string;
  free: number;
  reason: 'COLOUR' | 'SIMILAR';
}

/** The comparison form of a part code. */
export function normaliseCode(code: string): string {
  return String(code || '')
    .toUpperCase()
    .trim()
    .replace(/[\s/:_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-001$/, '');
}

function byAge(a: CustomLine, b: CustomLine): number {
  return a.orderedAt - b.orderedAt || a.pickListNumber.localeCompare(b.pickListNumber) || a.lineNumber - b.lineNumber;
}

function skuKey(sku: string): string {
  return String(sku || '').toUpperCase();
}

export function planCustomArrivals(lines: CustomLine[], stock: FreeStock[], pinned: PinnedLink[] = []): CustomArrival[] {
  // free units by exact SKU, and the SKUs that share one comparison form (biggest pile first)
  const left = new Map<string, number>();
  const byNorm = new Map<string, FreeStock[]>();
  for (const s of stock) {
    const key = skuKey(s.sku);
    left.set(key, (left.get(key) ?? 0) + Math.max(0, Math.trunc(s.free)));
    const norm = normaliseCode(s.sku);
    const group = byNorm.get(norm) ?? [];
    if (!group.some((g) => skuKey(g.sku) === key)) group.push({ sku: s.sku, free: 0 });
    byNorm.set(norm, group);
  }

  const out: CustomArrival[] = [];
  const done = new Set<string>();
  const live = lines.filter((l) => l.code && l.needed > 0);
  const byId = new Map(live.map((l) => [l.itemId, l]));

  // a person's link is honoured first, for as many units as are there; earlier entries in `pinned` win, so pass the newest first
  for (const link of pinned) {
    const line = byId.get(link.itemId);
    if (!line || done.has(line.itemId)) continue;
    const key = skuKey(link.sku);
    const give = Math.min(line.needed, left.get(key) ?? 0);
    if (give <= 0) continue;
    left.set(key, (left.get(key) ?? 0) - give);
    out.push({ itemId: line.itemId, sku: link.sku, qty: give, manual: true });
    done.add(line.itemId);
  }

  const byCode = new Map<string, CustomLine[]>();
  for (const line of live) {
    if (done.has(line.itemId)) continue;
    const norm = normaliseCode(line.code);
    const group = byCode.get(norm) ?? [];
    group.push(line);
    byCode.set(norm, group);
  }
  for (const [norm, group] of byCode) {
    const skus = byNorm.get(norm) ?? [];
    for (const line of [...group].sort(byAge)) {
      let best: { sku: string; free: number } | null = null;
      for (const s of skus) {
        const free = left.get(skuKey(s.sku)) ?? 0;
        if (free > 0 && (!best || free > best.free)) best = { sku: s.sku, free };
      }
      if (!best) break;
      const give = Math.min(line.needed, best.free);
      left.set(skuKey(best.sku), best.free - give);
      out.push({ itemId: line.itemId, sku: best.sku, qty: give, manual: false });
    }
  }
  return out;
}

/**
 * Stocked SKUs that might be the part a custom line means, for a person to confirm. Never linked automatically.
 *   COLOUR  : the same part with a colour or variant on one side (ROSFF and ROSFF-AV1).
 *   SIMILAR : the same family with a different last section (PLKCSYT10/34 and PLKCSYT10/6).
 * A bare extra character (PFBBSPSFP1 and PFBBSPSFP10) is deliberately not suggested.
 */
export function suggestParts(code: string, stock: FreeStock[], limit = 5): PartSuggestion[] {
  const norm = normaliseCode(code);
  if (!norm) return [];
  const out: PartSuggestion[] = [];
  for (const s of stock) {
    if (s.free <= 0) continue;
    const other = normaliseCode(s.sku);
    if (!other || other === norm) continue;
    if (other.startsWith(`${norm}-`) || norm.startsWith(`${other}-`)) {
      out.push({ sku: s.sku, free: s.free, reason: 'COLOUR' });
      continue;
    }
    const a = norm.lastIndexOf('-');
    const b = other.lastIndexOf('-');
    if (a > 5 && b > 5 && norm.slice(0, a) === other.slice(0, b)) out.push({ sku: s.sku, free: s.free, reason: 'SIMILAR' });
  }
  return out
    .sort((x, y) => (x.reason === y.reason ? y.free - x.free || x.sku.localeCompare(y.sku) : x.reason === 'COLOUR' ? -1 : 1))
    .slice(0, limit);
}
