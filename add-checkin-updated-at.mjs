#!/usr/bin/env node
/**
 * Migration: Add updated_at column to checkin_items table
 * Run: node add-checkin-updated-at.mjs
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
    console.log('Adding updated_at column to checkin_items...');
    await client.query(`
      ALTER TABLE checkin_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()
    `);
    console.log('✅ Successfully added updated_at column to checkin_items');
    
    // Verify the column exists
    const result = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'checkin_items' AND column_name = 'updated_at'
    `);
    if (result.rows[0]) {
      console.log('✅ Verified: updated_at column exists');
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
