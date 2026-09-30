#!/usr/bin/env node
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
    console.log('=== Colour for aa3 in wms_products ===');
    const r1 = await c.query(`
      SELECT DISTINCT colour_code, colour_name FROM wms_products 
      WHERE colour_code = 'aa3' 
      LIMIT 3
    `);
    console.log(JSON.stringify(r1.rows, null, 2));
    
    console.log('\n=== All distinct colour codes and names ===');
    const r2 = await c.query(`
      SELECT DISTINCT colour_code, colour_name FROM wms_products 
      WHERE colour_code IS NOT NULL AND colour_name IS NOT NULL 
      ORDER BY colour_code
      LIMIT 10
    `);
    console.log(JSON.stringify(r2.rows, null, 2));
  } finally {
    c.release();
    await pool.end();
  }
};
run();
