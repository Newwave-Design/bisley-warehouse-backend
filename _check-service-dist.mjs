import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.WAREHOUSE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const r = await pool.query(`SELECT preferred_service_code, count(*) FROM product_fulfillment_profiles GROUP BY preferred_service_code ORDER BY 2 DESC`);
  console.table(r.rows);
  await pool.end();
})();
