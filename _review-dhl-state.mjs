// One-off diagnostic: review DHL shipping services, wms_products sync state, and fulfillment profiles
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.WAREHOUSE_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  try {
    console.log('=== shipping_services ===');
    const services = await pool.query(`
      SELECT service_code, courier_code, courier_name, service_name, is_active,
             jsonb_typeof(metadata) as metadata_type,
             metadata ? 'weight_tiers' as has_weight_tiers,
             metadata ? 'surcharges' as has_surcharges,
             jsonb_array_length(coalesce(metadata->'weight_tiers','[]'::jsonb)) as tier_count
      FROM shipping_services
      ORDER BY courier_code, sort_order
    `);
    console.table(services.rows);

    console.log('\n=== DHL service full metadata sample ===');
    const dhl = await pool.query(`SELECT service_code, metadata FROM shipping_services WHERE courier_code='dhl' LIMIT 3`);
    dhl.rows.forEach(r => console.log(r.service_code, JSON.stringify(r.metadata, null, 2).slice(0, 600)));

    console.log('\n=== wms_products counts ===');
    const wp = await pool.query(`
      SELECT count(*) as total,
             count(*) FILTER (WHERE last_synced_at > now() - interval '1 day') as synced_today,
             count(*) FILTER (WHERE weight_grams IS NULL AND variant_weight_grams IS NULL) as missing_weight,
             max(last_synced_at) as last_sync
      FROM wms_products
    `);
    console.table(wp.rows);

    console.log('\n=== product_fulfillment_profiles counts ===');
    const pfp = await pool.query(`
      SELECT count(*) as total,
             count(*) FILTER (WHERE estimated_shipping_cost_gbp IS NULL OR estimated_shipping_cost_gbp = 0) as zero_or_null_cost,
             count(*) FILTER (WHERE preferred_service_code IS NOT NULL) as has_preferred_service,
             count(DISTINCT preferred_service_code) as distinct_services
      FROM product_fulfillment_profiles
    `);
    console.table(pfp.rows);

    console.log('\n=== sample fulfillment profiles ===');
    const sample = await pool.query(`
      SELECT product_sku, preferred_service_code, estimated_shipping_cost_gbp, pack_instructions
      FROM product_fulfillment_profiles
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 5
    `);
    console.table(sample.rows);
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
})();
