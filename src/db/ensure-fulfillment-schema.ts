import { query } from './index.js';

const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS packaging_profiles (
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
  )`,
  `CREATE TABLE IF NOT EXISTS packaging_checklist_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    checklist_items JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS shipping_services (
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
  )`,
  `CREATE TABLE IF NOT EXISTS product_fulfillment_profiles (
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )`,
  `ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS selected_courier_code VARCHAR(50)`,
  `ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS selected_service_code VARCHAR(80)`,
  `ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS shipping_requirements JSONB NOT NULL DEFAULT '{}'::jsonb`,
  `ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS parcel_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS packaging_cost_gbp DECIMAL(10,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS packing_started_at TIMESTAMP`,
  `ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS packed_at TIMESTAMP`,
  `ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS label_printed_at TIMESTAMP`,
  `ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMP`,
  `ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS packing_notes TEXT`,
  `ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE pick_list_items ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS pick_list_packages (
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
  )`,
  `CREATE TABLE IF NOT EXISTS pick_list_package_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    package_id UUID NOT NULL REFERENCES pick_list_packages(id) ON DELETE CASCADE,
    pick_list_item_id UUID NOT NULL REFERENCES pick_list_items(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT unique_package_item_assignment UNIQUE(package_id, pick_list_item_id)
  )`,
  `INSERT INTO shipping_services (courier_code, courier_name, service_code, service_name, service_level, shipment_mode, integration_type, constraints, metadata, sort_order)
   VALUES
    ('ups', 'UPS', 'ups_standard', 'UPS Standard', 'standard', 'parcel', 'manual', '{"max_weight_kg":70,"max_length_mm":2740,"max_girth_plus_length_mm":4000,"max_volume_litres":1200}'::jsonb, '{"ready_for_api":true,"category":"parcel"}'::jsonb, 5),
    ('ups', 'UPS', 'ups_express', 'UPS Express Saver', 'express', 'parcel', 'manual', '{"max_weight_kg":70,"max_length_mm":2740,"max_girth_plus_length_mm":4000,"max_volume_litres":1200}'::jsonb, '{"ready_for_api":true,"category":"parcel"}'::jsonb, 6),
    ('dpd', 'DPD', 'dpd_next_day', 'DPD Next Day', 'standard', 'parcel', 'manual', '{"max_weight_kg":30,"max_length_mm":1750,"max_girth_plus_length_mm":3000,"max_volume_litres":500}'::jsonb, '{"ready_for_api":false,"category":"parcel"}'::jsonb, 30),
    ('dhl', 'DHL Parcel UK', 'dhl_parcel_uk', 'DHL Parcel UK', 'standard', 'parcel', 'manual', '{"max_weight_kg":25,"max_length_mm":1200,"max_girth_plus_length_mm":3000,"max_volume_litres":350}'::jsonb, '{"ready_for_api":false,"category":"parcel"}'::jsonb, 40),
    ('palletways', 'Palletways', 'palletways_economy', 'Palletways Economy', 'economy', 'pallet', 'manual', '{"required_packaging_type":"pallet","max_weight_kg":700,"max_length_mm":1200,"max_width_mm":1000,"max_height_mm":2200,"max_volume_litres":2640}'::jsonb, '{"ready_for_api":false,"category":"pallet"}'::jsonb, 60),
    ('palletforce', 'Palletforce', 'palletforce_premium', 'Palletforce Premium', 'express', 'pallet', 'manual', '{"required_packaging_type":"pallet","max_weight_kg":700,"max_length_mm":1200,"max_width_mm":1000,"max_height_mm":2200,"max_volume_litres":2640}'::jsonb, '{"ready_for_api":false,"category":"pallet"}'::jsonb, 70),
    ('manual', 'Manual Selection', 'manual_standard', 'Manual Standard', 'standard', 'parcel', 'manual', '{}'::jsonb, '{"ready_for_api":false}'::jsonb, 10),
    ('manual', 'Manual Selection', 'manual_express', 'Manual Express', 'express', 'parcel', 'manual', '{}'::jsonb, '{"ready_for_api":false}'::jsonb, 20),
    ('manual', 'Manual Selection', 'manual_pallet', 'Manual Pallet', 'economy', 'pallet', 'manual', '{}'::jsonb, '{"ready_for_api":false}'::jsonb, 80)
   ON CONFLICT (service_code) DO NOTHING`,
  `INSERT INTO packaging_profiles (code, name, package_type, inner_length_mm, inner_width_mm, inner_height_mm, max_weight_grams, tare_weight_grams, default_cost_gbp, notes)
   VALUES
    ('BOX-SMALL', 'Small Carton', 'parcel', 350, 250, 180, 10000, 250, 1.25, 'Generic small parcel carton'),
    ('BOX-MEDIUM', 'Medium Carton', 'parcel', 500, 350, 250, 18000, 450, 2.10, 'Generic medium parcel carton'),
    ('PALLET-HALF', 'Half Pallet', 'pallet', 1200, 800, 1200, 350000, 12000, 18.00, 'For bulky mixed furniture orders'),
    ('PALLET-FULL', 'Full Pallet', 'pallet', 1200, 1000, 1800, 700000, 18000, 24.00, 'For larger consolidated dispatches')
   ON CONFLICT (code) DO NOTHING`,
  `INSERT INTO packaging_checklist_templates (code, name, checklist_items)
   VALUES
    ('STD-PARCEL', 'Standard Parcel', '["Check finish and colour","Add protection wrap","Add packing slip","Seal carton","Apply shipping label"]'::jsonb),
    ('FRAGILE-PARCEL', 'Fragile Parcel', '["Check finish and colour","Add corner protection","Add fragile wrap","Add packing slip","Seal carton","Apply fragile sticker","Apply shipping label"]'::jsonb),
    ('PALLET-FREIGHT', 'Pallet Freight', '["Check all picked items","Strap to pallet","Apply corner boards","Shrink wrap pallet","Attach dispatch paperwork","Apply pallet label"]'::jsonb)
   ON CONFLICT (code) DO NOTHING`,
];

export async function ensureFulfillmentSchema() {
  for (const statement of STATEMENTS) {
    await query(statement);
  }
  console.log('✓ Fulfillment schema verified');
}
