#!/usr/bin/env node
/**
 * Debug: Check what product data exists for NW code AA3
 */

import { Pool } from 'pg';

const pool = new Pool({
  connectionString: 'postgresql://postgres:BkKGzotqfkjPQeRQjIDLywPxRLRFEZRL@trolley.proxy.rlwy.net:54919/railway',
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const client = await pool.connect();
  try {
    console.log('\n=== Checking wms_products for nw_code = AA3 ===');
    const wms = await client.query(
      `SELECT nw_code, product_title, colour_name, colour_code, variant_sku FROM wms_products WHERE nw_code = 'AA3' LIMIT 10`
    );
    console.log(`Found ${wms.rows.length} rows in wms_products:`);
    wms.rows.forEach(r => console.log(`  ${r.nw_code} | ${r.product_title} | ${r.colour_name} (${r.colour_code}) | SKU: ${r.variant_sku}`));

    console.log('\n=== Checking barcode_mappings for product_sku = AA3 ===');
    const bm = await client.query(
      `SELECT product_sku, product_name, colour_name, colour_code, barcode FROM barcode_mappings WHERE product_sku = 'AA3' AND is_active = true LIMIT 10`
    );
    console.log(`Found ${bm.rows.length} rows in barcode_mappings:`);
    bm.rows.forEach(r => console.log(`  ${r.product_sku} | ${r.product_name} | ${r.colour_name} (${r.colour_code}) | Barcode: ${r.barcode}`));

    console.log('\n=== Checking if AA3 exists anywhere in sku_mappings ===');
    const sm = await client.query(
      `SELECT nw_code, product_name, medusa_sku FROM sku_mappings WHERE nw_code = 'AA3' LIMIT 5`
    );
    console.log(`Found ${sm.rows.length} rows in sku_mappings:`);
    sm.rows.forEach(r => console.log(`  ${r.nw_code} | ${r.product_name} | ${r.medusa_sku}`));

  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
