import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.WAREHOUSE_DATABASE_URL,
  ssl: process.env.WAREHOUSE_DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

const res = await pool.query(`
  SELECT sku, product_name, family, reorder_point, reorder_qty, monthly_demand, 
         COALESCE(SUM(wi.quantity), 0)::int AS current_stock,
         is_active
  FROM reorder_rules rr
  LEFT JOIN warehouse_inventory wi ON wi.product_sku = rr.sku
  GROUP BY rr.id
  ORDER BY sku
  LIMIT 30
`);

console.log('\n=== REORDER RULES SAMPLE ===\n');
res.rows.forEach(row => {
  console.log(`SKU: ${row.sku}`);
  console.log(`  Product: ${row.product_name}`);
  console.log(`  Family: ${row.family}`);
  console.log(`  Monthly Demand: ${row.monthly_demand}`);
  console.log(`  Reorder Point: ${row.reorder_point}`);
  console.log(`  Order Quantity: ${row.reorder_qty}`);
  console.log(`  Current Stock: ${row.current_stock}`);
  console.log(`  Active: ${row.is_active}`);
  console.log('');
});

console.log(`Total rules shown: ${res.rows.length}`);
await pool.end();
