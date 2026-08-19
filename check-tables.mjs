import pg from 'pg';

const { Client } = pg;

(async () => {
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  await c.connect();
  const r = await c.query(
    "SELECT table_name FROM information_schema.tables WHERE table_name IN ('sku_mappings', 'nw_stocking_items')"
  );
  console.log('Tables found:', r.rows);
  await c.end();
})();
