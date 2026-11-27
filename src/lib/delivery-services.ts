/**
 * Delivery services tagged on an order. Room of choice is an upgrade from the standard hallway delivery, set from the
 * customer desk; the SGK driver notes and carton labels say "Room of choice" instead of "Hallway delivery".
 */
import { query } from '../db/index.js';

let ready: Promise<void> | null = null;

/** The column is also in the startup schema; this covers a request that arrives before that has run. */
export function ensureDeliveryServiceColumns(): Promise<void> {
  if (!ready) {
    ready = query(`ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS room_of_choice BOOLEAN NOT NULL DEFAULT false`)
      .then(() => undefined)
      .catch((error) => {
        ready = null;
        throw error;
      });
  }
  return ready;
}

/** Turns the room of choice upgrade on or off. Null when the order does not exist. */
export async function setRoomOfChoice(pickListId: string, on: boolean): Promise<boolean | null> {
  await ensureDeliveryServiceColumns();
  const result = await query(
    `UPDATE pick_lists SET room_of_choice = $2, updated_at = NOW() WHERE id = $1 RETURNING room_of_choice`,
    [pickListId, on],
  );
  return result.rows[0] ? Boolean(result.rows[0].room_of_choice) : null;
}
