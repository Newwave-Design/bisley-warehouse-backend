#!/usr/bin/env node
/**
 * Debug: Check checkin_items and product lookup data
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const pool = new Pool({
  connectionString: process.env.WAREHOUSE_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const client = await pool.connect();
  try {
    console.log('\n=== RECENT CHECKIN ITEMS ===');
    const items = await client.query(`
      SELECT id, nw_code, colour, medusa_sku, quantity_scanned, created_at 
      FROM checkin_items 
      ORDER BY created_at DESC 
      LIMIT 5
    `);
    console.log(JSON.stringify(items.rows, null, 2));

    if (items.rows[0]) {
      const nw_code = items.rows[0].nw_code;
      const colour = items.rows[0].colour;
      
      console.log(`\n=== WMS_PRODUCTS for NW_CODE="${nw_code}" ===`);
      const wms = await client.query(`
        SELECT nw_code, colour_code, colour_name, product_title, variant_sku, medusa_product_id
        FROM wms_products 
        WHERE nw_code = $1
        LIMIT 5
      `, [nw_code]);
      console.log(JSON.stringify(wms.rows, null, 2));

      console.log(`\n=== BARCODE_MAPPINGS for PRODUCT_SKU="${nw_code}" ===`);
      const bm = await client.query(`
        SELECT product_sku, colour_code, colour_name, product_name, is_active
        FROM barcode_mappings 
        WHERE product_sku = $1 
        LIMIT 5
      `, [nw_code]);
      console.log(JSON.stringify(bm.rows, null, 2));

      console.log(`\n=== CURRENT QUERY RESULT (enriched) ===`);
      const enriched = await client.query(`
        SELECT 
          ci.nw_code,
          ci.colour,
          COALESCE(bm.product_name, wp.product_title, 'Unknown') as product_name,
          COALESCE(bm.colour_code, wp.colour_code, '') as colour_code,
          COALESCE(bm.colour_name, wp.colour_name, ci.colour) as colour_name
        FROM checkin_items ci
        LEFT JOIN barcode_mappings bm ON bm.product_sku = ci.nw_code AND bm.is_active = true
        LEFT JOIN wms_products wp ON wp.nw_code = ci.nw_code
        WHERE ci.nw_code = $1
        ORDER BY ci.created_at DESC
        LIMIT 1
      `, [nw_code]);
      console.log(JSON.stringify(enriched.rows, null, 2));
    }
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
