/**
 * Settings API Routes
 * CRUD for field_mappings table (Medusa → WMS and WMS → Genero field configuration).
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';

const router = express.Router();

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
       ORDER BY sort_order ASC, courier_name ASC, service_name ASC`
    );
    res.json({ shipping_services: result.rows });
  } catch (err) {
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
       ORDER BY name ASC`
    );
    res.json({ packaging_profiles: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load packaging profiles' });
  }
});

export default router;
