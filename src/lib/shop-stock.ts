/**
 * What the shop may sell is the stock not reserved to any existing order.
 *
 * Medusa works out what it can sell as stocked quantity minus its own reservations (one per open shop order).
 * The warehouse has already taken its reservations off its free stock, so pushing free stock as the stocked
 * quantity would take the same orders off twice. Instead the stocked quantity is set to what can be sold
 * plus Medusa's own reservations, so that stocked minus reserved is exactly what can be sold.
 *
 * What can be sold is the smaller of the warehouse free stock and what is left on the shelf after Medusa's
 * reservations. The second figure covers an order Medusa has reserved that the warehouse has not reserved yet
 * (for example while its payment is pending): that order still has first call on the unit.
 */

/** The Authorization header for a Medusa key. A secret key (sk_...) is sent as Basic, a token as Bearer. */
export function medusaKeyHeader(key: string): string {
  return key.startsWith('sk_') ? `Basic ${Buffer.from(`${key}:`).toString('base64')}` : `Bearer ${key}`;
}

export function shopStockTarget(input: { free: number; onhand: number | null; medusaReserved: number }): { sellable: number; stocked: number } {
  const reserved = Math.max(0, Math.trunc(Number(input.medusaReserved)) || 0);
  const free = Math.trunc(Number(input.free)) || 0;
  const room = input.onhand == null ? free : Math.trunc(Number(input.onhand)) - reserved;
  const sellable = Math.max(0, Math.min(free, room));
  return { sellable, stocked: sellable + reserved };
}
