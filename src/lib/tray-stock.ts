/**
 * Insert trays are stocked as singles or as packs of five, and either form converts into the other.
 * A shipment takes the form that was ordered, opening a pack or making one from singles when that form is short.
 */

export const TRAYS_PER_PACK = 5

const TRAY_BASE = '(?:22[1-7]|NCS22[2-7]|PIT45[01]|PIT522|PIT580)'
const SINGLE_TRAY = new RegExp(`^${TRAY_BASE}P1-`, 'i')
const PACK_TRAY = new RegExp(`^${TRAY_BASE}P5-`, 'i')

export interface TrayCounts {
  singles: number
  packs: number
}

export function trayForm(sku: string): 'single' | 'pack' | null {
  if (SINGLE_TRAY.test(sku)) return 'single'
  if (PACK_TRAY.test(sku)) return 'pack'
  return null
}

/** A scan-in adds the form that was scanned. A pack is not unpacked on the way in, and a single is not rolled into a pack. */
export function receiveTray(stock: TrayCounts, sku: string, quantity: number): TrayCounts {
  const form = trayForm(sku)
  const qty = Math.max(0, quantity)
  if (form === 'single') return { singles: stock.singles + qty, packs: stock.packs }
  if (form === 'pack') return { singles: stock.singles, packs: stock.packs + qty }
  return stock
}

/** Five singles become one pack. Returns null when there are not five singles to convert. */
export function convertSinglesToPack(stock: TrayCounts): TrayCounts | null {
  if (stock.singles < TRAYS_PER_PACK) return null
  return { singles: stock.singles - TRAYS_PER_PACK, packs: stock.packs + 1 }
}

/** One pack becomes five singles. Returns null when there is no pack to open. */
export function convertPackToSingles(stock: TrayCounts): TrayCounts | null {
  if (stock.packs < 1) return null
  return { singles: stock.singles + TRAYS_PER_PACK, packs: stock.packs - 1 }
}

/** How many packs to open so a single shipment can be filled. Singles already on hand are used first. */
export function packsToOpen(singles: number, packs: number, singlesNeeded: number): number {
  const short = Math.max(0, singlesNeeded - Math.max(0, singles))
  if (short === 0) return 0
  return Math.min(Math.max(0, packs), Math.ceil(short / TRAYS_PER_PACK))
}

/** How many loose singles are used up to ship packs that are not already on the shelf. */
export function singlesUsedToShipPacks(singles: number, packs: number, packsNeeded: number): number {
  const short = Math.max(0, packsNeeded - Math.max(0, packs))
  const made = Math.min(short, Math.floor(Math.max(0, singles) / TRAYS_PER_PACK))
  return made * TRAYS_PER_PACK
}

/**
 * Take a shipment of the ordered form.
 * A single comes off loose singles, opening a pack when there are none.
 * A pack comes off packs, and is made from five singles when there is no pack.
 */
export function shipTray(stock: TrayCounts, sku: string, quantity: number): { stock: TrayCounts; short: number } {
  const form = trayForm(sku)
  const qty = Math.max(0, quantity)
  if (!form || qty === 0) return { stock, short: 0 }
  if (form === 'single') {
    const open = packsToOpen(stock.singles, stock.packs, qty)
    const opened = { singles: stock.singles + open * TRAYS_PER_PACK, packs: stock.packs - open }
    const take = Math.min(qty, Math.max(0, opened.singles))
    return { stock: { singles: opened.singles - take, packs: opened.packs }, short: qty - take }
  }
  const fromPacks = Math.min(qty, Math.max(0, stock.packs))
  const usedSingles = singlesUsedToShipPacks(stock.singles, stock.packs, qty)
  return {
    stock: { singles: stock.singles - usedSingles, packs: stock.packs - fromPacks },
    short: qty - fromPacks - usedSingles / TRAYS_PER_PACK,
  }
}

/** A picked tray single is taken even when the collection booking names only the cabinet beside it. */
export function bookingSkusIncludingTraySingles(
  booked: string[],
  picked: { sku: string; quantity: number }[],
): string[] {
  const wanted = new Set(booked.filter((sku) => sku && sku !== 'SAMPLE' && !sku.startsWith('extra-')))
  for (const line of picked) {
    if (line.quantity > 0 && trayForm(line.sku) === 'single') wanted.add(line.sku)
  }
  return [...wanted]
}
