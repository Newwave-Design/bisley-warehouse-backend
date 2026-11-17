/**
 * A delivery note is the list of goods arriving on one day.
 * Scanning on the desk or the handheld records against that note, and can be left and reopened.
 */
import { readFileSync } from 'fs';
import { getPool, query } from '../db/index.js';

interface NoteLine { sku: string; quantity: number }
interface NoteFile {
  notes: { arrives_on: string; title: string; reference: string; lines: NoteLine[] }[];
}

const notesFile = JSON.parse(readFileSync(new URL('./delivery-notes.data.json', import.meta.url), 'utf8')) as NoteFile;

/** The note writes a trailing -001 that the warehouse code does not use. */
export function deliverySkuKey(value: string | null | undefined): string {
  return String(value || '').trim().toUpperCase().replace(/-001$/, '');
}

export async function ensureDeliveryNotes(): Promise<void> {
  for (const note of notesFile.notes) {
    const found = await query(
      `SELECT id FROM delivery_notes WHERE arrives_on = $1::date AND title = $2`,
      [note.arrives_on, note.title],
    );
    if (found.rows[0]) continue;
    const saved = await query(
      `INSERT INTO delivery_notes (arrives_on, title, reference)
       VALUES ($1::date, $2, $3)
       RETURNING id`,
      [note.arrives_on, note.title, note.reference],
    );
    const id = saved.rows[0].id;
    if (!note.lines.length) continue;
    await query(
      `INSERT INTO delivery_note_lines (delivery_note_id, sku, quantity)
       SELECT $1, sku, quantity FROM UNNEST($2::text[], $3::int[]) AS t(sku, quantity)`,
      [id, note.lines.map((line) => line.sku), note.lines.map((line) => line.quantity)],
    );
  }
}

async function scannedByNote(noteId: string): Promise<Map<string, number>> {
  const items = await query(
    `SELECT COALESCE(ci.medusa_sku, ci.nw_code) AS code, ci.quantity_scanned,
            bm.product_sku AS barcode_sku
       FROM checkin_items ci
       JOIN checkin_sessions s ON s.id = ci.session_id
       LEFT JOIN barcode_mappings bm ON bm.barcode = UPPER(ci.nw_code) AND bm.is_active = true
      WHERE s.delivery_note_id = $1 AND s.status <> 'CANCELLED' AND ci.removed_at IS NULL`,
    [noteId],
  );
  const scanned = new Map<string, number>();
  for (const row of items.rows) {
    const key = deliverySkuKey(row.barcode_sku || row.code);
    scanned.set(key, (scanned.get(key) || 0) + (Number(row.quantity_scanned) || 0));
  }
  return scanned;
}

export async function listDeliveryNotes() {
  const notes = await query(
    `SELECT id, arrives_on::text AS arrives_on, title, reference FROM delivery_notes ORDER BY arrives_on`,
  );
  const lines = await query(
    `SELECT delivery_note_id, sku, quantity FROM delivery_note_lines ORDER BY sku`,
  );
  const open = await query(
    `SELECT id, delivery_note_id FROM checkin_sessions WHERE status = 'OPEN' AND delivery_note_id IS NOT NULL`,
  );
  const openByNote = new Map(open.rows.map((row) => [row.delivery_note_id, row.id]));
  const out = [];
  for (const note of notes.rows) {
    const scanned = await scannedByNote(note.id);
    const noteLines = lines.rows.filter((line) => line.delivery_note_id === note.id).map((line) => {
      const received = scanned.get(deliverySkuKey(line.sku)) || 0;
      return { sku: line.sku, quantity: Number(line.quantity) || 0, received };
    });
    const expected = noteLines.reduce((sum, line) => sum + line.quantity, 0);
    const received = noteLines.reduce((sum, line) => sum + Math.min(line.received, line.quantity), 0);
    out.push({
      ...note,
      session_id: openByNote.get(note.id) || null,
      expected,
      received,
      complete: noteLines.length > 0 && noteLines.every((line) => line.received >= line.quantity),
      lines: noteLines,
    });
  }
  return out;
}

/** The open check-in for this note, creating one when scanning has not started. */
export async function openDeliveryNote(noteId: string, startedBy: string) {
  const note = await query(`SELECT id, title FROM delivery_notes WHERE id = $1`, [noteId]);
  if (!note.rows[0]) return null;
  const saved = await query(
    `INSERT INTO checkin_sessions (delivery_note_id, notes, started_by, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'OPEN', NOW(), NOW())
     ON CONFLICT (delivery_note_id) WHERE status = 'OPEN' AND delivery_note_id IS NOT NULL
     DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [noteId, note.rows[0].title, startedBy],
  );
  return saved.rows[0];
}

export async function deliveryNoteForSession(noteId: string | null) {
  if (!noteId) return null;
  const notes = await listDeliveryNotes();
  return notes.find((note) => note.id === noteId) || null;
}

export class DispatchNoteError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function cleanLines(lines: unknown): { sku: string; quantity: number }[] {
  if (!Array.isArray(lines)) throw new DispatchNoteError('Add the products on the note', 400);
  const merged = new Map<string, number>();
  for (const line of lines) {
    const sku = String(line?.sku || '').trim().toUpperCase();
    const raw = line?.quantity;
    if (!sku && (raw === '' || raw == null)) continue;
    const quantity = Math.floor(Number(raw));
    if (!sku) throw new DispatchNoteError('Each line needs a SKU', 400);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new DispatchNoteError(`${sku || 'A line'} needs a quantity`, 400);
    merged.set(sku, (merged.get(sku) || 0) + quantity);
  }
  return [...merged].map(([sku, quantity]) => ({ sku, quantity }));
}

/** Creates or replaces a dispatch note. Lines already scanned stay counted, because received is worked out from the scans. */
export async function saveDispatchNote(input: {
  id?: string;
  arrives_on: string;
  title: string;
  reference?: string | null;
  lines: unknown;
}): Promise<string> {
  const title = String(input.title || '').trim();
  const arrives = String(input.arrives_on || '').trim();
  const reference = String(input.reference || '').trim() || null;
  if (!title) throw new DispatchNoteError('A dispatch note needs a name', 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(arrives)) throw new DispatchNoteError('Choose the arrival date', 400);
  const lines = cleanLines(input.lines);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    let id = input.id;
    if (id) {
      const updated = await client.query(
        `UPDATE delivery_notes SET arrives_on = $1::date, title = $2, reference = $3 WHERE id = $4 RETURNING id`,
        [arrives, title, reference, id],
      );
      if (!updated.rows[0]) throw new DispatchNoteError('Dispatch note not found', 404);
    } else {
      const inserted = await client.query(
        `INSERT INTO delivery_notes (arrives_on, title, reference) VALUES ($1::date, $2, $3) RETURNING id`,
        [arrives, title, reference],
      );
      id = inserted.rows[0].id;
    }
    await client.query(`DELETE FROM delivery_note_lines WHERE delivery_note_id = $1`, [id]);
    if (lines.length) {
      await client.query(
        `INSERT INTO delivery_note_lines (delivery_note_id, sku, quantity)
         SELECT $1, sku, quantity FROM UNNEST($2::text[], $3::int[]) AS t(sku, quantity)`,
        [id, lines.map((line) => line.sku), lines.map((line) => line.quantity)],
      );
    }
    await client.query('COMMIT');
    return id!;
  } catch (err) {
    await client.query('ROLLBACK');
    if ((err as { code?: string }).code === '23505') {
      throw new DispatchNoteError('A dispatch note with that name is already on that date', 409);
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteDispatchNote(id: string): Promise<void> {
  try {
    const removed = await query(`DELETE FROM delivery_notes WHERE id = $1 RETURNING id`, [id]);
    if (!removed.rows[0]) throw new DispatchNoteError('Dispatch note not found', 404);
  } catch (err) {
    if (err instanceof DispatchNoteError) throw err;
    if ((err as { code?: string }).code === '23503') {
      throw new DispatchNoteError('This note already has scans, so it stays', 409);
    }
    throw err;
  }
}
