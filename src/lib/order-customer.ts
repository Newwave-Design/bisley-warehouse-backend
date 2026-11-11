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
