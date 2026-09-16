/**
 * Shipping Options API Endpoint
 * 
 * GET /shipping-options/:sku
 * 
 * Returns available shipping options for a product SKU including:
 * - All zones (A, B, C, D)
 * - Service types (NWD, 2nd+)
 * - Costs and timeframes from database
 */

import { Router } from 'express';
import { getPool } from '../db/index.js';

const router = Router();

interface ShippingServiceRow {
  service_code: string;
  service_name: string;
  courier_name: string;
  metadata: {
    timeframe?: string;
    zone_label?: string;
    zone?: string;
    zone_number?: number;
    [key: string]: any;
  };
}

interface ShippingCalculationBreakdown {
  actualWeightKg: number;
  volumetricWeightKg: number;
  billableWeightKg: number;
  baseParcelCost: number;
  heavyWeightSurcharge: number;
  longLengthSurcharge: number;
  totalSurcharges: number;
  totalCost: number;
  isOutOfGauge: boolean;
  calculation: string; // Human-readable breakdown
}

interface ShippingOption {
  serviceCode: string;
  serviceName: string;
  timeframe: string;
  zone: string;
  zoneLabel: string;
  cost: number;
  isFirstParcel: boolean;
  breakdown: ShippingCalculationBreakdown;
}

/**
 * GET /shipping-options/:sku
 * Fetch shipping options for a product with detailed calculation breakdowns
 */
router.get('/shipping-options/:sku', async (req, res) => {
  try {
    const { sku } = req.params;

    if (!sku) {
      return res.status(400).json({ error: 'Product SKU is required' });
    }

    const pool = getPool();

    // Get product details (weight and dimensions)
    const productResult = await pool.query(
      `SELECT 
         variant_sku,
         weight_grams,
         height_mm,
         width_mm,
         depth_mm
       FROM wms_products
       WHERE variant_sku = $1`,
      [sku]
    );

    if (productResult.rows.length === 0) {
      return res.status(200).json({
        productSku: sku,
        options: [],
        error: 'Product not found'
      });
    }

    const product = productResult.rows[0];
    const weightKg = product.weight_grams / 1000;
    const length = product.height_mm;
    const width = product.width_mm;
    const depth = product.depth_mm;

    // Get all active DPD shipping services with metadata
    const servicesResult = await pool.query(
      `SELECT 
         service_code,
         service_name,
         courier_name,
         metadata,
         constraints
       FROM shipping_services
       WHERE courier_code = 'DPD' AND is_active = true
       ORDER BY metadata->>'zone_number', service_name`
    );

    if (servicesResult.rows.length === 0) {
      return res.status(200).json({
        productSku: sku,
        options: [],
        error: 'No shipping services available'
      });
    }

    // Import calculator (must be available in the build)
    const { dpdCalculator } = await import('../lib/dpd-rates.js');

    // Transform services to options format with calculation breakdowns
    const options: ShippingOption[] = servicesResult.rows.map(
      (row: ShippingServiceRow) => {
        const metadata = row.metadata || {};
        const zoneNumber = metadata.zone_number || 1;
        const zone = String.fromCharCode(64 + zoneNumber); // A, B, C, D
        const isFirstParcel = row.service_code.includes('_NWD_');

        // Calculate actual shipping cost with breakdown
        const estimate = dpdCalculator.calculateShippingCost({
          weightKg,
          lengthMm: length,
          widthMm: width,
          depthMm: depth,
          zone: zone as 'A' | 'B' | 'C' | 'D',
          isFirstParcel
        });

        const breakdown: ShippingCalculationBreakdown = {
          actualWeightKg: weightKg,
          volumetricWeightKg: estimate.volumetricWeight,
          billableWeightKg: estimate.billableWeight,
          baseParcelCost: estimate.baseParcelCost,
          heavyWeightSurcharge: estimate.heavyWeightSurcharge,
          longLengthSurcharge: estimate.longLengthSurcharge,
          totalSurcharges: estimate.heavyWeightSurcharge + estimate.longLengthSurcharge,
          totalCost: estimate.totalCost,
          isOutOfGauge: estimate.isOutOfGauge,
          calculation: formatCalculation(estimate)
        };

        return {
          serviceCode: row.service_code,
          serviceName: row.service_name,
          timeframe: metadata.timeframe || 'Standard',
          zone: zone,
          zoneLabel: metadata.zone_label || `Zone ${zoneNumber}`,
          cost: estimate.totalCost,
          isFirstParcel,
          breakdown
        };
      }
    );

    res.status(200).json({
      productSku: sku,
      productDetails: {
        weight: weightKg,
        dimensions: `${width}×${depth}×${length}mm`
      },
      options: options.sort((a, b) => {
        // Sort by zone, then by service type (NWD first)
        if (a.zone !== b.zone) return a.zone.localeCompare(b.zone);
        return b.isFirstParcel ? -1 : 1; // NWD (true) before 2nd (false)
      })
    });
  } catch (error) {
    console.error('Error fetching shipping options:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Format calculation breakdown as human-readable string
 */
function formatCalculation(estimate: any): string {
  const lines = [
    `Actual weight: ${estimate.billableWeight <= estimate.volumetricWeight ? estimate.actualWeightKg.toFixed(2) : '(lighter than volumetric)'}kg`,
    `Volumetric weight: ${estimate.volumetricWeight.toFixed(2)}kg (divisor 4000)`,
    `Billable weight: ${estimate.billableWeight.toFixed(2)}kg (max of actual vs volumetric)`,
    `Base parcel cost: £${estimate.baseParcelCost.toFixed(2)}`,
    estimate.heavyWeightSurcharge > 0 ? `Heavy weight surcharge (+${estimate.billableWeight.toFixed(0)}kg): £${estimate.heavyWeightSurcharge.toFixed(2)}` : null,
    estimate.longLengthSurcharge > 0 ? `Long length surcharge: £${estimate.longLengthSurcharge.toFixed(2)}` : null,
    estimate.isOutOfGauge ? `⚠️ Out of gauge` : null,
    `TOTAL: £${estimate.totalCost.toFixed(2)}`
  ];
  return lines.filter(Boolean).join(' | ');
}

export default router;
