/**
 * Audit trail for Stock Sold V2.
 *
 * Every insert, update and delete on the V2 tables is copied into stock_sold_audit by database triggers (see
 * db/ensure-stock-sold-audit.ts), so nothing can change them unrecorded, including a manual SQL fix. The triggers read who and
 * why from transaction-local settings that this module sets; a change made with no context is recorded as a direct database edit.
 */
import type { PoolClient } from 'pg';
import { getPool, query } from '../db/index.js';

export interface AuditContext { actor: string; source: string; reason?: string }

export async function setAuditContext(client: { query: PoolClient['query'] }, ctx: AuditContext): Promise<void> {
  await client.query(
    `SELECT set_config('app.audit_actor', $1, true), set_config('app.audit_source', $2, true), set_config('app.audit_reason', $3, true)`,
    [ctx.actor, ctx.source, ctx.reason ?? '']
  );
}

/** Run fn in one transaction with the audit context set, so every row it changes is attributed. */
export async function withAudit<T>(ctx: AuditContext, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await setAuditContext(client, ctx);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Record an event that is not a row change, such as a statement being downloaded. */
export async function logAuditEvent(e: { table_name: string; action: string; actor: string; reason: string; week_start?: string; new_row?: unknown }): Promise<void> {
  try {
    await query(
      `INSERT INTO stock_sold_audit (table_name, action, week_start, new_row, actor, source, reason)
       VALUES ($1, $2, $3, $4, $5, 'user', $6)`,
      [e.table_name, e.action, e.week_start ?? null, e.new_row ? JSON.stringify(e.new_row) : null, e.actor, e.reason]
    );
  } catch (err) {
    console.warn('[audit] could not record event:', err instanceof Error ? err.message : err);
  }
}

export function actorOf(req: { user?: { id: string; email: string } }): string {
  return req.user?.email || req.user?.id || 'unknown';
}
