/**
 * Group & permission management API
 *
 * GET    /api/groups                     — list groups with their permission matrix + member counts
 * GET    /api/groups/permission-catalog  — the fixed list of permission keys (label + description)
 * POST   /api/groups                     — create a custom group
 * PATCH  /api/groups/:id                 — rename / re-describe a group
 * PUT    /api/groups/:id/permissions     — replace a group's permission ticks
 * DELETE /api/groups/:id                 — delete a custom group (must be empty, not a system group)
 */
import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, requirePermission, AuthRequest } from '../../middleware/auth.js';
import { PERMISSION_CATALOG, isValidPermissionKey } from '../../lib/permissions.js';

const router = express.Router();

router.get('/permission-catalog', authMiddleware, requirePermission('manage_users'), (_req: AuthRequest, res: Response) => {
  res.json({ permissions: PERMISSION_CATALOG });
});

router.get('/', authMiddleware, requirePermission('manage_users'), async (_req: AuthRequest, res: Response) => {
  try {
    const groups = await query(`
      SELECT g.id, g.name, g.description, g.is_system,
             COUNT(u.id)::int AS member_count
      FROM user_groups g
      LEFT JOIN warehouse_users u ON u.group_id = g.id
      GROUP BY g.id ORDER BY g.is_system DESC, g.name ASC
    `);
    const perms = await query(`SELECT group_id, permission_key, allowed FROM group_permissions`);
    const permsByGroup = new Map<string, Record<string, boolean>>();
    for (const row of perms.rows) {
      if (!permsByGroup.has(row.group_id)) permsByGroup.set(row.group_id, {});
      permsByGroup.get(row.group_id)![row.permission_key] = row.allowed;
    }

    res.json({
      groups: groups.rows.map((g: any) => ({
        ...g,
        permissions: permsByGroup.get(g.id) ?? {},
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load groups' });
  }
});

router.post('/', authMiddleware, requirePermission('manage_users'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const result = await query(
      `INSERT INTO user_groups (name, description, is_system) VALUES ($1, $2, false) RETURNING id, name, description, is_system`,
      [name, description ?? null]
    );
    res.status(201).json({ group: result.rows[0] });
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'A group with that name already exists' });
    res.status(500).json({ error: 'Failed to create group' });
  }
});

router.patch('/:id', authMiddleware, requirePermission('manage_users'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, description } = req.body;
    const result = await query(
      `UPDATE user_groups SET name = COALESCE($1, name), description = COALESCE($2, description), updated_at = NOW()
       WHERE id = $3 RETURNING id, name, description, is_system`,
      [name ?? null, description ?? null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Group not found' });
    res.json({ group: result.rows[0] });
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'A group with that name already exists' });
    res.status(500).json({ error: 'Failed to update group' });
  }
});

// Body: { permissions: { [key]: boolean } } — full replace of this group's ticks.
// The Admin system group always keeps manage_users=true, to guarantee at least one
// group can always fix a permissions mistake.
router.put('/:id/permissions', authMiddleware, requirePermission('manage_users'), async (req: AuthRequest, res: Response) => {
  try {
    const group = await query(`SELECT id, name, is_system FROM user_groups WHERE id = $1`, [req.params.id]);
    if (!group.rows[0]) return res.status(404).json({ error: 'Group not found' });

    const permissions: Record<string, boolean> = req.body.permissions ?? {};
    for (const key of Object.keys(permissions)) {
      if (!isValidPermissionKey(key)) return res.status(400).json({ error: `Unknown permission key: ${key}` });
    }
    if (group.rows[0].is_system && group.rows[0].name === 'Admin') {
      permissions.manage_users = true;
    }

    for (const [key, allowed] of Object.entries(permissions)) {
      await query(
        `INSERT INTO group_permissions (group_id, permission_key, allowed) VALUES ($1, $2, $3)
         ON CONFLICT (group_id, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed`,
        [req.params.id, key, allowed]
      );
    }

    const updated = await query(`SELECT permission_key, allowed FROM group_permissions WHERE group_id = $1`, [req.params.id]);
    res.json({ permissions: Object.fromEntries(updated.rows.map((r: any) => [r.permission_key, r.allowed])) });
  } catch (err) {
    console.error('Update group permissions error:', err);
    res.status(500).json({ error: 'Failed to update group permissions' });
  }
});

router.delete('/:id', authMiddleware, requirePermission('manage_users'), async (req: AuthRequest, res: Response) => {
  try {
    const group = await query(`SELECT id, is_system FROM user_groups WHERE id = $1`, [req.params.id]);
    if (!group.rows[0]) return res.status(404).json({ error: 'Group not found' });
    if (group.rows[0].is_system) return res.status(400).json({ error: 'System groups cannot be deleted' });

    const members = await query(`SELECT COUNT(*)::int AS c FROM warehouse_users WHERE group_id = $1`, [req.params.id]);
    if (members.rows[0].c > 0) {
      return res.status(400).json({ error: `Reassign the ${members.rows[0].c} user(s) in this group before deleting it` });
    }

    await query(`DELETE FROM user_groups WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete group' });
  }
});

export default router;
