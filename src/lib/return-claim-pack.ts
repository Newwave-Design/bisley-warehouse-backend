/**
 * A claim pack: a zip with the claim details and every photo taken of the goods, ready to send to the carrier or to Bisley.
 * Photos come from the Returns screen and from the older return queue (the same order's photos), so none are left behind.
 */
import { query } from '../db/index.js';
import { claimFileName, zipFiles, type ZipEntry } from './returns-desk-rules.js';

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_PACK_BYTES = 40 * 1024 * 1024;

function safe(text: string) {
  return String(text || 'item').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40);
}

export type ClaimPack = { file: string; zip: Buffer; photos: number; skipped: number; kind: 'bisley' | 'carrier'; target: string };

export async function buildClaimPack(claimId: string): Promise<ClaimPack | null> {
  const claim = await query(
    `SELECT c.id, c.kind, c.note, ra.id AS return_id, ra.rma_number, ra.customer_name, ra.customer_email, ra.return_reason, ra.tracking_number,
            ra.courier_problem, ra.decision, ra.notes, ra.pick_list_id, ra.created_at, pl.pick_list_number, pl.medusa_order_id
       FROM return_claims c
       JOIN return_authorizations ra ON ra.id = c.return_authorization_id
       LEFT JOIN pick_lists pl ON pl.id = ra.pick_list_id
      WHERE c.id = $1`,
    [claimId]
  );
  const row = claim.rows[0];
  if (!row) return null;
  const kind: 'bisley' | 'carrier' = row.kind === 'carrier' ? 'carrier' : 'bisley';
  const items = (await query(`SELECT id, product_sku, quantity_requested, quantity_received, item_condition, decision, item_notes FROM return_items WHERE return_authorization_id = $1 ORDER BY created_at, id`, [row.return_id])).rows;

  const files: ZipEntry[] = [];
  let used = 0;
  let skipped = 0;
  const lines: string[] = [];
  const add = (name: string, type: string, data: Buffer, label: string) => {
    if (used + data.length > MAX_PACK_BYTES) { skipped += 1; return; }
    used += data.length;
    const ext = EXT[type] || 'jpg';
    const file = `photos/${String(files.length + 1).padStart(2, '0')}-${safe(name)}.${ext}`;
    files.push({ name: file, data });
    lines.push(`  ${file}  ${label}`);
  };

  const desk = await query(`SELECT p.content_type, p.image, p.created_at, ri.product_sku FROM return_desk_photos p LEFT JOIN return_items ri ON ri.id = p.return_item_id WHERE p.return_authorization_id = $1 ORDER BY p.created_at`, [row.return_id]);
  for (const photo of desk.rows) add(photo.product_sku || 'return', photo.content_type, photo.image, `${photo.product_sku || 'whole return'}, taken on the Returns screen`);
  if (row.pick_list_id) {
    const older = await query(
      `SELECT i.content_type, i.image, r.sku FROM return_request_images i JOIN return_requests r ON r.id = i.return_request_id WHERE r.pick_list_id = $1 ORDER BY i.created_at`,
      [row.pick_list_id]
    );
    for (const photo of older.rows) add(photo.sku, photo.content_type, photo.image, `${photo.sku}, taken when the return was asked for`);
  }

  const text = [
    `Claim pack ${row.rma_number}`,
    `For: ${kind === 'carrier' ? 'the carrier (carrier claim)' : 'Bisley (Bisley claim)'}`,
    '',
    `Order: ${row.pick_list_number || ''}${row.medusa_order_id ? ` (shop order ${row.medusa_order_id})` : ''}`,
    `Customer: ${row.customer_name || ''}${row.customer_email ? ` <${row.customer_email}>` : ''}`,
    `Reason: ${row.return_reason || ''}`,
    `Courier problem: ${row.courier_problem || 'none'}`,
    `Tracking: ${row.tracking_number || ''}`,
    `Return opened: ${row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : ''}`,
    row.note ? `Claim note: ${row.note}` : '',
    '',
    'Items:',
    ...(items.length
      ? items.map((i: any) => `  ${i.product_sku} x${i.quantity_requested}${i.item_condition ? `, condition ${i.item_condition}` : ''}${i.decision ? `, decision ${i.decision}` : ''}${i.item_notes ? `, ${i.item_notes}` : ''}`)
      : ['  (a part refund for damage, the customer kept the goods)']),
    '',
    `Photos: ${files.length}${skipped ? ` (${skipped} left out to keep the pack under ${Math.round(MAX_PACK_BYTES / 1048576)} MB)` : ''}`,
    ...lines,
    row.notes ? `\nNotes on the return: ${row.notes}` : '',
  ].filter((line) => line !== '').join('\n');

  const entries: ZipEntry[] = [{ name: 'claim.txt', data: Buffer.from(text) }, ...files];
  return {
    file: claimFileName(row.rma_number, kind),
    zip: zipFiles(entries),
    photos: files.length,
    skipped,
    kind,
    target: kind === 'carrier' ? 'DX UAT or the carrier named on the order' : 'Bisley',
  };
}
