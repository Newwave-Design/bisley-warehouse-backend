/**
 * SKU Mapping API Routes
 * Phase 1: Inventory Intake & SKU Mapping
 * 
 * Endpoints:
 * - GET /api/sku-mappings - List all mappings with filters
 * - GET /api/sku-mappings/unmapped - Show only unmapped items
 * - GET /api/sku-mappings/conflicts - Show mapping conflicts
 * - GET /api/sku-mappings/:id - Get single mapping detail
 * - PATCH /api/sku-mappings/:id - Update mapping
 * - POST /api/sku-mappings/:id/validate - Mark as validated
 * - POST /api/sku-mappings/:id/reject - Mark as rejected
 * - POST /api/sku-mappings/auto-match - Run fuzzy matching
 */

import express, { Request, Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';

const router = express.Router();

/**
 * GET /api/sku-mappings
 * List all mappings with filters, search, and pagination
 * 
 * Query params:
 * - status: comma-separated (UNMAPPED,ASSUMED,VALIDATED,REJECTED)
 * - family: comma-separated (Home Filer, MultiDrawer, etc)
 * - colour: comma-separated (Black, Blue, etc)
 * - search: search by nw_code or product_name
 * - limit: items per page (default 50)
 * - offset: pagination offset (default 0)
 */
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const {
      status = '',
      family = '',
      colour = '',
      search = '',
      limit = '50',
      offset = '0',
    } = req.query;

    let sql = `
      SELECT 
        s.id, s.nw_code, s.product_name, s.family, s.colour,
        s.medusa_sku, s.genero_code, s.status, s.confidence,
        s.mapped_by, s.mapped_at, s.notes,
        COUNT(*) OVER() as total_count,
        COALESCE(SUM(n.quantity_ordered), 0) as total_quantity
      FROM sku_mappings s
      LEFT JOIN nw_stocking_items n ON s.id = n.mapping_id
      WHERE 1=1
    `;

    const params: any[] = [];
    let paramIndex = 1;

    // Status filter
    if (status) {
      const statuses = (status as string).split(',').map((s) => s.trim());
      sql += ` AND s.status = ANY($${paramIndex}::text[])`;
      params.push(statuses);
      paramIndex++;
    }

    // Family filter
    if (family) {
      const families = (family as string).split(',').map((f) => f.trim());
      sql += ` AND s.family = ANY($${paramIndex}::text[])`;
      params.push(families);
      paramIndex++;
    }

    // Colour filter
    if (colour) {
      const colours = (colour as string).split(',').map((c) => c.trim());
      sql += ` AND s.colour = ANY($${paramIndex}::text[])`;
      params.push(colours);
      paramIndex++;
    }

    // Search filter (nw_code or product_name)
    if (search) {
      sql += ` AND (s.nw_code ILIKE $${paramIndex} OR s.product_name ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    sql += ` GROUP BY s.id, s.nw_code, s.product_name, s.family, s.colour,
             s.medusa_sku, s.genero_code, s.status, s.confidence,
             s.mapped_by, s.mapped_at, s.notes`;

    sql += ` ORDER BY s.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit as string, 10));
    params.push(parseInt(offset as string, 10));

    const result = await query(sql, params);

    const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0;

    res.json({
      mappings: result.rows.map((row) => ({
        id: row.id,
        nw_code: row.nw_code,
        product_name: row.product_name,
        family: row.family,
        colour: row.colour,
        quantity_ordered: row.total_quantity,
        medusa_sku: row.medusa_sku,
        genero_code: row.genero_code,
        status: row.status,
        confidence: row.confidence,
        mapped_by: row.mapped_by,
        mapped_at: row.mapped_at,
        notes: row.notes,
      })),
      total,
      limit: parseInt(limit as string, 10),
      offset: parseInt(offset as string, 10),
    });
  } catch (error) {
    console.error('List mappings error:', error);
    res.status(500).json({ error: 'Failed to list mappings' });
  }
});

/**
 * GET /api/sku-mappings/unmapped
 * Show only unmapped items
 */
router.get('/unmapped', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { limit = '50', offset = '0', family = '', colour = '' } = req.query;

    let sql = `
      SELECT 
        s.id, s.nw_code, s.product_name, s.family, s.colour,
        s.medusa_sku, s.genero_code, s.status, s.confidence,
        COALESCE(SUM(n.quantity_ordered), 0) as quantity_ordered,
        COUNT(*) OVER() as total_count
      FROM sku_mappings s
      LEFT JOIN nw_stocking_items n ON s.id = n.mapping_id
      WHERE s.status = 'UNMAPPED'
    `;

    const params: any[] = [];
    let paramIndex = 1;

    if (family) {
      const families = (family as string).split(',').map((f) => f.trim());
      sql += ` AND s.family = ANY($${paramIndex}::text[])`;
      params.push(families);
      paramIndex++;
    }

    if (colour) {
      const colours = (colour as string).split(',').map((c) => c.trim());
      sql += ` AND s.colour = ANY($${paramIndex}::text[])`;
      params.push(colours);
      paramIndex++;
    }

    sql += ` GROUP BY s.id, s.nw_code, s.product_name, s.family, s.colour,
             s.medusa_sku, s.genero_code, s.status, s.confidence`;
    sql += ` ORDER BY s.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit as string, 10));
    params.push(parseInt(offset as string, 10));

    const result = await query(sql, params);
    const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0;

    res.json({
      mappings: result.rows.map((row) => ({
        id: row.id,
        nw_code: row.nw_code,
        product_name: row.product_name,
        family: row.family,
        colour: row.colour,
        quantity_ordered: row.quantity_ordered,
        medusa_sku: row.medusa_sku,
        genero_code: row.genero_code,
        status: row.status,
        confidence: row.confidence,
      })),
      total,
      limit: parseInt(limit as string, 10),
      offset: parseInt(offset as string, 10),
    });
  } catch (error) {
    console.error('List unmapped error:', error);
    res.status(500).json({ error: 'Failed to list unmapped items' });
  }
});

/**
 * GET /api/sku-mappings/conflicts
 * Show items with mapping conflicts
 */
router.get('/conflicts', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    // One NW code -> multiple Medusa SKUs
    const multiMedusaResult = await query(`
      SELECT nw_code, COUNT(DISTINCT medusa_sku) as sku_count, array_agg(DISTINCT medusa_sku) as skus
      FROM sku_mappings
      WHERE medusa_sku IS NOT NULL
      GROUP BY nw_code
      HAVING COUNT(DISTINCT medusa_sku) > 1
    `);

    // One Medusa SKU -> multiple NW codes
    const multiNwResult = await query(`
      SELECT medusa_sku, COUNT(DISTINCT nw_code) as code_count, array_agg(DISTINCT nw_code) as codes
      FROM sku_mappings
      WHERE medusa_sku IS NOT NULL
      GROUP BY medusa_sku
      HAVING COUNT(DISTINCT nw_code) > 1
    `);

    res.json({
      conflicts: {
        one_nw_multiple_medusa: multiMedusaResult.rows,
        one_medusa_multiple_nw: multiNwResult.rows,
      },
      total: multiMedusaResult.rows.length + multiNwResult.rows.length,
    });
  } catch (error) {
    console.error('List conflicts error:', error);
    res.status(500).json({ error: 'Failed to list conflicts' });
  }
});

/**
 * GET /api/sku-mappings/:id
 * Get single mapping detail with linked items
 */
router.get('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const mappingResult = await query(
      `SELECT * FROM sku_mappings WHERE id = $1`,
      [id]
    );

    if (mappingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Mapping not found' });
    }

    const mapping = mappingResult.rows[0];

    // Get linked inventory items
    const itemsResult = await query(
      `SELECT * FROM nw_stocking_items WHERE mapping_id = $1 ORDER BY created_at DESC`,
      [id]
    );

    res.json({
      ...mapping,
      items: itemsResult.rows,
    });
  } catch (error) {
    console.error('Get mapping error:', error);
    res.status(500).json({ error: 'Failed to get mapping' });
  }
});

/**
 * PATCH /api/sku-mappings/:id
 * Update mapping (medusa_sku, genero_code, status, notes, confidence)
 */
router.patch('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { medusa_sku, genero_code, status, notes, confidence } = req.body;

    const updates: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (medusa_sku !== undefined) {
      updates.push(`medusa_sku = $${paramIndex}`);
      params.push(medusa_sku);
      paramIndex++;
    }

    if (genero_code !== undefined) {
      updates.push(`genero_code = $${paramIndex}`);
      params.push(genero_code);
      paramIndex++;
    }

    if (status !== undefined) {
      updates.push(`status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    if (notes !== undefined) {
      updates.push(`notes = $${paramIndex}`);
      params.push(notes);
      paramIndex++;
    }

    if (confidence !== undefined) {
      updates.push(`confidence = $${paramIndex}`);
      params.push(confidence);
      paramIndex++;
    }

    updates.push('updated_at = NOW()');

    if (updates.length === 1) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(id);
    const sql = `UPDATE sku_mappings SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;

    const result = await query(sql, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Mapping not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update mapping error:', error);
    res.status(500).json({ error: 'Failed to update mapping' });
  }
});

/**
 * POST /api/sku-mappings/:id/validate
 * Mark mapping as validated
 */
router.post('/:id/validate', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as any).user?.email || 'unknown';

    const result = await query(
      `UPDATE sku_mappings 
       SET status = $1, mapped_by = $2, mapped_at = NOW(), updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      ['VALIDATED', userId, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Mapping not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Validate mapping error:', error);
    res.status(500).json({ error: 'Failed to validate mapping' });
  }
});

/**
 * POST /api/sku-mappings/:id/reject
 * Mark mapping as rejected
 */
router.post('/:id/reject', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    const userId = (req as any).user?.email || 'unknown';

    if (!notes) {
      return res.status(400).json({ error: 'Rejection notes required' });
    }

    const result = await query(
      `UPDATE sku_mappings 
       SET status = $1, mapped_by = $2, mapped_at = NOW(), notes = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      ['REJECTED', userId, notes, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Mapping not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Reject mapping error:', error);
    res.status(500).json({ error: 'Failed to reject mapping' });
  }
});

/**
 * POST /api/sku-mappings/auto-match
 * Run fuzzy matching to auto-assign Medusa SKUs
 * 
 * Algorithm: Match NW code prefix with Medusa SKU prefix
 */
router.post('/auto-match', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { min_confidence = 0.7 } = req.body;

    // Get all Medusa products from the products module
    // For now, we'll use a placeholder - in Phase 2 this will query Medusa API
    const medusaProducts = await query(
      `SELECT DISTINCT medusa_sku FROM sku_mappings WHERE medusa_sku IS NOT NULL`
    );

    if (medusaProducts.rows.length === 0) {
      return res.json({ matched: 0, updated: false, message: 'No Medusa SKUs to match against' });
    }

    let matchedCount = 0;

    // For each unmapped item, try to find a Medusa match
    const unmapped = await query(
      `SELECT * FROM sku_mappings WHERE status = 'UNMAPPED' AND medusa_sku IS NULL`
    );

    for (const item of unmapped.rows) {
      const nwPrefix = item.nw_code.split('-')[0]; // Get prefix (e.g., "PFA2" from "PFA2-BK")

      // Find Medusa SKU with matching prefix
      const match = medusaProducts.rows.find(
        (p: any) => p.medusa_sku && p.medusa_sku.startsWith(nwPrefix)
      );

      if (match) {
        const confidence = 0.8; // Heuristic confidence for prefix match

        if (confidence >= min_confidence) {
          await query(
            `UPDATE sku_mappings SET medusa_sku = $1, confidence = $2, status = 'ASSUMED', updated_at = NOW()
             WHERE id = $3`,
            [match.medusa_sku, confidence, item.id]
          );
          matchedCount++;
        }
      }
    }

    res.json({
      matched: matchedCount,
      updated: matchedCount > 0,
      message: `Auto-matched ${matchedCount} items`,
    });
  } catch (error) {
    console.error('Auto-match error:', error);
    res.status(500).json({ error: 'Failed to run auto-match' });
  }
});

/**
 * POST /api/sku-mappings/import
 * Bulk import NW stocking items from parsed spreadsheet data
 * Body: { items: [{ nw_code, description, family, colour, quantity_ordered, unit_cost? }] }
 */
router.post('/import', async (req: Request, res: Response) => {
  try {
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array required' });
    }

    let mappingsCreated = 0;
    let stockingItemsCreated = 0;
    let skipped = 0;

    // Group by nw_code to upsert unique mappings first
    const uniqueCodes = new Map<string, any>();
    for (const item of items) {
      if (!uniqueCodes.has(item.nw_code)) {
        uniqueCodes.set(item.nw_code, item);
      }
    }

    for (const [nwCode, item] of uniqueCodes) {
      const result = await query(
        `INSERT INTO sku_mappings (nw_code, product_name, family, colour, status, confidence, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'UNMAPPED', 0, NOW(), NOW())
         ON CONFLICT (nw_code) DO NOTHING`,
        [nwCode, item.description, item.family, item.colour]
      );
      if (result.rowCount && result.rowCount > 0) mappingsCreated++;
    }

    for (const item of items) {
      const mappingResult = await query(
        `SELECT id FROM sku_mappings WHERE nw_code = $1`,
        [item.nw_code]
      );
      const mappingId = mappingResult.rows[0]?.id ?? null;

      const result = await query(
        `INSERT INTO nw_stocking_items (nw_code, description, family, colour, quantity_ordered, unit_cost, mapping_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        [item.nw_code, item.description, item.family, item.colour, item.quantity_ordered, item.unit_cost ?? 0, mappingId]
      );
      if (result.rowCount && result.rowCount > 0) stockingItemsCreated++;
      else skipped++;
    }

    res.json({
      success: true,
      mappingsCreated,
      stockingItemsCreated,
      skipped,
      total: items.length,
    });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: 'Failed to import items' });
  }
});

export default router;
