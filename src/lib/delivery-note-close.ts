/**
 * Closing off a delivery note as received.
 * A closed note drops off the handheld's check-in list. It closes when every line has been scanned in, or, with a reason
 * written down, when the delivery is short. A check-in that is still open on it has to be finished or cancelled first,
 * because stock is only added when that check-in is completed. A closed note can be reopened.
 */
import { query } from '../db/index.js';

let ready: Promise<void> | null = null;

/** The columns a closed note needs. The server creates them itself, at start and before anything reads them. */
export function ensureCloseColumns(): Promise<void> {
  if (!ready) {
    ready = query(
      `ALTER TABLE delivery_notes
         ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS closed_by VARCHAR(255),
         ADD COLUMN IF NOT EXISTS close_note TEXT`
    )
      .then(() => undefined)
      .catch((error) => {
        ready = null;
        throw error;
      });
  }
  return ready;
}

export interface NoteForClose {
  complete: boolean;
  lines: { sku: string; quantity: number; received: number }[];
}

export type CloseDecision =
  | { ok: true; summary: string; short: string[]; over: string[] }
  | { ok: false; status: number; error: string; short?: string[] };

export function closeDecision(note: NoteForClose, openSession: boolean, input: { acceptShortfall?: boolean; note?: string }): CloseDecision {
  if (openSession) {
    return { ok: false, status: 409, error: 'A check-in is still open on this delivery. Finish or cancel it on the handheld first, so the stock is added.' };
  }
  const short = note.lines.filter((line) => line.received < line.quantity).map((line) => `${line.sku} ${line.received}/${line.quantity}`);
  const over = note.lines.filter((line) => line.received > line.quantity).map((line) => `${line.sku} ${line.received}/${line.quantity}`);
  const units = note.lines.reduce((sum, line) => sum + line.quantity, 0);
  if (!note.lines.length) return { ok: false, status: 409, error: 'This delivery has no lines, so there is nothing to close off.' };
  if (!short.length) {
    return { ok: true, summary: `All ${units} units scanned in${over.length ? `; more than expected on ${over.join(', ')}` : ''}`, short, over };
  }
  if (!input.acceptShortfall) {
    return { ok: false, status: 409, short, error: `Not everything has been scanned in. Short on ${short.length} line${short.length === 1 ? '' : 's'}: ${short.slice(0, 6).join(', ')}${short.length > 6 ? '…' : ''}. Close it with a reason if you accept that.` };
  }
  if (String(input.note || '').trim().length < 5) {
    return { ok: false, status: 400, short, error: 'Say why it is being closed short, in a few words.' };
  }
  return { ok: true, summary: `Closed short on ${short.length} line${short.length === 1 ? '' : 's'}: ${short.join(', ')}`, short, over };
}

export async function closeDeliveryNote(
  note: NoteForClose & { id: string; closed?: boolean; session_id?: string | null },
  actor: string,
  input: { acceptShortfall?: boolean; note?: string }
): Promise<CloseDecision> {
  if (note.closed) return { ok: false, status: 409, error: 'This delivery is already closed.' };
  const decision = closeDecision(note, Boolean(note.session_id), input);
  if (!decision.ok) return decision;
  const reason = String(input.note || '').trim();
  await ensureCloseColumns();
  await query(
    `UPDATE delivery_notes SET closed_at = NOW(), closed_by = $2, close_note = $3 WHERE id = $1 AND closed_at IS NULL`,
    [note.id, actor.slice(0, 255), `${decision.summary}${reason ? `. ${reason.slice(0, 500)}` : ''}`.slice(0, 1000)]
  );
  return decision;
}

export async function reopenDeliveryNote(id: string): Promise<boolean> {
  await ensureCloseColumns();
  const result = await query(`UPDATE delivery_notes SET closed_at = NULL, closed_by = NULL, close_note = NULL WHERE id = $1 AND closed_at IS NOT NULL RETURNING id`, [id]);
  return result.rows.length > 0;
}
