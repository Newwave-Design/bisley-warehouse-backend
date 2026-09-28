import * as dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: '.env.local' });

const db = new pg.Pool({ connectionString: process.env.WAREHOUSE_DATABASE_URL });

async function run() {
  try {
    // Show product ranges
    console.log('\n=== PRODUCT RANGES (from wms_products) ===');
    const ranges = await db.query(`
      SELECT DISTINCT product_title 
      FROM wms_products 
      WHERE is_archived = false
      ORDER BY product_title
      LIMIT 15
    `);
    console.log('Sample products:');
    ranges.rows.forEach(r => console.log('  ' + r.product_title));

    // Show colour distribution
    console.log('\n=== UNIQUE COLOURS (from wms_products) ===');
    const colours = await db.query(`
      SELECT DISTINCT colour_code, colour_name 
      FROM wms_products 
      WHERE colour_code IS NOT NULL 
      AND is_archived = false
      ORDER BY colour_code
    `);
    console.log('Found ' + colours.rows.length + ' unique colours:');
    colours.rows.forEach(r => console.log('  ' + r.colour_code + ' = ' + r.colour_name));

    // Show barcode samples
    console.log('\n=== BARCODE SAMPLE ===');
    const barcodes = await db.query(`
      SELECT barcode, product_sku, colour_code, colour_name, product_name 
      FROM barcode_mappings 
      LIMIT 8
    `);
    console.log('Sample barcodes:');
    barcodes.rows.forEach(r => {
      console.log(`  Barcode: ${r.barcode} -> SKU: ${r.product_sku} (${r.colour_code} ${r.colour_name})`);
    });

    // Show inventory structure
    console.log('\n=== INVENTORY EXAMPLE ===');
    const inv = await db.query(`
      SELECT wi.product_sku, wi.colour_code, wl.location_code, wi.quantity, wi.quantity_reserved
      FROM warehouse_inventory wi
      JOIN warehouse_locations wl ON wi.location_id = wl.id
      LIMIT 8
    `);
    console.log('Sample inventory rows:');
    inv.rows.forEach(r => {
      console.log(`  SKU: ${r.product_sku}, Colour: ${r.colour_code}, Location: ${r.location_code}, Qty: ${r.quantity} (reserved: ${r.quantity_reserved})`);
    });

    // Show tables
    console.log('\n=== ALL TABLES ===');
    const tables = await db.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    console.log('Total tables: ' + tables.rows.length);
    console.log(tables.rows.map(r => '  ' + r.table_name).join('\n'));

    // Show SKU samples with product info
    console.log('\n=== SKU SAMPLES ===');
    const skus = await db.query(`
      SELECT DISTINCT variant_sku, product_title, colour_code, colour_name, manage_inventory, is_kit
      FROM wms_products 
      WHERE is_archived = false
      ORDER BY variant_sku
      LIMIT 20
    `);
    console.log('Sample SKUs:');
    skus.rows.forEach(r => {
      const kitInfo = r.is_kit ? ' [KIT]' : '';
      console.log(`  ${r.variant_sku}: ${r.product_title} (${r.colour_code}/${r.colour_name})${kitInfo}`);
    });

  } catch(err) {
    console.error('DB Error:', err.message);
  } finally {
    await db.end();
  }
}

run();
