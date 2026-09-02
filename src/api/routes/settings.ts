/**
 * Settings API Routes
 * CRUD for field_mappings table (Medusa → WMS and WMS → Genero field configuration).
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { DEFAULT_PACKAGING_PROFILES, DEFAULT_SHIPPING_SERVICES, isMissingRelationError } from '../../lib/fulfillment-defaults.js';
import { estimateShippingForServices, type PackagingProfile, type ShippingService } from '../../lib/shipping-estimator.js';

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
router.get('/field-mappings', authMiddleware, async (_req: AuthRequest, res: Response) => {
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
router.post('/field-mappings', authMiddleware, async (req: AuthRequest, res: Response) => {
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
router.put('/field-mappings/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
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
router.delete('/field-mappings/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    await query('DELETE FROM field_mappings WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete mapping' });
  }
});

router.get('/shipping-services', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT id, courier_code, courier_name, service_code, service_name, service_level,
              shipment_mode, integration_type, constraints, metadata, is_active, sort_order,
              created_at, updated_at
       FROM shipping_services
       WHERE courier_code = 'ups'
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

router.post('/shipping-services', authMiddleware, async (req: AuthRequest, res: Response) => {
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

router.put('/shipping-services/:serviceCode', authMiddleware, async (req: AuthRequest, res: Response) => {
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

router.get('/packaging-profiles', authMiddleware, async (_req: AuthRequest, res: Response) => {
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

router.post('/shipping-services/ups-sync', authMiddleware, async (_req: AuthRequest, res: Response) => {
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
       WHERE courier_code <> 'ups'`
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
            ? 'Oversize or heavy items. Freight and packaging pricing require a quote.'
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
       WHERE courier_code = 'ups'
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

router.post('/shipping-services/ups-auto-tag-products', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const [servicesResult, profilesResult, productsResult] = await Promise.all([
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
        `SELECT variant_sku, variant_title, colour_name,
                COALESCE(variant_weight_grams, weight_grams) AS weight_grams,
                COALESCE(variant_depth_mm, depth_mm) AS depth_mm,
                COALESCE(variant_width_mm, width_mm) AS width_mm,
                COALESCE(variant_height_mm, height_mm) AS height_mm
         FROM wms_products
         WHERE variant_sku IS NOT NULL AND variant_sku <> ''`
      ),
    ]);

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

    if (!services.length) {
      return res.status(400).json({ error: 'No active UPS shipping services found' });
    }

    if (!profiles.length) {
      return res.status(400).json({ error: 'No active UPS packaging profiles found' });
    }

    let tagged = 0;
    let manualReview = 0;
    let noEligible = 0;
    let missingDims = 0;

    for (const row of productsResult.rows as any[]) {
      const dims = {
        weight_grams: asNumber(row.weight_grams),
        length_mm: asNumber(row.depth_mm),
        width_mm: asNumber(row.width_mm),
        height_mm: asNumber(row.height_mm),
      };

      const hasCompleteDimensions = Boolean(
        dims.length_mm && dims.width_mm && dims.height_mm && dims.weight_grams
      );
      if (!hasCompleteDimensions) {
        missingDims++;
      }

      const estimate = hasCompleteDimensions
        ? estimateShippingForServices({
            dims,
            services,
            packagingProfiles: profiles,
            packagingPaddingMinMm: 15,
            packagingPaddingMaxMm: 20,
          })
        : null;

      const preferred = estimate?.estimates.find(s => s.eligible) ?? null;
      const isFreight = preferred?.shipment_mode === 'freight';
      const needsManual = !preferred || isFreight || !estimate?.picked_packaging_profile;

      if (!preferred) noEligible++;
      if (needsManual) manualReview++;

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
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, false, false, $6::jsonb, $7, NOW())
         ON CONFLICT (product_sku) DO UPDATE SET
           packaging_profile_code = EXCLUDED.packaging_profile_code,
           checklist_template_code = EXCLUDED.checklist_template_code,
           preferred_service_code = EXCLUDED.preferred_service_code,
           requires_manual_review = EXCLUDED.requires_manual_review,
           fulfilment_tags = EXCLUDED.fulfilment_tags,
           pack_instructions = EXCLUDED.pack_instructions,
           updated_at = NOW()
         WHERE product_fulfillment_profiles.fulfilment_tags @> '["ups-auto-tagged"]'::jsonb`,
        [
          row.variant_sku,
          estimate?.picked_packaging_profile?.code ?? null,
          isFreight ? 'PALLET-FREIGHT' : 'STD-PARCEL',
          preferred?.service_code ?? null,
          needsManual,
          JSON.stringify(needsManual ? ['ups-manual-review'] : ['ups-auto-tagged']),
          !hasCompleteDimensions
            ? 'Manual review required - product weight and all dimensions must be recorded before UPS service assignment.'
            : isFreight
              ? 'Manual review required - UPS freight handling and pricing must be confirmed before dispatch.'
              : needsManual
                ? 'Manual review required - no eligible UPS service or packaging profile found.'
            : 'Auto-tagged by UPS estimator using packed dimensions (+15 to +20 mm).',
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

    res.json({
      success: true,
      tagged,
      manual_review_count: manualReview,
      no_eligible_count: noEligible,
      missing_dimension_count: missingDims,
      sample: sample.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to auto-tag products with UPS options' });
  }
});

export default router;
