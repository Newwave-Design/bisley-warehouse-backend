import pg from 'pg';

const { Client } = pg;

const client = new Client({
  host: 'trolley.proxy.rlwy.net',
  port: 54919,
  user: 'postgres',
  password: 'BkKGzotqfkjPQeRQjIDLywPxRLRFEZRL',
  database: 'railway',
  ssl: { rejectUnauthorized: false },
});

await client.connect();

const result = await client.query(
  `SELECT service_code, metadata->'surcharges'->'heavy_weight_kg' AS heavy_weight FROM shipping_services WHERE courier_code = 'dhl' ORDER BY service_code`
);

for (const row of result.rows) {
  console.log(`\n${row.service_code}:`);
  console.log(JSON.stringify(row.heavy_weight, null, 2));
}

await client.end();
process.exit(0);
