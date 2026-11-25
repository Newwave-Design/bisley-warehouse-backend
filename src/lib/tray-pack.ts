/** Insert-tray single (`…P1-000`) and its 5-pack (`…P5-000`). */
const PACK_RE = /^(.+)P5-000$/i
const SINGLE_RE = /^(.+)P1-000$/i

export function packBase(sku: string): string | null {
  return PACK_RE.exec(sku.trim())?.[1] ?? null
}

export function singleBase(sku: string): string | null {
  return SINGLE_RE.exec(sku.trim())?.[1] ?? null
}

export function singleSkuForBase(base: string): string {
  return `${base}P1-000`
}

export function packSkuFor(base: string): string {
  return `${base}P5-000`
}
