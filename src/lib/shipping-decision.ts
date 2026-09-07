/**
 * Shared courier-decision logic for a single packed item, used by both the bulk auto-tag job
 * (settings.ts) and the per-product shipping-estimates endpoint (products.ts). Kept as one
 * function so the two call sites can't silently drift out of sync on the routing rules.
 *
 * Rules (as confirmed with Bisley):
 * 1. MultiDesk kit bundles always ship via AIT, regardless of whether UPS would accept them.
 * 2. Everything else tries a real live UPS Rating API quote first, restricted to genuine UPS
 *    parcel services (never UPS's own freight/pallet-tier service — Bisley uses AIT for freight).
 * 3. If UPS rejects the package, or only offers freight-tier services, fall back to AIT.
 * 4. If UPS accepts it but the cheapest quote costs more than MAX_UPS_COST_PERCENT_OF_PRICE of
 *    the item's price, it's not worth using UPS even though it's technically eligible — use AIT.
 * 5. AIT's real rate card is a flat cost per weight band (see aitWeightTiers) — not a live-quoted
 *    courier. If the item's weight exceeds every configured band, it needs manual review rather
 *    than guessing a price. Falls back to a percentage-of-price estimate only if no weight tiers
 *    are configured at all (legacy behaviour, kept as a safety net).
 */

import type { ShippingService } from './shipping-estimator.js';
import type { UpsRateQuote } from './ups.js';

export const MAX_UPS_COST_PERCENT_OF_PRICE = 12;

/** A flat AIT rate band — charged when the packed weight is at or below max_weight_kg. */
export interface AitWeightTier {
  max_weight_kg: number;
  cost_gbp: number;
}

/** Parses/validates the ait_freight service's metadata.weight_tiers into a sorted tier list. */
export function parseAitWeightTiers(metadata: unknown): AitWeightTier[] | null {
  const raw = (metadata as { weight_tiers?: unknown } | null | undefined)?.weight_tiers;
  if (!Array.isArray(raw) || !raw.length) return null;
  const tiers = raw
    .map((t) => ({ max_weight_kg: Number((t as any)?.max_weight_kg), cost_gbp: Number((t as any)?.cost_gbp) }))
    .filter((t) => Number.isFinite(t.max_weight_kg) && t.max_weight_kg > 0 && Number.isFinite(t.cost_gbp) && t.cost_gbp >= 0)
    .sort((a, b) => a.max_weight_kg - b.max_weight_kg);
  return tiers.length ? tiers : null;
}

export interface AitAssignment {
  service_code: string;
  service_name: string;
  pricing_method: 'weight_tiers' | 'percentage_of_price';
  percentage_of_price: number | null;
  matched_tier_max_kg: number | null;
  price_gbp: number | null;
  estimated_cost_gbp: number | null;
}

export interface ShippingDecisionInput {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  weightGrams: number;
  priceGbp: number | null;
  isMultidesk: boolean;
  /** Active UPS shipping services — used to resolve a quote's shipment_mode and display name. */
  upsServices: ShippingService[];
  aitServiceCode: string;
  aitServiceName: string;
  /** Real AIT rate card, sorted ascending by max_weight_kg. Preferred over aitPercentageOfPrice. */
  aitWeightTiers: AitWeightTier[] | null;
  /** Legacy flat-percentage-of-price estimate — only used when aitWeightTiers is empty/null. */
  aitPercentageOfPrice: number;
  upsConfigured: boolean;
  getUpsQuotes: (params: { lengthMm: number; widthMm: number; heightMm: number; weightGrams: number }) =>
    Promise<{ quotes: UpsRateQuote[] | null; error: string | null }>;
}

export interface ShippingDecisionResult {
  preferredServiceCode: string | null;
  preferredCostAmount: number | null;
  preferredCostCurrency: string | null;
  manualReviewReason: string | null;
  /** Genuine UPS parcel quotes only (freight-tier quotes are filtered out) — for display. */
  liveQuotes: UpsRateQuote[] | null;
  liveQuoteError: string | null;
  liveQuoteConfigRequired: boolean;
  aitQuote: AitAssignment | null;
}

export async function decideShippingForPackedItem(input: ShippingDecisionInput): Promise<ShippingDecisionResult> {
  const {
    lengthMm, widthMm, heightMm, weightGrams, priceGbp, isMultidesk, upsServices,
    aitServiceCode, aitServiceName, aitWeightTiers, aitPercentageOfPrice, upsConfigured, getUpsQuotes,
  } = input;

  let preferredServiceCode: string | null = null;
  let preferredCostAmount: number | null = null;
  let preferredCostCurrency: string | null = null;
  let manualReviewReason: string | null = null;
  let liveQuotes: UpsRateQuote[] | null = null;
  let liveQuoteError: string | null = null;
  let liveQuoteConfigRequired = false;
  let aitQuote: AitAssignment | null = null;

  // Returns true if AIT could actually be assigned a real cost.
  const assignAit = (): boolean => {
    if (aitWeightTiers && aitWeightTiers.length) {
      const weightKg = weightGrams / 1000;
      const tier = aitWeightTiers.find(t => weightKg <= t.max_weight_kg);
      aitQuote = {
        service_code: aitServiceCode, service_name: aitServiceName, pricing_method: 'weight_tiers',
        percentage_of_price: null, matched_tier_max_kg: tier?.max_weight_kg ?? null,
        price_gbp: priceGbp, estimated_cost_gbp: tier?.cost_gbp ?? null,
      };
      if (!tier) return false; // heavier than every known AIT band — don't guess, needs a manual quote
      preferredServiceCode = aitServiceCode;
      preferredCostAmount = tier.cost_gbp;
      preferredCostCurrency = 'GBP';
      return true;
    }

    // Legacy fallback: no rate card configured yet, estimate from a flat % of item price.
    const estimatedCostGbp = priceGbp != null ? Math.round(priceGbp * (aitPercentageOfPrice / 100) * 100) / 100 : null;
    aitQuote = {
      service_code: aitServiceCode, service_name: aitServiceName, pricing_method: 'percentage_of_price',
      percentage_of_price: aitPercentageOfPrice, matched_tier_max_kg: null,
      price_gbp: priceGbp, estimated_cost_gbp: estimatedCostGbp,
    };
    if (estimatedCostGbp == null) return false;
    preferredServiceCode = aitServiceCode;
    preferredCostAmount = estimatedCostGbp;
    preferredCostCurrency = 'GBP';
    return true;
  };

  const aitFailureReason = (): string => {
    if (aitWeightTiers && aitWeightTiers.length) {
      const heaviestTierKg = aitWeightTiers[aitWeightTiers.length - 1].max_weight_kg;
      return `Manual review required - item weighs more than the heaviest AIT rate band (${heaviestTierKg}kg) — get a manual quote from AIT.`;
    }
    return 'Manual review required - no price recorded to calculate AIT percentage-based shipping cost.';
  };

  if (isMultidesk) {
    if (!assignAit()) {
      manualReviewReason = aitFailureReason();
    }
    return { preferredServiceCode, preferredCostAmount, preferredCostCurrency, manualReviewReason, liveQuotes, liveQuoteError, liveQuoteConfigRequired, aitQuote };
  }

  if (!upsConfigured) {
    liveQuoteConfigRequired = true;
    liveQuoteError = 'Live UPS rates are not configured. Set UPS_REFERENCE_DESTINATION_* env vars on the backend.';
    return { preferredServiceCode, preferredCostAmount, preferredCostCurrency, manualReviewReason, liveQuotes, liveQuoteError, liveQuoteConfigRequired, aitQuote };
  }

  const result = await getUpsQuotes({ lengthMm, widthMm, heightMm, weightGrams });

  // Bisley uses AIT for freight, not UPS Express Freight — only genuine parcel-tier quotes count.
  const parcelQuotes = (result.quotes ?? []).filter((quote) => {
    const matchedService = quote.internalServiceCode ? upsServices.find(s => s.service_code === quote.internalServiceCode) : null;
    return matchedService?.shipment_mode === 'parcel';
  });
  liveQuotes = parcelQuotes.length
    ? parcelQuotes.map((quote) => {
        const matchedService = quote.internalServiceCode ? upsServices.find(s => s.service_code === quote.internalServiceCode) : null;
        // UPS's Rating API often omits Service.Description for this account — fall back to our own
        // configured service name (same catalogue shown in Settings > Shipping & Packing).
        return { ...quote, serviceName: matchedService?.service_name ?? quote.serviceName ?? `UPS service ${quote.upsServiceCode}` };
      })
    : null;
  liveQuoteError = result.error ?? (result.quotes?.length && !parcelQuotes.length ? 'UPS only offered freight-tier services for this package.' : null);

  if (liveQuoteError || !liveQuotes?.length) {
    // Genuinely too big for UPS parcel (or freight-tier only) — fall back to AIT.
    if (!assignAit()) {
      manualReviewReason = `Manual review required - UPS ${result.error ? 'rejected this package' : 'only offered freight-tier services'} (${result.error ?? 'no parcel services were returned'}) and AIT could not be assigned either: ${aitFailureReason().replace('Manual review required - ', '')}`;
    }
    return { preferredServiceCode, preferredCostAmount, preferredCostCurrency, manualReviewReason, liveQuotes, liveQuoteError, liveQuoteConfigRequired, aitQuote };
  }

  const cheapest = liveQuotes.reduce((best, quote) => {
    if (quote.totalChargesAmount == null || !quote.internalServiceCode) return best;
    if (!best || (best.totalChargesAmount ?? Infinity) > quote.totalChargesAmount) return quote;
    return best;
  }, null as (typeof liveQuotes)[number] | null);

  if (!cheapest?.internalServiceCode) {
    manualReviewReason = 'Manual review required - UPS returned quotes but none matched a configured internal service code.';
    return { preferredServiceCode, preferredCostAmount, preferredCostCurrency, manualReviewReason, liveQuotes, liveQuoteError, liveQuoteConfigRequired, aitQuote };
  }

  const tooExpensiveForUps = priceGbp != null && cheapest.totalChargesAmount != null
    && cheapest.totalChargesAmount > priceGbp * (MAX_UPS_COST_PERCENT_OF_PRICE / 100);

  if (tooExpensiveForUps) {
    // UPS would carry it (with surcharges, up to its published limits) but the cost isn't worth
    // it relative to the item's price — use AIT instead even though UPS technically accepted it.
    assignAit();
  } else {
    preferredServiceCode = cheapest.internalServiceCode;
    preferredCostAmount = cheapest.totalChargesAmount ?? null;
    preferredCostCurrency = cheapest.totalChargesCurrency ?? null;
  }

  return { preferredServiceCode, preferredCostAmount, preferredCostCurrency, manualReviewReason, liveQuotes, liveQuoteError, liveQuoteConfigRequired, aitQuote };
}
