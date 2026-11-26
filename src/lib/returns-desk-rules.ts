/** Rules from the 19 Nov 2026 returns design. Stock changes only after a confirmed unopened scan. */

export const RETURN_REASONS = ['Change of mind', 'Damaged', 'Wrong item', 'Faulty', 'Courier problem'] as const

export const CONDITIONS = ['Unopened', 'Opened', 'Damaged', 'Faulty', 'Wrong item'] as const

export const DECISIONS = ['write_off', 'bisley_claim', 'carrier_claim', 'spares', 'second'] as const

export function canScanIntoStock(input: { condition: string; itemScanned: boolean; bayScanned: boolean; confirmUnopened: boolean }) {
  if (input.condition !== 'Unopened') return { ok: false as const, reason: 'Only an unopened item, with the seal and packaging intact, can go back into stock' }
  if (!input.itemScanned || !input.bayScanned || !input.confirmUnopened) {
    return { ok: false as const, reason: 'Scan the item, scan the bay, and tick Confirm unopened' }
  }
  return { ok: true as const }
}

export function decisionChangesStock(): boolean {
  return false
}

/** Lost parcels and sealed refused boxes are refunded without waiting for an inspection. */
export function refundWaitsForInspection(input: { courierProblem?: string | null; holdRefund?: boolean }) {
  if (input.courierProblem === 'lost' || input.courierProblem === 'refused_sealed') return false
  return input.holdRefund !== false
}

/**
 * Open returns are held out of the Bisley sold-stock report until decided.
 * After the report is sent, the line stays reported.
 */
export function soldStockTreatment(input: { reportSent: boolean; open: boolean; scannedIn: boolean }) {
  if (input.reportSent) return 'stays_reported' as const
  if (input.open) return 'held_out' as const
  if (input.scannedIn) return 'bisley_stock' as const
  return 'reported_sold' as const
}

export function claimFileName(rma: string, kind: 'bisley' | 'carrier') {
  return `${rma}-${kind}-claim.zip`
}

/** Stored (uncompressed) zip of one text file. Enough for a claim pack download. */
export function zipStore(name: string, text: string): Buffer {
  const file = Buffer.from(text)
  const nameBuf = Buffer.from(name)
  const crc = crc32(file)
  const local = Buffer.alloc(30 + nameBuf.length + file.length)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(0, 8)
  local.writeUInt16LE(0, 10)
  local.writeUInt16LE(0, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(file.length, 18)
  local.writeUInt32LE(file.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  local.writeUInt16LE(0, 28)
  nameBuf.copy(local, 30)
  file.copy(local, 30 + nameBuf.length)
  const central = Buffer.alloc(46 + nameBuf.length)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(file.length, 20)
  central.writeUInt32LE(file.length, 24)
  central.writeUInt16LE(nameBuf.length, 28)
  central.writeUInt32LE(local.length, 42)
  nameBuf.copy(central, 46)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(local.length, 16)
  return Buffer.concat([local, central, end])
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export type DeskItem = {
  item_condition: string | null
  quantity_requested: number | null
  quantity_received: number | null
  stock_scanned_at: unknown
}

/** How many units one scan puts back. One unit per scan, never more than the units still to come back. */
export function scanInUnits(item: Pick<DeskItem, 'quantity_requested' | 'quantity_received'>, wanted = 1) {
  const left = Math.max(0, Number(item.quantity_requested ?? 1) - Number(item.quantity_received ?? 0))
  if (left <= 0) return { ok: false as const, reason: 'Every unit on this line is already back in stock' }
  const units = Math.max(1, Math.min(Math.trunc(Number(wanted)) || 1, left))
  return { ok: true as const, units, left: left - units }
}

/** A line is done for stock when every requested unit has been scanned in. */
function lineScannedIn(item: DeskItem) {
  return Number(item.quantity_received ?? 0) >= Number(item.quantity_requested ?? 1)
}

/**
 * Where the whole return sits after an inspection or a scan-in. It only moves on when every line is dealt with:
 * a line with no condition yet, or an unopened line still to be scanned in, keeps the return at To inspect.
 * When every line is back in stock the return is ready to refund. Otherwise it is ready for a decision.
 */
export function nextDeskStatus(items: DeskItem[]) {
  if (!items.length) return 'to_inspect' as const
  if (items.some((item) => !item.item_condition)) return 'to_inspect' as const
  if (items.some((item) => item.item_condition === 'Unopened' && !lineScannedIn(item))) return 'to_inspect' as const
  if (items.every(lineScannedIn)) return 'to_refund' as const
  return 'to_decide' as const
}

/** The scanned code is the item's SKU, or a barcode that belongs to it. Spaces and case are ignored. */
export function codeMatchesItem(code: string, sku: string, barcodeSkus: string[]) {
  const wanted = String(sku || '').trim().toUpperCase()
  const typed = String(code || '').trim().toUpperCase()
  if (!wanted || !typed) return false
  return typed === wanted || barcodeSkus.some((owner) => String(owner || '').trim().toUpperCase() === wanted)
}

/** Units on a line that did not go back into stock, so still need a decision. */
export function unitsToDecide(item: Pick<DeskItem, 'quantity_requested' | 'quantity_received'>) {
  return Math.max(0, Number(item.quantity_requested ?? 1) - Number(item.quantity_received ?? 0))
}

export const ITEM_DECISIONS = ['write_off', 'spares', 'second', 'bisley_claim', 'carrier_claim'] as const

/** What a decision does to stock. Nothing here puts a damaged unit on a pick bay: spares and seconds are held apart. */
export function decisionStockEffect(decision: string) {
  if (decision === 'write_off') return 'write_off' as const
  if (decision === 'spares' || decision === 'second') return 'held' as const
  return 'none' as const
}

export type DecidedItem = DeskItem & { decision?: string | null }

/**
 * Where the return sits once lines are decided. A line is dealt with when it is back in stock or has a decision.
 * Not every line dealt with yet: stays To decide. Any claim: Claim. Otherwise: closed if the money has already gone, else To refund.
 */
export function deskAfterDecisions(items: DecidedItem[], alreadyRefunded: boolean) {
  const open = items.filter((item) => unitsToDecide(item) > 0 && !item.decision)
  if (open.length) return 'to_decide' as const
  if (items.some((item) => item.decision === 'bisley_claim' || item.decision === 'carrier_claim')) return 'claim' as const
  return alreadyRefunded ? ('closed' as const) : ('to_refund' as const)
}

export type ZipEntry = { name: string; data: Buffer }

/** Stored (uncompressed) zip of several files: text and photos. */
export function zipFiles(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name)
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    nameBuf.copy(local, 30)
    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    locals.push(local, entry.data)
    centrals.push(central)
    offset += local.length + entry.data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, end])
}
