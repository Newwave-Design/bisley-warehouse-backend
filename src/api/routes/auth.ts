/**
 * Authentication API
 *
 * POST /api/auth/login            — verify email/password against warehouse_users, issue a signed JWT
 * POST /api/auth/bootstrap-admin  — one-time only: creates the initial admin account if none exists yet
 */
import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../../db/index.js';
import { WAREHOUSE_SCHEMA } from '../../db/schema.js';

const router = express.Router();

// TEMPORARY diagnostic route — remove after use.
// Finds exactly which schema statement is failing during startup migrations.
router.get('/debug-migrate', async (_req: Request, res: Response) => {
  const statements = WAREHOUSE_SCHEMA.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
  for (let i = 0; i < statements.length; i++) {
    try {
      await query(statements[i]);
    } catch (err: any) {
      if (err.code === '42P07') continue;
      return res.json({ failedAtIndex: i, of: statements.length, statement: statements[i].slice(0, 300), error: err.message, code: err.code });
    }
  }
  res.json({ success: true, ranStatements: statements.length });
});

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
  } catch (err: any) {
    console.error('Bootstrap error:', err);
    res.status(500).json({ error: 'Bootstrap failed', detail: err.message });
  }
});

export default router;
