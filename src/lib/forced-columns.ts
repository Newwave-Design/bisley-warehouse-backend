/**
 * The columns that mark a force-added line. schema.ts only runs on a manual migration, so the server creates these itself,
 * at start and again before anything reads them. Safe to call any number of times.
 */
import { query } from '../db/index.js';

let ready: Promise<void> | null = null;

export function ensureForcedColumns(): Promise<void> {
  if (!ready) {
    ready = query(`ALTER TABLE pick_list_items ADD COLUMN IF NOT EXISTS forced_at TIMESTAMP, ADD COLUMN IF NOT EXISTS forced_by VARCHAR(255)`)
      .then(() => undefined)
      .catch((error) => {
        ready = null;
        throw error;
      });
  }
  return ready;
}
