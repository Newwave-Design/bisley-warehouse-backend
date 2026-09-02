export interface ProductDims {
  weight_grams: number | null;
  length_mm: number | null;
  width_mm: number | null;
  height_mm: number | null;
}

export interface PackagingProfile {
  code: string;
  name: string;
  package_type: string;
  inner_length_mm: number | null;
  inner_width_mm: number | null;
  inner_height_mm: number | null;
  max_weight_grams: number | null;
  tare_weight_grams: number | null;
  default_cost_gbp: number | string | null;
}

export interface ShippingService {
  service_code: string;
  service_name: string;
  courier_code: string;
  courier_name: string;
  service_level: string;
  shipment_mode: string;
  constraints: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface KitComponent {
  sku: string;
  required_quantity: number;
}

/**
 * Kit variants (e.g. MultiDesk) have no physical dimensions of their own in Medusa — they are a
 * bundle of separately-stocked component SKUs. This computes the combined shipping dims assuming
 * the components are stacked on top of each other in one box: weight sums, footprint takes the
 * largest component, height sums. Returns nulls (and complete: false) if any component is missing
 * or itself has incomplete dimensions, so callers don't silently ship on a partial guess.
 */
export function resolveKitDimensions(
  components: KitComponent[],
  componentDimsBySku: Map<string, ProductDims>
): ProductDims & { complete: boolean } {
  if (!components.length) return { weight_grams: null, length_mm: null, width_mm: null, height_mm: null, complete: false };

  let totalWeight = 0;
  let maxLength = 0;
  let maxWidth = 0;
  let totalHeight = 0;

  for (const component of components) {
    const dims = componentDimsBySku.get(component.sku);
    const qty = component.required_quantity > 0 ? component.required_quantity : 1;
    if (!dims || !dims.weight_grams || !dims.length_mm || !dims.width_mm || !dims.height_mm) {
      return { weight_grams: null, length_mm: null, width_mm: null, height_mm: null, complete: false };
    }
    totalWeight += dims.weight_grams * qty;
    maxLength = Math.max(maxLength, dims.length_mm);
    maxWidth = Math.max(maxWidth, dims.width_mm);
    totalHeight += dims.height_mm * qty;
  }

  return { weight_grams: totalWeight, length_mm: maxLength, width_mm: maxWidth, height_mm: totalHeight, complete: true };
}

export interface ServiceEstimate {
  service_code: string;
  service_name: string;
  courier_code: string;
  courier_name: string;
  service_level: string;
  shipment_mode: string;
  eligible: boolean;
  is_ups: boolean;
  estimated_shipping_cost_gbp: number | null;
  estimated_packaging_cost_gbp: number;
  estimated_total_cost_gbp: number | null;
  billable_weight_kg: number | null;
  volumetric_weight_kg: number | null;
  requirements: string[];
  reasons_not_eligible: string[];
}

export interface PackagedDimensions {
  raw_length_mm: number | null;
  raw_width_mm: number | null;
  raw_height_mm: number | null;
  padded_min_length_mm: number | null;
  padded_min_width_mm: number | null;
  padded_min_height_mm: number | null;
  padded_max_length_mm: number | null;
  padded_max_width_mm: number | null;
  padded_max_height_mm: number | null;
  used_length_mm: number | null;
  used_width_mm: number | null;
  used_height_mm: number | null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function mmToCm(mm: number | null): number {
  return mm && mm > 0 ? mm / 10 : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function paddedDimension(value: number | null, extraMm: number): number | null {
  if (value == null || value <= 0) return null;
  return value + extraMm;
}

function dimensionTuple(input: ProductDims): [number, number, number] {
  const dims = [input.length_mm ?? 0, input.width_mm ?? 0, input.height_mm ?? 0]
    .map(n => (Number.isFinite(n) ? Number(n) : 0));
  dims.sort((a, b) => b - a);
  return [dims[0], dims[1], dims[2]];
}

function computeVolumetricWeightKg(input: ProductDims, divisor = 5000): number | null {
  const l = mmToCm(input.length_mm);
  const w = mmToCm(input.width_mm);
  const h = mmToCm(input.height_mm);
  if (!l || !w || !h || divisor <= 0) return null;
  return round2((l * w * h) / divisor);
}

function computeVolumeLitres(input: ProductDims): number | null {
  const l = input.length_mm ?? 0;
  const w = input.width_mm ?? 0;
  const h = input.height_mm ?? 0;
  if (l <= 0 || w <= 0 || h <= 0) return null;
  return round2((l * w * h) / 1_000_000);
}

function pickPackagingProfile(
  dims: ProductDims,
  packagingProfiles: PackagingProfile[],
  preferredCode?: string | null
): PackagingProfile | null {
  if (preferredCode) {
    const preferred = packagingProfiles.find(p => p.code === preferredCode);
    if (preferred) return preferred;
  }

  const productWeight = dims.weight_grams ?? 0;
  const [longest, middle, shortest] = dimensionTuple(dims);
  const fitting = packagingProfiles.filter(p => {
    const maxWeight = p.max_weight_grams ?? Number.MAX_SAFE_INTEGER;
    const innerL = p.inner_length_mm ?? 0;
    const innerW = p.inner_width_mm ?? 0;
    const innerH = p.inner_height_mm ?? 0;
    if (!innerL || !innerW || !innerH) return false;
    const profileDims = [innerL, innerW, innerH].sort((a, b) => b - a);
    return (
      productWeight <= maxWeight &&
      longest <= profileDims[0] &&
      middle <= profileDims[1] &&
      shortest <= profileDims[2]
    );
  });

  if (!fitting.length) return null;

  fitting.sort((a, b) => {
    const va = (a.inner_length_mm ?? 0) * (a.inner_width_mm ?? 0) * (a.inner_height_mm ?? 0);
    const vb = (b.inner_length_mm ?? 0) * (b.inner_width_mm ?? 0) * (b.inner_height_mm ?? 0);
    return va - vb;
  });
  return fitting[0];
}

function defaultRateForService(service: ShippingService): { base: number; perKg: number; divisor: number; fuelPct: number } {
  const defaultByMode: Record<string, { base: number; perKg: number }> = {
    parcel: { base: 7.5, perKg: 0.45 },
    freight: { base: 32, perKg: 0.7 },
    pallet: { base: 58, perKg: 0.25 },
  };
  const defaultByLevel: Record<string, number> = {
    economy: 0.92,
    standard: 1,
    express: 1.35,
  };

  const mode = defaultByMode[service.shipment_mode] ?? defaultByMode.parcel;
  const levelMult = defaultByLevel[service.service_level] ?? 1;
  const baseOverride = asFiniteNumber(service.metadata?.base_cost_gbp);
  const perKgOverride = asFiniteNumber(service.metadata?.per_kg_gbp);
  const divisorOverride = asFiniteNumber(service.metadata?.volumetric_divisor);
  const fuelPct = asFiniteNumber(service.metadata?.fuel_surcharge_pct) ?? 0;

  return {
    base: round2((baseOverride ?? mode.base) * levelMult),
    perKg: round2((perKgOverride ?? mode.perKg) * levelMult),
    divisor: divisorOverride ?? 5000,
    fuelPct,
  };
}

function evaluateServiceEligibility(
  service: ShippingService,
  dims: ProductDims,
  packageWeightGrams: number,
  packageType: string
): { eligible: boolean; reasons: string[]; requirements: string[] } {
  const c = service.constraints ?? {};
  const reasons: string[] = [];
  const requirements: string[] = [];

  const [longest, middle, shortest] = dimensionTuple(dims);
  const weightKg = packageWeightGrams > 0 ? packageWeightGrams / 1000 : 0;
  const girthPlusLength = longest + (2 * middle) + (2 * shortest);
  const volumeLitres = computeVolumeLitres(dims);

  const maxWeightKg = asFiniteNumber(c.max_weight_kg);
  if (maxWeightKg != null) {
    requirements.push(`Max weight ${maxWeightKg} kg`);
    if (weightKg > maxWeightKg) reasons.push(`Weight ${round2(weightKg)} kg exceeds max ${maxWeightKg} kg`);
  }

  const maxLength = asFiniteNumber(c.max_length_mm) ?? asFiniteNumber(c.max_longest_side_mm);
  if (maxLength != null) {
    requirements.push(`Max longest side ${Math.round(maxLength)} mm`);
    if (longest > maxLength) reasons.push(`Longest side ${Math.round(longest)} mm exceeds ${Math.round(maxLength)} mm`);
  }

  const maxWidth = asFiniteNumber(c.max_width_mm);
  if (maxWidth != null) {
    requirements.push(`Max width ${Math.round(maxWidth)} mm`);
    if ((dims.width_mm ?? 0) > maxWidth) reasons.push(`Width ${(dims.width_mm ?? 0)} mm exceeds ${Math.round(maxWidth)} mm`);
  }

  const maxHeight = asFiniteNumber(c.max_height_mm);
  if (maxHeight != null) {
    requirements.push(`Max height ${Math.round(maxHeight)} mm`);
    if ((dims.height_mm ?? 0) > maxHeight) reasons.push(`Height ${(dims.height_mm ?? 0)} mm exceeds ${Math.round(maxHeight)} mm`);
  }

  const maxGirthPlusLength = asFiniteNumber(c.max_girth_plus_length_mm);
  if (maxGirthPlusLength != null) {
    requirements.push(`Max length+girth ${Math.round(maxGirthPlusLength)} mm`);
    if (girthPlusLength > maxGirthPlusLength) {
      reasons.push(`Length+girth ${Math.round(girthPlusLength)} mm exceeds ${Math.round(maxGirthPlusLength)} mm`);
    }
  }

  const maxVolumeLitres = asFiniteNumber(c.max_volume_litres);
  if (maxVolumeLitres != null) {
    requirements.push(`Max volume ${maxVolumeLitres} L`);
    if (volumeLitres != null && volumeLitres > maxVolumeLitres) {
      reasons.push(`Volume ${volumeLitres} L exceeds ${maxVolumeLitres} L`);
    }
  }

  const requiredPackageType = typeof c.required_packaging_type === 'string' ? c.required_packaging_type : null;
  if (requiredPackageType) {
    requirements.push(`Requires package type: ${requiredPackageType}`);
    if (requiredPackageType !== packageType) {
      reasons.push(`Package type ${packageType} does not match required ${requiredPackageType}`);
    }
  }

  return { eligible: reasons.length === 0, reasons, requirements };
}

export function estimateShippingForServices(input: {
  dims: ProductDims;
  services: ShippingService[];
  packagingProfiles: PackagingProfile[];
  preferredPackagingCode?: string | null;
  packagingPaddingMinMm?: number;
  packagingPaddingMaxMm?: number;
}): {
  packaged_dimensions: PackagedDimensions;
  picked_packaging_profile: PackagingProfile | null;
  package_weight_grams: number;
  volume_litres: number | null;
  estimates: ServiceEstimate[];
} {
  const { dims, services, packagingProfiles, preferredPackagingCode } = input;
  const paddingMin = Math.max(0, input.packagingPaddingMinMm ?? 15);
  const paddingMax = Math.max(paddingMin, input.packagingPaddingMaxMm ?? 20);

  // Conservative rule: use max packaging growth for eligibility and costing.
  const effectiveDims: ProductDims = {
    weight_grams: dims.weight_grams,
    length_mm: paddedDimension(dims.length_mm, paddingMax),
    width_mm: paddedDimension(dims.width_mm, paddingMax),
    height_mm: paddedDimension(dims.height_mm, paddingMax),
  };

  const pickedPackaging = pickPackagingProfile(effectiveDims, packagingProfiles, preferredPackagingCode);
  const packagingCost = asFiniteNumber(pickedPackaging?.default_cost_gbp) ?? 0;
  const tare = pickedPackaging?.tare_weight_grams ?? 0;
  const packageType = pickedPackaging?.package_type ?? 'parcel';
  const packageWeightGrams = Math.max((dims.weight_grams ?? 0) + tare, 0);
  const volumeLitres = computeVolumeLitres(effectiveDims);

  const packagedDimensions: PackagedDimensions = {
    raw_length_mm: dims.length_mm,
    raw_width_mm: dims.width_mm,
    raw_height_mm: dims.height_mm,
    padded_min_length_mm: paddedDimension(dims.length_mm, paddingMin),
    padded_min_width_mm: paddedDimension(dims.width_mm, paddingMin),
    padded_min_height_mm: paddedDimension(dims.height_mm, paddingMin),
    padded_max_length_mm: paddedDimension(dims.length_mm, paddingMax),
    padded_max_width_mm: paddedDimension(dims.width_mm, paddingMax),
    padded_max_height_mm: paddedDimension(dims.height_mm, paddingMax),
    used_length_mm: effectiveDims.length_mm,
    used_width_mm: effectiveDims.width_mm,
    used_height_mm: effectiveDims.height_mm,
  };

  const estimates = services.map((service): ServiceEstimate => {
    const rate = defaultRateForService(service);
    const volumetricWeight = computeVolumetricWeightKg(effectiveDims, rate.divisor);
    const actualWeightKg = packageWeightGrams > 0 ? packageWeightGrams / 1000 : 0;
    const minBillable = asFiniteNumber(service.metadata?.min_billable_kg) ?? 0;
    const billableKg = round2(Math.max(actualWeightKg, volumetricWeight ?? 0, minBillable));

    const eligibility = evaluateServiceEligibility(service, effectiveDims, packageWeightGrams, packageType);

    let shippingEstimate = round2(rate.base + (billableKg * rate.perKg));
    if (rate.fuelPct > 0) shippingEstimate = round2(shippingEstimate * (1 + (rate.fuelPct / 100)));

    const total = round2(shippingEstimate + packagingCost);

    return {
      service_code: service.service_code,
      service_name: service.service_name,
      courier_code: service.courier_code,
      courier_name: service.courier_name,
      service_level: service.service_level,
      shipment_mode: service.shipment_mode,
      eligible: eligibility.eligible,
      is_ups: service.courier_code.toLowerCase() === 'ups',
      estimated_shipping_cost_gbp: eligibility.eligible ? shippingEstimate : null,
      estimated_packaging_cost_gbp: round2(packagingCost),
      estimated_total_cost_gbp: eligibility.eligible ? total : null,
      billable_weight_kg: eligibility.eligible ? billableKg : null,
      volumetric_weight_kg: volumetricWeight,
      requirements: [
        ...eligibility.requirements,
        `Protective packaging allowance applied: +${paddingMin} to +${paddingMax} mm on each dimension`,
      ],
      reasons_not_eligible: eligibility.reasons,
    };
  });

  estimates.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    const ta = a.estimated_total_cost_gbp ?? Number.MAX_SAFE_INTEGER;
    const tb = b.estimated_total_cost_gbp ?? Number.MAX_SAFE_INTEGER;
    return ta - tb;
  });

  return {
    packaged_dimensions: packagedDimensions,
    picked_packaging_profile: pickedPackaging,
    package_weight_grams: packageWeightGrams,
    volume_litres: volumeLitres,
    estimates,
  };
}