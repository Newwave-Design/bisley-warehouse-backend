import pg from 'pg';
import { WAREHOUSE_SCHEMA } from './schema.js';

const { Client } = pg;

async function runMigrations() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log('✓ Connected to PostgreSQL');

    // Execute schema creation
    await client.query(WAREHOUSE_SCHEMA);
    console.log('✓ Warehouse schema created/verified');

    // Verify tables exist
    const result = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);

    console.log('\n📋 Created tables:');
    result.rows.forEach(row => console.log(`   - ${row.table_name}`));

    console.log('\n✅ Migrations completed successfully');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigrations();
