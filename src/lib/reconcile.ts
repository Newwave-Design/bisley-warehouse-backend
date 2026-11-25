/**
 * Stock-in lines the catalogue cannot place. The scanner always accepts the scan; the desk reconciles it afterwards.
 *  UNMATCHED         — the code is not a known barcode or SKU. No stock is added until the desk picks the product.
 *  NOT_IN_CATALOGUE  — the barcode maps to a SKU that is not a catalogue product. Stocked as scanned; the desk checks it.
 */
import { query } from '../db/index.js';

let ready: Promise<void> | null = null;

export function ensureReconcileTable(): Promise<void> {
  if (!ready) {
    ready = query(`
      CREATE TABLE IF NOT EXISTS stock_in_reconcile (
        id SERIAL PRIMARY KEY,
        kind VARCHAR(20) NOT NULL,
        code VARCHAR(255) NOT NULL,
        sku VARCHAR(255),
        quantity INTEGER NOT NULL,
        session_id UUID,
        status VARCHAR(10) NOT NULL DEFAULT 'OPEN',
        resolved_sku VARCHAR(255),
        resolved_by VARCHAR(255),
        resolved_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_stock_in_reconcile_open ON stock_in_reconcile(status) WHERE status = 'OPEN'`)
      .then(() => undefined)
      .catch((error) => {
        ready = null;
        throw error;
      });
  }
  return ready;
}
