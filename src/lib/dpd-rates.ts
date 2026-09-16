/**
 * DPD Shipping Rates Parser & Calculator
 * 
 * Parses DPD rate card and provides shipping cost calculation
 * based on destination zone, weight, dimensions, and service type.
 */

export interface DPDZone {
  code: 'A' | 'B' | 'C' | 'D';
  description: string;
  examples?: string[];
}

export interface DPDWeightTier {
  minKg: number;
  maxKg: number;
  nextWorkingDay: number;
  secondAndSubsequent: number;
}

export interface DPDHeavyWeightSurcharge {
  minKg: number;
  maxKg: number;
  charge: number;
}

export interface DPDLongLengthSurcharge {
  minCm: number;
  maxCm: number;
  charge: number;
}

export interface DPDTimedService {
  name: string;
  surcharge: number;
  applicableZones: ('A' | 'B' | 'C' | 'D')[];
}

export interface DPDService {
  name: string;
  baseCharge: number;
  applicableZones: ('A' | 'B' | 'C' | 'D')[];
}

export interface DPDBagitPack {
  size: 'S' | 'M' | 'L';
  weightRange: string;
  price: number;
  applicableZones: ('A' | 'B' | 'C' | 'D')[];
}

/**
 * DPD Shipping Rates — From official rate card
 * Last updated: 2026-09-16
 */
export class DPDRateCalculator {
  // Zone definitions
  zones: Record<'A' | 'B' | 'C' | 'D', DPDZone> = {
    A: { code: 'A', description: 'Zone A' },
    B: { code: 'B', description: 'Zone B' },
    C: { code: 'C', description: 'Zone C' },
    D: { code: 'D', description: 'Zone D' },
  };

  // Standard Weight Tiers (per parcel)
  standardWeightTiers: DPDWeightTier[] = [
    { minKg: 0, maxKg: 25, nextWorkingDay: 0, secondAndSubsequent: 0 }, // Placeholder - will be populated by zone
    { minKg: 25, maxKg: Infinity, nextWorkingDay: 0, secondAndSubsequent: 0 }, // Over 25kg
  ];

  // Rate card (from image)
  // Next Working Day rates (per parcel)
  ratesNextWorkingDay = {
    A: { upTo25kg: 5.75, over25kg: 0.29 }, // £0.29 per kg over 25kg
    B: { upTo25kg: 5.75, over25kg: 0.29 },
    C: { upTo25kg: 9.0, over25kg: 0.55 },
    D: { upTo25kg: 12.75, over25kg: 0.75 },
  };

  // 2nd and Subsequent Parcels rates
  rates2ndSubsequent = {
    A: { upTo25kg: 4.5, over25kg: 0.29 },
    B: { upTo25kg: 4.5, over25kg: 0.29 },
    C: { upTo25kg: 7.0, over25kg: 0.55 },
    D: { upTo25kg: 10.75, over25kg: 0.75 },
  };

  // Heavy Weight Surcharges (applies when weight > 30kg per item)
  heavyWeightSurcharges: DPDHeavyWeightSurcharge[] = [
    { minKg: 25.01, maxKg: 30, charge: 0 }, // No surcharge
    { minKg: 30.01, maxKg: 34, charge: 15.5 },
    { minKg: 34.01, maxKg: 36, charge: 35.0 },
    { minKg: 36.01, maxKg: Infinity, charge: 50.0 },
  ];

  // Long Length Surcharges (applies when single dimension ≥ 100cm OR length > 119.99cm)
  longLengthSurcharges: DPDLongLengthSurcharge[] = [
    { minCm: 100, maxCm: 119.99, charge: 1.0 },
    { minCm: 120, maxCm: 139.99, charge: 5.0 },
    { minCm: 140, maxCm: 159.99, charge: 6.0 },
    { minCm: 160, maxCm: 179.99, charge: 9.0 },
    { minCm: 180, maxCm: 199.99, charge: 14.0 },
    { minCm: 200, maxCm: 219.99, charge: 21.0 },
    { minCm: 220, maxCm: 239.99, charge: 26.0 },
    { minCm: 240, maxCm: 259.99, charge: 31.0 },
    { minCm: 260, maxCm: 279.99, charge: 36.0 },
    { minCm: 280, maxCm: 299.99, charge: 51.0 },
    { minCm: 300, maxCm: 319.99, charge: 56.0 },
    { minCm: 320, maxCm: 339.99, charge: 66.0 },
    { minCm: 340, maxCm: Infinity, charge: 76.0 },
  ];

  // Out of Gauge Surcharge: applies when two sides ≥ 80cm OR combined length+2×girth > 300cm
  outOfGaugeSurcharge = 0.0; // No surcharge per line, but flag for manual review

  // Other Services
  services: Record<string, DPDService> = {
    isleOfWight: { name: 'Isle of Wight / Scilly Isles', baseCharge: 5.99, applicableZones: ['A', 'B', 'C', 'D'] },
    returnToSender: { name: 'Return to Sender', baseCharge: 4.5, applicableZones: ['A', 'B', 'C', 'D'] },
    compensationCharge: { name: 'Compensation Charge', baseCharge: 0.75, applicableZones: ['A', 'B', 'C', 'D'] },
    carriageCharge: { name: 'Carriage Charge', baseCharge: 0.125, applicableZones: ['A', 'B', 'C', 'D'] },
    bookedInDelivery: { name: 'Booked in Delivery', baseCharge: 15.99, applicableZones: ['A', 'B', 'C', 'D'] },
    fuelSurcharge: { name: 'Fuel Surcharge', baseCharge: 0.0, applicableZones: ['A', 'B', 'C', 'D'] },
    peakSurcharge: { name: 'Peak Surcharge', baseCharge: 0.5, applicableZones: ['A', 'B', 'C', 'D'] },
  };

  // Timed services
  timedServices: DPDTimedService[] = [
    { name: 'Early Morning (by 10:30am)', surcharge: 5.71, applicableZones: ['A', 'B', 'C', 'D'] },
    { name: 'Next Working Day by 10:30am', surcharge: 2.89, applicableZones: ['A', 'B', 'C', 'D'] },
    { name: 'Saturday by 10:30am', surcharge: 12.19, applicableZones: ['A', 'B', 'C', 'D'] },
  ];

  // Bagit Packs (flat rate, no per-kg charge)
  bagitPacks: DPDBagitPack[] = [
    { size: 'S', weightRange: '1-2kg', price: 4.9, applicableZones: ['A', 'B', 'C', 'D'] },
    { size: 'M', weightRange: '2-3kg', price: 4.9, applicableZones: ['A', 'B', 'C', 'D'] },
    { size: 'L', weightRange: '3-5kg', price: 4.9, applicableZones: ['A', 'B', 'C', 'D'] },
  ];

  // Volumetric divisor (4000 cc/kg)
  volumetricDivisor = 4000;

  /**
   * Calculate volumetric weight from dimensions
   * Formula: (length × width × depth) / divisor
   */
  calculateVolumetricWeight(lengthMm: number, widthMm: number, depthMm: number): number {
    const volumeCc = (lengthMm * widthMm * depthMm) / 1000; // Convert mm³ to cm³
    return volumeCc / this.volumetricDivisor;
  }

  /**
   * Get the billable weight (max of actual vs volumetric)
   */
  getBillableWeight(actualWeightKg: number, lengthMm: number, widthMm: number, depthMm: number): number {
    const volumetricWeight = this.calculateVolumetricWeight(lengthMm, widthMm, depthMm);
    return Math.max(actualWeightKg, volumetricWeight);
  }

  /**
   * Check if parcel is out of gauge
   * Out of gauge: two sides ≥ 80cm OR length + 2×girth > 300cm
   */
  isOutOfGauge(lengthMm: number, widthMm: number, depthMm: number): boolean {
    const lengthCm = lengthMm / 10;
    const widthCm = widthMm / 10;
    const depthCm = depthMm / 10;

    const dimensions = [lengthCm, widthCm, depthCm].sort((a, b) => b - a);
    
    // Check if two largest sides are >= 80cm
    if (dimensions[0] >= 80 && dimensions[1] >= 80) {
      return true;
    }

    // Check if length + 2×(width+depth) > 300cm (girth = width + depth)
    const girth = (widthCm + depthCm) * 2;
    if (lengthCm + girth > 300) {
      return true;
    }

    return false;
  }

  /**
   * Get any long length surcharges
   */
  getLongLengthSurcharges(lengthMm: number, widthMm: number, depthMm: number): number {
    const dimensions = [lengthMm / 10, widthMm / 10, depthMm / 10]; // Convert to cm
    const maxDimension = Math.max(...dimensions);

    for (const tier of this.longLengthSurcharges) {
      if (maxDimension >= tier.minCm && maxDimension <= tier.maxCm) {
        return tier.charge;
      }
    }

    return 0;
  }

  /**
   * Get heavy weight surcharge
   */
  getHeavyWeightSurcharge(weightKg: number): number {
    for (const tier of this.heavyWeightSurcharges) {
      if (weightKg >= tier.minKg && weightKg <= tier.maxKg) {
        return tier.charge;
      }
    }
    return 0;
  }

  /**
   * Calculate base parcel cost for first parcel
   */
  calculateBaseParcelCost(
    weightKg: number,
    zone: 'A' | 'B' | 'C' | 'D',
    isFirstParcel: boolean = true
  ): number {
    const rateTable = isFirstParcel ? this.ratesNextWorkingDay : this.rates2ndSubsequent;
    const zoneRates = rateTable[zone];

    if (weightKg <= 25) {
      return zoneRates.upTo25kg;
    } else {
      // Base rate for 25kg + per-kg charge for additional weight
      const baseCost = (zone === 'A' || zone === 'B') ? 5.75 : (zone === 'C' ? 9.0 : 12.75);
      const overageKg = weightKg - 25;
      const overageCharge = overageKg * zoneRates.over25kg;
      return baseCost + overageCharge;
    }
  }

  /**
   * Full shipping cost calculation
   */
  calculateShippingCost(options: {
    weightKg: number;
    lengthMm: number;
    widthMm: number;
    depthMm: number;
    zone: 'A' | 'B' | 'C' | 'D';
    isFirstParcel?: boolean;
    includeHeavyWeightSurcharge?: boolean;
    includeLongLengthSurcharge?: boolean;
  }): {
    baseParcelCost: number;
    billableWeight: number;
    volumetricWeight: number;
    heavyWeightSurcharge: number;
    longLengthSurcharge: number;
    isOutOfGauge: boolean;
    totalCost: number;
    breakdown: Array<{ label: string; amount: number }>;
  } {
    const {
      weightKg,
      lengthMm,
      widthMm,
      depthMm,
      zone,
      isFirstParcel = true,
      includeHeavyWeightSurcharge = true,
      includeLongLengthSurcharge = true,
    } = options;

    const volumetricWeight = this.calculateVolumetricWeight(lengthMm, widthMm, depthMm);
    const billableWeight = Math.max(weightKg, volumetricWeight);
    const baseParcelCost = this.calculateBaseParcelCost(billableWeight, zone, isFirstParcel);
    const heavyWeightSurcharge = includeHeavyWeightSurcharge ? this.getHeavyWeightSurcharge(billableWeight) : 0;
    const longLengthSurcharge = includeLongLengthSurcharge ? this.getLongLengthSurcharges(lengthMm, widthMm, depthMm) : 0;
    const isOutOfGauge = this.isOutOfGauge(lengthMm, widthMm, depthMm);

    const breakdown = [
      { label: 'Base Parcel Cost', amount: baseParcelCost },
    ];

    if (heavyWeightSurcharge > 0) {
      breakdown.push({ label: 'Heavy Weight Surcharge', amount: heavyWeightSurcharge });
    }

    if (longLengthSurcharge > 0) {
      breakdown.push({ label: 'Long Length Surcharge', amount: longLengthSurcharge });
    }

    const totalCost = baseParcelCost + heavyWeightSurcharge + longLengthSurcharge;

    return {
      baseParcelCost,
      billableWeight,
      volumetricWeight,
      heavyWeightSurcharge,
      longLengthSurcharge,
      isOutOfGauge,
      totalCost,
      breakdown,
    };
  }
}

// Singleton instance
export const dpdCalculator = new DPDRateCalculator();
