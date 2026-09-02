/**
 * Warehouse Database Schema
 * PostgreSQL migration for warehouse management system
 */

export const WAREHOUSE_SCHEMA = `
-- ================================================================================
-- WAREHOUSE LOCATIONS (Aisles, Rows and Bays)
-- ================================================================================
CREATE TABLE IF NOT EXISTS warehouse_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aisle_code VARCHAR(10),
  bay_code VARCHAR(10) NOT NULL,
  bin_code VARCHAR(10) NOT NULL,
  location_code VARCHAR(30) NOT NULL UNIQUE,
  description TEXT,
  max_weight_kg DECIMAL(8,2),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_bay_bin UNIQUE(bay_code, bin_code)
);
-- Add aisle_code to existing deployments
ALTER TABLE warehouse_locations ADD COLUMN IF NOT EXISTS aisle_code VARCHAR(10);
-- Widen location_code to fit three-level codes (e.g. A-10-20)
ALTER TABLE warehouse_locations ALTER COLUMN location_code TYPE VARCHAR(30);

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
  thumbnail_url VARCHAR(500),
  medusa_product_id VARCHAR(100),
  medusa_variant_id VARCHAR(100),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
-- Add thumbnail_url to existing installations that predate this column
ALTER TABLE barcode_mappings ADD COLUMN IF NOT EXISTS thumbnail_url VARCHAR(500);

-- ================================================================================
-- WMS PRODUCTS (Local Medusa cache — synced via POST /api/products/sync)
-- ================================================================================
CREATE TABLE IF NOT EXISTS wms_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  medusa_product_id VARCHAR(100) NOT NULL,
  medusa_variant_id VARCHAR(100) NOT NULL,
  product_title VARCHAR(255) NOT NULL,
  product_subtitle VARCHAR(500),
  product_handle VARCHAR(255),
  product_status VARCHAR(50) DEFAULT 'draft',
  product_thumbnail VARCHAR(500),
  product_description TEXT,
  product_material VARCHAR(255),
  gallery_images JSONB DEFAULT '[]'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  weight_grams INTEGER,
  height_mm INTEGER,
  width_mm INTEGER,
  depth_mm INTEGER,
  variant_sku VARCHAR(100) NOT NULL,
  variant_title VARCHAR(255),
  colour_code VARCHAR(30),
  colour_name VARCHAR(100),
  variant_thumbnail VARCHAR(500),
  manage_inventory BOOLEAN DEFAULT false,
  allow_backorder BOOLEAN DEFAULT false,
  price_gbp DECIMAL(10,2),
  variant_barcode VARCHAR(100),
  variant_weight_grams INTEGER,
  variant_height_mm INTEGER,
  variant_width_mm INTEGER,
  variant_depth_mm INTEGER,
  is_kit BOOLEAN DEFAULT false,
  kit_components JSONB DEFAULT '[]'::jsonb,
  inventory_qty INTEGER DEFAULT 0,
  last_synced_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_medusa_variant_id UNIQUE(medusa_variant_id)
);
-- Extend existing installations with new columns (safe to re-run)
ALTER TABLE wms_products ADD COLUMN IF NOT EXISTS product_subtitle VARCHAR(500);
ALTER TABLE wms_products ADD COLUMN IF NOT EXISTS product_description TEXT;
ALTER TABLE wms_products ADD COLUMN IF NOT EXISTS product_material VARCHAR(255);
ALTER TABLE wms_products ADD COLUMN IF NOT EXISTS gallery_images JSONB DEFAULT '[]'::jsonb;
ALTER TABLE wms_products ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
ALTER TABLE wms_products ADD COLUMN IF NOT EXISTS weight_grams INTEGER;
ALTER TABLE wms_products ADD COLUMN IF NOT EXISTS height_mm INTEGER;
ALTER TABLE wms_products ADD COLUMN IF NOT EXISTS width_mm INTEGER;
ALTER TABLE wms_products ADD COLUMN IF NOT EXISTS depth_mm INTEGER;
ALTER TABLE wms_products ADD COLUMN IF NOT EXISTS allow_backorder BOOLEAN DEFAULT false;
ALTER TABLE wms_products ADD COLUMN IF NOT EXISTS price_gbp DECIMAL(10,2);
ALTER TABLE wms_products ADD COLUMN IF NOT EXISTS variant_barcode VARCHAR(100);
ALTER TABLE wms_products ADD COLUMN IF NOT EXISTS variant_weight_grams INTEGER;
ALTER TABLE wms_products ADD COLUMN IF NOT EXISTS variant_height_mm INTEGER;
ALTER TABLE wms_products ADD COLUMN IF NOT EXISTS variant_width_mm INTEGER;
ALTER TABLE wms_products ADD COLUMN IF NOT EXISTS variant_depth_mm INTEGER;

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
  -- Functional unique index handles NULL colour_code (PostgreSQL NULLs are not equal in plain UNIQUE)
  CONSTRAINT unique_location_sku_colour UNIQUE(location_id, product_sku, colour_code)
);
-- Fix NULL colour_code uniqueness: replace plain UNIQUE with functional COALESCE index
-- Note: runs as separate ALTER + CREATE to avoid a DO block, since the migration runner splits on the semicolon character
ALTER TABLE warehouse_inventory DROP CONSTRAINT IF EXISTS unique_location_sku_colour;
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_sku_loc_coalesce
  ON warehouse_inventory(location_id, product_sku, COALESCE(colour_code, ''));

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
CREATE TABLE IF NOT EXISTS packaging_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  package_type VARCHAR(50) NOT NULL DEFAULT 'parcel',
  inner_length_mm INTEGER,
  inner_width_mm INTEGER,
  inner_height_mm INTEGER,
  max_weight_grams INTEGER,
  tare_weight_grams INTEGER,
  default_cost_gbp DECIMAL(10,2) DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS packaging_checklist_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  checklist_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shipping_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  courier_code VARCHAR(50) NOT NULL,
  courier_name VARCHAR(255) NOT NULL,
  service_code VARCHAR(80) NOT NULL UNIQUE,
  service_name VARCHAR(255) NOT NULL,
  service_level VARCHAR(50) DEFAULT 'standard',
  shipment_mode VARCHAR(50) NOT NULL DEFAULT 'parcel',
  integration_type VARCHAR(50) NOT NULL DEFAULT 'manual',
  constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 100,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_fulfillment_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_sku VARCHAR(100) NOT NULL UNIQUE,
  packaging_profile_code VARCHAR(50) REFERENCES packaging_profiles(code),
  checklist_template_code VARCHAR(50) REFERENCES packaging_checklist_templates(code),
  shipping_group VARCHAR(50),
  fulfilment_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  preferred_service_code VARCHAR(80) REFERENCES shipping_services(service_code),
  requires_manual_review BOOLEAN DEFAULT false,
  is_fragile BOOLEAN DEFAULT false,
  is_multi_box BOOLEAN DEFAULT false,
  pack_instructions TEXT,
  estimated_shipping_cost_gbp DECIMAL(10,2),
  estimated_shipping_currency VARCHAR(10),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pick_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  medusa_order_id VARCHAR(100) NOT NULL UNIQUE,
  pick_list_number VARCHAR(50) NOT NULL UNIQUE,
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  -- Statuses: PENDING, IN_PROGRESS, PICKED, PACKING, PACKED, LABEL_PRINTED, DISPATCHED, CANCELLED
  customer_name VARCHAR(255),
  customer_email VARCHAR(255),
  shipping_method_name VARCHAR(255),
  shipping_method_code VARCHAR(100),
  shipping_address JSONB NOT NULL DEFAULT '{}'::jsonb,
  selected_courier_code VARCHAR(50),
  selected_service_code VARCHAR(80) REFERENCES shipping_services(service_code),
  shipping_requirements JSONB NOT NULL DEFAULT '{}'::jsonb,
  parcel_count INTEGER NOT NULL DEFAULT 0,
  packaging_cost_gbp DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  packing_started_at TIMESTAMP,
  packed_at TIMESTAMP,
  label_printed_at TIMESTAMP,
  dispatched_at TIMESTAMP,
  picked_by UUID REFERENCES warehouse_locations(id),
  packing_notes TEXT,
  notes TEXT,
  is_sandbox BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255);
ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS customer_email VARCHAR(255);
ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS shipping_method_name VARCHAR(255);
ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS shipping_method_code VARCHAR(100);
ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS shipping_address JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS selected_courier_code VARCHAR(50);
ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS selected_service_code VARCHAR(80);
ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS shipping_requirements JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS parcel_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS packaging_cost_gbp DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS packing_started_at TIMESTAMP;
ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS packed_at TIMESTAMP;
ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS label_printed_at TIMESTAMP;
ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMP;
ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS packing_notes TEXT;
ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT false;

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
  is_sandbox BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_line_per_picklist UNIQUE(pick_list_id, line_number)
);
ALTER TABLE pick_list_items ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS pick_list_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pick_list_id UUID NOT NULL REFERENCES pick_lists(id) ON DELETE CASCADE,
  package_number INTEGER NOT NULL,
  packaging_profile_code VARCHAR(50) REFERENCES packaging_profiles(code),
  courier_service_code VARCHAR(80) REFERENCES shipping_services(service_code),
  label_status VARCHAR(50) NOT NULL DEFAULT 'NOT_PRINTED',
  tracking_number VARCHAR(255),
  package_weight_grams INTEGER,
  package_length_mm INTEGER,
  package_width_mm INTEGER,
  package_height_mm INTEGER,
  package_cost_gbp DECIMAL(10,2) NOT NULL DEFAULT 0,
  contents_summary TEXT,
  checklist_state JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_package_per_picklist UNIQUE(pick_list_id, package_number)
);

CREATE TABLE IF NOT EXISTS pick_list_package_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID NOT NULL REFERENCES pick_list_packages(id) ON DELETE CASCADE,
  pick_list_item_id UUID NOT NULL REFERENCES pick_list_items(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_package_item_assignment UNIQUE(package_id, pick_list_item_id)
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
  password_hash VARCHAR(255),
  is_active BOOLEAN DEFAULT true,
  last_login_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE warehouse_users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

-- ================================================================================
-- SUPPLIER ORDERS / REPLENISHMENT REQUESTS (Integration with Genero)
-- ================================================================================
CREATE TABLE IF NOT EXISTS supplier_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number VARCHAR(100) NOT NULL UNIQUE,
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  colour_palette VARCHAR(20),
  triggered_by UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  submitted_at TIMESTAMP,
  expected_delivery_date DATE,
  received_date DATE,
  notes TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);
-- Add Phase 2 columns to existing installations
ALTER TABLE supplier_orders ADD COLUMN IF NOT EXISTS expected_delivery DATE;
ALTER TABLE supplier_orders ADD COLUMN IF NOT EXISTS genero_dispatch_ref VARCHAR(100);
ALTER TABLE supplier_orders ADD COLUMN IF NOT EXISTS created_by VARCHAR(100);
ALTER TABLE supplier_orders ADD COLUMN IF NOT EXISTS supplier VARCHAR(100) DEFAULT 'New Wave';
ALTER TABLE supplier_orders ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMP;
ALTER TABLE supplier_orders ADD COLUMN IF NOT EXISTS received_at TIMESTAMP;
UPDATE supplier_orders SET expected_delivery = expected_delivery_date WHERE expected_delivery IS NULL AND expected_delivery_date IS NOT NULL;

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

INSERT INTO shipping_services (courier_code, courier_name, service_code, service_name, service_level, shipment_mode, integration_type, constraints, metadata, sort_order)
VALUES
  ('ups', 'UPS', 'ups_standard', 'UPS Standard', 'standard', 'parcel', 'manual', '{"max_weight_kg": 70}'::jsonb, '{"ready_for_api": true, "category": "parcel"}'::jsonb, 5),
  ('ups', 'UPS', 'ups_express', 'UPS Express Saver', 'express', 'parcel', 'manual', '{"max_weight_kg": 70}'::jsonb, '{"ready_for_api": true, "category": "parcel"}'::jsonb, 6),
  ('manual', 'Manual Selection', 'manual_standard', 'Manual Standard', 'standard', 'parcel', 'manual', '{}'::jsonb, '{"ready_for_api": false}'::jsonb, 10),
  ('manual', 'Manual Selection', 'manual_express', 'Manual Express', 'express', 'parcel', 'manual', '{}'::jsonb, '{"ready_for_api": false}'::jsonb, 20),
  ('dpd', 'DPD', 'dpd_next_day', 'DPD Next Day', 'standard', 'parcel', 'manual', '{"max_weight_kg": 30}'::jsonb, '{"ready_for_api": false, "category": "parcel"}'::jsonb, 30),
  ('dhl', 'DHL Parcel UK', 'dhl_parcel_uk', 'DHL Parcel UK', 'standard', 'parcel', 'manual', '{"max_weight_kg": 25}'::jsonb, '{"ready_for_api": false, "category": "parcel"}'::jsonb, 40),
  ('dx', 'DX Freight', 'dx_freight_two_man', 'DX Freight Two-Man', 'standard', 'freight', 'manual', '{"oversized": true}'::jsonb, '{"ready_for_api": false, "category": "freight"}'::jsonb, 50),
  ('palletways', 'Palletways', 'palletways_economy', 'Palletways Economy', 'economy', 'pallet', 'manual', '{"pallet_required": true}'::jsonb, '{"ready_for_api": false, "category": "pallet"}'::jsonb, 60),
  ('palletforce', 'Palletforce', 'palletforce_premium', 'Palletforce Premium', 'express', 'pallet', 'manual', '{"pallet_required": true}'::jsonb, '{"ready_for_api": false, "category": "pallet"}'::jsonb, 70),
  ('manual', 'Manual Selection', 'manual_pallet', 'Manual Pallet', 'economy', 'pallet', 'manual', '{}'::jsonb, '{"ready_for_api": false}'::jsonb, 80),
  ('ait', 'AIT', 'ait_freight', 'AIT Freight (Oversized / Non-Parcel)', 'standard', 'freight', 'percentage', '{"required_packaging_type": "freight"}'::jsonb, '{"ready_for_api": false, "category": "freight", "percentage_of_price": 10}'::jsonb, 45)
ON CONFLICT (service_code) DO NOTHING;

-- Default size/weight/volume rules used by the shipping estimator.
UPDATE shipping_services
SET constraints = constraints || '{"max_weight_kg":70,"max_length_mm":2740,"max_girth_plus_length_mm":4000,"max_volume_litres":1200}'::jsonb
WHERE service_code IN ('ups_standard', 'ups_express');

UPDATE shipping_services
SET constraints = constraints || '{"max_weight_kg":30,"max_length_mm":1750,"max_girth_plus_length_mm":3000,"max_volume_litres":500}'::jsonb
WHERE service_code = 'dpd_next_day';

UPDATE shipping_services
SET constraints = constraints || '{"max_weight_kg":25,"max_length_mm":1200,"max_girth_plus_length_mm":3000,"max_volume_litres":350}'::jsonb
WHERE service_code = 'dhl_parcel_uk';

UPDATE shipping_services
SET constraints = constraints || '{"required_packaging_type":"pallet","max_weight_kg":700,"max_length_mm":1200,"max_width_mm":1000,"max_height_mm":2200,"max_volume_litres":2640}'::jsonb
WHERE service_code = 'palletforce_premium';

UPDATE shipping_services
SET constraints = constraints || '{"required_packaging_type":"pallet","max_weight_kg":700,"max_length_mm":1200,"max_width_mm":1000,"max_height_mm":2200,"max_volume_litres":2640}'::jsonb
WHERE service_code = 'palletways_economy';

INSERT INTO packaging_profiles (code, name, package_type, inner_length_mm, inner_width_mm, inner_height_mm, max_weight_grams, tare_weight_grams, default_cost_gbp, notes)
VALUES
  ('BOX-SMALL', 'Small Carton', 'parcel', 350, 250, 180, 10000, 250, 1.25, 'Generic small parcel carton'),
  ('BOX-MEDIUM', 'Medium Carton', 'parcel', 500, 350, 250, 18000, 450, 2.10, 'Generic medium parcel carton'),
  ('PALLET-HALF', 'Half Pallet', 'pallet', 1200, 800, 1200, 350000, 12000, 18.00, 'For bulky mixed furniture orders'),
  ('PALLET-FULL', 'Full Pallet', 'pallet', 1200, 1000, 1800, 700000, 18000, 24.00, 'For larger consolidated dispatches')
ON CONFLICT (code) DO NOTHING;

INSERT INTO packaging_checklist_templates (code, name, checklist_items)
VALUES
  ('STD-PARCEL', 'Standard Parcel', '["Check finish and colour","Add protection wrap","Add packing slip","Seal carton","Apply shipping label"]'::jsonb),
  ('FRAGILE-PARCEL', 'Fragile Parcel', '["Check finish and colour","Add corner protection","Add fragile wrap","Add packing slip","Seal carton","Apply fragile sticker","Apply shipping label"]'::jsonb),
  ('PALLET-FREIGHT', 'Pallet Freight', '["Check all picked items","Strap to pallet","Apply corner boards","Shrink wrap pallet","Attach dispatch paperwork","Apply pallet label"]'::jsonb)
ON CONFLICT (code) DO NOTHING;

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
-- ORDER LINE ITEMS (Phase 2: Individual products within a supplier order)
-- (supplier_orders is defined earlier — see SUPPLIER ORDERS section above.
--  A duplicate CREATE TABLE for supplier_orders used to live here; removed —
--  its extra columns are now ALTERed onto the original definition instead.)
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
CREATE INDEX IF NOT EXISTS idx_wms_products_variant_id ON wms_products(medusa_variant_id);
CREATE INDEX IF NOT EXISTS idx_wms_products_sku ON wms_products(variant_sku);
CREATE INDEX IF NOT EXISTS idx_wms_products_product_id ON wms_products(medusa_product_id);
CREATE INDEX IF NOT EXISTS idx_wms_products_status ON wms_products(product_status);
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
  ('WMS_TO_GENERO', 'sku_mappings.medusa_sku',          'Bisley SKU',           'sku',        'sku',          'Bisley product SKU in format PRODUCTCODE-colourcode e.g. AOC4-av4. Required by Genero.'),
  ('WMS_TO_GENERO', 'order_line_items.product_name',    'Product Name',         'name',       'name',         'Product description sent to Genero with the order line'),
  ('WMS_TO_GENERO', 'order_line_items.quantity_ordered','Quantity Ordered',     'quantity',   'quantity',     'Integer quantity to order. Required by Genero.'),
  ('WMS_TO_GENERO', 'supplier_orders.order_number',     'WMS Order Reference',  'order_ref',  'order_ref',    'Our WMS order reference, returned unchanged for correlation'),
  ('WMS_TO_GENERO', '(env) GENERO_ACCOUNT_NO',          'NW Account Number',    'account',    'account',      'Bisley New Wave account number — configured as GENERO_ACCOUNT_NO env var. Required.'),
  ('WMS_TO_GENERO', 'genero_order_lines.bisley_order',  'Bisley Order No',      'order_id',   'order_id',     'Genero returns bisley_order on first submit; pass as order_id on subsequent polls'),
  ('WMS_TO_GENERO', '(returned) status',                'Order Status',         null,         'status',       'Returned by Genero: Open / In Production / Dispatched etc. Update on each poll.'),
  ('WMS_TO_GENERO', '(returned) Est_delivery',          'Est. Delivery Date',   null,         'Est_delivery', 'Returned by Genero: estimated delivery date. Poll periodically as it updates.')
ON CONFLICT (mapping_direction, source_field) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_field_mappings_direction ON field_mappings(mapping_direction);

-- ================================================================================
-- GENERO ORDER LINES (Bisley NW API line-item submissions and their poll status)
-- ================================================================================
CREATE TABLE IF NOT EXISTS genero_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_order_id UUID REFERENCES supplier_orders(id) ON DELETE CASCADE,
  order_line_item_id UUID REFERENCES order_line_items(id) ON DELETE SET NULL,
  -- Fields sent to Genero POST API
  account VARCHAR(50) NOT NULL,
  order_ref VARCHAR(100),
  name VARCHAR(255),
  sku VARCHAR(100) NOT NULL,
  quantity INTEGER NOT NULL,
  -- Fields returned by Genero
  bisley_order INTEGER,
  genero_status VARCHAR(50),
  est_delivery DATE,
  -- Polling metadata
  submitted_at TIMESTAMP,
  last_polled_at TIMESTAMP,
  poll_error TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_genero_line_item UNIQUE(order_line_item_id)
);
CREATE INDEX IF NOT EXISTS idx_genero_lines_order ON genero_order_lines(supplier_order_id);
CREATE INDEX IF NOT EXISTS idx_genero_lines_bisley_order ON genero_order_lines(bisley_order);
CREATE INDEX IF NOT EXISTS idx_genero_lines_status ON genero_order_lines(genero_status);

-- ================================================================================
-- REORDER RULES (Automatic replenishment rules per SKU)
-- ================================================================================
CREATE TABLE IF NOT EXISTS reorder_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku VARCHAR(100) NOT NULL UNIQUE,
  product_name VARCHAR(255),
  family VARCHAR(100),
  reorder_point INTEGER NOT NULL DEFAULT 1,
  reorder_qty INTEGER NOT NULL DEFAULT 2,
  lead_time_weeks INTEGER NOT NULL DEFAULT 8,
  monthly_demand DECIMAL(8,2),
  is_active BOOLEAN DEFAULT true,
  notes TEXT,
  last_triggered_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ================================================================================
-- PENDING REORDERS (Triggered suggestions awaiting approval)
-- ================================================================================
CREATE TABLE IF NOT EXISTS pending_reorders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reorder_rule_id UUID REFERENCES reorder_rules(id) ON DELETE SET NULL,
  sku VARCHAR(100) NOT NULL,
  product_name VARCHAR(255),
  qty_to_order INTEGER NOT NULL,
  current_stock INTEGER DEFAULT 0,
  reorder_point INTEGER NOT NULL,
  status TEXT CHECK (status IN ('PENDING','APPROVED','DELAYED','CANCELLED')) DEFAULT 'PENDING',
  triggered_at TIMESTAMP DEFAULT NOW(),
  delayed_until DATE,
  delay_reason TEXT,
  approved_at TIMESTAMP,
  approved_by VARCHAR(100),
  supplier_order_id UUID REFERENCES supplier_orders(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pending_reorders_status ON pending_reorders(status);
CREATE INDEX IF NOT EXISTS idx_pending_reorders_sku ON pending_reorders(sku);
CREATE INDEX IF NOT EXISTS idx_reorder_rules_sku ON reorder_rules(sku);
CREATE INDEX IF NOT EXISTS idx_reorder_rules_active ON reorder_rules(is_active);

-- ================================================================================
-- WMS ERROR LOG (Centralised error tracking for all external integrations)
-- ================================================================================
CREATE TABLE IF NOT EXISTS wms_error_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source VARCHAR(50) NOT NULL,
  severity VARCHAR(10) NOT NULL DEFAULT 'ERROR',
  message TEXT NOT NULL,
  context JSONB,
  stack TEXT,
  resolved BOOLEAN DEFAULT false,
  resolved_at TIMESTAMP,
  resolved_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_error_log_source ON wms_error_log(source);
CREATE INDEX IF NOT EXISTS idx_error_log_severity ON wms_error_log(severity);
CREATE INDEX IF NOT EXISTS idx_error_log_resolved ON wms_error_log(resolved);
CREATE INDEX IF NOT EXISTS idx_error_log_created ON wms_error_log(created_at DESC);

-- ================================================================================
-- WMS NOTIFICATIONS (Site-wide alerts and operational events)
-- ================================================================================
CREATE TABLE IF NOT EXISTS wms_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(50) NOT NULL,
  -- DELIVERY_TODAY, DELIVERY_UPCOMING, DELIVERY_DATE_CHANGE, DELIVERY_DISPATCHED,
  -- INVENTORY_UNASSIGNED, API_ERROR, SYNC_ERROR, ORDER, SYSTEM
  title VARCHAR(200) NOT NULL,
  body TEXT,
  link VARCHAR(300),
  severity VARCHAR(20) NOT NULL DEFAULT 'info',
  -- info, warning, error
  is_read BOOLEAN NOT NULL DEFAULT false,
  is_dismissed BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_read ON wms_notifications(is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_type ON wms_notifications(type);

-- ================================================================================
-- GENERO DELIVERIES (Incoming dispatch batches detected from Genero poll)
-- ================================================================================
CREATE TABLE IF NOT EXISTS genero_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bisley_order_ref VARCHAR(50) NOT NULL,
  est_delivery DATE,
  status VARCHAR(30) NOT NULL DEFAULT 'UPCOMING',
  -- UPCOMING, TODAY, IN_TRANSIT, ARRIVED, CHECKED_IN, CANCELLED
  total_lines INT NOT NULL DEFAULT 0,
  total_units INT NOT NULL DEFAULT 0,
  skus JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- [{sku, quantity, name, genero_status}]
  prev_est_delivery DATE,
  -- tracks last known date for change detection
  notification_created_at TIMESTAMP,
  checkin_session_id UUID,
  last_updated TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(bisley_order_ref)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_est ON genero_deliveries(est_delivery);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON genero_deliveries(status);
`;
