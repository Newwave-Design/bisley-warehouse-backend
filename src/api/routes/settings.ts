/**
 * Settings API Routes
 * CRUD for field_mappings table (Medusa → WMS and WMS → Genero field configuration).
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, requireRole, AuthRequest } from '../../middleware/auth.js';
import { DEFAULT_PACKAGING_PROFILES, DEFAULT_SHIPPING_SERVICES, isMissingRelationError } from '../../lib/fulfillment-defaults.js';
import { estimateShippingForServices, resolveKitDimensions, type PackagingProfile, type ShippingService } from '../../lib/shipping-estimator.js';
import { getCachedUpsRates, upsReferenceDestinationConfigured } from '../../lib/ups.js';
import { decideShippingForPackedItem } from '../../lib/shipping-decision.js';

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
router.get('/field-mappings', authMiddleware, requireRole(['MANAGER','ADMIN']), async (_req: AuthRequest, res: Response) => {
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
router.post('/field-mappings', authMiddleware, requireRole(['MANAGER','ADMIN']), async (req: AuthRequest, res: Response) => {
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
router.put('/field-mappings/:id', authMiddleware, requireRole(['MANAGER','ADMIN']), async (req: AuthRequest, res: Response) => {
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
router.delete('/field-mappings/:id', authMiddleware, requireRole(['MANAGER','ADMIN']), async (req: AuthRequest, res: Response) => {
  try {
    await query('DELETE FROM field_mappings WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete mapping' });
  }
});

router.get('/shipping-services', authMiddleware, requireRole(['MANAGER','ADMIN']), async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT id, courier_code, courier_name, service_code, service_name, service_level,
              shipment_mode, integration_type, constraints, metadata, is_active, sort_order,
              created_at, updated_at
       FROM shipping_services
       WHERE courier_code IN ('ups', 'ait')
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

router.post('/shipping-services', authMiddleware, requireRole(['MANAGER','ADMIN']), async (req: AuthRequest, res: Response) => {
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

router.put('/shipping-services/:serviceCode', authMiddleware, requireRole(['MANAGER','ADMIN']), async (req: AuthRequest, res: Response) => {
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

router.get('/packaging-profiles', authMiddleware, requireRole(['MANAGER','ADMIN']), async (_req: AuthRequest, res: Response) => {
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
              pfp.estimated_shipping_currency
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


router.post('/shipping-services/ups-sync', authMiddleware, requireRole(['MANAGER','ADMIN']), async (_req: AuthRequest, res: Response) => {
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
       WHERE courier_code NOT IN ('ups', 'ait')`
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to sync UPS services' });
  }
});

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
    const [servicesResult, profilesResult, productsResult, aitServiceResult] = await Promise.all([
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
    ]);

    // AIT is Bisley's real current shipping operation for anything that doesn't fit a standard
    // carton — a flat percentage-of-price cost estimate, not a live-quoted courier. Percentage is
    // configurable via the shipping-services settings UI (falls back to 10% if not set up yet).
    const aitServiceCode = aitServiceResult.rows[0]?.service_code ?? 'ait_freight';
    const aitServiceName = aitServiceResult.rows[0]?.service_name ?? 'AIT Freight (Oversized / Non-Parcel)';
    const aitPercentageOfPrice = asNumber(aitServiceResult.rows[0]?.metadata?.percentage_of_price) ?? 10;

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

        const packed = estimate?.packaged_dimensions;
        const lengthMm = packed?.used_length_mm ?? 0;
        const widthMm = packed?.used_width_mm ?? 0;
        const heightMm = packed?.used_height_mm ?? 0;
        const packageWeightGrams = estimate?.package_weight_grams ?? 0;
        const hasCompletePackedDims = lengthMm > 0 && widthMm > 0 && heightMm > 0 && packageWeightGrams > 0;

        // Courier eligibility and service choice come from a REAL live UPS Rating API quote for
        // this exact packed size/weight — not a static constraint table. Whatever UPS actually
        // accepts (or rejects) is the final word.
        let preferredServiceCode: string | null = null;
        let preferredCostAmount: number | null = null;
        let preferredCostCurrency: string | null = null;
        let manualReviewReason: string | null = null;

        if (!hasCompleteDimensions) {
          manualReviewReason = 'Manual review required - product weight and all dimensions must be recorded before a shipping service can be assigned.';
        } else if (!hasCompletePackedDims) {
          manualReviewReason = 'Manual review required - no packaging profile could be resolved for this item\'s dimensions.';
        } else {
          const decisionResult = await decideShippingForPackedItem({
            lengthMm, widthMm, heightMm, weightGrams: packageWeightGrams,
            priceGbp: asNumber(row.price_gbp),
            isMultidesk: Boolean(row.is_kit),
            upsServices: services,
            aitServiceCode, aitServiceName, aitPercentageOfPrice,
            upsConfigured: true,
            getUpsQuotes: getCachedUpsRates,
          });
          preferredServiceCode = decisionResult.preferredServiceCode;
          preferredCostAmount = decisionResult.preferredCostAmount;
          preferredCostCurrency = decisionResult.preferredCostCurrency;
          manualReviewReason = decisionResult.manualReviewReason;
        }

        decision = { estimate, preferredServiceCode, preferredCostAmount, preferredCostCurrency, manualReviewReason };
        if (groupKey) groupDecisionCache.set(groupKey, decision);
      }

      const { estimate, preferredServiceCode, preferredCostAmount, preferredCostCurrency, manualReviewReason } = decision;

      if (!preferredServiceCode) noEligible++;
      const needsManual = Boolean(manualReviewReason);
      if (needsManual) manualReview++;
      // Checklist template follows the REAL assigned courier, not the packaging-profile-fit
      // heuristic (which is just a physical box-size check and can flag a small item as "doesn't
      // fit a standard carton" without it actually shipping via freight).
      const checklistTemplateCode = preferredServiceCode === aitServiceCode ? 'PALLET-FREIGHT' : 'STD-PARCEL';

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
           updated_at = NOW()
         WHERE product_fulfillment_profiles.fulfilment_tags @> '["ups-auto-tagged"]'::jsonb`,
        [
          row.variant_sku,
          estimate?.picked_packaging_profile?.code ?? null,
          checklistTemplateCode,
          preferredServiceCode,
          needsManual,
          JSON.stringify(needsManual ? ['ups-manual-review'] : ['ups-auto-tagged']),
          manualReviewReason ?? (preferredServiceCode === aitServiceCode
            ? `Auto-tagged for AIT freight shipping - flat ${aitPercentageOfPrice}% of item price.`
            : 'Auto-tagged using a live UPS Rating API quote for packed dimensions (+140 mm).'),
          preferredCostAmount,
          preferredCostCurrency,
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
  } catch (err: any) {
    console.error('UPS auto-tag job error:', err);
    autoTagState.error = err.message || 'Failed to auto-tag products with UPS options';
  } finally {
    autoTagState.running = false;
    autoTagState.finished_at = new Date();
    autoTagState.progress = autoTagState.error ? 'failed' : 'complete';
  }
}

/** POST /api/settings/shipping-services/ups-auto-tag-products — starts the auto-tag job in the background; poll ups-auto-tag-status. */
router.post('/shipping-services/ups-auto-tag-products', authMiddleware, requireRole(['MANAGER','ADMIN']), (_req: AuthRequest, res: Response) => {
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
router.get('/shipping-services/ups-auto-tag-status', authMiddleware, requireRole(['MANAGER','ADMIN']), (_req: AuthRequest, res: Response) => {
  res.json({
    running: autoTagState.running,
    progress: autoTagState.progress,
    started_at: autoTagState.started_at,
    finished_at: autoTagState.finished_at,
    result: autoTagState.result,
    error: autoTagState.error,
  });
});

export default router;
