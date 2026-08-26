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

export default router;
