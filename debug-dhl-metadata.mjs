#!/usr/bin/env node
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function main() {
  try {
    const result = await pool.query(
      `SELECT service_code, service_name, metadata FROM shipping_services 
       WHERE courier_code='dhl' OR service_code LIKE 'dhl%'
       ORDER BY service_name`
    );
    
    console.log('DHL Services in Database:');
    console.log('==========================\n');
    
    for (const row of result.rows) {
      console.log(`Service: ${row.service_code}`);
      console.log(`Name: ${row.service_name}`);
      console.log('Metadata:');
      console.log(JSON.stringify(row.metadata, null, 2));
      console.log('\n');
      
      if (row.metadata?.weight_tiers) {
        console.log(`✓ weight_tiers exists: ${row.metadata.weight_tiers.length} tiers`);
      } else {
        console.log('✗ weight_tiers missing or undefined');
      }
      console.log('---\n');
    }
    
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
