/**
 * Authentication API
 *
 * POST /api/auth/login              — verify email/password against warehouse_users, issue a signed JWT
 *                                      (body.device=true → 90-day token for dedicated scanner handhelds)
 * POST /api/auth/refresh            — exchange a valid (or recently expired) token for a fresh one, keeping scanners logged in
 * POST /api/auth/bootstrap-admin    — one-time only: creates the initial admin account if none exists yet
 * POST /api/auth/promote-to-admin   — one-time only: moves the calling account into the Admin group if none exists yet
 * GET  /api/auth/me                 — current user + group + effective permissions
 * GET  /api/auth/invite/:token      — public: look up an invite by token (for the accept-invite page)
 * POST /api/auth/accept-invite      — public: set a password for an invited account, returns a login token
 */
import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../../db/index.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { getEffectivePermissions } from '../../lib/permissions.js';

const router = express.Router();

const USER_TOKEN_TTL = '30d';
const DEVICE_TOKEN_TTL = '90d';
const REFRESH_GRACE_SECONDS = 14 * 24 * 60 * 60; // an expired token can still be refreshed for this long

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password, device } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const result = await query(
      `SELECT id, name, email, role, status, password_hash, is_active FROM warehouse_users WHERE LOWER(email) = LOWER($1)`,
      [email]
    );
    const user = result.rows[0];
    if (!user || !user.is_active || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (user.status === 'INVITED') {
      return res.status(401).json({ error: 'This account has not accepted its invite yet — use the invite link to set a password' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    await query(`UPDATE warehouse_users SET last_login_at = NOW() WHERE id = $1`, [user.id]);

    const token = jwt.sign(
      { sub: user.id, name: user.name, email: user.email, role: user.role, ...(device ? { dev: true } : {}) },
      process.env.JWT_SECRET || 'your_secret',
      { expiresIn: device ? DEVICE_TOKEN_TTL : USER_TOKEN_TTL }
    );

    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Sliding session: a scanner calls this on startup / on a 401 so a logged-in handheld never
// needs a password re-entered. Re-checks the account is still active, so deactivation still
// locks the device out at the next refresh. Token lifetime class (user vs device) is preserved.
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const old = req.headers.authorization?.replace('Bearer ', '');
    if (!old) return res.status(401).json({ error: 'No token provided' });

    let decoded: any;
    try {
      decoded = jwt.verify(old, process.env.JWT_SECRET || 'your_secret', { ignoreExpiration: true });
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (decoded.exp && Date.now() / 1000 - decoded.exp > REFRESH_GRACE_SECONDS) {
      return res.status(401).json({ error: 'Session expired — please log in again' });
    }

    const userId = decoded.sub || decoded.id;
    const result = await query(
      `SELECT id, name, email, role, is_active FROM warehouse_users WHERE id = $1`,
      [userId]
    );
    const user = result.rows[0];
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'This account has been deactivated' });
    }

    const isDevice = decoded.dev === true;
    const token = jwt.sign(
      { sub: user.id, name: user.name, email: user.email, role: user.role, ...(isDevice ? { dev: true } : {}) },
      process.env.JWT_SECRET || 'your_secret',
      { expiresIn: isDevice ? DEVICE_TOKEN_TTL : USER_TOKEN_TTL }
    );
    res.json({ token });
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({ error: 'Refresh failed' });
  }
});

// One-time bootstrap: only succeeds while no account has a password set yet.
// Lets a fresh deployment get its first working login without direct DB access;
// becomes permanently inert the moment any account has a password_hash.
router.post('/bootstrap-admin', async (_req: Request, res: Response) => {
  try {
    const existing = await query(`SELECT COUNT(*)::int AS c FROM warehouse_users WHERE password_hash IS NOT NULL`);
    if (existing.rows[0].c > 0) {
      return res.status(403).json({ error: 'Bootstrap already used — an account with a password already exists' });
    }

    const passwordHash = await bcrypt.hash('demo123', 10);
    await query(
      `INSERT INTO warehouse_users (id, medusa_user_id, name, email, role, status, password_hash, is_active)
       VALUES (gen_random_uuid(), 'bootstrap_admin', 'Admin', 'admin@bisley.com', 'MANAGER', 'ACTIVE', $1, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true, status = 'ACTIVE'`,
      [passwordHash]
    );

    res.json({ success: true, email: 'admin@bisley.com', message: 'Admin account created — log in with admin@bisley.com / demo123, then change the password' });
  } catch (err) {
    console.error('Bootstrap error:', err);
    res.status(500).json({ error: 'Bootstrap failed' });
  }
});

// One-time self-promotion: only succeeds while no account belongs to the Admin group yet.
// Sync/Medusa/API-type endpoints require the 'system_admin' permission, but the bootstrap
// flow above only ever creates a WMS-group account — this lets that first account move
// itself into Admin once, without needing raw DB access. Becomes inert once any account
// is in the Admin group.
router.post('/promote-to-admin', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const adminGroup = await query(`SELECT id FROM user_groups WHERE name = 'Admin'`);
    if (!adminGroup.rows[0]) return res.status(500).json({ error: 'Admin group not found' });

    const existingAdmin = await query(
      `SELECT COUNT(*)::int AS c FROM warehouse_users WHERE group_id = $1`,
      [adminGroup.rows[0].id]
    );
    if (existingAdmin.rows[0].c > 0) {
      return res.status(403).json({ error: 'An admin account already exists' });
    }

    const result = await query(
      `UPDATE warehouse_users SET group_id = $1, role = 'ADMIN', updated_at = NOW() WHERE id = $2 RETURNING id, name, email, role`,
      [adminGroup.rows[0].id, req.user?.id]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Account not found — log in with a real account first, not the demo token' });

    const token = jwt.sign(
      { sub: user.id, name: user.name, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'your_secret',
      { expiresIn: '30d' }
    );

    res.json({ success: true, token, user });
  } catch (err) {
    console.error('Promote-to-admin error:', err);
    res.status(500).json({ error: 'Promotion failed' });
  }
});

// Current user + group + effective permissions — the frontend polls this after login
// and after anything that might change permissions, rather than trusting the JWT.
router.get('/me', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const permissions = await getEffectivePermissions(req.user.id);

    if (req.user.id === '1') {
      return res.json({
        user: { id: '1', name: 'Demo', email: req.user.email, status: 'ACTIVE' },
        group: { id: null, name: 'Demo (all access)' },
        permissions,
      });
    }

    const result = await query(
      `SELECT u.id, u.name, u.email, u.status, g.id AS group_id, g.name AS group_name
       FROM warehouse_users u LEFT JOIN user_groups g ON g.id = u.group_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'Account not found' });

    res.json({
      user: { id: row.id, name: row.name, email: row.email, status: row.status },
      group: row.group_id ? { id: row.group_id, name: row.group_name } : null,
      permissions,
    });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Failed to load account' });
  }
});

// Public: look up an invite by token, for the accept-invite page to greet the user by name.
router.get('/invite/:token', async (req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT name, email, invite_token_expires_at FROM warehouse_users
       WHERE invite_token = $1 AND status = 'INVITED'`,
      [req.params.token]
    );
    const invite = result.rows[0];
    if (!invite) return res.status(404).json({ error: 'Invite not found or already used' });
    if (new Date(invite.invite_token_expires_at) < new Date()) {
      return res.status(410).json({ error: 'This invite has expired — ask an admin to resend it' });
    }
    res.json({ name: invite.name, email: invite.email });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load invite' });
  }
});

// Public: accept an invite by setting a password. Auto-logs the user in.
router.post('/accept-invite', async (req: Request, res: Response) => {
  try {
    const { token, password } = req.body;
    if (!token || !password || password.length < 8) {
      return res.status(400).json({ error: 'token and a password of at least 8 characters are required' });
    }

    const result = await query(
      `SELECT id, name, email, role, invite_token_expires_at FROM warehouse_users
       WHERE invite_token = $1 AND status = 'INVITED'`,
      [token]
    );
    const invite = result.rows[0];
    if (!invite) return res.status(404).json({ error: 'Invite not found or already used' });
    if (new Date(invite.invite_token_expires_at) < new Date()) {
      return res.status(410).json({ error: 'This invite has expired — ask an admin to resend it' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await query(
      `UPDATE warehouse_users
       SET password_hash = $1, status = 'ACTIVE', is_active = true,
           invite_token = NULL, invite_token_expires_at = NULL, updated_at = NOW()
       WHERE id = $2`,
      [passwordHash, invite.id]
    );

    const jwtToken = jwt.sign(
      { sub: invite.id, name: invite.name, email: invite.email, role: invite.role },
      process.env.JWT_SECRET || 'your_secret',
      { expiresIn: '30d' }
    );

    res.json({ success: true, token: jwtToken, user: { id: invite.id, name: invite.name, email: invite.email, role: invite.role } });
  } catch (err) {
    console.error('Accept-invite error:', err);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

export default router;
