// The name and address printed on a pick list. A shop order sometimes has the
// person and street on the billing address only, with shipping left as a country.

type AddressLike = {
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
} | null | undefined

export type AddressSnapshot = {
  first_name: string | null
  last_name: string | null
  company: string | null
  address_1: string | null
  address_2: string | null
  city: string | null
  province: string | null
  postal_code: string | null
  country_code: string | null
  phone: string | null
}

function text(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  return raw || null
}

function personName(address: AddressLike): string {
  return [text(address?.first_name), text(address?.last_name)].filter(Boolean).join(' ')
}

function hasDestination(address: AddressLike): boolean {
  return Boolean(text(address?.address_1) || text(address?.postal_code) || personName(address))
}

function snapshot(address: AddressLike, countryFallback?: string | null): AddressSnapshot {
  return {
    first_name: text(address?.first_name),
    last_name: text(address?.last_name),
    company: text(address?.company),
    address_1: text(address?.address_1),
    address_2: text(address?.address_2),
    city: text(address?.city),
    province: text(address?.province),
    postal_code: text(address?.postal_code),
    country_code: text(address?.country_code) || text(countryFallback),
    phone: text(address?.phone),
  }
}

export function customerFromOrder(order: any): { customerName: string | null; customerEmail: string | null; shippingAddress: AddressSnapshot } {
  const shipping = (order?.shipping_address ?? order?.address ?? null) as AddressLike
  const billing = (order?.billing_address ?? null) as AddressLike
  const customer = order?.customer ?? null
  const destination = hasDestination(shipping) ? shipping : (hasDestination(billing) ? billing : shipping)
  const customerName = personName(destination)
    || personName(billing)
    || [text(customer?.first_name), text(customer?.last_name)].filter(Boolean).join(' ')
    || text(destination?.company)
    || text(billing?.company)
    || text(customer?.company_name)
    || text(order?.email)
    || text(customer?.email)
    || null
  return {
    customerName,
    customerEmail: text(order?.email) || text(customer?.email),
    shippingAddress: snapshot(destination, text(shipping?.country_code) || text(billing?.country_code)),
  }
}

/** The shop email to write onto open pick lists, or null when every copy already matches. */
export function customerEmailChanged(stored: string[], incoming: string | null): string | null {
  const next = (incoming ?? '').trim()
  if (!next) return null
  const differs = stored.some((email) => email.trim().toLowerCase() !== next.toLowerCase())
  return differs ? next : null
}

const NEVER_BLANKED: (keyof AddressSnapshot)[] = ['first_name', 'last_name', 'phone', 'address_1', 'city', 'postal_code', 'country_code']

function sameValue(field: keyof AddressSnapshot, a: string, b: string): boolean {
  if (field === 'postal_code') return a.replace(/\s+/g, '').toUpperCase() === b.replace(/\s+/g, '').toUpperCase()
  if (field === 'country_code') return a.toLowerCase() === b.toLowerCase()
  return a === b
}

/**
 * The fields of the stored delivery address that the shop now says differently, to be copied onto an open pick list.
 * A shop address with no street, town or postcode is ignored, so a half-filled edit never wipes a good address.
 * The name, phone, street, town, postcode and country are never blanked; a second line, county or company can be cleared.
 */
export function addressChanges(stored: Record<string, unknown> | null | undefined, incoming: AddressSnapshot): Partial<Record<keyof AddressSnapshot, string>> {
  if (!incoming.address_1 || !incoming.postal_code || !incoming.city) return {}
  const changes: Partial<Record<keyof AddressSnapshot, string>> = {}
  for (const field of Object.keys(incoming) as (keyof AddressSnapshot)[]) {
    const next = String(incoming[field] ?? '').trim()
    const was = String(stored?.[field] ?? '').trim()
    if (sameValue(field, next, was)) continue
    if (!next && NEVER_BLANKED.includes(field)) continue
    changes[field] = next
  }
  return changes
}
