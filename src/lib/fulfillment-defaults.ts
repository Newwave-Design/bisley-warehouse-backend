import type { PackagingProfile, ShippingService } from './shipping-estimator.js';

export const DEFAULT_SHIPPING_SERVICES: ShippingService[] = [
  {
    courier_code: 'ups',
    courier_name: 'UPS',
    service_code: 'ups_standard',
    service_name: 'UPS Standard',
    service_level: 'standard',
    shipment_mode: 'parcel',
    constraints: { required_packaging_type: 'parcel', max_weight_kg: 70, max_length_mm: 2740, max_girth_plus_length_mm: 4000, max_volume_litres: 1200 },
    metadata: { ready_for_api: true, category: 'parcel' },
  },
  {
    courier_code: 'ups',
    courier_name: 'UPS',
    service_code: 'ups_express',
    service_name: 'UPS Express Saver',
    service_level: 'express',
    shipment_mode: 'parcel',
    constraints: { required_packaging_type: 'parcel', max_weight_kg: 70, max_length_mm: 2740, max_girth_plus_length_mm: 4000, max_volume_litres: 1200 },
    metadata: { ready_for_api: true, category: 'parcel' },
  },
  {
    courier_code: 'ups',
    courier_name: 'UPS',
    service_code: 'ups_express_worldwide',
    service_name: 'UPS Worldwide Express',
    service_level: 'express',
    shipment_mode: 'parcel',
    constraints: { required_packaging_type: 'parcel', max_weight_kg: 70, max_length_mm: 2740, max_girth_plus_length_mm: 4000, max_volume_litres: 1200 },
    metadata: { ready_for_api: false, category: 'parcel' },
  },
  {
    courier_code: 'ups',
    courier_name: 'UPS',
    service_code: 'ups_express_plus',
    service_name: 'UPS Worldwide Express Plus',
    service_level: 'express',
    shipment_mode: 'parcel',
    constraints: { required_packaging_type: 'parcel', max_weight_kg: 70, max_length_mm: 2740, max_girth_plus_length_mm: 4000, max_volume_litres: 1200 },
    metadata: { ready_for_api: false, category: 'parcel' },
  },
  {
    courier_code: 'ups',
    courier_name: 'UPS',
    service_code: 'ups_expedited',
    service_name: 'UPS Worldwide Expedited',
    service_level: 'standard',
    shipment_mode: 'parcel',
    constraints: { required_packaging_type: 'parcel', max_weight_kg: 70, max_length_mm: 2740, max_girth_plus_length_mm: 4000, max_volume_litres: 1200 },
    metadata: { ready_for_api: false, category: 'parcel' },
  },
  {
    courier_code: 'ups',
    courier_name: 'UPS',
    service_code: 'ups_express_freight',
    service_name: 'UPS Worldwide Express Freight',
    service_level: 'express',
    shipment_mode: 'freight',
    constraints: { required_packaging_type: 'freight', max_weight_kg: 500, max_length_mm: 3000, max_volume_litres: 5000 },
    metadata: { ready_for_api: false, category: 'freight' },
  },
  {
    // Bisley's real current shipping operation for anything that doesn't fit a standard
    // carton (BOX-SMALL/MEDIUM/LARGE) — not a live-quoted courier, a flat percentage-of-price
    // cost estimate. percentage_of_price is editable via the shipping-services settings UI.
    courier_code: 'ait',
    courier_name: 'AIT',
    service_code: 'ait_freight',
    service_name: 'AIT Freight (Oversized / Non-Parcel)',
    service_level: 'standard',
    shipment_mode: 'freight',
    constraints: { required_packaging_type: 'freight' },
    metadata: { ready_for_api: false, category: 'freight', integration_type: 'percentage', percentage_of_price: 10 },
  },
];

export const DEFAULT_PACKAGING_PROFILES: PackagingProfile[] = [
  {
    code: 'BOX-SMALL',
    name: 'Small Carton',
    package_type: 'parcel',
    inner_length_mm: 350,
    inner_width_mm: 250,
    inner_height_mm: 180,
    max_weight_grams: 10000,
    tare_weight_grams: 250,
    default_cost_gbp: 1.25,
  },
  {
    code: 'BOX-MEDIUM',
    name: 'Medium Carton',
    package_type: 'parcel',
    inner_length_mm: 500,
    inner_width_mm: 350,
    inner_height_mm: 250,
    max_weight_grams: 18000,
    tare_weight_grams: 450,
    default_cost_gbp: 2.1,
  },
  {
    code: 'BOX-LARGE',
    name: 'Large Carton',
    package_type: 'parcel',
    inner_length_mm: 700,
    inner_width_mm: 500,
    inner_height_mm: 400,
    max_weight_grams: 30000,
    tare_weight_grams: 900,
    default_cost_gbp: 3.8,
  },
  {
    // Anything too big for BOX-SMALL/MEDIUM/LARGE. Not a pallet or freight decision by itself —
    // the real courier (real UPS parcel quote, or AIT) is decided independently in
    // src/lib/shipping-decision.ts. Kept as a large catch-all bin footprint for packaging-profile
    // (physical box) selection purposes only.
    code: 'UPS-FREIGHT-CUSTOM-PALLET',
    name: 'Oversized / Non-Standard',
    package_type: 'freight',
    inner_length_mm: 3000,
    inner_width_mm: 2000,
    inner_height_mm: 2000,
    max_weight_grams: 500000,
    tare_weight_grams: 0,
    default_cost_gbp: null,
  },
];

export function isMissingRelationError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === '42P01' || (e?.message ?? '').toLowerCase().includes('relation') && (e?.message ?? '').toLowerCase().includes('does not exist');
}
