import { query } from './index.js';

/**
 * Packaging inventory + shipping rate cards.
 * WMS is the master; SmartSuite snapshot is a one-time seed (see scripts/import-packaging-snapshot.mjs).
 * extra JSONB on each row is for bot-maintained fields without a schema change.
 */
export async function ensurePackagingSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS packaging_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      item_type VARCHAR(30) NOT NULL,
      code VARCHAR(50) NOT NULL UNIQUE,
      name VARCHAR(255),
      internal_length_mm INTEGER,
      internal_width_mm INTEGER,
      internal_height_mm INTEGER,
      external_length_mm INTEGER,
      external_width_mm INTEGER,
      external_height_mm INTEGER,
      length_mm INTEGER,
      thickness_mm INTEGER,
      gap_mm INTEGER,
      tare_weight_grams INTEGER,
      unit_cost_gbp DECIMAL(10,2),
      supplier_id UUID,
      supplier_name VARCHAR(100),
      supplier_code VARCHAR(50),
      pack_size INTEGER DEFAULT 1,
      stock_on_hand INTEGER NOT NULL DEFAULT 0,
      reorder_level INTEGER,
      reorder_qty INTEGER,
      stocked BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      location_id UUID,
      smartsuite_id VARCHAR(40) UNIQUE,
      smartsuite_table VARCHAR(40),
      notes TEXT,
      extra JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_packaging_items_type ON packaging_items(item_type, is_active)`,
    `CREATE INDEX IF NOT EXISTS idx_packaging_items_stocked ON packaging_items(stocked) WHERE is_active`,

    `CREATE TABLE IF NOT EXISTS packaging_sleeve_sets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      label VARCHAR(80) NOT NULL UNIQUE,
      packed_length_mm INTEGER,
      packed_width_mm INTEGER,
      packed_height_mm INTEGER,
      tray_item_id UUID REFERENCES packaging_items(id),
      sleeve_item_id UUID REFERENCES packaging_items(id),
      edge_guard_item_id UUID REFERENCES packaging_items(id),
      stocked BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      smartsuite_id VARCHAR(40) UNIQUE,
      notes TEXT,
      extra JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS packaging_product_specs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_code VARCHAR(50) NOT NULL UNIQUE,
      product_title VARCHAR(255),
      product_range VARCHAR(100),
      length_mm INTEGER,
      width_mm INTEGER,
      height_mm INTEGER,
      length_packed_mm INTEGER,
      width_packed_mm INTEGER,
      height_packed_mm INTEGER,
      packed_dims_checked BOOLEAN NOT NULL DEFAULT false,
      weight_grams INTEGER,
      method VARCHAR(30) NOT NULL DEFAULT 'needs_packaging',
      stocked BOOLEAN NOT NULL DEFAULT false,
      listed BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      units_per_month DECIMAL(8,2),
      smartsuite_id VARCHAR(40) UNIQUE,
      notes TEXT,
      extra JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_packaging_specs_method ON packaging_product_specs(method, is_active)`,

    `CREATE TABLE IF NOT EXISTS packaging_boms (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_code VARCHAR(50),
      sku VARCHAR(100),
      method VARCHAR(30) NOT NULL,
      option_rank INTEGER NOT NULL DEFAULT 1,
      label VARCHAR(100),
      parcels INTEGER NOT NULL DEFAULT 1,
      is_active BOOLEAN NOT NULL DEFAULT true,
      source VARCHAR(30) DEFAULT 'manual',
      notes TEXT,
      extra JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT packaging_bom_target CHECK (
        (product_code IS NOT NULL AND sku IS NULL) OR (product_code IS NULL AND sku IS NOT NULL)
      )
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_packaging_bom_product_rank
      ON packaging_boms (product_code, option_rank) WHERE sku IS NULL AND is_active`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_packaging_bom_sku_rank
      ON packaging_boms (sku, option_rank) WHERE sku IS NOT NULL AND is_active`,

    `CREATE TABLE IF NOT EXISTS packaging_bom_lines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      bom_id UUID NOT NULL REFERENCES packaging_boms(id) ON DELETE CASCADE,
      packaging_item_id UUID NOT NULL REFERENCES packaging_items(id),
      qty DECIMAL(8,2) NOT NULL DEFAULT 1,
      qty_confirmed BOOLEAN NOT NULL DEFAULT true,
      notes TEXT,
      extra JSONB NOT NULL DEFAULT '{}'::jsonb
    )`,

    `CREATE TABLE IF NOT EXISTS packaging_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      from_kind VARCHAR(30) NOT NULL,
      from_key VARCHAR(120) NOT NULL,
      to_kind VARCHAR(30) NOT NULL,
      to_key VARCHAR(120) NOT NULL,
      role VARCHAR(40) NOT NULL DEFAULT 'uses',
      extra JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_packaging_links_unique
      ON packaging_links (from_kind, from_key, to_kind, to_key, role)`,

    `CREATE TABLE IF NOT EXISTS packaging_stock_movements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      packaging_item_id UUID NOT NULL REFERENCES packaging_items(id),
      movement_type VARCHAR(20) NOT NULL,
      qty INTEGER NOT NULL,
      unit_cost_gbp DECIMAL(10,2),
      pick_list_id UUID,
      pick_list_package_id UUID,
      supplier_order_ref VARCHAR(100),
      reason TEXT,
      created_by UUID,
      extra JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_pkg_moves_item ON packaging_stock_movements(packaging_item_id, created_at DESC)`,

    `CREATE TABLE IF NOT EXISTS pick_list_package_packaging (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      pick_list_package_id UUID NOT NULL REFERENCES pick_list_packages(id) ON DELETE CASCADE,
      packaging_item_id UUID NOT NULL REFERENCES packaging_items(id),
      qty DECIMAL(8,2) NOT NULL,
      bom_id UUID REFERENCES packaging_boms(id),
      was_free_choice BOOLEAN NOT NULL DEFAULT false,
      stock_movement_id UUID REFERENCES packaging_stock_movements(id),
      created_by UUID,
      extra JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS shipping_rate_cards (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      courier_code VARCHAR(50) NOT NULL,
      service_code VARCHAR(80) NOT NULL,
      name VARCHAR(255) NOT NULL,
      currency VARCHAR(10) NOT NULL DEFAULT 'GBP',
      effective_from DATE,
      effective_to DATE,
      is_active BOOLEAN NOT NULL DEFAULT true,
      notes TEXT,
      extra JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_rate_cards_service ON shipping_rate_cards(service_code, is_active)`,

    `CREATE TABLE IF NOT EXISTS shipping_rate_rows (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      card_id UUID NOT NULL REFERENCES shipping_rate_cards(id) ON DELETE CASCADE,
      zone VARCHAR(20) NOT NULL,
      min_kg DECIMAL(8,2) NOT NULL DEFAULT 0,
      max_kg DECIMAL(8,2),
      amount_gbp DECIMAL(10,2) NOT NULL DEFAULT 0,
      per_kg_gbp DECIMAL(10,3) NOT NULL DEFAULT 0,
      parcel_index INTEGER NOT NULL DEFAULT 1,
      extra JSONB NOT NULL DEFAULT '{}'::jsonb
    )`,
    `CREATE INDEX IF NOT EXISTS idx_rate_rows_card ON shipping_rate_rows(card_id, zone)`,

    `CREATE TABLE IF NOT EXISTS shipping_rate_surcharges (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      card_id UUID NOT NULL REFERENCES shipping_rate_cards(id) ON DELETE CASCADE,
      surcharge_type VARCHAR(40) NOT NULL,
      min_value DECIMAL(10,2),
      max_value DECIMAL(10,2),
      amount_gbp DECIMAL(10,2) NOT NULL DEFAULT 0,
      extra JSONB NOT NULL DEFAULT '{}'::jsonb
    )`,

    `CREATE TABLE IF NOT EXISTS packaging_field_defs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity VARCHAR(30) NOT NULL,
      field_key VARCHAR(80) NOT NULL,
      label VARCHAR(120),
      data_type VARCHAR(20) NOT NULL DEFAULT 'text',
      extra JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (entity, field_key)
    )`,
  ];

  for (const sql of statements) {
    await query(sql);
  }
}
