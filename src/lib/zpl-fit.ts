/**
 * Courier labels are drawn longer than the ZD421 roll (102 × 152 mm, 4 × 6 inch,
 * 812 × 1218 dots). DX sets ^LL1595, about 8 inches. One label still looks nearly
 * whole because the extra feed runs off the end. The next label in the same batch
 * starts too early, so the bottom of each sticker is missing. Shrink anything
 * larger than the roll, then force the print length to the sticker.
 */

const STOCK_W = 812
const STOCK_H = 1218
const SHIP_W = 770
const SHIP_H = 1140

export function fitZpl(zpl: string): string {
  return zpl.split(/(?=\^XA)/).map((part) => (part.includes('^XA') ? fitLabel(part) : part)).join('')
}

function fitLabel(label: string): string {
  const [maxX, maxY] = bounds(label)
  const declaredW = Number(label.match(/\^PW(\d+)/)?.[1] || 0)
  const declaredH = Number(label.match(/\^LL(\d+)/)?.[1] || 0)
  if (maxY <= 500 && declaredH <= 500) return label
  const needW = Math.max(maxX, declaredW)
  const needH = Math.max(maxY, declaredH)
  if (needW <= STOCK_W && needH <= STOCK_H && maxX <= SHIP_W && maxY <= SHIP_H) return label
  const scale = Math.min(
    needW > SHIP_W ? SHIP_W / needW : 1,
    needH > SHIP_H ? SHIP_H / needH : 1,
    1,
  )
  const scaled = scale > 0.985 ? label : scaleLabel(label, scale)
  return forceStock(scaled)
}

function forceStock(label: string): string {
  let out = /\^PW\d+/.test(label) ? label.replace(/\^PW\d+/, `^PW${STOCK_W}`) : label.replace('^XA', `^XA\n^PW${STOCK_W}`)
  out = /\^LL\d+/.test(out) ? out.replace(/\^LL\d+/, `^LL${STOCK_H}`) : out.replace('^XA', `^XA\n^LL${STOCK_H}`)
  return out
}

function bounds(label: string): [number, number] {
  let x = 0
  let y = 0
  let maxX = 0
  let maxY = 0
  const mark = (px: number, py: number) => {
    if (px > maxX) maxX = px
    if (py > maxY) maxY = py
  }
  const tokens = label.matchAll(/\^(?:FO|FT|GB|GFA|A[A-Z0-9][NRIB]|BC[NRIB])[^^]*/g)
  for (const match of tokens) {
    const token = match[0]
    const nums = [...token.matchAll(/-?\d+/g)].map((part) => Number(part[0]))
    if (token.startsWith('^FO') || token.startsWith('^FT')) {
      x = nums[0] || 0
      y = nums[1] || 0
      mark(x, y)
    } else if (token.startsWith('^GB')) {
      mark(x + (nums[0] || 0), y + (nums[1] || 0))
    } else if (token.startsWith('^GFA')) {
      const row = nums[2] || 0
      const total = nums[0] || 0
      mark(x + row * 8, y + (row ? Math.floor(total / row) : 0))
    } else if (token.startsWith('^A')) {
      const height = nums[0] || 0
      const width = nums[1] || 0
      const ori = token[3]
      if (ori === 'R' || ori === 'B') mark(x + height, y + width)
      else mark(x + width, y + height)
    } else if (token.startsWith('^BC')) {
      const height = nums[0] || 0
      const ori = token[3]
      if (ori === 'R' || ori === 'B') mark(x + height, y)
      else mark(x, y + height)
    }
  }
  return [maxX, maxY]
}

function scaleLabel(label: string, factor: number): string {
  const dots = (value: number, min = 0) => Math.max(min, Math.round(value * factor))
  let out = label
  out = out.replace(/\^(FO|FT|LH)(-?\d+),(-?\d+)/g, (_m, cmd, a, b) => `^${cmd}${dots(Number(a))},${dots(Number(b))}`)
  out = out.replace(/\^(PW|LL|LT|LS)(-?\d+)/g, (_m, cmd, value) => `^${cmd}${dots(Number(value))}`)
  out = out.replace(/\^GB(\d+),(\d+),(\d+)/g, (_m, w, h, t) => `^GB${dots(Number(w), 1)},${dots(Number(h), 1)},${dots(Number(t), 1)}`)
  out = out.replace(/\^A([A-Z0-9])([NRIB]),(\d+),(\d+)/g, (_m, font, ori, h, w) => `^A${font}${ori},${dots(Number(h), 1)},${dots(Number(w), 1)}`)
  out = out.replace(/\^BY([0-9]*\.?[0-9]+)(?:,([0-9]*\.?[0-9]+))?(?:,([0-9]*\.?[0-9]+))?/g, (_m, width, ratio, height) => {
    let next = `^BY${decimal(width, factor)}`
    if (ratio) next += `,${ratio}`
    if (height) next += `,${decimal(height, factor)}`
    return next
  })
  out = out.replace(/\^BC([NRIB]),(\d+)/g, (_m, ori, height) => `^BC${ori},${dots(Number(height), 1)}`)
  out = out.replace(/\^BQ([NRIB]),(\d+),(\d+)/g, (_m, ori, mode, mag) => `^BQ${ori},${mode},${dots(Number(mag), 1)}`)
  return out
}

function decimal(raw: string, factor: number): string {
  const text = Math.max(1, Number(raw) * factor).toFixed(1)
  return text.endsWith('.0') ? text.slice(0, -2) : text
}
