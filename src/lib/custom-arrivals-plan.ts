/**
 * Which open custom order lines a part that has arrived should go to. Pure: no database.
 * Oldest order first, never more than the units free, never more than the line still needs.
 */

export interface CustomLine {
  itemId: string;
  orderedAt: number;
  pickListNumber: string;
  lineNumber: number;
  /** The part code read from the line's title, upper case. */
  code: string;
  /** Units still to supply: ordered minus picked. */
  needed: number;
}

export interface CustomArrival {
  itemId: string;
  sku: string;
  qty: number;
}

function byAge(a: CustomLine, b: CustomLine): number {
  return a.orderedAt - b.orderedAt || a.pickListNumber.localeCompare(b.pickListNumber) || a.lineNumber - b.lineNumber;
}

/** [free] is the units of each code (upper case) on the shelf that no other order has claimed. */
export function planCustomArrivals(lines: CustomLine[], free: Map<string, number>): CustomArrival[] {
  const byCode = new Map<string, CustomLine[]>();
  for (const line of lines) {
    if (!line.code || line.needed <= 0) continue;
    const group = byCode.get(line.code) ?? [];
    group.push(line);
    byCode.set(line.code, group);
  }
  const out: CustomArrival[] = [];
  for (const [code, group] of byCode) {
    let left = Math.max(0, Math.trunc(free.get(code) ?? 0));
    for (const line of [...group].sort(byAge)) {
      if (left <= 0) break;
      const give = Math.min(line.needed, left);
      left -= give;
      out.push({ itemId: line.itemId, sku: code, qty: give });
    }
  }
  return out;
}
