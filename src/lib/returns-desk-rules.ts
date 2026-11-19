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
