import { query } from '../db/index.js';

export class PartsSendError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function londonStamp() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date()).replace(/-/g, '');
}

function orderDigits(pickListNumber: string) {
  const match = String(pickListNumber || '').match(/^PL-\d{8}-(\d+)/i);
  return match ? String(parseInt(match[1], 10)).padStart(4, '0') : '0000';
}

async function unusedValue(column: 'medusa_order_id' | 'pick_list_number', preferred: string, limit: number) {
  const taken = await query(`SELECT 1 FROM pick_lists WHERE ${column} = $1`, [preferred]);
  if (!taken.rows.length) return preferred;
  const suffix = Date.now().toString(36).slice(-4).toUpperCase();
  return `${preferred}${suffix}`.slice(0, limit);
}

/**
 * A missing part or replacement is its own pick, linked to the original order.
 * The shop order is not fulfilled again: the id does not start with order_.
 */
export async function openPartsSend(sourceId: string, input: { sku?: string; quantity?: number; reason?: string; byHand?: boolean }) {
  const sku = String(input.sku || '').trim().slice(0, 50);
  const quantity = Math.round(Number(input.quantity) || 0);
  const reason = String(input.reason || '').trim().slice(0, 500);
  if (!sku) throw new PartsSendError(400, 'Enter the part SKU');
  if (quantity < 1 || quantity > 99) throw new PartsSendError(400, 'Enter a quantity from 1 to 99');
  if (reason.length < 3) throw new PartsSendError(400, 'Say what is missing or being replaced');

  const found = await query(`SELECT * FROM pick_lists WHERE id = $1`, [sourceId]);
  const source = found.rows[0];
  if (!source) throw new PartsSendError(404, 'Order not found');

  const byHand = input.byHand !== false;
  const prefix = byHand ? 'manual' : 'part';
  const medusaId = await unusedValue('medusa_order_id', `${prefix}-${orderDigits(source.pick_list_number)}-${sku}`.slice(0, 100), 100);
  const pickListNumber = await unusedValue('pick_list_number', `PL-${londonStamp()}-${orderDigits(source.pick_list_number)}P`, 50);
  const payment = ['captured', 'partially_refunded'].includes(source.payment_status) ? source.payment_status : 'captured';
  const created = await query(
    `INSERT INTO pick_lists (
       medusa_order_id, pick_list_number, status, parent_pick_list_id,
       customer_name, customer_email, shipping_method_name, shipping_method_code, shipping_address,
       is_sandbox, is_return, payment_status, purchase_order_number, notes, created_at, updated_at
     ) VALUES (
       $1, $2, 'PENDING', $3,
       $4, $5, $6, $7, $8::jsonb,
       false, false, $9, $10, $11, NOW(), NOW()
     ) RETURNING id, pick_list_number`,
    [
      medusaId,
      pickListNumber,
      source.id,
      source.customer_name,
      source.customer_email,
      source.shipping_method_name,
      source.shipping_method_code,
      JSON.stringify(source.shipping_address || {}),
      payment,
      source.purchase_order_number || null,
      reason,
    ]
  );
  const id = created.rows[0].id;
  await query(
    `INSERT INTO pick_list_items (
       pick_list_id, line_number, product_sku, quantity_required, quantity_picked, status, item_title, is_sandbox, is_custom
     ) VALUES ($1, 1, $2, $3, 0, 'PENDING', $4, false, false)`,
    [id, sku, quantity, reason]
  );
  await query(
    `INSERT INTO pick_list_notes (pick_list_id, note_text, is_flagged, created_by)
     VALUES ($1, $2, true, 'warehouse')`,
    [id, reason]
  );
  return { id, pick_list_number: created.rows[0].pick_list_number, by_hand: byHand };
}
