/**
 * Who currently holds a SKU, and the one-unit move onto a return replacement.
 */
import { query } from '../db/index.js';
import { ensureStockHolds } from './stock-holds.js';

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'To pick',
  IN_PROGRESS: 'Picking',
  PICKED: 'Picked',
  PACKING: 'Packing',
  PACKED: 'Packed',
  LABEL_PRINTED: 'Label printed',
  DISPATCHED: 'Shipped',
  AWAITING_STOCK: 'Awaiting stock',
  CANCELLED: 'Cancelled',
};

function orderNumber(pickListNumber: string): string {
  const match = String(pickListNumber || '').match(/^PL-\d{8}-(\d+)/i);
  return match ? `#${parseInt(match[1], 10)}` : '';
}

function addressLines(address: any, name?: string): string[] {
  const value = address && typeof address === 'object' ? address : {};
  return [name, value.company, value.address_1, value.address_2, [value.city, value.postal_code].filter(Boolean).join(' '), value.phone]
    .map((line) => String(line || '').trim())
    .filter(Boolean);
}

export async function stockReservations(pickListId: string) {
  await ensureStockHolds();
  const items = await query(
    `SELECT pli.id, pli.product_sku, pli.item_title, pli.quantity_required, pli.quantity_picked,
            COALESCE(wp.product_title, pli.item_title) AS title,
            COALESCE((SELECT SUM(quantity) FROM warehouse_inventory WHERE product_sku = pli.product_sku), 0)::int AS on_hand,
            COALESCE((SELECT qty FROM order_stock_holds WHERE pick_list_item_id = pli.id AND sku = pli.product_sku), 0)::int AS held_here
       FROM pick_list_items pli
       LEFT JOIN LATERAL (
         SELECT product_title FROM wms_products WHERE variant_sku = pli.product_sku ORDER BY is_archived LIMIT 1
       ) wp ON true
      WHERE pli.pick_list_id = $1 AND NOT COALESCE(pli.is_archived, false)
      ORDER BY pli.line_number`,
    [pickListId]
  );

  const skus = [...new Set(items.rows.map((row: any) => row.product_sku).filter(Boolean))];
  const others = skus.length
    ? await query(
      `SELECT h.pick_list_item_id, h.sku, h.qty,
              pli.quantity_picked, pli.quantity_required,
              pl.id AS pick_list_id, pl.pick_list_number, pl.customer_name, pl.customer_email,
              pl.shipping_address, pl.status, pl.created_at
         FROM order_stock_holds h
         JOIN pick_list_items pli ON pli.id = h.pick_list_item_id
         JOIN pick_lists pl ON pl.id = pli.pick_list_id
        WHERE h.sku = ANY($1::text[])
          AND pl.id <> $2
          AND pl.status NOT IN ('DISPATCHED', 'CANCELLED')
          AND NOT pl.is_archived
        ORDER BY pl.created_at, pl.pick_list_number`,
      [skus, pickListId]
    )
    : { rows: [] as any[] };

  return {
    items: items.rows.map((item: any) => {
      const required = Number(item.quantity_required) || 0;
      const picked = Number(item.quantity_picked) || 0;
      const heldHere = Number(item.held_here) || 0;
      const stillNeed = Math.max(0, required - picked - heldHere);
      const reserved = others.rows
        .filter((row: any) => row.sku === item.product_sku)
        .map((row: any) => {
          const reservedQty = Number(row.qty) || 0;
          const donorPicked = Number(row.quantity_picked) || 0;
          const stealable = Math.max(0, reservedQty - donorPicked);
          return {
            item_id: row.pick_list_item_id,
            pick_list_id: row.pick_list_id,
            pick_list_number: row.pick_list_number,
            order_number: orderNumber(row.pick_list_number),
            customer_name: row.customer_name || 'No customer name',
            email: row.customer_email || '',
            status: row.status,
            status_label: STATUS_LABELS[row.status] || row.status,
            ordered_at: row.created_at,
            qty_reserved: reservedQty,
            qty_picked: donorPicked,
            can_take: stillNeed > 0 && stealable > 0,
            address_lines: addressLines(row.shipping_address),
          };
        })
        .filter((row: { qty_reserved: number; qty_picked: number }) => row.qty_reserved > row.qty_picked);
      return {
        item_id: item.id,
        sku: item.product_sku,
        title: item.title || item.product_sku,
        quantity_required: required,
        quantity_picked: picked,
        on_hand: Number(item.on_hand) || 0,
        held_here: heldHere,
        reserved_by: reserved,
      };
    }),
  };
}

export async function takeReservedItem(pickListId: string, fromItemId: string, sku: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const productSku = sku.trim();
  if (!/^[0-9a-f-]{36}$/i.test(fromItemId) || !productSku) {
    return { ok: false, error: 'Choose the order to take this item from.' };
  }
  const list = await query(
    `SELECT is_return, status FROM pick_lists WHERE id = $1`,
    [pickListId]
  );
  const header = list.rows[0];
  if (!header?.is_return) return { ok: false, error: 'Stock can only be taken onto a return replacement.' };
  if (['DISPATCHED', 'CANCELLED'].includes(header.status)) {
    return { ok: false, error: 'This return is no longer on the pick list.' };
  }

  const target = await query(
    `SELECT id, quantity_required, quantity_picked
       FROM pick_list_items
      WHERE pick_list_id = $1 AND product_sku = $2 AND NOT COALESCE(is_archived, false)
      LIMIT 1`,
    [pickListId, productSku]
  );
  const line = target.rows[0];
  if (!line) return { ok: false, error: 'That item is not on this return.' };
  if (Number(line.quantity_picked) >= Number(line.quantity_required)) {
    return { ok: false, error: 'This return has already been picked.' };
  }

  const donor = await query(
    `SELECT pli.id, pli.pick_list_id, pli.quantity_picked
       FROM pick_list_items pli
       JOIN pick_lists pl ON pl.id = pli.pick_list_id
      WHERE pli.id = $1 AND pl.status NOT IN ('DISPATCHED', 'CANCELLED')`,
    [fromItemId]
  );
  if (!donor.rows[0] || donor.rows[0].pick_list_id === pickListId) {
    return { ok: false, error: 'That order no longer has this item.' };
  }

  await ensureStockHolds(true);
  const before = await query(
    `SELECT COALESCE((SELECT qty FROM order_stock_holds WHERE pick_list_item_id = $1 AND sku = $2), 0)::int AS qty`,
    [line.id, productSku]
  );
  const beforeQty = Number(before.rows[0]?.qty) || 0;
  if (beforeQty >= Number(line.quantity_required)) {
    return { ok: false, error: 'This return already has this item reserved.' };
  }
  const donorHold = await query(
    `SELECT qty FROM order_stock_holds WHERE pick_list_item_id = $1 AND sku = $2`,
    [fromItemId, productSku]
  );
  const stealable = Math.max(0, (Number(donorHold.rows[0]?.qty) || 0) - (Number(donor.rows[0].quantity_picked) || 0));
  if (stealable <= 0) return { ok: false, error: 'That order no longer has this item reserved.' };

  await query(
    `INSERT INTO stock_preempts (pick_list_item_id, from_pick_list_item_id, sku, qty)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (pick_list_item_id, from_pick_list_item_id, sku)
     DO UPDATE SET qty = stock_preempts.qty + 1`,
    [line.id, fromItemId, productSku]
  );
  await ensureStockHolds(true);
  const after = await query(
    `SELECT COALESCE((SELECT qty FROM order_stock_holds WHERE pick_list_item_id = $1 AND sku = $2), 0)::int AS qty`,
    [line.id, productSku]
  );
  if ((Number(after.rows[0]?.qty) || 0) <= beforeQty) {
    await query(
      `UPDATE stock_preempts
          SET qty = qty - 1
        WHERE pick_list_item_id = $1 AND from_pick_list_item_id = $2 AND sku = $3`,
      [line.id, fromItemId, productSku]
    );
    await query(
      `DELETE FROM stock_preempts
        WHERE pick_list_item_id = $1 AND from_pick_list_item_id = $2 AND sku = $3 AND qty <= 0`,
      [line.id, fromItemId, productSku]
    );
    return { ok: false, error: 'That item could not be taken. It may already have been picked.' };
  }
  return { ok: true };
}
