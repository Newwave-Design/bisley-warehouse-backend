/**
 * Authentication API
 *
 * POST /api/auth/login              — verify email/password against warehouse_users, issue a signed JWT
 * POST /api/auth/bootstrap-admin    — one-time only: creates the initial admin account if none exists yet
 * POST /api/auth/promote-to-admin   — one-time only: promotes the calling account to ADMIN if no ADMIN exists yet
 */
import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../../db/index.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';

const router = express.Router();

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const result = await query(
      `SELECT id, name, email, role, password_hash, is_active FROM warehouse_users WHERE LOWER(email) = LOWER($1)`,
      [email]
    );
    const user = result.rows[0];
    if (!user || !user.is_active || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    await query(`UPDATE warehouse_users SET last_login_at = NOW() WHERE id = $1`, [user.id]);

    const token = jwt.sign(
      { sub: user.id, name: user.name, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'your_secret',
      { expiresIn: '30d' }
    );

    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
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
      `INSERT INTO warehouse_users (id, medusa_user_id, name, email, role, password_hash, is_active)
       VALUES (gen_random_uuid(), 'bootstrap_admin', 'Admin', 'admin@bisley.com', 'MANAGER', $1, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true`,
      [passwordHash]
    );

    res.json({ success: true, email: 'admin@bisley.com', message: 'Admin account created — log in with admin@bisley.com / demo123, then change the password' });
  } catch (err) {
    console.error('Bootstrap error:', err);
    res.status(500).json({ error: 'Bootstrap failed' });
  }
});

// One-time self-promotion: only succeeds while no account holds the ADMIN role yet.
// Sync/Medusa/API-type endpoints require ADMIN, but the bootstrap flow above only
// ever creates a MANAGER — this lets that first account elevate itself once, without
// needing raw DB access. Becomes permanently inert the moment any account is ADMIN.
router.post('/promote-to-admin', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const existingAdmin = await query(`SELECT COUNT(*)::int AS c FROM warehouse_users WHERE role = 'ADMIN'`);
    if (existingAdmin.rows[0].c > 0) {
      return res.status(403).json({ error: 'An admin account already exists' });
    }

    const result = await query(
      `UPDATE warehouse_users SET role = 'ADMIN', updated_at = NOW() WHERE id = $1 RETURNING id, name, email, role`,
      [req.user?.id]
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

export default router;
