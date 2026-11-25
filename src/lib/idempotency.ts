/**
 * Safe repeats for a device's uploads.
 *
 * A handheld that loses its connection after the server has saved a scan, but before the reply arrives, sends the scan
 * again. Without help the server counts it twice. A request that carries a `client_id` is remembered: the same
 * `client_id` on the same route gets the first answer back and changes nothing.
 *
 * Opt in only. A request with no `client_id` (every older handheld, the web scanner) behaves exactly as before, and a
 * problem with this bookkeeping never blocks a scan: it just runs as it always did.
 */
import type { NextFunction, Request, Response } from 'express';
import { query } from '../db/index.js';

let ready: Promise<void> | null = null;
const inFlight = new Set<string>();
let lastPurge = 0;

function ensureTable(): Promise<void> {
  if (!ready) {
    ready = query(`
      CREATE TABLE IF NOT EXISTS idempotent_requests (
        key TEXT PRIMARY KEY,
        status INTEGER NOT NULL,
        body JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`)
      .then(() => undefined)
      .catch((error) => {
        ready = null;
        throw error;
      });
  }
  return ready;
}

/** Old answers are only needed while a device might still be retrying. */
async function purgeOld(): Promise<void> {
  if (Date.now() - lastPurge < 6 * 60 * 60 * 1000) return;
  lastPurge = Date.now();
  await query(`DELETE FROM idempotent_requests WHERE created_at < NOW() - INTERVAL '14 days'`).catch(() => undefined);
}

export function idempotent() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const id = String((req.body as { client_id?: unknown } | undefined)?.client_id ?? '').trim().slice(0, 120);
    if (!id) return next();
    const key = `${req.method} ${req.baseUrl}${req.path}:${id}`;
    try {
      await ensureTable();
      const prior = await query(`SELECT status, body FROM idempotent_requests WHERE key = $1`, [key]);
      if (prior.rows[0]) {
        const body = prior.rows[0].body && typeof prior.rows[0].body === 'object' ? { ...prior.rows[0].body, replayed: true } : { replayed: true };
        return res.status(prior.rows[0].status).json(body);
      }
    } catch (error) {
      // Bookkeeping must never stop a scan. Run it as normal.
      console.warn('[idempotency] lookup failed, running the request normally:', error instanceof Error ? error.message : error);
      return next();
    }
    if (inFlight.has(key)) {
      // The first copy is still being saved. A 503 tells the device to try again shortly, not to give up.
      return res.status(503).json({ error: 'That scan is still being saved. Trying again.' });
    }
    inFlight.add(key);
    res.on('close', () => inFlight.delete(key));
    const send = res.json.bind(res);
    res.json = ((body: unknown) => {
      const status = res.statusCode;
      // Only a saved result is remembered. A refusal or a server error may succeed on a retry.
      const remember = status >= 200 && status < 300
        ? query(`INSERT INTO idempotent_requests (key, status, body) VALUES ($1, $2, $3::jsonb) ON CONFLICT (key) DO NOTHING`, [key, status, JSON.stringify(body ?? null)]).catch(() => undefined)
        : Promise.resolve();
      void remember.finally(() => {
        inFlight.delete(key);
        send(body);
      });
      void purgeOld();
      return res;
    }) as typeof res.json;
    next();
  };
}
