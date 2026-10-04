/**
 * Mobile app releases — lets the Android handheld update itself without USB.
 *
 * GET  /api/mobile-app/latest                 newest published release (metadata only), or { release: null }
 * GET  /api/mobile-app/releases/:code/apk     the APK itself
 * POST /api/mobile-app/releases               publish a build (system_admin); raw APK body, metadata in headers:
 *                                             x-version-code, x-version-name, x-notes (URL-encoded, optional)
 * Publish with scripts/publish-android-release.mjs in the warehouse-android app.
 */

import crypto from 'crypto';
import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, requirePermission, AuthRequest } from '../../middleware/auth.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('mobile-app');
const router = express.Router();

router.get('/latest', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `SELECT version_code, version_name, notes, size_bytes, sha256, created_at
         FROM mobile_app_releases ORDER BY version_code DESC LIMIT 1`
    );
    res.json({ release: r.rows[0] ?? null });
  } catch (err) {
    logger.error(`Failed to load latest app release: ${(err as Error).message}`);
    res.status(500).json({ error: 'Failed to load latest release' });
  }
});

router.get('/releases/:code/apk', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(`SELECT apk, size_bytes FROM mobile_app_releases WHERE version_code = $1`, [parseInt(req.params.code)]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Release not found' });
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Length', String(r.rows[0].size_bytes));
    res.end(r.rows[0].apk);
  } catch (err) {
    logger.error(`Failed to send app release: ${(err as Error).message}`);
    res.status(500).json({ error: 'Failed to send release' });
  }
});

router.post(
  '/releases',
  authMiddleware,
  requirePermission('system_admin'),
  express.raw({ type: () => true, limit: '150mb' }),
  async (req: AuthRequest, res: Response) => {
    try {
      const code = parseInt(String(req.headers['x-version-code']));
      const name = String(req.headers['x-version-name'] ?? '').trim();
      const notes = req.headers['x-notes'] ? decodeURIComponent(String(req.headers['x-notes'])) : null;
      const apk = req.body as Buffer;
      if (!(code >= 1) || !name) return res.status(400).json({ error: 'x-version-code and x-version-name required' });
      if (!Buffer.isBuffer(apk) || apk.length < 1024 || apk[0] !== 0x50 || apk[1] !== 0x4b) {
        return res.status(400).json({ error: 'Body must be an APK file' });
      }

      const newest = await query(`SELECT MAX(version_code) AS m FROM mobile_app_releases`);
      if (newest.rows[0].m !== null && code <= newest.rows[0].m) {
        return res.status(409).json({ error: `Version code must be higher than the published ${newest.rows[0].m}` });
      }

      const sha256 = crypto.createHash('sha256').update(apk).digest('hex');
      await query(
        `INSERT INTO mobile_app_releases (version_code, version_name, notes, size_bytes, sha256, apk, published_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [code, name, notes, apk.length, sha256, apk, req.user?.email ?? null]
      );
      logger.info(`[mobile-app] Published ${name} (${code}), ${apk.length} bytes, by ${req.user?.email}`);
      res.status(201).json({ version_code: code, version_name: name, size_bytes: apk.length, sha256 });
    } catch (err) {
      logger.error(`Failed to publish app release: ${(err as Error).message}`);
      res.status(500).json({ error: 'Failed to publish release' });
    }
  }
);

export default router;
