/**
 * Order values for the Customer Orders list, read live from Medusa (refunds change after the order is placed).
 *   gross    = order total: incl. VAT and shipping, after discounts. Medusa has already taken refunds/credit lines off it.
 *   vat      = order tax total, scaled down to match the total once credit lines (refunds) are removed
 *   refunded = summary.refunded_total (informational only — not subtracted again)
 *   net      = gross - vat
 * Cached briefly per order; any failure yields null so the list never breaks.
 */
import { medusaGet } from './medusa-client.js';

export interface OrderValue {
  gross: number;
  net: number;
  vat: number;
  refunded: number;
  currency: string;
}

const TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 1000;
const CONCURRENCY = 8;
const cache = new Map<string, { at: number; ttl: number; value: OrderValue | null }>();

const round2 = (n: number) => Math.round(n * 100) / 100;

async function fetchOrderValue(orderId: string): Promise<OrderValue | null> {
  const data = await medusaGet(`/admin/orders/${encodeURIComponent(orderId)}?fields=id,currency_code,total,tax_total,credit_line_total,*summary`);
  const o = data?.order;
  const gross = Number(o?.total);
  if (!o || Number.isNaN(gross)) return null;

  // tax_total still includes the VAT on credit lines, which `total` has already had deducted
  const taxTotal = Number(o.tax_total) || 0;
  const creditLines = Number(o.credit_line_total) || 0;
  const vat = creditLines > 0 && gross + creditLines > 0 ? taxTotal * (gross / (gross + creditLines)) : taxTotal;
  const refunded = Number(o.summary?.refunded_total) || 0;

  return {
    gross: round2(gross),
    vat: round2(vat),
    refunded: round2(refunded),
    net: round2(gross - vat),
    currency: String(o.currency_code || 'gbp').toUpperCase(),
  };
}

export async function getOrderValues(orderIds: string[]): Promise<Record<string, OrderValue | null>> {
  const out: Record<string, OrderValue | null> = {};
  const missing: string[] = [];

  for (const id of new Set(orderIds.filter(Boolean))) {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < hit.ttl) out[id] = hit.value;
    else missing.push(id);
  }

  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    await Promise.all(missing.slice(i, i + CONCURRENCY).map(async (id) => {
      let value: OrderValue | null = null;
      try {
        value = await fetchOrderValue(id);
      } catch {
        value = null;
      }
      cache.set(id, { at: Date.now(), ttl: value ? TTL_MS : FAILURE_TTL_MS, value });
      out[id] = value;
    }));
  }

  return out;
}
