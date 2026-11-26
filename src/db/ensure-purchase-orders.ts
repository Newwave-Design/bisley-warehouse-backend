import { query } from './index.js';

/**
 * Purchase orders: what we buy from suppliers (Bisley, packaging, anything else).
 * Separate from supplier_orders, which is the New Wave / Genero replenishment request.
 */
export async function ensurePurchaseOrders() {
  await query(`CREATE SEQUENCE IF NOT EXISTS purchase_order_number_seq START 1001`);
  await query(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      po_number TEXT NOT NULL UNIQUE,
      supplier_id UUID NOT NULL REFERENCES suppliers(id),
      status TEXT NOT NULL DEFAULT 'DRAFT',
      currency TEXT NOT NULL DEFAULT 'GBP',
      expected_date DATE,
      delivery_address TEXT,
      notes TEXT,
      created_by UUID,
      created_by_name TEXT,
      submitted_at TIMESTAMPTZ,
      approved_by UUID,
      approved_by_name TEXT,
      approved_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT purchase_orders_status_check CHECK (status IN
        ('DRAFT','AWAITING_APPROVAL','APPROVED','SENT','PART_RECEIVED','RECEIVED','CLOSED','CANCELLED'))
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS purchase_order_lines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      line_number INT NOT NULL,
      product_sku TEXT NOT NULL,
      description TEXT,
      quantity_ordered INT NOT NULL CHECK (quantity_ordered > 0),
      quantity_received INT NOT NULL DEFAULT 0,
      unit_price NUMERIC(12,4) NOT NULL CHECK (unit_price >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (purchase_order_id, line_number)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS purchase_order_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      actor TEXT,
      action TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS purchase_orders_status_idx ON purchase_orders (status)`);
  await query(`CREATE INDEX IF NOT EXISTS purchase_order_lines_sku_idx ON purchase_order_lines (product_sku)`);
  await query(`CREATE INDEX IF NOT EXISTS purchase_order_events_po_idx ON purchase_order_events (purchase_order_id, created_at DESC)`);
}
