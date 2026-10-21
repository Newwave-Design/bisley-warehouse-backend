import { query } from './index.js';

export async function ensurePickListEvents() {
  await query(`
    CREATE TABLE IF NOT EXISTS pick_list_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      pick_list_id UUID NOT NULL REFERENCES pick_lists(id) ON DELETE CASCADE,
      actor TEXT,
      action TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS pick_list_events_list_created_idx ON pick_list_events (pick_list_id, created_at DESC)`);
  await query(`ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ`);
  await query(`ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS last_event_by TEXT`);
  await query(`ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS last_event_summary TEXT`);
}
