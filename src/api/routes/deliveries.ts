/**
 * Deliveries API — incoming dispatch batches detected from Genero polling.
 * Deliveries are distinct from our order requests: they represent what Genero
 * is actually sending us, grouped by bisley_order ref.
 *
 * GET  /api/deliveries              — list upcoming/recent deliveries
 * GET  /api/deliveries/:id          — detail with all SKU lines
 * PATCH /api/deliveries/:id/status  — mark as ARRIVED / CHECKED_IN
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';

const router = express.Router();

router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.query;
    const params: any[] = [];
    let where = '';
    if (status) { params.push(status); where = `WHERE d.status = $1`; }
    else { where = `WHERE d.status NOT IN ('CHECKED_IN','CANCELLED')`; }

    const r = await query(`
      SELECT d.*,
        cs.id AS checkin_session_id_ref
      FROM genero_deliveries d
      LEFT JOIN checkin_sessions cs ON cs.id = d.checkin_session_id
      ${where}
      ORDER BY COALESCE(d.est_delivery, '9999-12-31'::date), d.created_at DESC
    `, params);

    res.json({ deliveries: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load deliveries' });
  }
});

router.get('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(`SELECT * FROM genero_deliveries WHERE id = $1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Delivery not found' });
    res.json({ delivery: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load delivery' });
  }
});

router.patch('/:id/status', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.body;
    const valid = ['UPCOMING', 'TODAY', 'IN_TRANSIT', 'ARRIVED', 'CHECKED_IN', 'CANCELLED'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const r = await query(
      `UPDATE genero_deliveries SET status=$1, last_updated=NOW() WHERE id=$2 RETURNING *`,
      [status, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Delivery not found' });
    res.json({ delivery: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update status' });
  }
});

export default router;
