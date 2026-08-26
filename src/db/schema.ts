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
-- REQUIRES LOCATION QUEUE (Phase 5: Items checked in, awaiting bay assignment)
-- ================================================================================
CREATE TABLE IF NOT EXISTS requires_location_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES checkin_sessions(id) ON DELETE SET NULL,
  order_id UUID REFERENCES supplier_orders(id) ON DELETE SET NULL,
  nw_code VARCHAR NOT NULL,
  colour VARCHAR,
  medusa_sku VARCHAR,
  quantity INT NOT NULL DEFAULT 0,
  location_id UUID REFERENCES warehouse_locations(id) ON DELETE SET NULL,
  status TEXT CHECK (status IN ('PENDING', 'ASSIGNED', 'STOCKED')) DEFAULT 'PENDING',
  assigned_by VARCHAR,
  assigned_at TIMESTAMP,
  stocked_at TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ================================================================================
-- CHECKIN SESSIONS (Phase 3: Receiving sessions when stock arrives)
-- ================================================================================
CREATE TABLE IF NOT EXISTS checkin_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES supplier_orders(id) ON DELETE SET NULL,
  status TEXT CHECK (status IN ('OPEN', 'COMPARING', 'COMPLETE')) DEFAULT 'OPEN',
  started_by VARCHAR,
  notes TEXT,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ================================================================================
-- CHECKIN ITEMS (Phase 3: Items scanned during a check-in session)
-- ================================================================================
CREATE TABLE IF NOT EXISTS checkin_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES checkin_sessions(id) ON DELETE CASCADE,
  nw_code VARCHAR NOT NULL,
  colour VARCHAR,
  medusa_sku VARCHAR,
  quantity_scanned INT NOT NULL DEFAULT 1,
  notes TEXT,
  scanned_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

-- ================================================================================
-- CHECKIN DISCREPANCIES (Phase 3: Auto-flagged mismatches vs order)
-- ================================================================================
CREATE TABLE IF NOT EXISTS checkin_discrepancies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES checkin_sessions(id) ON DELETE CASCADE,
  order_id UUID REFERENCES supplier_orders(id) ON DELETE SET NULL,
  nw_code VARCHAR NOT NULL,
  colour VARCHAR,
  medusa_sku VARCHAR,
  quantity_ordered INT NOT NULL DEFAULT 0,
  quantity_received INT NOT NULL DEFAULT 0,
  discrepancy_type TEXT CHECK (discrepancy_type IN ('SHORT', 'OVERAGE', 'MISSING', 'UNEXPECTED')) NOT NULL,
  status TEXT CHECK (status IN ('FLAGGED', 'ACCEPTED', 'RESOLVED')) DEFAULT 'FLAGGED',
  resolution_notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ================================================================================
-- SUPPLIER ORDERS (Phase 2: Purchase orders sent to NW/Genero)
-- ================================================================================
CREATE TABLE IF NOT EXISTS supplier_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number VARCHAR(50) NOT NULL UNIQUE,
  status TEXT CHECK (status IN ('DRAFT', 'SUBMITTED', 'ACKNOWLEDGED', 'DISPATCHED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED')) DEFAULT 'DRAFT',
  supplier VARCHAR(100) DEFAULT 'New Wave',
  notes TEXT,
  expected_delivery DATE,
  submitted_at TIMESTAMP,
  dispatched_at TIMESTAMP,
  received_at TIMESTAMP,
  genero_dispatch_ref VARCHAR(100),
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ================================================================================
-- ORDER LINE ITEMS (Phase 2: Individual products within a supplier order)
-- ================================================================================
CREATE TABLE IF NOT EXISTS order_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES supplier_orders(id) ON DELETE CASCADE,
  nw_code VARCHAR NOT NULL,
  medusa_sku VARCHAR,
  product_name VARCHAR,
  family VARCHAR,
  colour VARCHAR,
  quantity_ordered INT NOT NULL DEFAULT 0,
  quantity_received INT NOT NULL DEFAULT 0,
  unit_cost DECIMAL(10,2),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ================================================================================
-- INVENTORY THRESHOLDS (Phase 2: Reorder trigger levels per NW code + colour)
-- ================================================================================
CREATE TABLE IF NOT EXISTS inventory_thresholds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nw_code VARCHAR NOT NULL,
  colour VARCHAR,
  min_quantity INT NOT NULL DEFAULT 0,
  reorder_quantity INT NOT NULL DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(nw_code, colour)
);

-- ================================================================================
-- GENERO DISPATCH NOTES (Phase 2: Incoming dispatch notifications from Genero)
-- ================================================================================
CREATE TABLE IF NOT EXISTS genero_dispatch_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_ref VARCHAR(100) NOT NULL UNIQUE,
  order_id UUID REFERENCES supplier_orders(id) ON DELETE SET NULL,
  dispatch_date DATE,
  expected_delivery DATE,
  carrier VARCHAR(100),
  tracking_number VARCHAR(100),
  raw_payload JSONB,
  processed BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ================================================================================
-- SKU MAPPINGS (Phase 1: NW codes to Medusa SKUs and Genero codes)
-- ================================================================================
CREATE TABLE IF NOT EXISTS sku_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nw_code VARCHAR UNIQUE NOT NULL,
  medusa_sku VARCHAR,
  genero_code VARCHAR,
  product_name VARCHAR,
  family VARCHAR,
  colour VARCHAR,
  status TEXT CHECK (status IN ('UNMAPPED', 'ASSUMED', 'VALIDATED', 'REJECTED')) DEFAULT 'UNMAPPED',
  notes TEXT,
  mapped_by VARCHAR,
  mapped_at TIMESTAMP,
  confidence FLOAT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ================================================================================
-- NW STOCKING ITEMS (Phase 1: Inventory items from NW stocking programme)
-- ================================================================================
CREATE TABLE IF NOT EXISTS nw_stocking_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nw_code VARCHAR NOT NULL,
  description VARCHAR,
  family VARCHAR,
  colour VARCHAR,
  quantity_ordered INT,
  unit_cost DECIMAL(10,2),
  mapping_id UUID REFERENCES sku_mappings(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ================================================================================
-- INDEXES (Performance optimization)
-- ================================================================================
CREATE INDEX IF NOT EXISTS idx_barcode_sku ON barcode_mappings(product_sku);
CREATE INDEX IF NOT EXISTS idx_barcode_active ON barcode_mappings(is_active);
CREATE INDEX IF NOT EXISTS idx_sku_mappings_nw_code ON sku_mappings(nw_code);
CREATE INDEX IF NOT EXISTS idx_sku_mappings_status ON sku_mappings(status);
CREATE INDEX IF NOT EXISTS idx_sku_mappings_family ON sku_mappings(family);
CREATE INDEX IF NOT EXISTS idx_nw_stocking_nw_code ON nw_stocking_items(nw_code);
CREATE INDEX IF NOT EXISTS idx_nw_stocking_mapping_id ON nw_stocking_items(mapping_id);
CREATE INDEX IF NOT EXISTS idx_nw_stocking_family ON nw_stocking_items(family);
CREATE INDEX IF NOT EXISTS idx_inventory_location ON warehouse_inventory(location_id);
CREATE INDEX IF NOT EXISTS idx_inventory_sku ON warehouse_inventory(product_sku);
CREATE INDEX IF NOT EXISTS idx_movements_location ON warehouse_movements(location_id);
CREATE INDEX IF NOT EXISTS idx_movements_sku ON warehouse_movements(product_sku);
CREATE INDEX IF NOT EXISTS idx_movements_date ON warehouse_movements(movement_date);
CREATE INDEX IF NOT EXISTS idx_pick_lists_status ON pick_lists(status);
CREATE INDEX IF NOT EXISTS idx_pick_lists_medusa_id ON pick_lists(medusa_order_id);
CREATE INDEX IF NOT EXISTS idx_pick_items_status ON pick_list_items(status);
CREATE INDEX IF NOT EXISTS idx_supplier_orders_status ON supplier_orders(status);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_line_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_nw_code ON order_line_items(nw_code);
CREATE INDEX IF NOT EXISTS idx_thresholds_nw_code ON inventory_thresholds(nw_code);
CREATE INDEX IF NOT EXISTS idx_dispatch_notes_order ON genero_dispatch_notes(order_id);
CREATE INDEX IF NOT EXISTS idx_checkin_sessions_order ON checkin_sessions(order_id);
CREATE INDEX IF NOT EXISTS idx_checkin_sessions_status ON checkin_sessions(status);
CREATE INDEX IF NOT EXISTS idx_checkin_items_session ON checkin_items(session_id);
CREATE INDEX IF NOT EXISTS idx_checkin_discrepancies_session ON checkin_discrepancies(session_id);
CREATE INDEX IF NOT EXISTS idx_requires_location_session ON requires_location_queue(session_id);
CREATE INDEX IF NOT EXISTS idx_requires_location_status ON requires_location_queue(status);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- ================================================================================
-- FIELD MAPPINGS (Medusa → WMS and WMS → Genero field configuration)
-- ================================================================================
CREATE TABLE IF NOT EXISTS field_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mapping_direction VARCHAR(20) NOT NULL CHECK (mapping_direction IN ('MEDUSA_TO_WMS', 'WMS_TO_GENERO')),
  source_field VARCHAR(100) NOT NULL,
  source_label VARCHAR(200) NOT NULL,
  target_field VARCHAR(100),
  target_label VARCHAR(200),
  transform VARCHAR(500),
  notes TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_direction_source UNIQUE(mapping_direction, source_field)
);

-- Seed default Medusa → WMS field mappings (idempotent)
INSERT INTO field_mappings (mapping_direction, source_field, source_label, target_field, target_label, notes) VALUES
  ('MEDUSA_TO_WMS', 'variant.sku',                   'Variant SKU',            'sku_mappings.medusa_sku',            'Medusa SKU',          'Primary identifier for matching variants to WMS records'),
  ('MEDUSA_TO_WMS', 'product.title',                 'Product Title',          'sku_mappings.product_name',          'Product Name',        'Human-readable product name shown in WMS'),
  ('MEDUSA_TO_WMS', 'product.handle',                'URL Handle',             'sku_mappings.handle',                'Handle',              'Medusa URL slug — used for deep-linking to storefront'),
  ('MEDUSA_TO_WMS', 'variant.title',                 'Variant Title',          'sku_mappings.colour',                'Colour Label',        'Option label on the variant e.g. "Bisley Blue"'),
  ('MEDUSA_TO_WMS', 'variant.thumbnail',             'Thumbnail URL',          'barcode_mappings.image_url',         'Image URL',           'S3/CDN URL for variant swatch image'),
  ('MEDUSA_TO_WMS', 'variant.manage_inventory',      'Manage Inventory',       'warehouse_inventory.tracked',        'Track Stock',         'When true the WMS tracks physical stock for this variant'),
  ('MEDUSA_TO_WMS', 'inventory_item.sku',            'Inventory Item SKU',     'warehouse_inventory.product_sku',    'WMS Product SKU',     'SKU used as the primary key in WMS stock tables'),
  ('MEDUSA_TO_WMS', 'inventory_item.available_qty',  'Available Quantity',     'warehouse_inventory.quantity',       'WMS Stock Qty',       'Current available stock level pushed to/from Medusa'),
  ('MEDUSA_TO_WMS', 'inventory_item.required_qty',   'Kit Required Qty',       'kit_component_qty',                  'Kit Component Qty',   'Quantity of this component required per assembled kit unit'),
  ('MEDUSA_TO_WMS', 'product.status',                'Product Status',         'product_status',                     'Product Status',      'published / draft / proposed — display only, not synced'),
  ('WMS_TO_GENERO', 'sku_mappings.genero_code',      'Genero Product Code',    null,                                 null,                  'Awaiting Genero schema — maps WMS Genero code to Genero product identifier'),
  ('WMS_TO_GENERO', 'order_line_items.nw_code',      'NW Stocking Code',       null,                                 null,                  'Awaiting Genero schema — NW code used to identify item in Genero order'),
  ('WMS_TO_GENERO', 'order_line_items.qty_ordered',  'Quantity Ordered',       null,                                 null,                  'Awaiting Genero schema — quantity to send in Genero purchase order'),
  ('WMS_TO_GENERO', 'supplier_orders.order_number',  'WMS Order Reference',    null,                                 null,                  'Awaiting Genero schema — WMS order ref to correlate with Genero dispatch note')
ON CONFLICT (mapping_direction, source_field) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_field_mappings_direction ON field_mappings(mapping_direction);
`;
