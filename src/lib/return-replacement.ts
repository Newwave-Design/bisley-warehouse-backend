/**
 * A replacement return puts the returned item back on To pick.
 * It is a warehouse pick only: the shop order was already fulfilled.
 */
import { query } from '../db/index.js';
import { rootMedusaOrderId } from './order-values.js';
import { scheduleStockHolds } from './stock-holds.js';

export interface OpenedReplacement {
  id: string;
  pick_list_number: string;
}

async function unusedNumber(preferred: string): Promise<string> {
  const taken = await query(`SELECT 1 FROM pick_lists WHERE pick_list_number = $1`, [preferred]);
  if (!taken.rows.length) return preferred;
  const suffix = Date.now().toString(36).slice(-4).toUpperCase();
  return `${preferred}${suffix}`.slice(0, 50);
}

async function unusedOrderId(root: string): Promise<string> {
  const preferred = `${root}-RT`.slice(0, 100);
  const taken = await query(`SELECT status FROM pick_lists WHERE medusa_order_id = $1`, [preferred]);
  if (!taken.rows.length) return preferred;
  const suffix = Date.now().toString(36).slice(-4).toUpperCase();
  return `${root}-RT${suffix}`.slice(0, 100);
}

/** Add the returned SKU to the open replacement for this order, creating that pick list when needed. */
export async function openReturnReplacement(sourcePickListId: string, sku: string): Promise<OpenedReplacement | null> {
  const productSku = sku.trim();
  if (!productSku || productSku.startsWith('extra-')) return null;

  const found = await query(`SELECT * FROM pick_lists WHERE id = $1`, [sourcePickListId]);
  const source = found.rows[0];
  if (!source) return null;

  const line = await query(
    `SELECT product_sku, colour_code, item_title, medusa_order_line_item_id, medusa_variant_id, medusa_product_id, is_sandbox
       FROM pick_list_items
      WHERE pick_list_id = $1 AND product_sku = $2 AND NOT COALESCE(is_archived, false)
      ORDER BY line_number
      LIMIT 1`,
    [sourcePickListId, productSku]
  );
  const item = line.rows[0];

  const open = await query(
    `SELECT id, pick_list_number, status
       FROM pick_lists
      WHERE parent_pick_list_id = $1 AND COALESCE(is_return, false) = true
        AND status IN ('PENDING', 'IN_PROGRESS', 'AWAITING_STOCK', 'CANCELLED')
      ORDER BY created_at DESC
      LIMIT 1`,
    [sourcePickListId]
  );
  let pickListId = open.rows[0]?.id as string | undefined;
  let pickListNumber = open.rows[0]?.pick_list_number as string | undefined;

  if (pickListId && open.rows[0].status === 'CANCELLED') {
    await query(
      `UPDATE pick_lists
          SET status = 'PENDING', is_archived = false, archived_at = NULL, is_return = true, updated_at = NOW()
        WHERE id = $1`,
      [pickListId]
    );
  }

  if (!pickListId) {
    const root = rootMedusaOrderId(String(source.medusa_order_id || ''));
    const medusaId = await unusedOrderId(root || String(source.medusa_order_id || sourcePickListId));
    pickListNumber = await unusedNumber(`${source.pick_list_number}-R`);
    const payment = source.payment_status || 'captured';
    const created = await query(
      `INSERT INTO pick_lists (
         medusa_order_id, pick_list_number, status, parent_pick_list_id,
         customer_name, customer_email, shipping_method_name, shipping_method_code, shipping_address,
         is_sandbox, is_return, payment_status, purchase_order_number, notes, created_at, updated_at
       ) VALUES (
         $1, $2, 'PENDING', $3,
         $4, $5, $6, $7, $8::jsonb,
         $9, true, $10, $11, $12, NOW(), NOW()
       ) RETURNING id, pick_list_number`,
      [
        medusaId,
        pickListNumber,
        sourcePickListId,
        source.customer_name,
        source.customer_email,
        source.shipping_method_name,
        source.shipping_method_code,
        JSON.stringify(source.shipping_address || {}),
        source.is_sandbox,
        payment,
        source.purchase_order_number || null,
        `Replacement for ${source.pick_list_number}`,
      ]
    );
    pickListId = created.rows[0].id;
    pickListNumber = created.rows[0].pick_list_number;
  }

  const already = await query(
    `SELECT id FROM pick_list_items
      WHERE pick_list_id = $1 AND product_sku = $2 AND NOT COALESCE(is_archived, false)
      LIMIT 1`,
    [pickListId, productSku]
  );
  if (!already.rows.length) {
    const nextLine = await query(
      `SELECT COALESCE(MAX(line_number), 0)::int + 1 AS line_number FROM pick_list_items WHERE pick_list_id = $1`,
      [pickListId]
    );
    await query(
      `INSERT INTO pick_list_items (
         pick_list_id, line_number, product_sku, colour_code, item_title, quantity_required, status, is_sandbox,
         medusa_order_line_item_id, medusa_variant_id, medusa_product_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 1, 'PENDING', $6, $7, $8, $9, NOW(), NOW())`,
      [
        pickListId,
        nextLine.rows[0].line_number,
        productSku,
        item?.colour_code || null,
        item?.item_title || null,
        item?.is_sandbox || source.is_sandbox || false,
        item?.medusa_order_line_item_id || null,
        item?.medusa_variant_id || null,
        item?.medusa_product_id || null,
      ]
    );
  }

  scheduleStockHolds();
  return { id: pickListId!, pick_list_number: pickListNumber! };
}

async function unpickedSkus(sku: string): Promise<string[]> {
  const productSku = sku.trim();
  if (!productSku) return [];
  const found = await query(
    `SELECT kit_components FROM wms_products
      WHERE variant_sku = $1 AND COALESCE(is_kit, false) = true
      ORDER BY is_archived
      LIMIT 1`,
    [productSku]
  );
  const parts = Array.isArray(found.rows[0]?.kit_components) ? found.rows[0].kit_components : [];
  const componentSkus = parts
    .map((part: { sku?: string }) => String(part?.sku || '').trim())
    .filter((partSku: string) => partSku && partSku !== productSku);
  return [productSku, ...componentSkus];
}

/** Drop an unpicked replacement line when its return is cancelled. A kit also drops its pieces. */
export async function releaseReturnReplacement(sourcePickListId: string, sku: string): Promise<void> {
  const skus = await unpickedSkus(sku);
  if (!skus.length) return;
  const lists = await query(
    `SELECT id FROM pick_lists
      WHERE parent_pick_list_id = $1 AND COALESCE(is_return, false) = true AND status NOT IN ('DISPATCHED', 'CANCELLED')`,
    [sourcePickListId]
  );
  for (const list of lists.rows) {
    for (const productSku of skus) {
      const line = await query(
        `SELECT id, quantity_picked FROM pick_list_items
          WHERE pick_list_id = $1 AND product_sku = $2 AND NOT COALESCE(is_archived, false)
          LIMIT 1`,
        [list.id, productSku]
      );
      const row = line.rows[0];
      if (!row || Number(row.quantity_picked) > 0) continue;
      const scans = await query(`SELECT 1 FROM pick_scans WHERE pick_list_item_id = $1 LIMIT 1`, [row.id]);
      if (scans.rows.length) continue;
      await query(`DELETE FROM pick_list_items WHERE id = $1`, [row.id]);
    }
    const left = await query(
      `SELECT 1 FROM pick_list_items WHERE pick_list_id = $1 AND NOT COALESCE(is_archived, false) LIMIT 1`,
      [list.id]
    );
    if (!left.rows.length) {
      await query(
        `UPDATE pick_lists
            SET status = 'CANCELLED', is_archived = true, archived_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [list.id]
      );
    }
  }
  scheduleStockHolds();
}
