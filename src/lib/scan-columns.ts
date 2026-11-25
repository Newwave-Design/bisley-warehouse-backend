/** checkin_scans.scanned_input keeps the exact code that was scanned, whatever it resolved to. Safe to call any number of times. */
import { query } from '../db/index.js';

let ready: Promise<void> | null = null;

export function ensureScanInputColumn(): Promise<void> {
  if (!ready) {
    ready = query(`ALTER TABLE checkin_scans ADD COLUMN IF NOT EXISTS scanned_input VARCHAR(255)`)
      .then(() => undefined)
      .catch((error) => {
        ready = null;
        throw error;
      });
  }
  return ready;
}
