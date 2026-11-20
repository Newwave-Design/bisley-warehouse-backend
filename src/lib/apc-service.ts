/**
 * APC's availability call lists every product on the account. A collection
 * should come back as the smallest service the boxes actually fit.
 *
 * Lightweight is one boxed item, 5kg, 45 × 35 × 20 cm.
 * Next day parcel is up to 20 items, 30kg each, 120 × 55 × 50 cm.
 * Non-conveyable is up to 4 items, 30kg each, 160 × 60 × 60 cm.
 * Anything larger stays on non-conveyable extra.
 * More than 4 boxes on either of those is separate consignments of 4.
 *
 * A mainland postcode is offered the next-day product (APCNC16 and the
 * 10:30 / 12:00 versions). A remote postcode is offered the same size as a
 * 2–5 day product (APCTDNC and the matching lightweight and parcel codes).
 * Northern Ireland is the road non-conveyable product, APCRDNC.
 * Those slower products are listed after the next-day codes, so a next-day
 * service is kept when APC offers both.
 */

export interface ApcServiceChoice {
  code: string
  name: string
  ruleMatch: boolean
  ruleName: string
}

export interface ApcBox {
  weightKg: number
  lengthCm: number
  widthCm: number
  heightCm: number
}

interface Family {
  label: string
  codes: string[]
  maxPieces: number
  maxWeightKg: number
  limit: [number, number, number] | null
}

const FAMILIES: Family[] = [
  { label: 'Lightweight', codes: ['APCLW16', 'APCLW12', 'APCLW10', 'APCTDLW'], maxPieces: 1, maxWeightKg: 5, limit: [45, 35, 20] },
  { label: 'Next day parcel', codes: ['APCND16', 'APCND12', 'APCND10', 'APCTDAY'], maxPieces: 20, maxWeightKg: 30, limit: [120, 55, 50] },
  { label: 'Non-conveyable', codes: ['APCNC16', 'APCNC12', 'APCNC10', 'APCTDNC', 'APCRDNC'], maxPieces: 4, maxWeightKg: 30, limit: [160, 60, 60] },
  { label: 'Non-conveyable extra', codes: ['APCYC16', 'APCYC12', 'APCYC10'], maxPieces: 4, maxWeightKg: 30, limit: null },
]

function serviceLabel(code: string, name: string, family: string): string {
  return code.toUpperCase().startsWith('APCTD') ? (name || family) : family
}

function sides(box: ApcBox): [number, number, number] {
  const [length, width, height] = [box.lengthCm, box.widthCm, box.heightCm].sort((left, right) => right - left)
  return [length, width, height]
}

function boxFits(box: ApcBox, family: Family): boolean {
  if (!Number.isFinite(box.weightKg) || box.weightKg <= 0 || box.weightKg > family.maxWeightKg) return false
  if (!family.limit) return true
  const [length, width, height] = sides(box)
  return length <= family.limit[0] && width <= family.limit[1] && height <= family.limit[2]
}

function fits(boxes: ApcBox[], family: Family): boolean {
  if (!boxes.length) return false
  if (!boxes.every((box) => boxFits(box, family))) return false
  if (boxes.length <= family.maxPieces) return true
  return family.label === 'Non-conveyable' || family.label === 'Non-conveyable extra'
}

function familyFor(boxes: ApcBox[]): Family | null {
  for (const family of FAMILIES) {
    if (!boxes.every((box) => boxFits(box, family))) continue
    if (boxes.length <= family.maxPieces) return family
    if (family.label === 'Non-conveyable' || family.label === 'Non-conveyable extra') return family
  }
  return null
}

/**
 * APC will not offer a service when the availability call has more boxes than that
 * product allows. Ask about the largest boxes that fit in one consignment. The
 * booking still sends every box, split into consignments of that size.
 */
export function apcAvailabilityItems<T>(boxes: ApcBox[], items: T[]): T[] {
  if (!items.length || items.length !== boxes.length) return items
  const family = familyFor(boxes)
  if (!family || boxes.length <= family.maxPieces) return items
  const largest = boxes
    .map((box, index) => ({ index, size: box.lengthCm * box.widthCm * box.heightCm }))
    .sort((left, right) => right.size - left.size || left.index - right.index)
    .slice(0, family.maxPieces)
  return largest.map((row) => items[row.index])
}

/** How many boxes one APC order can carry for this product. Null when the booking stays as one consignment. */
export function apcConsignmentSize(serviceCode: string): number | null {
  const code = serviceCode.trim().toUpperCase()
  const family = FAMILIES.find((row) => row.codes.some((item) => item.toUpperCase() === code))
  if (!family || family.label === 'Lightweight' || family.maxPieces >= 20) return null
  return family.maxPieces
}

export function appropriateApcServices<T extends ApcServiceChoice>(services: T[], boxes: ApcBox[]): T[] {
  const byCode = new Map(services.map((service) => [service.code.toUpperCase(), service]))
  for (const family of FAMILIES) {
    if (!fits(boxes, family)) continue
    const matched = family.codes.map((code) => byCode.get(code)).filter((service): service is T => Boolean(service))
    if (!matched.length) continue
    const chosen = matched[0].code.toUpperCase()
    return matched.map((service) => ({
      ...service,
      ruleMatch: service.code.toUpperCase() === chosen,
      ruleName: serviceLabel(service.code, service.name, family.label),
    }))
  }
  return []
}
