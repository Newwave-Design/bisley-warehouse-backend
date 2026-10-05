import { query } from '../db/index.js';

/** Scans a handheld could not match against a product, for one stock-in / move session or pick list (newest first). */
export async function failedScansFor(source: 'STOCK_IN' | 'MOVE' | 'PICK', sessionId: string) {
  const r = await query(
    `SELECT id, code, quantity, scanned_by, scanned_at, resolved_at, resolution, resolved_sku
       FROM failed_scans WHERE source = $1 AND session_id = $2 ORDER BY scanned_at DESC LIMIT 200`,
    [source, String(sessionId)]
  );
  return r.rows;
}
