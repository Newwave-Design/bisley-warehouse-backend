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
  `ALTER TABLE product_fulfillment_profiles ADD COLUMN IF NOT EXISTS estimated_shipping_cost_gbp DECIMAL(10,2)`,
  `ALTER TABLE product_fulfillment_profiles ADD COLUMN IF NOT EXISTS estimated_shipping_currency VARCHAR(10)`,
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
    ('ups', 'UPS', 'ups_standard', 'UPS Standard', 'standard', 'parcel', 'manual', '{"required_packaging_type":"parcel","max_weight_kg":70,"max_length_mm":2740,"max_girth_plus_length_mm":4000,"max_volume_litres":1200}'::jsonb, '{"ready_for_api":true,"category":"parcel"}'::jsonb, 5),
    ('ups', 'UPS', 'ups_express', 'UPS Express Saver', 'express', 'parcel', 'manual', '{"required_packaging_type":"parcel","max_weight_kg":70,"max_length_mm":2740,"max_girth_plus_length_mm":4000,"max_volume_litres":1200}'::jsonb, '{"ready_for_api":true,"category":"parcel"}'::jsonb, 6),
    ('ups', 'UPS', 'ups_express_worldwide', 'UPS Worldwide Express', 'express', 'parcel', 'manual', '{"required_packaging_type":"parcel","max_weight_kg":70,"max_length_mm":2740,"max_girth_plus_length_mm":4000,"max_volume_litres":1200}'::jsonb, '{"ready_for_api":true,"category":"parcel"}'::jsonb, 7),
    ('ups', 'UPS', 'ups_express_plus', 'UPS Worldwide Express Plus', 'express', 'parcel', 'manual', '{"required_packaging_type":"parcel","max_weight_kg":70,"max_length_mm":2740,"max_girth_plus_length_mm":4000,"max_volume_litres":1200}'::jsonb, '{"ready_for_api":false,"category":"parcel"}'::jsonb, 8),
    ('ups', 'UPS', 'ups_expedited', 'UPS Worldwide Expedited', 'standard', 'parcel', 'manual', '{"required_packaging_type":"parcel","max_weight_kg":70,"max_length_mm":2740,"max_girth_plus_length_mm":4000,"max_volume_litres":1200}'::jsonb, '{"ready_for_api":false,"category":"parcel"}'::jsonb, 9),
    ('ups', 'UPS', 'ups_express_freight', 'UPS Worldwide Express Freight', 'express', 'freight', 'manual', '{"required_packaging_type":"freight","max_weight_kg":500,"max_length_mm":3000,"max_volume_litres":5000}'::jsonb, '{"ready_for_api":false,"category":"freight"}'::jsonb, 10)
   ON CONFLICT (service_code) DO NOTHING`,
  `INSERT INTO packaging_profiles (code, name, package_type, inner_length_mm, inner_width_mm, inner_height_mm, max_weight_grams, tare_weight_grams, default_cost_gbp, notes)
   VALUES
    ('BOX-SMALL', 'Small Carton', 'parcel', 350, 250, 180, 10000, 250, 1.25, 'Generic small parcel carton'),
    ('BOX-MEDIUM', 'Medium Carton', 'parcel', 500, 350, 250, 18000, 450, 2.10, 'Generic medium parcel carton'),
    ('BOX-LARGE', 'Large Carton', 'parcel', 700, 500, 400, 30000, 900, 3.80, 'Large parcel carton for bigger items'),
    ('UPS-FREIGHT-CUSTOM-PALLET', 'UPS Freight Custom Pallet', 'freight', 3000, 2000, 2000, 500000, 0, NULL, 'Oversize or heavy items. Freight and packaging pricing require a quote.')
   ON CONFLICT (code) DO NOTHING`,
    `UPDATE packaging_profiles
     SET is_active = false,
       updated_at = NOW()
       WHERE package_type NOT IN ('parcel', 'freight')`,
  `INSERT INTO packaging_checklist_templates (code, name, checklist_items)
   VALUES
    ('STD-PARCEL', 'Standard Parcel', '["Check finish and colour","Add protection wrap","Add packing slip","Seal carton","Apply shipping label"]'::jsonb),
    ('FRAGILE-PARCEL', 'Fragile Parcel', '["Check finish and colour","Add corner protection","Add fragile wrap","Add packing slip","Seal carton","Apply fragile sticker","Apply shipping label"]'::jsonb),
    ('PALLET-FREIGHT', 'Pallet Freight', '["Check all picked items","Strap to pallet","Apply corner boards","Shrink wrap pallet","Attach dispatch paperwork","Apply pallet label"]'::jsonb)
   ON CONFLICT (code) DO NOTHING`,
  // Reference box sizes from Ovara's packaging measurements, per product range. match_rules tags
  // each row to real Medusa products (matched by title/handle at query time in box-sizes.ts) since
  // Medusa doesn't have a stable code shared with this spreadsheet's naming.
  `CREATE TABLE IF NOT EXISTS box_size_requirements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(80) NOT NULL UNIQUE,
    product_range VARCHAR(255) NOT NULL,
    product_label VARCHAR(255) NOT NULL DEFAULT '',
    width_mm INTEGER,
    depth_mm INTEGER,
    height_mm INTEGER,
    protection_type VARCHAR(50),
    foam_thickness_mm INTEGER,
    box_internal_width_mm INTEGER,
    box_internal_depth_mm INTEGER,
    box_internal_height_mm INTEGER,
    match_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
    notes TEXT,
    sort_order INTEGER DEFAULT 100,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )`,
  `INSERT INTO box_size_requirements
     (code, product_range, product_label, width_mm, depth_mm, height_mm, protection_type, foam_thickness_mm,
      box_internal_width_mm, box_internal_depth_mm, box_internal_height_mm, match_rules, notes, sort_order)
   VALUES
  ('multidrawer-12-series', 'MultiDrawer', '12 Series MultiDrawer', 279, 380, 325, 'Foam Corners', 50, 379, 480, 425, '[{"field":"title","contains":"12 series multidrawer"}]'::jsonb, NULL, 1),
  ('multidrawer-29-series', 'MultiDrawer', '29 Series MultiDrawer', 279, 380, 590, 'Foam Corners', 50, 379, 480, 690, '[{"field":"title","contains":"29 series multidrawer"}]'::jsonb, NULL, 2),
  ('multidrawer-39-series', 'MultiDrawer', '39 Series MultiDrawer', 279, 380, 860, 'Foam Corners', 50, 379, 480, 960, '[{"field":"title","contains":"39 series multidrawer"}]'::jsonb, NULL, 3),
  ('a3-multidrawer-9-15-drawer', 'A3 Series MultiDrawer', '9 Drawer, 15 Drawer', 349, 462, 940, 'Foam Corners', 50, 449, 562, 1040, '[{"field":"handle","contains":"a3-series-multidrawer-9-drawer"},{"field":"handle","contains":"a3-series-multidrawer-15-drawer"}]'::jsonb, NULL, 4),
  ('a3-multidrawer-6-10-drawer', 'A3 Series MultiDrawer', '10 Drawer, 6 Drawer', 349, 462, 670, 'Foam Corners', 50, 449, 562, 770, '[{"field":"handle","contains":"a3-series-multidrawer-10-drawer"},{"field":"handle","contains":"a3-series-multidrawer-6-drawer"}]'::jsonb, NULL, 5),
  ('bs-filing-a4-2dr', 'BS Filing Cabinet', '2 drawer filing cabinet (A4)', 413, 622, 711, 'Foam Corners', 50, 513, 722, 811, '[{"field":"handle","contains":"bs-filing-cabinet-a4-two-drawer"}]'::jsonb, NULL, 6),
  ('bs-filing-a4-3dr', 'BS Filing Cabinet', '3 drawer filing cabinet (A4)', 413, 622, 1016, 'Foam Corners', 50, 513, 722, 1116, '[{"field":"handle","contains":"bs-filing-cabinet-a4-three-drawer"}]'::jsonb, NULL, 7),
  ('bs-filing-a4-4dr', 'BS Filing Cabinet', '4 drawer filing cabinet (A4)', 413, 622, 1321, 'Foam Corners', 50, 513, 722, 1421, '[{"field":"handle","contains":"bs-filing-cabinet-a4-four-drawer"}]'::jsonb, NULL, 8),
  ('bs-filing-foolscap-4dr-3qh', 'BS Filing Cabinet', 'Foolscap 4 drawer filing cabinet (3/4 height)', 470, 622, 1321, 'Foam Corners', 50, 570, 722, 1421, '[{"field":"handle","contains":"bs-filing-cabinet-foolscap-4-drawer-3qh"}]'::jsonb, NULL, 9),
  ('bs-filing-foolscap-3dr-3qh', 'BS Filing Cabinet', 'Foolscap 3 drawer filing cabinet (3/4 height)', 470, 622, 1016, 'Foam Corners', 50, 570, 722, 1116, '[{"field":"handle","contains":"bs-filing-cabinet-foolscap-3-drawer-3qh"}]'::jsonb, NULL, 10),
  ('bs-filing-foolscap-2dr-3qh', 'BS Filing Cabinet', 'Foolscap 2 drawer filing cabinet (3/4 height)', 470, 622, 711, 'Foam Corners', 50, 570, 722, 811, '[{"field":"handle","contains":"bs-filing-cabinet-foolscap-two-drawer-3qh"}]'::jsonb, NULL, 11),
  ('bs-filing-foolscap-3dr-full', 'BS Filing Cabinet', 'Foolscap filing cabinet with 3 drawers', 470, 622, 1016, 'Foam Corners', 50, 570, 722, 1116, '[{"field":"handle","contains":"bs-filing-cabinet-foolscap-3-drawer"}]'::jsonb, 'Height is identical to the 3/4-height variant above, but this is the FULL-HEIGHT cabinet - it should almost certainly be taller. Looks like a copy-paste error, needs re-measuring.', 12),
  ('bs-filing-foolscap-4dr-full', 'BS Filing Cabinet', 'Foolscap filing cabinet with 4 drawer', 470, 622, 1321, 'Foam Corners', 50, 570, 722, 1421, '[{"field":"handle","contains":"bs-filing-cabinet-foolscap-four-drawer"}]'::jsonb, 'Height is identical to the 3/4-height variant above, but this is the FULL-HEIGHT cabinet - it should almost certainly be taller. Looks like a copy-paste error, needs re-measuring.', 13),
  ('bs-filing-foolscap-2dr-full', 'BS Filing Cabinet', '2 drawer foolscap filing cabinet', 470, 622, 711, 'Foam Corners', 50, 570, 722, 811, '[{"field":"handle","contains":"bs-filing-cabinet-foolscap-two-drawer"}]'::jsonb, 'Height is identical to the 3/4-height variant above, but this is the FULL-HEIGHT cabinet - it should almost certainly be taller. Looks like a copy-paste error, needs re-measuring.', 14),
  ('caddy', 'Caddy', 'Mobile pedestal with drawers for the home office', 1000, 490, 563, 'Foam Corners', 50, 1100, 590, 663, '[{"field":"title","contains":"caddy"}]'::jsonb, NULL, 15),
  ('fern-cabby', 'Fern Cabby', 'Fern Cabby, Fern Cabby Peek', 1140, 400, 731, 'Foam Corners', 50, 1240, 500, 831, '[{"field":"title","contains":"fern cabby"}]'::jsonb, NULL, 16),
  ('fern-locker-hanging-shelves', 'Fern Locker', 'Hanging, With Shelves, With shelves left hand', 380, 510, 1800, 'Foam Corners', 50, 480, 610, 1900, '[{"field":"title","contains":"fern locker"}]'::jsonb, NULL, 17),
  ('fern-locker-hanging-double-door', 'Fern Locker', 'Hanging double door', 700, 510, 1800, 'Foam Corners', 50, 800, 610, 1900, '[{"field":"title","contains":"fern maxi (hanging)"}]'::jsonb, 'Same dimensions as "Fern Maxi / Hanging" below - likely the same physical product, filed under the wrong range name in the original sheet.', 18),
  ('fern-maxi', 'Fern Maxi', 'Hanging, Peek, With Shelves', 700, 510, 1800, 'Foam Corners', 50, 800, 610, 1900, '[{"field":"title","contains":"fern maxi"}]'::jsonb, NULL, 19),
  ('fern-middle', 'Fern Middle', 'Middle, Peek', 800, 400, 1106, 'Foam Corners', 50, 900, 500, 1206, '[{"field":"title","contains":"fern middle"}]'::jsonb, NULL, 20),
  ('fern-mini', 'Fern Mini', 'Mini, Left, Right', 380, 400, 731, 'Foam Corners', 50, 480, 500, 831, '[{"field":"title","contains":"fern mini"}]'::jsonb, 'No published product currently matches - Fern Mini SKUs (FLBS04RH/FLBS04LH) exist in Medusa but aren''t published yet.', 21),
  ('fern-stendi', 'Fern Stendi', 'Stendi, Stendi Peek', 1200, 400, 905, 'Foam Corners', 50, 1300, 500, 1005, '[{"field":"title","contains":"fern stendi"}]'::jsonb, NULL, 22),
  ('f-series-filer', 'F-Series Filer', 'Suspension drawer filing cabinet, With combination drawer, 6 drawer', 470, 470, 711, 'Foam Corners', 50, 570, 570, 811, '[{"field":"title","contains":"f-series filer"}]'::jsonb, NULL, 23),
  ('home-filer-standard', 'Home Filer', 'Suspension filing cabinet, With combination drawer', 413, 400, 672, 'Foam Corners', 50, 513, 500, 772, '[{"field":"title","contains":"home filer"}]'::jsonb, NULL, 24),
  ('home-filer-handles', 'Home Filer', 'Steel handles, Wood handles', 413, 400, 736, 'Foam Corners', 50, 513, 500, 836, '[{"field":"title","contains":"steel handles"},{"field":"title","contains":"wooden handles"}]'::jsonb, 'Handles more than 50mm', 25),
  ('little-height-desk-1050', 'Little Height Standing Desk', '1050', 1050, 700, 25, 'Hard Corners', 50, 1150, 800, 125, '[{"field":"title","contains":"little height adjustable desk","width_mm":1050}]'::jsonb, NULL, 26),
  ('little-height-desk-1200', 'Little Height Standing Desk', '1200', 1200, 700, 25, 'Hard Corners', 50, 1300, 800, 125, '[{"field":"title","contains":"little height adjustable desk","width_mm":1200}]'::jsonb, NULL, 27),
  ('multidesk-1050-top', 'MultiDesk', '1050 Top', 1050, 600, 25, 'Hard Corners', 50, 1150, 700, 125, '[{"field":"handle","contains":"desktop-top-1050"}]'::jsonb, 'Are filing cabinet options different to drawers?', 28),
  ('multidesk-1400-top', 'MultiDesk', '1400 Top', 1400, 600, 25, 'Hard Corners', 50, 1500, 700, 125, '[{"field":"handle","contains":"desktop-top-1400"}]'::jsonb, NULL, 29),
  ('multidesk-hairpin-legs', 'MultiDesk', 'Hairpin legs', NULL, NULL, NULL, 'Bubble', 25, 50, 50, 50, '[{"field":"title","contains":"multidesk hairpin leg"}]'::jsonb, 'Width/Depth not measured - box size only reflects height + foam padding', 30),
  ('cyl-desk-1200', 'CYL Height Adjustable Desk', '1200', 1200, 700, 25, 'Hard Corners', 50, 1300, 800, 125, '[{"field":"title","contains":"cyl height adjustable desk","width_mm":1200}]'::jsonb, NULL, 31),
  ('cyl-desk-1400', 'CYL Height Adjustable Desk', '1400', 1400, 700, 25, 'Hard Corners', 50, 1500, 800, 125, '[{"field":"title","contains":"cyl height adjustable desk","width_mm":1400}]'::jsonb, NULL, 32),
  ('cyl-desk-1600', 'CYL Height Adjustable Desk', '1600', 1600, 700, 25, 'Hard Corners', 50, 1700, 800, 125, '[{"field":"title","contains":"cyl height adjustable desk","width_mm":1600}]'::jsonb, 'Check with colleague: is desktop height really 25mm, or should it be 80mm like the original sheet''s summary text said?', 33),
  ('multidrawer-plinth-standard', 'MultiDrawer Plinth', 'Standard', NULL, NULL, 80, 'Bubble', 50, 100, 100, 180, '[{"field":"title","contains":"multidrawer plinth"}]'::jsonb, 'Width/Depth not measured - box size only reflects height + foam padding', 34),
  ('multidrawer-plinth-high', 'MultiDrawer Plinth', 'High', NULL, NULL, 118, 'Bubble', 50, 100, 100, 218, '[{"field":"title","contains":"multidrawer plinth"}]'::jsonb, 'Width/Depth not measured - box size only reflects height + foam padding', 35),
  ('note-pedestal-300-stationery', 'Note Pedestal (3 Stationery Drawers, 300mm)', '', 300, 565, 495, 'Foam Corners', 50, 400, 665, 595, '[{"field":"title","contains":"note pedestal (3 stationery drawers, 300mm)"}]'::jsonb, NULL, 36),
  ('note-pedestal-2-intermediate', 'Note Pedestal - 2 intermediate', '', 300, 565, 565, 'Foam Corners', 50, 400, 665, 665, '[{"field":"handle","contains":"300w"}]'::jsonb, 'No exact title match in Medusa - matched by the 300mm-width handle convention. Please verify against your colleague.', 37),
  ('note-pedestal-420-stationery', 'Note Pedestal (3 Stationery Drawers, 420mm)', '', 420, 565, 495, 'Foam Corners', 50, 520, 665, 595, '[{"field":"title","contains":"note pedestal (3 stationery drawers, 420mm)"}]'::jsonb, NULL, 38),
  ('note-pedestal-3-drawer-combo', 'Note Pedestal - 3 drawers', '3-drawer pedestal with 2 stationery and 1 filing drawer, Combination 420', 420, 565, 645, 'Foam Corners', 50, 520, 665, 745, '[{"field":"title","contains":"combination"},{"field":"handle","contains":"420"}]'::jsonb, NULL, 39)
   ON CONFLICT (code) DO UPDATE SET
     product_range = EXCLUDED.product_range,
     product_label = EXCLUDED.product_label,
     width_mm = EXCLUDED.width_mm,
     depth_mm = EXCLUDED.depth_mm,
     height_mm = EXCLUDED.height_mm,
     protection_type = EXCLUDED.protection_type,
     foam_thickness_mm = EXCLUDED.foam_thickness_mm,
     box_internal_width_mm = EXCLUDED.box_internal_width_mm,
     box_internal_depth_mm = EXCLUDED.box_internal_depth_mm,
     box_internal_height_mm = EXCLUDED.box_internal_height_mm,
     match_rules = EXCLUDED.match_rules,
     notes = EXCLUDED.notes,
     sort_order = EXCLUDED.sort_order,
     updated_at = NOW()`,
];

export async function ensureFulfillmentSchema() {
  for (const statement of STATEMENTS) {
    await query(statement);
  }
  console.log('✓ Fulfillment schema verified');
}
