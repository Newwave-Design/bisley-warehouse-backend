/**
 * WMS Error Log API
 *
 * GET  /api/error-log              — paginated error list with filters
 * GET  /api/error-log/stats        — counts by source + severity
 * PATCH /api/error-log/:id/resolve — mark as resolved
 * POST /api/error-log/resolve-all  — resolve all matching a filter
 * DELETE /api/error-log/old        — purge INFO logs older than 7 days
 * POST /api/error-log/check-discrepancies — run WMS-vs-Medusa qty check now
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { runDiscrepancyCheck } from '../../lib/discrepancy-check.js';

const router = express.Router();

router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const {
      source = '',
      severity = '',
      resolved = '',
      limit = '100',
      offset = '0',
      search = '',
    } = req.query;

    let sql = `
      SELECT id, source, severity, message, context, resolved, resolved_at, resolved_by, created_at,
             COUNT(*) OVER() AS total_count
      FROM wms_error_log WHERE 1=1
    `;
    const params: any[] = [];
    let pi = 1;

    if (source) {
      const sources = (source as string).split(',').map(s => s.trim());
      sql += ` AND source = ANY($${pi}::text[])`; params.push(sources); pi++;
    }
    if (severity) {
      const severities = (severity as string).split(',').map(s => s.trim());
      sql += ` AND severity = ANY($${pi}::text[])`; params.push(severities); pi++;
    }
    if (resolved === 'true') { sql += ` AND resolved = true`; }
    else if (resolved === 'false') { sql += ` AND resolved = false`; }
    if (search) {
      sql += ` AND (message ILIKE $${pi} OR context::text ILIKE $${pi})`;
      params.push(`%${search}%`); pi++;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${pi} OFFSET $${pi + 1}`;
    params.push(parseInt(limit as string), parseInt(offset as string));

    const result = await query(sql, params);
    const total = result.rows[0]?.total_count ?? 0;

    res.json({
      errors: result.rows.map(r => ({ ...r, total_count: undefined })),
      total: parseInt(total),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch error log' });
  }
});

router.get('/stats', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const [bySrc, bySev, recent] = await Promise.all([
      query(`SELECT source, severity, COUNT(*)::int AS count
             FROM wms_error_log WHERE resolved = false
             GROUP BY source, severity ORDER BY count DESC`),
      query(`SELECT severity, COUNT(*)::int AS count
             FROM wms_error_log WHERE resolved = false GROUP BY severity`),
      query(`SELECT COUNT(*)::int AS unresolved_errors
             FROM wms_error_log WHERE resolved = false AND severity = 'ERROR'`),
    ]);
    res.json({
      by_source: bySrc.rows,
      by_severity: bySev.rows,
      unresolved_errors: recent.rows[0]?.unresolved_errors ?? 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

router.patch('/:id/resolve', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { note } = req.body;
    await query(`
      UPDATE wms_error_log SET resolved=true, resolved_at=NOW(), resolved_by=$1 WHERE id=$2
    `, [(req as any).user?.email ?? 'system', req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Resolve failed' });
  }
});

router.post('/resolve-all', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { source, severity } = req.body;
    let sql = `UPDATE wms_error_log SET resolved=true, resolved_at=NOW(), resolved_by=$1 WHERE resolved=false`;
    const params: any[] = [(req as any).user?.email ?? 'system'];
    let pi = 2;
    if (source) { sql += ` AND source=$${pi}`; params.push(source); pi++; }
    if (severity) { sql += ` AND severity=$${pi}`; params.push(severity); pi++; }
    const r = await query(sql + ' RETURNING id', params);
    res.json({ resolved: r.rowCount ?? 0 });
  } catch (err) {
    res.status(500).json({ error: 'Resolve-all failed' });
  }
});

router.delete('/old', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const r = await query(`
      DELETE FROM wms_error_log
      WHERE created_at < NOW() - INTERVAL '7 days' AND severity = 'INFO'
      RETURNING id
    `);
    res.json({ deleted: r.rowCount ?? 0 });
  } catch (err) {
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

router.post('/check-discrepancies', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await runDiscrepancyCheck();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Discrepancy check failed' });
  }
});

export default router;
