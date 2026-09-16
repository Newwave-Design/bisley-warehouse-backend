/**
 * Settings API Routes
 * CRUD for field_mappings table (Medusa → WMS and WMS → Genero field configuration).
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, requirePermission, AuthRequest } from '../../middleware/auth.js';
import { DEFAULT_PACKAGING_PROFILES, DEFAULT_SHIPPING_SERVICES, isMissingRelationError } from '../../lib/fulfillment-defaults.js';
import { estimateShippingForServices, resolveKitDimensions, type PackagingProfile, type ShippingService } from '../../lib/shipping-estimator.js';
import { getCachedUpsRates, upsReferenceDestinationConfigured } from '../../lib/ups.js';
import { decideShippingForPackedItem, parseAitWeightTiers, parseDhlTiers, type DhlTier } from '../../lib/shipping-decision.js';
import { logError, logWarning } from '../../lib/logger.js';

const router = express.Router();

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}


/** GET /api/settings/field-mappings — returns all mappings grouped by direction */
router.get('/field-mappings', authMiddleware, requirePermission('manage_settings'), async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT * FROM field_mappings ORDER BY mapping_direction, created_at ASC`
    );
    const MEDUSA_TO_WMS = result.rows.filter(r => r.mapping_direction === 'MEDUSA_TO_WMS');
    const WMS_TO_GENERO = result.rows.filter(r => r.mapping_direction === 'WMS_TO_GENERO');
    res.json({ MEDUSA_TO_WMS, WMS_TO_GENERO });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load field mappings' });
  }
});

/** POST /api/settings/field-mappings — create a new mapping row */
router.post('/field-mappings', authMiddleware, requirePermission('manage_settings'), async (req: AuthRequest, res: Response) => {
  try {
    const { mapping_direction, source_field, source_label, target_field, target_label, transform, notes } = req.body;
    if (!mapping_direction || !source_field || !source_label) {
      return res.status(400).json({ error: 'mapping_direction, source_field, and source_label are required' });
    }
    const result = await query(
      `INSERT INTO field_mappings
         (mapping_direction, source_field, source_label, target_field, target_label, transform, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [mapping_direction, source_field, source_label, target_field ?? null, target_label ?? null, transform ?? null, notes ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A mapping for this direction + source field already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to create mapping' });
  }
});

/** PUT /api/settings/field-mappings/:id — update an existing mapping row */
router.put('/field-mappings/:id', authMiddleware, requirePermission('manage_settings'), async (req: AuthRequest, res: Response) => {
  try {
    const { source_field, source_label, target_field, target_label, transform, notes, is_active } = req.body;
    const result = await query(
      `UPDATE field_mappings
       SET source_field  = COALESCE($1, source_field),
           source_label  = COALESCE($2, source_label),
           target_field  = $3,
           target_label  = $4,
           transform     = $5,
           notes         = $6,
           is_active     = COALESCE($7, is_active),
           updated_at    = NOW()
       WHERE id = $8
       RETURNING *`,
      [source_field, source_label, target_field ?? null, target_label ?? null,
       transform ?? null, notes ?? null, is_active, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Mapping not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update mapping' });
  }
});

/** DELETE /api/settings/field-mappings/:id */
router.delete('/field-mappings/:id', authMiddleware, requirePermission('manage_settings'), async (req: AuthRequest, res: Response) => {
  try {
    await query('DELETE FROM field_mappings WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete mapping' });
  }
});

router.get('/shipping-services', authMiddleware, requirePermission('manage_settings'), async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT id, courier_code, courier_name, service_code, service_name, service_level,
              shipment_mode, integration_type, constraints, metadata, is_active, sort_order,
              created_at, updated_at
       FROM shipping_services
       WHERE courier_code IN ('ups', 'ait', 'dhl')
       ORDER BY sort_order ASC, courier_name ASC, service_name ASC`
    );
    res.json({ shipping_services: result.rows });
  } catch (err) {
    if (isMissingRelationError(err)) {
      return res.json({
        shipping_services: DEFAULT_SHIPPING_SERVICES.map((s, idx) => ({
          ...s,
          id: `fallback-${s.service_code}`,
          is_active: true,
          sort_order: (idx + 1) * 10,
        })),
        source: 'fallback',
      });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to load shipping services' });
  }
});

router.post('/shipping-services', authMiddleware, requirePermission('manage_settings'), async (req: AuthRequest, res: Response) => {
  try {
    const {
      courier_code,
      courier_name,
      service_code,
      service_name,
      service_level,
      shipment_mode,
      integration_type,
      constraints,
      metadata,
      is_active,
      sort_order,
    } = req.body;

    if (!courier_code || !courier_name || !service_code || !service_name) {
      return res.status(400).json({ error: 'courier_code, courier_name, service_code and service_name are required' });
    }

    const result = await query(
      `INSERT INTO shipping_services (
         courier_code, courier_name, service_code, service_name, service_level,
         shipment_mode, integration_type, constraints, metadata, is_active, sort_order
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::jsonb, '{}'::jsonb), COALESCE($9::jsonb, '{}'::jsonb), COALESCE($10, true), COALESCE($11, 100))
       RETURNING *`,
      [
        courier_code,
        courier_name,
        service_code,
        service_name,
        service_level ?? 'standard',
        shipment_mode ?? 'parcel',
        integration_type ?? 'manual',
        constraints ? JSON.stringify(constraints) : null,
        metadata ? JSON.stringify(metadata) : null,
        is_active,
        sort_order,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'Service code already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create shipping service' });
  }
});

router.put('/shipping-services/:serviceCode', authMiddleware, requirePermission('manage_settings'), async (req: AuthRequest, res: Response) => {
  try {
    const {
      courier_code,
      courier_name,
      service_name,
      service_level,
      shipment_mode,
      integration_type,
      constraints,
      metadata,
      is_active,
      sort_order,
    } = req.body;

    const result = await query(
      `UPDATE shipping_services
       SET courier_code = COALESCE($1, courier_code),
           courier_name = COALESCE($2, courier_name),
           service_name = COALESCE($3, service_name),
           service_level = COALESCE($4, service_level),
           shipment_mode = COALESCE($5, shipment_mode),
           integration_type = COALESCE($6, integration_type),
           constraints = CASE WHEN $7::jsonb IS NULL THEN constraints ELSE $7::jsonb END,
           metadata = CASE WHEN $8::jsonb IS NULL THEN metadata ELSE $8::jsonb END,
           is_active = COALESCE($9, is_active),
           sort_order = COALESCE($10, sort_order),
           updated_at = NOW()
       WHERE service_code = $11
       RETURNING *`,
      [
        courier_code ?? null,
        courier_name ?? null,
        service_name ?? null,
        service_level ?? null,
        shipment_mode ?? null,
        integration_type ?? null,
        constraints ? JSON.stringify(constraints) : null,
        metadata ? JSON.stringify(metadata) : null,
        is_active,
        sort_order,
        req.params.serviceCode,
      ]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Shipping service not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update shipping service' });
  }
});

router.get('/packaging-profiles', authMiddleware, requirePermission('manage_settings'), async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT code, name, package_type, inner_length_mm, inner_width_mm, inner_height_mm,
              max_weight_grams, tare_weight_grams, default_cost_gbp, is_active, notes
       FROM packaging_profiles
      WHERE package_type IN ('parcel', 'freight')
       ORDER BY name ASC`
    );
    res.json({ packaging_profiles: result.rows });
  } catch (err) {
    if (isMissingRelationError(err)) {
      return res.json({
        packaging_profiles: DEFAULT_PACKAGING_PROFILES.map((p) => ({
          ...p,
          is_active: true,
          notes: null,
        })),
        source: 'fallback',
      });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to load packaging profiles' });
  }
});

/** GET /api/settings/product-fulfillment-map — per-SKU real assigned service (or none), for grouping the product catalogue by actual courier option. */
router.get('/product-fulfillment-map', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT DISTINCT wp.variant_sku AS sku,
              pfp.preferred_service_code,
              pfp.requires_manual_review,
              pfp.packaging_profile_code,
              pfp.estimated_shipping_cost_gbp,
              pfp.estimated_shipping_currency,
              pfp.pack_instructions
       FROM wms_products wp
       LEFT JOIN product_fulfillment_profiles pfp ON pfp.product_sku = wp.variant_sku
       WHERE wp.variant_sku IS NOT NULL AND wp.variant_sku <> ''`
    );
    res.json({ items: result.rows });
  } catch (err) {
    if (isMissingRelationError(err)) return res.json({ items: [] });
    console.error(err);
    res.status(500).json({ error: 'Failed to load product fulfilment map' });
  }
});

/** PUT /api/settings/product-fulfillment-map/:productSku — update estimated shipping cost for a product */
router.put('/product-fulfillment-map/:productSku', authMiddleware, requirePermission('manage_settings'), async (req: AuthRequest, res: Response) => {
  try {
    const { estimated_shipping_cost_gbp, estimated_shipping_currency } = req.body;
    
    if (estimated_shipping_cost_gbp === undefined || estimated_shipping_cost_gbp === null) {
      return res.status(400).json({ error: 'estimated_shipping_cost_gbp is required' });
    }
    
    const result = await query(
      `UPDATE product_fulfillment_profiles
       SET estimated_shipping_cost_gbp = $1,
           estimated_shipping_currency = $2,
           updated_at = NOW()
       WHERE product_sku = $3
       RETURNING *`,
      [Number(estimated_shipping_cost_gbp), estimated_shipping_currency ?? 'GBP', req.params.productSku]
    );
    
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Product not found in fulfillment profiles' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update product fulfillment cost' });
  }
});

/** GET /api/settings/dhl-zones — DHL zone info with postcodes and region summary */
router.get('/dhl-zones', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT service_code, service_name, metadata
       FROM shipping_services
       WHERE courier_code = 'dhl' AND is_active = true
       ORDER BY metadata->>'zone' ASC`
    );
    
    const zones = result.rows.map((row: any) => {
      const metadata = row.metadata || {};
      const zone = metadata.zone || '';
      let region_summary = '';
      
      if (zone === 'A') region_summary = 'England & Wales (excluding Isle of Wight and Isles of Scilly)';
      else if (zone === 'B') region_summary = 'Scotland Central (Lowlands & Central Belt)';
      else if (zone === 'C') region_summary = 'Northern Ireland';
      else if (zone === 'D') region_summary = 'Remote & Islands (Scotland Highlands, Islands, Crown Dependencies)';
      
      return {
        zone,
        service_code: row.service_code,
        service_name: row.service_name,
        region_summary,
        postcode_ranges: metadata.postcode_ranges || [],
        surcharge_areas: metadata.surcharge_areas || [],
        base_rates: metadata.tiers ? metadata.tiers.slice(0, 2) : [], // NWD and Standard
      };
    });
    
    res.json({ zones });
  } catch (err) {
    if (isMissingRelationError(err)) return res.json({ zones: [] });
    console.error(err);
    res.status(500).json({ error: 'Failed to load DHL zones' });
  }
});

router.post('/shipping-services/ups-sync', authMiddleware, requirePermission('system_admin'), async (_req: AuthRequest, res: Response) => {
  try {
    let upserted = 0;

    for (const [idx, service] of DEFAULT_SHIPPING_SERVICES.entries()) {
      await query(
        `INSERT INTO shipping_services (
           courier_code, courier_name, service_code, service_name, service_level,
           shipment_mode, integration_type, constraints, metadata, is_active, sort_order
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7::jsonb, $8::jsonb, true, $9)
         ON CONFLICT (service_code) DO UPDATE SET
           courier_code = EXCLUDED.courier_code,
           courier_name = EXCLUDED.courier_name,
           service_name = EXCLUDED.service_name,
           service_level = EXCLUDED.service_level,
           shipment_mode = EXCLUDED.shipment_mode,
           constraints = EXCLUDED.constraints,
           metadata = EXCLUDED.metadata,
           is_active = true,
           sort_order = EXCLUDED.sort_order,
           updated_at = NOW()`,
        [
          service.courier_code,
          service.courier_name,
          service.service_code,
          service.service_name,
          service.service_level,
          service.shipment_mode,
          JSON.stringify(service.constraints ?? {}),
          JSON.stringify(service.metadata ?? {}),
          (idx + 1) * 5,
        ]
      );
      upserted++;
    }

    await query(
      `UPDATE shipping_services
       SET is_active = false,
           updated_at = NOW()
       WHERE courier_code NOT IN ('ups', 'ait', 'dhl')`
    );

    for (const profile of DEFAULT_PACKAGING_PROFILES) {
      await query(
        `INSERT INTO packaging_profiles (
           code, name, package_type, inner_length_mm, inner_width_mm, inner_height_mm,
           max_weight_grams, tare_weight_grams, default_cost_gbp, is_active, notes
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10)
         ON CONFLICT (code) DO UPDATE SET
           name = EXCLUDED.name,
           package_type = EXCLUDED.package_type,
           inner_length_mm = EXCLUDED.inner_length_mm,
           inner_width_mm = EXCLUDED.inner_width_mm,
           inner_height_mm = EXCLUDED.inner_height_mm,
           max_weight_grams = EXCLUDED.max_weight_grams,
           tare_weight_grams = EXCLUDED.tare_weight_grams,
           default_cost_gbp = EXCLUDED.default_cost_gbp,
           notes = EXCLUDED.notes,
           is_active = true,
           updated_at = NOW()`,
        [
          profile.code,
          profile.name,
          profile.package_type,
          profile.inner_length_mm,
          profile.inner_width_mm,
          profile.inner_height_mm,
          profile.max_weight_grams,
          profile.tare_weight_grams,
          profile.default_cost_gbp,
          profile.code === 'UPS-FREIGHT-CUSTOM-PALLET'
            ? "Doesn't fit a standard carton. Real courier (UPS parcel or AIT) is decided per item from a live quote, not from this profile."
            : null,
        ]
      );
    }

    await query(
      `UPDATE packaging_profiles
       SET is_active = false,
           updated_at = NOW()
       WHERE package_type NOT IN ('parcel', 'freight')`
    );

    const servicesAfter = await query(
      `SELECT service_code, is_active
       FROM shipping_services
       WHERE courier_code IN ('ups', 'ait')
       ORDER BY sort_order ASC, service_code ASC`
    );

    res.json({
      success: true,
      upserted_services: upserted,
      active_ups_services: servicesAfter.rows,
    });
  } catch (err: any) {
    console.error(err);
    await logError('SHIPPING_SYNC', `Shipping services sync failed: ${err.message}`, undefined, 'ERROR', err.stack);
    res.status(500).json({ error: 'Failed to sync UPS services' });
  }
});

// Helper: Calculate DHL cost with surcharge breakdown
interface DhlCostBreakdown {
  base_cost_gbp: number;
  weight_surcharge_gbp: number;
  weight_bracket?: string; // e.g., "5.01-10kg"
  length_surcharge_gbp: number;
  length_bracket?: string; // e.g., "1000-1500cm"
  total_cost_gbp: number;
  calculation_summary: string;
}

function calculateDhlCostBreakdown(
  weightGrams: number,
  lengthMm: number,
  widthMm: number,
  heightMm: number,
  dhlTiers: any[],
  dhlSurcharges: any
): DhlCostBreakdown {
  const weightKg = weightGrams / 1000;
  let weightSurcharge = 0;
  let weightBracket: string | undefined;
  let lengthSurcharge = 0;
  let lengthBracket: string | undefined;
  
  // 1. Find base rate tier (weight-only matching for DHL Parcel UK)
  // Weight tiers only cover up to 25kg — anything heavier still uses the highest
  // tier as its base cost, with the excess weight covered by the surcharge bands below.
  const baseTier = dhlTiers.find(t => weightKg <= t.max_weight_kg)
    ?? dhlTiers.reduce((max, t) => (!max || t.max_weight_kg > max.max_weight_kg ? t : max), null as any);
  if (!baseTier) {
    return {
      base_cost_gbp: 0,
      weight_surcharge_gbp: 0,
      length_surcharge_gbp: 0,
      total_cost_gbp: 0,
      calculation_summary: `ERROR: No DHL weight tiers configured`,
    };
  }
  
  const baseCost = baseTier.cost_gbp;
  
  // 2. Heavy weight surcharge (weight > 5kg)
  if (weightKg > 5 && dhlSurcharges?.heavy_weight_kg && Array.isArray(dhlSurcharges.heavy_weight_kg)) {
    const heavyBand = (dhlSurcharges.heavy_weight_kg as any[]).find(
      b => weightKg >= b.min_kg && weightKg <= b.max_kg
    );
    if (heavyBand) {
      weightSurcharge = heavyBand.surcharge_gbp;
      weightBracket = `${heavyBand.min_kg.toFixed(2)}-${heavyBand.max_kg.toFixed(2)}kg`;
    }
  }
  
  // 3. Long length surcharge (max dimension > 100cm)
  const maxDim = Math.max(lengthMm, widthMm, heightMm) / 10;
  if (maxDim > 100 && dhlSurcharges?.long_length_cm && Array.isArray(dhlSurcharges.long_length_cm)) {
    const lengthBand = (dhlSurcharges.long_length_cm as any[]).find(
      b => maxDim >= b.min_cm && maxDim <= b.max_cm
    );
    if (lengthBand) {
      lengthSurcharge = lengthBand.surcharge_gbp;
      lengthBracket = `${lengthBand.min_cm.toFixed(0)}-${lengthBand.max_cm.toFixed(0)}cm`;
    }
  }
  
  const totalCost = baseCost + weightSurcharge + lengthSurcharge;
  
  // Format as: "Base £X.XX + Weight £Y.YY (5.01-10kg) + Length £Z.ZZ (1000-1500cm) = £Total"
  const parts = [`Base £${baseCost.toFixed(2)}`];
  if (weightSurcharge > 0) {
    parts.push(`Weight £${weightSurcharge.toFixed(2)}${weightBracket ? ` (${weightBracket})` : ''}`);
  }
  if (lengthSurcharge > 0) {
    parts.push(`Length £${lengthSurcharge.toFixed(2)}${lengthBracket ? ` (${lengthBracket})` : ''}`);
  }
  
  return {
    base_cost_gbp: baseCost,
    weight_surcharge_gbp: weightSurcharge,
    weight_bracket: weightBracket,
    length_surcharge_gbp: lengthSurcharge,
    length_bracket: lengthBracket,
    total_cost_gbp: totalCost,
    calculation_summary: `${parts.join(' + ')} = £${totalCost.toFixed(2)}`,
  };
}

interface AutoTagState {
  running: boolean;
  started_at: Date | null;
  finished_at: Date | null;
  progress: string;
  result: Record<string, any> | null;
  error: string | null;
}
const autoTagState: AutoTagState = {
  running: false, started_at: null, finished_at: null,
  progress: 'idle', result: null, error: null,
};

// Runs as a background job (not awaited by the route) — thousands of sequential per-SKU
// upserts exceed Railway's proxy timeout if run inline within a single HTTP request.
async function runUpsAutoTagJob() {
  try {
    autoTagState.progress = 'Loading services, packaging profiles and products…';
    const [servicesResult, profilesResult, productsResult, aitServiceResult, dhlServiceResult] = await Promise.all([
      query(
        `SELECT service_code, service_name, courier_code, courier_name, service_level, shipment_mode, constraints, metadata
         FROM shipping_services
         WHERE courier_code = 'ups' AND is_active = true
         ORDER BY sort_order ASC, service_name ASC`
      ),
      query(
        `SELECT code, name, package_type, inner_length_mm, inner_width_mm, inner_height_mm,
                max_weight_grams, tare_weight_grams, default_cost_gbp
         FROM packaging_profiles
         WHERE package_type IN ('parcel', 'freight') AND is_active = true
         ORDER BY inner_length_mm ASC, inner_width_mm ASC, inner_height_mm ASC`
      ),
      query(
        `SELECT medusa_product_id, variant_sku, variant_title, colour_name, is_kit, COALESCE(kit_components::text, '[]') AS kit_components,
                COALESCE(variant_weight_grams, weight_grams) AS weight_grams,
                COALESCE(variant_depth_mm, depth_mm) AS depth_mm,
                COALESCE(variant_width_mm, width_mm) AS width_mm,
                COALESCE(variant_height_mm, height_mm) AS height_mm,
                price_gbp
         FROM wms_products
         WHERE variant_sku IS NOT NULL AND variant_sku <> ''`
      ),
      query(
        `SELECT service_code, service_name, metadata FROM shipping_services WHERE service_code = 'ait_freight' AND is_active = true LIMIT 1`
      ),
      query(
        `SELECT service_code, service_name, metadata FROM shipping_services 
         WHERE service_code IN ('dhl_parcel_zone_a', 'dhl_parcel_zone_b', 'dhl_parcel_zone_c', 'dhl_parcel_zone_d') 
         AND is_active = true 
         ORDER BY metadata->>'zone' ASC`
      ),
    ]);

    // AIT is Bisley's real current shipping operation for anything that doesn't fit a standard
    // carton — a flat cost per weight band (see weight_tiers), falling back to a percentage-of-
    // price estimate only if no rate card has been configured yet.
    const aitServiceCode = aitServiceResult.rows[0]?.service_code ?? 'ait_freight';
    const aitServiceName = aitServiceResult.rows[0]?.service_name ?? 'AIT Freight (Oversized / Non-Parcel)';
    const aitPercentageOfPrice = asNumber(aitServiceResult.rows[0]?.metadata?.percentage_of_price) ?? 10;
    const aitWeightTiers = parseAitWeightTiers(aitServiceResult.rows[0]?.metadata);

    // DHL zones: query returns all 4 zone services (A, B, C, D). Default to Zone A for all products.
    // Can be overridden per-product via manual edit in the dashboard.
    const dhlZoneServices = (dhlServiceResult.rows as any[]).map(row => ({
      service_code: row.service_code,
      service_name: row.service_name,
      zone: row.metadata?.zone || 'A',
      metadata: row.metadata || {},
    }));
    const dhlZoneA = dhlZoneServices.find(s => s.zone === 'A') ?? dhlZoneServices[0];
    const dhlServiceCode = dhlZoneA?.service_code ?? null;
    const dhlServiceName = dhlZoneA?.service_name ?? null;
    const dhlTiers = parseDhlTiers(dhlZoneA?.metadata);
    const dhlSurcharges = dhlZoneA?.metadata?.surcharges ?? {};

    // Kit variants (e.g. MultiDesk) have no dims of their own — batch-load every component
    // SKU's dims once so kit dimensions can be computed as stacked-in-a-box totals.
    const kitComponentSkus = Array.from(new Set(
      (productsResult.rows as any[]).flatMap(row => row.is_kit ? (JSON.parse(row.kit_components) as { sku: string }[]).map(c => c.sku) : [])
    ));
    const componentDimsBySku = new Map<string, { weight_grams: number | null; length_mm: number | null; width_mm: number | null; height_mm: number | null }>();
    if (kitComponentSkus.length) {
      const componentResult = await query(
        `SELECT variant_sku,
                COALESCE(variant_weight_grams, weight_grams) AS weight_grams,
                COALESCE(variant_depth_mm, depth_mm) AS depth_mm,
                COALESCE(variant_width_mm, width_mm) AS width_mm,
                COALESCE(variant_height_mm, height_mm) AS height_mm
         FROM wms_products
         WHERE variant_sku = ANY($1::text[])`,
        [kitComponentSkus]
      );
      for (const row of componentResult.rows as any[]) {
        componentDimsBySku.set(row.variant_sku, {
          weight_grams: asNumber(row.weight_grams),
          length_mm: asNumber(row.depth_mm),
          width_mm: asNumber(row.width_mm),
          height_mm: asNumber(row.height_mm),
        });
      }
    }

    const services: ShippingService[] = servicesResult.rows.map((row: any) => ({
      service_code: row.service_code,
      service_name: row.service_name,
      courier_code: row.courier_code,
      courier_name: row.courier_name,
      service_level: row.service_level,
      shipment_mode: row.shipment_mode,
      constraints: row.constraints ?? {},
      metadata: row.metadata ?? {},
    }));

    const profiles: PackagingProfile[] = profilesResult.rows.map((row: any) => ({
      code: row.code,
      name: row.name,
      package_type: row.package_type,
      inner_length_mm: row.inner_length_mm,
      inner_width_mm: row.inner_width_mm,
      inner_height_mm: row.inner_height_mm,
      max_weight_grams: row.max_weight_grams,
      tare_weight_grams: row.tare_weight_grams,
      default_cost_gbp: row.default_cost_gbp,
    }));

    if (!services.length) throw new Error('No active UPS shipping services found');
    if (!profiles.length) throw new Error('No active UPS packaging profiles found');
    if (!upsReferenceDestinationConfigured()) throw new Error('Live UPS rates are not configured. Set UPS_REFERENCE_DESTINATION_* env vars on the backend.');

    let tagged = 0;
    let manualReview = 0;
    let noEligible = 0;
    let missingDims = 0;
    const total = productsResult.rows.length;

    // Colour variants of the same physical product share identical dims — cache the computed
    // decision per (product, dims) so they inherit one parent result instead of re-running the
    // packaging/UPS/AIT logic (and issuing redundant live UPS calls) for every colour.
    interface AutoTagDecision {
      estimate: ReturnType<typeof estimateShippingForServices> | null;
      preferredServiceCode: string | null;
      preferredCostAmount: number | null;
      preferredCostCurrency: string | null;
      manualReviewReason: string | null;
    }
    const groupDecisionCache = new Map<string, AutoTagDecision>();

    for (const [idx, row] of (productsResult.rows as any[]).entries()) {
      if (idx % 200 === 0) autoTagState.progress = `Tagging ${idx}/${total} SKUs…`;

      const dims = {
        weight_grams: asNumber(row.weight_grams),
        length_mm: asNumber(row.depth_mm),
        width_mm: asNumber(row.width_mm),
        height_mm: asNumber(row.height_mm),
      };

      let hasCompleteDimensions = Boolean(
        dims.length_mm && dims.width_mm && dims.height_mm && dims.weight_grams
      );
      let effectiveDims = dims;
      if (!hasCompleteDimensions && row.is_kit) {
        const kitComponents = JSON.parse(row.kit_components) as { sku: string; required_quantity: number }[];
        const kitDims = resolveKitDimensions(kitComponents, componentDimsBySku);
        if (kitDims.complete) {
          effectiveDims = kitDims;
          hasCompleteDimensions = true;
        }
      }
      if (!hasCompleteDimensions) missingDims++;

      // Width/height variants have different dims and therefore a different group key — they always
      // get their own computation (and, for AIT, their own price). Colour-only variants (identical
      // dims within the same product) share a group key and reuse the first-computed decision.
      const groupKey = hasCompleteDimensions
        ? `${row.medusa_product_id}|${effectiveDims.weight_grams}|${effectiveDims.length_mm}|${effectiveDims.width_mm}|${effectiveDims.height_mm}`
        : null;

      let decision = groupKey ? groupDecisionCache.get(groupKey) : undefined;

      if (!decision) {
        // Packaging profile pick is a real physical-packing decision (which Bisley carton/pallet
        // fits) — kept from the padded-dimension geometry check, independent of courier eligibility.
        const estimate = hasCompleteDimensions
          ? estimateShippingForServices({
              dims: effectiveDims,
              services,
              packagingProfiles: profiles,
              packagingPaddingMinMm: 140,
              packagingPaddingMaxMm: 140,
            })
          : null;

        let preferredServiceCode: string | null = null;
        let preferredCostAmount: number | null = null;
        let preferredCostCurrency: string | null = null;
        let manualReviewReason: string | null = null;

        if (!hasCompleteDimensions) {
          manualReviewReason = 'Manual review required - product weight and all dimensions must be recorded before a shipping service can be assigned.';
        } else if (!estimate || !estimate.packaged_dimensions) {
          manualReviewReason = 'Manual review required - no packaging profile could be resolved for this item\'s dimensions.';
        } else {
          // FORCE DHL assignment for all standard parcels (no UPS/AIT fallback in auto-tag).
          // Weight tiers only cover the base rate up to 25kg — anything heavier still gets DHL,
          // with the excess covered by the heavy-weight/long-length surcharge bands (up to 500kg/deep lengths).
          const packageWeightGrams = estimate?.package_weight_grams ?? 0;
          const weightKg = packageWeightGrams / 1000;
          const dhlTierForWeight = dhlTiers && dhlTiers.length
            ? (dhlTiers.find(t => weightKg <= t.max_weight_kg)
                ?? dhlTiers.reduce((max, t) => (!max || t.max_weight_kg > max.max_weight_kg ? t : max), null as any))
            : null;

          if (dhlTierForWeight && dhlServiceCode) {
            preferredServiceCode = dhlServiceCode;
            preferredCostAmount = dhlTierForWeight.cost_gbp;
            preferredCostCurrency = 'GBP';
            // Will be updated with surcharge breakdown below when building pack_instructions
          } else {
            // No DHL weight tiers configured at all — genuinely needs manual review
            manualReviewReason = 'Manual review required - no DHL weight tiers are configured for this service.';
          }
        }

        decision = { estimate, preferredServiceCode, preferredCostAmount, preferredCostCurrency, manualReviewReason };
        if (groupKey) groupDecisionCache.set(groupKey, decision);
      }

      const { estimate, preferredServiceCode, preferredCostAmount, preferredCostCurrency, manualReviewReason } = decision;

      // Extract packed dimensions for cost calculation
      const packed = estimate?.packaged_dimensions;
      const lengthMm = packed?.used_length_mm ?? 0;
      const widthMm = packed?.used_width_mm ?? 0;
      const heightMm = packed?.used_height_mm ?? 0;
      const packageWeightGrams = estimate?.package_weight_grams ?? 0;

      if (!preferredServiceCode) noEligible++;
      const needsManual = Boolean(manualReviewReason);
      if (needsManual) manualReview++;
      const checklistTemplateCode = 'STD-PARCEL';

      // Build pack instructions with DHL cost breakdown (including surcharges with brackets)
      let packInstructions = manualReviewReason ?? '';
      let finalCostGbp: number = preferredCostAmount ? Number(preferredCostAmount) : 0;
      
      if (preferredServiceCode === dhlServiceCode && estimate?.packaged_dimensions && !manualReviewReason && dhlTiers) {
        try {
          const breakdown = calculateDhlCostBreakdown(
            packageWeightGrams,
            lengthMm,
            widthMm,
            heightMm,
            dhlTiers,
            dhlSurcharges
          );
          // Format: "DHL Zone A: Base £5.75 + Weight £0.45 (5.01-10kg) + Length £0.00 = £6.20"
          packInstructions = `DHL Zone ${dhlZoneA?.zone || 'A'}: ${breakdown.calculation_summary}`;
          finalCostGbp = breakdown.total_cost_gbp;
        } catch (e) {
          // Fallback to base cost if breakdown fails
          packInstructions = `DHL Zone ${dhlZoneA?.zone || 'A'}: Base £${Number(preferredCostAmount).toFixed(2)}`;
        }
      }

      await query(
        `INSERT INTO product_fulfillment_profiles (
           product_sku,
           packaging_profile_code,
           checklist_template_code,
           preferred_service_code,
           requires_manual_review,
           is_fragile,
           is_multi_box,
           fulfilment_tags,
           pack_instructions,
           estimated_shipping_cost_gbp,
           estimated_shipping_currency,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, false, false, $6::jsonb, $7, $8, $9, NOW())
         ON CONFLICT (product_sku) DO UPDATE SET
           packaging_profile_code = EXCLUDED.packaging_profile_code,
           checklist_template_code = EXCLUDED.checklist_template_code,
           preferred_service_code = EXCLUDED.preferred_service_code,
           requires_manual_review = EXCLUDED.requires_manual_review,
           fulfilment_tags = EXCLUDED.fulfilment_tags,
           pack_instructions = EXCLUDED.pack_instructions,
           estimated_shipping_cost_gbp = EXCLUDED.estimated_shipping_cost_gbp,
           estimated_shipping_currency = EXCLUDED.estimated_shipping_currency,
           updated_at = NOW()`,
        [
          row.variant_sku,
          estimate?.picked_packaging_profile?.code ?? null,
          checklistTemplateCode,
          preferredServiceCode,
          needsManual,
          JSON.stringify(preferredServiceCode === dhlServiceCode ? ['dhl-zone-a'] : needsManual ? ['manual-review'] : ['auto-tagged']),
          packInstructions,
          finalCostGbp,
          'GBP',
        ]
      );

      tagged++;
    }

    const sample = await query(
      `SELECT product_sku, packaging_profile_code, preferred_service_code, requires_manual_review
       FROM product_fulfillment_profiles
       WHERE preferred_service_code IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT 10`
    );

    autoTagState.result = {
      success: true,
      tagged,
      manual_review_count: manualReview,
      no_eligible_count: noEligible,
      missing_dimension_count: missingDims,
      sample: sample.rows,
    };
    autoTagState.error = null;
    if (manualReview > 0 || noEligible > 0) {
      await logWarning('AUTO_TAG', `DHL auto-tag completed with ${manualReview} manual-review and ${noEligible} no-eligible-service SKU(s)`, {
        tagged, manual_review_count: manualReview, no_eligible_count: noEligible, missing_dimension_count: missingDims,
      });
    }
  } catch (err: any) {
    console.error('UPS auto-tag job error:', err);
    autoTagState.error = err.message || 'Failed to auto-tag products with UPS options';
    await logError('AUTO_TAG', `DHL auto-tag job failed: ${autoTagState.error}`, undefined, 'ERROR', err.stack);
  } finally {
    autoTagState.running = false;
    autoTagState.finished_at = new Date();
    autoTagState.progress = autoTagState.error ? 'failed' : 'complete';
  }
}

/** POST /api/settings/shipping-services/ups-auto-tag-products — starts the auto-tag job in the background; poll ups-auto-tag-status. */
router.post('/shipping-services/ups-auto-tag-products', authMiddleware, requirePermission('system_admin'), (_req: AuthRequest, res: Response) => {
  if (autoTagState.running) {
    return res.status(409).json({
      error: 'Auto-tag job already in progress',
      progress: autoTagState.progress,
      started_at: autoTagState.started_at,
    });
  }
  autoTagState.running = true;
  autoTagState.started_at = new Date();
  autoTagState.finished_at = null;
  autoTagState.result = null;
  autoTagState.error = null;
  autoTagState.progress = 'Starting…';

  res.json({ status: 'started', message: 'Auto-tag running in background. Poll GET /api/settings/shipping-services/ups-auto-tag-status' });

  runUpsAutoTagJob();
});

/** GET /api/settings/shipping-services/ups-auto-tag-status — poll this after triggering the auto-tag job. */
router.get('/shipping-services/ups-auto-tag-status', authMiddleware, requirePermission('system_admin'), (_req: AuthRequest, res: Response) => {
  res.json({
    running: autoTagState.running,
    progress: autoTagState.progress,
    started_at: autoTagState.started_at,
    finished_at: autoTagState.finished_at,
    result: autoTagState.result,
    error: autoTagState.error,
  });
});

/**
 * Bisley/Ovara stock liability (Phase 6: Financials)
 * GET   /api/settings/liability-default   — current default owner applied to newly received stock
 * PATCH /api/settings/liability-default   — manually flip the default (Bisley -> Ovara)
 */
router.get('/liability-default', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(`SELECT key, value, updated_at FROM wms_settings WHERE key IN ('default_liability_status', 'liability_review_date')`);
    const byKey = Object.fromEntries(result.rows.map(r => [r.key, r]));
    res.json({
      default_liability_status: byKey.default_liability_status?.value ?? 'Bisley',
      updated_at: byKey.default_liability_status?.updated_at ?? null,
      liability_review_date: byKey.liability_review_date?.value ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch liability default' });
  }
});

router.patch('/liability-default', authMiddleware, requirePermission('manage_settings'), async (req: AuthRequest, res: Response) => {
  try {
    const { default_liability_status } = req.body;
    if (!['Bisley', 'Ovara'].includes(default_liability_status)) {
      return res.status(400).json({ error: "default_liability_status must be 'Bisley' or 'Ovara'" });
    }
    const result = await query(
      `INSERT INTO wms_settings (key, value, updated_at) VALUES ('default_liability_status', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
       RETURNING value, updated_at`,
      [default_liability_status]
    );
    res.json({ default_liability_status: result.rows[0].value, updated_at: result.rows[0].updated_at });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update liability default' });
  }
});

export default router;
