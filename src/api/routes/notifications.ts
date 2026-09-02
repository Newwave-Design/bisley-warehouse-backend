/**
 * Notifications API
 * GET  /api/notifications         — list (newest first, filterable)
 * GET  /api/notifications/count   — unread count for badge
 * PATCH /api/notifications/:id/read   — mark one read
 * POST  /api/notifications/read-all  — mark all read
 * DELETE /api/notifications/old      — purge dismissed >30 days
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, requireRole, AuthRequest } from '../../middleware/auth.js';

const router = express.Router();

router.get('/count', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const r = await query(`SELECT COUNT(*)::int AS count FROM wms_notifications WHERE is_read=false AND is_dismissed=false`);
    res.json({ count: r.rows[0].count });
  } catch { res.json({ count: 0 }); }
});

router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { type, unread_only = 'false', limit = '50', offset = '0' } = req.query;
    const params: any[] = [];
    const clauses: string[] = ['is_dismissed=false'];
    if (unread_only === 'true') { clauses.push(`is_read=false`); }
    if (type) { params.push(type); clauses.push(`type=$${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(parseInt(limit as string), parseInt(offset as string));
    const r = await query(
      `SELECT * FROM wms_notifications ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const total = await query(`SELECT COUNT(*)::int AS c FROM wms_notifications WHERE is_dismissed=false`);
    const unread = await query(`SELECT COUNT(*)::int AS c FROM wms_notifications WHERE is_read=false AND is_dismissed=false`);
    res.json({ notifications: r.rows, total: total.rows[0].c, unread: unread.rows[0].c });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

router.patch('/:id/read', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    await query(`UPDATE wms_notifications SET is_read=true WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed to mark as read' }); }
});

router.patch('/:id/dismiss', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    await query(`UPDATE wms_notifications SET is_read=true, is_dismissed=true WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed to dismiss' }); }
});

router.post('/read-all', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const r = await query(`UPDATE wms_notifications SET is_read=true WHERE is_read=false`);
    res.json({ updated: r.rowCount ?? 0 });
  } catch { res.status(500).json({ error: 'Failed to mark all read' }); }
});

router.delete('/old', authMiddleware, requireRole(['ADMIN']), async (_req: AuthRequest, res: Response) => {
  try {
    const r = await query(`DELETE FROM wms_notifications WHERE is_dismissed=true AND created_at < NOW() - INTERVAL '30 days'`);
    res.json({ deleted: r.rowCount ?? 0 });
  } catch { res.status(500).json({ error: 'Failed to purge' }); }
});

export default router;
