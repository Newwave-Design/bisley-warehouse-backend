/**
 * APC's availability call lists every product on the account. A collection
 * should come back as the smallest service the boxes actually fit.
 *
 * Lightweight is one boxed item, 5kg, 45 × 35 × 20 cm.
 * Next day parcel is up to 20 items, 30kg each, 120 × 55 × 50 cm.
 * Non-conveyable is up to 2 items, 30kg each, 160 × 60 × 60 cm.
 * Anything larger stays on non-conveyable extra.
 *
 * A mainland postcode is offered the next-day product (APCNC16 and the
 * 10:30 / 12:00 versions). A remote postcode is offered the same size as a
 * 2–5 day product (APCTDNC and the matching lightweight and parcel codes).
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
  { label: 'Non-conveyable', codes: ['APCNC16', 'APCNC12', 'APCNC10', 'APCTDNC'], maxPieces: 2, maxWeightKg: 30, limit: [160, 60, 60] },
  { label: 'Non-conveyable extra', codes: ['APCYC16', 'APCYC12', 'APCYC10'], maxPieces: 2, maxWeightKg: 30, limit: null },
]

function serviceLabel(code: string, name: string, family: string): string {
  return code.toUpperCase().startsWith('APCTD') ? (name || family) : family
}

function sides(box: ApcBox): [number, number, number] {
  const [length, width, height] = [box.lengthCm, box.widthCm, box.heightCm].sort((left, right) => right - left)
  return [length, width, height]
}

function fits(boxes: ApcBox[], family: Family): boolean {
  if (!boxes.length || boxes.length > family.maxPieces) return false
  return boxes.every((box) => {
    if (!Number.isFinite(box.weightKg) || box.weightKg <= 0 || box.weightKg > family.maxWeightKg) return false
    if (!family.limit) return true
    const [length, width, height] = sides(box)
    return length <= family.limit[0] && width <= family.limit[1] && height <= family.limit[2]
  })
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
