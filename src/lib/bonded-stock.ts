/**
 * Bonded stock: the stock that came in on the two starting orders (OV010-504108 and OV010-504206).
 *
 * The system counts stock per SKU and bay, not per order, so it cannot say which units came from which order.
 * This list says how many units of each SKU are bonded. What counts as bonded on the shelf is the smaller of the units
 * on hand and the units listed, so the figure falls as the bonded stock sells down.
 *
 * It is seeded once from the two orders' lines, then it is an ordinary list that can be edited
 * (GET / POST /api/reports/bonded-stock). A later restart never overwrites an edit.
 */
import { query } from '../db/index.js';

export const STARTING_ORDERS = ['OV010-504108', 'OV010-504206'];
const SEEDED_KEY = 'bonded_stock_seeded';

let ready: Promise<void> | null = null;

/** Only SKUs on the starting orders can be bonded, and no more than was ordered. Keyed by upper-case SKU. */
export async function bondableUnits(): Promise<Map<string, { sku: string; max: number }>> {
  const found = await query(
    `SELECT i.product_sku AS sku, SUM(i.quantity_ordered)::int AS ordered
       FROM supplier_order_items i
       JOIN supplier_orders o ON o.id = i.supplier_order_id
      WHERE o.order_number = ANY($1::text[]) AND COALESCE(i.product_sku, '') <> ''
      GROUP BY i.product_sku`,
    [STARTING_ORDERS],
  );
  return new Map((found.rows as { sku: string; ordered: number }[]).map((row) => [row.sku.toUpperCase(), { sku: row.sku, max: row.ordered }]));
}

export function ensureBondedStock(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS bonded_stock (
          product_sku VARCHAR(120) PRIMARY KEY,
          units INTEGER NOT NULL CHECK (units >= 0),
          source VARCHAR(200),
          updated_by VARCHAR(255),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      const done = await query(`SELECT 1 FROM wms_settings WHERE key = $1`, [SEEDED_KEY]);
      if (done.rows.length) return;
      // One transaction-free pass: the insert is idempotent (ON CONFLICT DO NOTHING) and the flag is written after it.
      await query(
        `INSERT INTO bonded_stock (product_sku, units, source)
         SELECT i.product_sku, SUM(i.quantity_ordered)::int, $2
           FROM supplier_order_items i
           JOIN supplier_orders o ON o.id = i.supplier_order_id
          WHERE o.order_number = ANY($1::text[])
            AND COALESCE(i.product_sku, '') <> ''
          GROUP BY i.product_sku
         HAVING SUM(i.quantity_ordered) > 0
         ON CONFLICT (product_sku) DO NOTHING`,
        [STARTING_ORDERS, `Starting orders ${STARTING_ORDERS.join(' and ')}`],
      );
      await query(
        `INSERT INTO wms_settings (key, value) VALUES ($1, 'yes') ON CONFLICT (key) DO NOTHING`,
        [SEEDED_KEY],
      );
    })().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}
