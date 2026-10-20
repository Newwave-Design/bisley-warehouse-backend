/**
 * 102 × 40 mm sample address labels for the Zebra ZD421D (203 dpi direct thermal).
 * One ZPL job can contain many labels; the printer peels/tears them in sequence.
 */

export const SAMPLE_LABEL = {
  widthMm: 102,
  heightMm: 40,
  dpi: 203,
} as const

const DOTS_PER_MM = SAMPLE_LABEL.dpi / 25.4
export const SAMPLE_LABEL_WIDTH_DOTS = Math.round(SAMPLE_LABEL.widthMm * DOTS_PER_MM) // 816
export const SAMPLE_LABEL_HEIGHT_DOTS = Math.round(SAMPLE_LABEL.heightMm * DOTS_PER_MM) // 320

export type ShippingAddress = {
  first_name?: string | null
  last_name?: string | null
  company?: string | null
  address_1?: string | null
  address_2?: string | null
  city?: string | null
  province?: string | null
  postal_code?: string | null
  country_code?: string | null
  phone?: string | null
}

export type SampleAddressLabel = {
  id: string
  pick_list_number: string
  name: string
  company: string | null
  lines: string[]
  postal_code: string
  country: string | null
  flag: string | null
  first_class: boolean
}

export function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function zplText(value: string): string {
  return clean(value).replace(/[\^~\\]/g, ' ')
}

export function isFirstClassNote(text: string | null | undefined): boolean {
  return /first\s*class/i.test(text || '')
}

export function formatSampleAddressLabel(input: {
  id: string
  pick_list_number: string
  customer_name?: string | null
  shipping_address?: ShippingAddress | null
  flag_preview?: string | null
}): SampleAddressLabel | { skip: string } {
  const a = input.shipping_address || {}
  const name = clean(`${a.first_name || ''} ${a.last_name || ''}`) || clean(input.customer_name)
  const company = clean(a.company) || null
  const lines = [a.address_1, a.address_2, a.city, a.province].map(clean).filter(Boolean)
  const postal_code = clean(a.postal_code).toUpperCase()
  const countryCode = clean(a.country_code).toUpperCase()
  const country = countryCode && countryCode !== 'GB' ? countryCode : null
  const flag = clean(input.flag_preview) || null

  if (!name && !lines.length && !postal_code) {
    return { skip: 'No shipping address' }
  }

  return {
    id: input.id,
    pick_list_number: input.pick_list_number,
    name: name || 'Sample order',
    company,
    lines,
    postal_code,
    country,
    flag,
    first_class: isFirstClassNote(flag),
  }
}

export function buildSampleAddressZpl(labels: SampleAddressLabel[]): string {
  return labels.map(buildOneLabelZpl).join('')
}

function buildOneLabelZpl(label: SampleAddressLabel): string {
  const cmds: string[] = [
    '^XA',
    '^CI28',
    '^PON',
    '^MMT',
    `^PW${SAMPLE_LABEL_WIDTH_DOTS}`,
    `^LL${SAMPLE_LABEL_HEIGHT_DOTS}`,
    '^LH0,0',
    '^PR2',
    `^FO24,16^A0N,22,22^FD${zplText(`SAMPLE  ${label.pick_list_number}`)}^FS`,
  ]

  if (label.first_class) {
    cmds.push('^FO560,12^GB240,36,36^FS')
    cmds.push('^FO572,18^A0N,24,24^FR^FD1ST CLASS^FS')
  } else if (label.flag) {
    cmds.push(`^FO520,16^A0N,20,20^FDLABEL NOTE^FS`)
  }

  let y = 52
  cmds.push(`^FO24,${y}^A0N,36,36^FD${zplText(label.name)}^FS`)
  y += 40

  if (label.company) {
    cmds.push(`^FO24,${y}^A0N,26,26^FD${zplText(label.company)}^FS`)
    y += 30
  }

  for (const line of label.lines.slice(0, 4)) {
    cmds.push(`^FO24,${y}^A0N,26,26^FD${zplText(line)}^FS`)
    y += 28
  }

  if (label.country) {
    cmds.push(`^FO24,${y}^A0N,24,24^FD${zplText(label.country)}^FS`)
    y += 28
  }

  const postY = Math.min(y + 4, SAMPLE_LABEL_HEIGHT_DOTS - 52)
  cmds.push(`^FO24,${postY}^A0N,42,42^FD${zplText(label.postal_code)}^FS`)

  if (label.flag && !label.first_class) {
    cmds.push(`^FO24,${SAMPLE_LABEL_HEIGHT_DOTS - 28}^A0N,18,18^FD${zplText(label.flag.slice(0, 42))}^FS`)
  }

  cmds.push('^XZ')
  return cmds.join('\n') + '\n'
}
