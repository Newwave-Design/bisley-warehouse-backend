/**
 * Insert trays the supplier sells in packs of 5.
 * A single (`…P1-…`) is re-ordered as the matching 5-pack (`…P5-…`).
 * Not every P1 code is a tray — DUBLINP1 is a hinge pack — so the bases are listed.
 * Colour suffix is kept (`225P1-000` → `225P5-000`).
 */
const TRAY_BASE = '(?:22[1-7]|NCS22[2-7]|PIT45[01]|PIT522|PIT580)'
const SINGLE_TRAY = new RegExp(`^${TRAY_BASE}P1-`)
const FIVE_PACK_TRAY = new RegExp(`^${TRAY_BASE}P5-`, 'i')

export function fivePackTraySku(sku: string): string | null {
  if (!SINGLE_TRAY.test(sku)) return null
  return sku.replace(/P1-/, 'P5-')
}

/** Receiving override. A scanned 5-pack is one single of the same tray. The catalogue barcode stays a 5-pack. */
export function singleTrayFromFivePack(sku: string): string | null {
  const code = sku.trim()
  if (!FIVE_PACK_TRAY.test(code)) return null
  return code.replace(/P5-/i, 'P1-')
}
