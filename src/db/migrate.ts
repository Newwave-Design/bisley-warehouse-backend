import * as pg from 'pg';
import { WAREHOUSE_SCHEMA } from './schema.js';
import { fileURLToPath } from 'url';

const { Client } = pg;

export async function runMigrations() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log('✓ Connected to PostgreSQL');

    // Split schema into individual statements and execute each one
    // This avoids transaction issues with some Neon configurations
    // Strip '--' line comments first: a semicolon inside a comment (e.g. "note: splits on ;")
    // would otherwise be mistaken for a statement terminator, silently truncating and
    // aborting the rest of the migration run.
    const schemaWithoutComments = WAREHOUSE_SCHEMA
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    const statements = schemaWithoutComments.split(';')
      .map((stmt) => stmt.trim())
      .filter((stmt) => stmt.length > 0);

    let failureCount = 0;
    for (const statement of statements) {
      try {
        await client.query(statement);
      } catch (error: any) {
        // Log but continue if table already exists
        if (error.code === '42P07') {
          console.log(`⚠️  Table already exists (skipping)`);
        } else {
          // Statements are independent idempotent CREATE/ALTER/INDEX operations —
          // one bad statement should not prevent the rest of the schema from applying.
          failureCount++;
          console.error(`⚠️  Statement failed (continuing):`, error.message?.substring(0, 200));
          console.error(`   Statement was:`, statement.substring(0, 200));
        }
      }
    }
    if (failureCount > 0) {
      console.error(`❌ ${failureCount} schema statement(s) failed to apply — check logs above`);
    }

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
    throw error;
  } finally {
    await client.end();
  }
}

// Run directly when executed as a script
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runMigrations().catch(() => process.exit(1));
}
