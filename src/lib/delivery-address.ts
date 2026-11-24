/**
 * Correcting the delivery address on a warehouse order.
 * The warehouse copies the shop's address once, when the order is placed, and never refreshes it, so a fix in the shop
 * does not reach the label. This is the way to change the copy. Only an order that has not shipped can be changed.
 */

export const ADDRESS_FIELDS = ['first_name', 'last_name', 'company', 'address_1', 'address_2', 'city', 'province', 'postal_code', 'country_code', 'phone'] as const;
export type AddressField = (typeof ADDRESS_FIELDS)[number];
export type AddressPatch = Partial<Record<AddressField, string>>;

export class AddressError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const LIMITS: Record<AddressField, number> = {
  first_name: 60, last_name: 60, company: 80, address_1: 100, address_2: 100, city: 60, province: 60, postal_code: 12, country_code: 2, phone: 30,
};

/** Only the known fields, trimmed. A field left out is left alone; a field sent empty is cleared. */
export function cleanAddressPatch(input: unknown): AddressPatch {
  const source = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const patch: AddressPatch = {};
  for (const field of ADDRESS_FIELDS) {
    if (!(field in source) || source[field] == null) continue;
    const value = String(source[field]).replace(/\s+/g, ' ').trim();
    if (value.length > LIMITS[field]) throw new AddressError(400, `${field.replace(/_/g, ' ')} is too long`);
    // Control characters and the stray punctuation a mis-key leaves behind never belong in a street line.
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new AddressError(400, `${field.replace(/_/g, ' ')} has a character that cannot be used`);
    patch[field] = field === 'country_code' || field === 'postal_code' ? value.toUpperCase() : value;
  }
  if (!Object.keys(patch).length) throw new AddressError(400, 'Send at least one address field to change');
  if ('address_1' in patch && !patch.address_1) throw new AddressError(400, 'The first address line cannot be empty');
  if ('city' in patch && !patch.city) throw new AddressError(400, 'The town or city cannot be empty');
  if ('postal_code' in patch && !patch.postal_code) throw new AddressError(400, 'The postcode cannot be empty');
  if (patch.country_code && !/^[A-Z]{2}$/.test(patch.country_code)) throw new AddressError(400, 'The country must be a two-letter code such as GB');
  if (patch.country_code === 'GB' && patch.postal_code && !/^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/.test(patch.postal_code)) {
    throw new AddressError(400, 'That does not look like a UK postcode');
  }
  return patch;
}

/** The changed fields as a short line for the order history. */
export function describeAddressChange(before: Record<string, unknown> | null, patch: AddressPatch): string {
  const parts: string[] = [];
  for (const field of Object.keys(patch) as AddressField[]) {
    const was = String((before && before[field]) ?? '').trim();
    const now = patch[field] ?? '';
    if (was === now) continue;
    parts.push(`${field.replace(/_/g, ' ')} "${was}" to "${now}"`);
  }
  return parts.length ? `Delivery address corrected: ${parts.join(', ')}` : 'Delivery address confirmed, nothing changed';
}
