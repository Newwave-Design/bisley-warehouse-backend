/**
 * User management API (invite-based)
 *
 * GET    /api/users                    — list all users
 * POST   /api/users/invite             — create an invited user, returns a shareable invite link
 * POST   /api/users/:id/resend-invite  — regenerate an invite token (still-INVITED users only)
 * PATCH  /api/users/:id                — update name / group / active status
 * DELETE /api/users/:id                — deactivate (soft-delete; preserves audit-trail FKs)
 * GET    /api/users/:id/overrides      — this user's permission overrides + effective permissions
 * PUT    /api/users/:id/overrides      — replace this user's permission overrides
 */
import express, { Response } from 'express';
import crypto from 'crypto';
import { query } from '../../db/index.js';
import { authMiddleware, requirePermission, AuthRequest } from '../../middleware/auth.js';
import { getEffectivePermissions, isValidPermissionKey } from '../../lib/permissions.js';

const router = express.Router();

const INVITE_EXPIRY_DAYS = 7;

router.get('/', authMiddleware, requirePermission('manage_users'), async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(`
      SELECT u.id, u.name, u.email, u.status, u.is_active, u.last_login_at, u.created_at,
             g.id AS group_id, g.name AS group_name
      FROM warehouse_users u
      LEFT JOIN user_groups g ON g.id = u.group_id
      ORDER BY u.created_at ASC
    `);
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load users' });
  }
});

router.post('/invite', authMiddleware, requirePermission('manage_users'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, group_id } = req.body;
    if (!name || !email || !group_id) {
      return res.status(400).json({ error: 'name, email, and group_id are required' });
    }
    const group = await query(`SELECT id FROM user_groups WHERE id = $1`, [group_id]);
    if (!group.rows[0]) return res.status(400).json({ error: 'Unknown group' });

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const result = await query(
      `INSERT INTO warehouse_users (id, name, email, role, group_id, status, invite_token, invite_token_expires_at, invited_by, is_active)
       VALUES (gen_random_uuid(), $1, $2, 'WMS', $3, 'INVITED', $4, $5, $6, false)
       RETURNING id, name, email, status`,
      [name, email, group_id, token, expiresAt, req.user?.id === '1' ? null : req.user?.id]
    );

    res.status(201).json({
      user: result.rows[0],
      invite_token: token,
      invite_path: `/accept-invite?token=${token}`,
      expires_at: expiresAt,
    });
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'A user with that email already exists' });
    console.error('Invite error:', err);
    res.status(500).json({ error: 'Failed to invite user' });
  }
});

router.post('/:id/resend-invite', authMiddleware, requirePermission('manage_users'), async (req: AuthRequest, res: Response) => {
  try {
    const existing = await query(`SELECT id, status FROM warehouse_users WHERE id = $1`, [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'User not found' });
    if (existing.rows[0].status !== 'INVITED') {
      return res.status(400).json({ error: 'This user has already accepted their invite' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await query(
      `UPDATE warehouse_users SET invite_token = $1, invite_token_expires_at = $2, updated_at = NOW() WHERE id = $3`,
      [token, expiresAt, req.params.id]
    );

    res.json({ invite_token: token, invite_path: `/accept-invite?token=${token}`, expires_at: expiresAt });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resend invite' });
  }
});

router.patch('/:id', authMiddleware, requirePermission('manage_users'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, group_id, is_active } = req.body;
    const existing = await query(`SELECT id, group_id FROM warehouse_users WHERE id = $1`, [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'User not found' });

    if (group_id) {
      const group = await query(`SELECT id FROM user_groups WHERE id = $1`, [group_id]);
      if (!group.rows[0]) return res.status(400).json({ error: 'Unknown group' });
    }

    const result = await query(
      `UPDATE warehouse_users SET
         name = COALESCE($1, name),
         group_id = COALESCE($2, group_id),
         is_active = COALESCE($3, is_active),
         status = CASE WHEN $3 = false THEN 'DISABLED' WHEN $3 = true AND status = 'DISABLED' THEN 'ACTIVE' ELSE status END,
         updated_at = NOW()
       WHERE id = $4
       RETURNING id, name, email, status, is_active, group_id`,
      [name ?? null, group_id ?? null, is_active ?? null, req.params.id]
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Soft-delete: deactivate rather than remove the row, so historical performed_by /
// picked_by / invited_by references stay intact.
router.delete('/:id', authMiddleware, requirePermission('manage_users'), async (req: AuthRequest, res: Response) => {
  try {
    if (req.params.id === req.user?.id) {
      return res.status(400).json({ error: 'You cannot deactivate your own account' });
    }
    const result = await query(
      `UPDATE warehouse_users SET is_active = false, status = 'DISABLED', updated_at = NOW() WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

router.get('/:id/overrides', authMiddleware, requirePermission('manage_users'), async (req: AuthRequest, res: Response) => {
  try {
    const overrides = await query(
      `SELECT permission_key, allowed FROM user_permission_overrides WHERE user_id = $1`,
      [req.params.id]
    );
    const effective = await getEffectivePermissions(req.params.id);
    res.json({
      overrides: Object.fromEntries(overrides.rows.map((r: any) => [r.permission_key, r.allowed])),
      effective,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load overrides' });
  }
});

// Body: { overrides: { [permission_key]: true | false | null } } — null clears the
// override so the user falls back to their group's default for that permission.
router.put('/:id/overrides', authMiddleware, requirePermission('manage_users'), async (req: AuthRequest, res: Response) => {
  try {
    const overrides = req.body.overrides ?? {};
    for (const key of Object.keys(overrides)) {
      if (!isValidPermissionKey(key)) return res.status(400).json({ error: `Unknown permission key: ${key}` });
    }

    for (const [key, value] of Object.entries(overrides)) {
      if (value === null) {
        await query(`DELETE FROM user_permission_overrides WHERE user_id = $1 AND permission_key = $2`, [req.params.id, key]);
      } else {
        await query(
          `INSERT INTO user_permission_overrides (user_id, permission_key, allowed)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed`,
          [req.params.id, key, value]
        );
      }
    }

    const effective = await getEffectivePermissions(req.params.id);
    res.json({ success: true, effective });
  } catch (err) {
    console.error('Update overrides error:', err);
    res.status(500).json({ error: 'Failed to update overrides' });
  }
});

export default router;
