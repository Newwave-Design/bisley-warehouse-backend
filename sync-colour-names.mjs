#!/usr/bin/env node
/**
 * Sync colour_name from wms_products to barcode_mappings
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const pool = new Pool({
  connectionString: process.env.WAREHOUSE_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const run = async () => {
  const c = await pool.connect();
  try {
    console.log('Syncing colour_name from wms_products to barcode_mappings...');
    
    const result = await c.query(`
      UPDATE barcode_mappings bm
      SET colour_name = wp.colour_name
      FROM wms_products wp
      WHERE bm.colour_code = wp.colour_code 
        AND bm.colour_name IS NULL
        AND wp.colour_name IS NOT NULL
      RETURNING bm.product_sku, bm.colour_code, bm.colour_name
    `);
    
    console.log(`✅ Updated ${result.rowCount} rows`);
    
    if (result.rows.length > 0) {
      console.log('\nSample updates:');
      console.log(JSON.stringify(result.rows.slice(0, 5), null, 2));
    }
    
    // Verify the changes
    console.log('\n=== Verification: barcode_mappings for scanned SKUs ===');
    const verify = await c.query(`
      SELECT DISTINCT product_sku, colour_code, colour_name, product_name
      FROM barcode_mappings 
      WHERE product_sku IN ('H123NL-aa3', '3643-aa3', '3633-aa3')
      LIMIT 3
    `);
    console.log(JSON.stringify(verify.rows, null, 2));
  } finally {
    c.release();
    await pool.end();
  }
};
run();
