/**
 * Warehouse Database Schema
 * PostgreSQL migration for warehouse management system
 */

export const WAREHOUSE_SCHEMA = `
-- ================================================================================
-- WAREHOUSE LOCATIONS (Bays and Bins)
-- ================================================================================
CREATE TABLE IF NOT EXISTS warehouse_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bay_code VARCHAR(10) NOT NULL,
  bin_code VARCHAR(10) NOT NULL,
  location_code VARCHAR(20) NOT NULL UNIQUE,
  description TEXT,
  max_weight_kg DECIMAL(8,2),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_bay_bin UNIQUE(bay_code, bin_code)
);

-- ================================================================================
-- BARCODE MAPPINGS (Supercode / SKU+Colour lookups)
-- ================================================================================
CREATE TABLE IF NOT EXISTS barcode_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  barcode VARCHAR(100) NOT NULL UNIQUE,
  product_sku VARCHAR(50) NOT NULL,
  colour_code VARCHAR(20),
  colour_name VARCHAR(100),
  product_name VARCHAR(255),
  medusa_product_id VARCHAR(100),
  medusa_variant_id VARCHAR(100),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ================================================================================
-- WAREHOUSE INVENTORY (Current stock levels by location)
-- ================================================================================
CREATE TABLE IF NOT EXISTS warehouse_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES warehouse_locations(id),
  product_sku VARCHAR(50) NOT NULL,
  colour_code VARCHAR(20),
  quantity INT NOT NULL DEFAULT 0,
  quantity_reserved INT NOT NULL DEFAULT 0,
  quantity_available INT GENERATED ALWAYS AS (quantity - quantity_reserved) STORED,
  last_counted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_location_sku_colour UNIQUE(location_id, product_sku, colour_code)
);

-- ================================================================================
-- WAREHOUSE MOVEMENTS (Audit trail: receives, picks, adjustments)
-- ================================================================================
CREATE TABLE IF NOT EXISTS warehouse_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_type VARCHAR(50) NOT NULL,
  -- Types: RECEIVE, PICK, RETURN, ADJUST, RECOUNT
  location_id UUID REFERENCES warehouse_locations(id),
  product_sku VARCHAR(50) NOT NULL,
  colour_code VARCHAR(20),
  quantity INT NOT NULL,
  notes TEXT,
  performed_by UUID NOT NULL,
  -- References warehouse_users.id
  order_id VARCHAR(100),
  -- Optional: ties to Medusa order or Genero replenishment request
  movement_date TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

-- ================================================================================
-- PICK LISTS (Orders to be picked from warehouse)
-- ================================================================================
CREATE TABLE IF NOT EXISTS pick_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  medusa_order_id VARCHAR(100) NOT NULL UNIQUE,
  pick_list_number VARCHAR(50) NOT NULL UNIQUE,
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  -- Statuses: PENDING, IN_PROGRESS, PICKED, PACKED, SHIPPED, CANCELLED
  created_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  picked_by UUID REFERENCES warehouse_locations(id),
  notes TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ================================================================================
-- PICK LIST ITEMS (Individual line items in a pick list)
-- ================================================================================
CREATE TABLE IF NOT EXISTS pick_list_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pick_list_id UUID NOT NULL REFERENCES pick_lists(id) ON DELETE CASCADE,
  line_number INT NOT NULL,
  product_sku VARCHAR(50) NOT NULL,
  colour_code VARCHAR(20),
  quantity_required INT NOT NULL,
  quantity_picked INT DEFAULT 0,
  picked_from_location_id UUID REFERENCES warehouse_locations(id),
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  -- Statuses: PENDING, PICKING, PICKED, SHORT
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_line_per_picklist UNIQUE(pick_list_id, line_number)
);

-- ================================================================================
-- WAREHOUSE USERS (Staff with warehouse access)
-- ================================================================================
CREATE TABLE IF NOT EXISTS warehouse_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  medusa_user_id VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  role VARCHAR(50) NOT NULL DEFAULT 'PICKER',
  -- Roles: ADMIN, MANAGER, PICKER, RECEIVER
  is_active BOOLEAN DEFAULT true,
  last_login_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ================================================================================
-- SUPPLIER ORDERS / REPLENISHMENT REQUESTS (Integration with Genero)
-- ================================================================================
CREATE TABLE IF NOT EXISTS supplier_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number VARCHAR(100) NOT NULL UNIQUE,
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  -- Statuses: PENDING, SUBMITTED_TO_GENERO, ACKNOWLEDGED, IN_PRODUCTION, READY_TO_RECEIVE, RECEIVED, CANCELLED
  colour_palette VARCHAR(20),
  -- Palette 1 or Palette 2
  triggered_by UUID,
  -- References warehouse_users.id
  created_at TIMESTAMP DEFAULT NOW(),
  submitted_at TIMESTAMP,
  expected_delivery_date DATE,
  received_date DATE,
  notes TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ================================================================================
-- SUPPLIER ORDER ITEMS (SKU quantities in a replenishment request)
-- ================================================================================
CREATE TABLE IF NOT EXISTS supplier_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_order_id UUID NOT NULL REFERENCES supplier_orders(id) ON DELETE CASCADE,
  product_sku VARCHAR(50) NOT NULL,
  colour_code VARCHAR(20),
  quantity_ordered INT NOT NULL,
  quantity_received INT DEFAULT 0,
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  -- Statuses: PENDING, PARTIAL, COMPLETE
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ================================================================================
-- AUDIT LOG (Security/compliance: who did what when)
-- ================================================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action VARCHAR(255) NOT NULL,
  entity_type VARCHAR(50),
  entity_id VARCHAR(100),
  user_id UUID REFERENCES warehouse_users(id),
  old_values JSONB,
  new_values JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ================================================================================
-- INDEXES (Performance optimization)
-- ================================================================================
CREATE INDEX IF NOT EXISTS idx_barcode_sku ON barcode_mappings(product_sku);
CREATE INDEX IF NOT EXISTS idx_barcode_active ON barcode_mappings(is_active);
CREATE INDEX IF NOT EXISTS idx_inventory_location ON warehouse_inventory(location_id);
CREATE INDEX IF NOT EXISTS idx_inventory_sku ON warehouse_inventory(product_sku);
CREATE INDEX IF NOT EXISTS idx_movements_location ON warehouse_movements(location_id);
CREATE INDEX IF NOT EXISTS idx_movements_sku ON warehouse_movements(product_sku);
CREATE INDEX IF NOT EXISTS idx_movements_date ON warehouse_movements(movement_date);
CREATE INDEX IF NOT EXISTS idx_pick_lists_status ON pick_lists(status);
CREATE INDEX IF NOT EXISTS idx_pick_lists_medusa_id ON pick_lists(medusa_order_id);
CREATE INDEX IF NOT EXISTS idx_pick_items_status ON pick_list_items(status);
CREATE INDEX IF NOT EXISTS idx_supplier_orders_status ON supplier_orders(status);
CREATE INDEX IF NOT EXISTS idx_supplier_orders_palette ON supplier_orders(colour_palette);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`;
