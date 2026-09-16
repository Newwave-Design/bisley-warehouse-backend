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

const correctSurcharges = [
  { min_kg: 25.01, max_kg: 30, surcharge_gbp: 1.50 },
  { min_kg: 30.01, max_kg: 32, surcharge_gbp: 30.00 },
  { min_kg: 32.01, max_kg: 34, surcharge_gbp: 35.00 },
  { min_kg: 34.01, max_kg: 36, surcharge_gbp: 40.00 },
  { min_kg: 36.01, max_kg: 500, surcharge_gbp: 50.00 },
];

const zones = ['dhl_parcel_zone_a', 'dhl_parcel_zone_b', 'dhl_parcel_zone_c', 'dhl_parcel_zone_d'];

for (const zone of zones) {
  const metadata = (await client.query(`SELECT metadata FROM shipping_services WHERE service_code = $1`, [zone])).rows[0];
  if (!metadata) {
    console.log(`⚠️  ${zone} not found`);
    continue;
  }

  const updated = { ...metadata.metadata, surcharges: { ...metadata.metadata.surcharges, heavy_weight_kg: correctSurcharges } };
  
  await client.query(
    `UPDATE shipping_services SET metadata = $1 WHERE service_code = $2`,
    [JSON.stringify(updated), zone]
  );
  
  console.log(`✓ Updated ${zone}`);
}

await client.end();
console.log('\n✓ All DHL surcharge bands corrected');
process.exit(0);
