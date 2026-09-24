/**
 * Audit script: compares the Medusa commerce catalogue against the WMS's
 * wms_products cache and warehouse_inventory ledger to find:
 *   1. Live (non-deleted) Medusa variants missing entirely from wms_products (never synced)
 *   2. wms_products rows that no longer exist as a live Medusa variant (stale/deleted in Medusa)
 *   3. manage_inventory=true variants with ZERO warehouse_inventory rows (no initial stock set up)
 *   4. warehouse_inventory rows whose SKU doesn't match any current Medusa variant (orphaned)
 *   5. Published Medusa variants excluded from sync because dims/weight are incomplete
 *      (the /api/products/sync route silently skips these)
 *
 * Run: node audit-catalogue-sync.mjs
 * Reads DATABASE_URL (Medusa/Neon) and WAREHOUSE_DATABASE_URL (WMS/Railway) from
 * ../../.env.local (the monorepo's canonical .env.local, one level above apps/).
 */
import * as dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env.local') });

const { DATABASE_URL, WAREHOUSE_DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL (Medusa/Neon) not set');
if (!WAREHOUSE_DATABASE_URL) throw new Error('WAREHOUSE_DATABASE_URL (WMS/Railway) not set');

const medusaClient = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const wmsClient = new pg.Client({ connectionString: WAREHOUSE_DATABASE_URL, ssl: { rejectUnauthorized: false } });

await medusaClient.connect();
await wmsClient.connect();
console.log('Connected to Medusa (Neon) and WMS (Railway).\n');

// ── Pull all live (not soft-deleted) Medusa product/variant data ──────────────
const { rows: medusaVariants } = await medusaClient.query(`
  SELECT
    p.id            AS product_id,
    p.title         AS product_title,
    p.handle        AS product_handle,
    p.status        AS product_status,
    v.id            AS variant_id,
    v.sku,
    v.title         AS variant_title,
    v.manage_inventory,
    v.allow_backorder,
    v.weight, v.height, v.width, v.length,
    p.weight AS p_weight, p.height AS p_height, p.width AS p_width, p.length AS p_length
  FROM product p
  JOIN product_variant v ON v.product_id = p.id
  WHERE p.deleted_at IS NULL AND v.deleted_at IS NULL
`);
console.log(`Medusa: ${medusaVariants.length} live variants across all products/statuses.`);

const bySku = new Map(medusaVariants.filter(v => v.sku).map(v => [v.sku, v]));
const publishedVariants = medusaVariants.filter(v => v.product_status === 'published');
console.log(`Medusa: ${publishedVariants.length} live variants on PUBLISHED products.`);
const skuDupes = medusaVariants.length - bySku.size;
if (skuDupes > 0) console.log(`⚠️  ${skuDupes} variants have missing/duplicate SKUs (excluded from SKU-keyed comparisons).\n`);
else console.log();

// ── Pull WMS cache + inventory ──────────────────────────────────────────────
const { rows: wmsRows } = await wmsClient.query(`
  SELECT medusa_variant_id, variant_sku, product_title, product_status, manage_inventory, is_kit, last_synced_at
  FROM wms_products
`);
const wmsBySku = new Map(wmsRows.map(r => [r.variant_sku, r]));
console.log(`WMS wms_products cache: ${wmsRows.length} rows.`);

const { rows: invRows } = await wmsClient.query(`
  SELECT product_sku, SUM(quantity)::int AS total_qty, COUNT(*)::int AS location_count
  FROM warehouse_inventory GROUP BY product_sku
`);
const invBySku = new Map(invRows.map(r => [r.product_sku, r]));
console.log(`WMS warehouse_inventory: ${invRows.length} distinct SKUs with stock rows.\n`);

// ── 1. Published Medusa variants missing from wms_products entirely ─────────
const missingFromWms = publishedVariants.filter(v => v.sku && !wmsBySku.has(v.sku));
console.log(`\n=== 1. Published Medusa variants NEVER synced to WMS (${missingFromWms.length}) ===`);
for (const v of missingFromWms.slice(0, 50)) {
  const hasDims = [v.weight ?? v.p_weight, v.height ?? v.p_height, v.width ?? v.p_width, v.length ?? v.p_length].every(x => x != null);
  console.log(`  ${v.sku.padEnd(24)} ${v.product_title.slice(0, 40).padEnd(42)} manage_inv=${v.manage_inventory} dims_complete=${hasDims}`);
}
if (missingFromWms.length > 50) console.log(`  ...and ${missingFromWms.length - 50} more`);

// ── 2. wms_products rows referencing a variant no longer live in Medusa ──────
const wmsOrphaned = wmsRows.filter(r => !bySku.has(r.variant_sku));
console.log(`\n=== 2. WMS wms_products rows with NO matching live Medusa variant (stale/deleted) (${wmsOrphaned.length}) ===`);
for (const r of wmsOrphaned.slice(0, 50)) {
  console.log(`  ${r.variant_sku.padEnd(24)} ${(r.product_title ?? '').slice(0, 40).padEnd(42)} status=${r.product_status} last_synced=${r.last_synced_at ?? 'never'}`);
}
if (wmsOrphaned.length > 50) console.log(`  ...and ${wmsOrphaned.length - 50} more`);

// ── 3. manage_inventory variants with zero warehouse_inventory rows ──────────
const managedNoStock = publishedVariants.filter(v => v.sku && v.manage_inventory && !invBySku.has(v.sku));
console.log(`\n=== 3. Published, stock-managed Medusa variants with NO warehouse_inventory row (no initial stock/bin set up) (${managedNoStock.length}) ===`);
for (const v of managedNoStock.slice(0, 50)) {
  console.log(`  ${v.sku.padEnd(24)} ${v.product_title.slice(0, 40).padEnd(42)} allow_backorder=${v.allow_backorder}`);
}
if (managedNoStock.length > 50) console.log(`  ...and ${managedNoStock.length - 50} more`);

// ── 4. warehouse_inventory SKUs with no matching live Medusa variant ─────────
const invOrphaned = invRows.filter(r => !bySku.has(r.product_sku));
console.log(`\n=== 4. warehouse_inventory SKUs with NO matching live Medusa variant (orphaned stock) (${invOrphaned.length}) ===`);
for (const r of invOrphaned.slice(0, 50)) {
  console.log(`  ${r.product_sku.padEnd(24)} qty=${r.total_qty}  locations=${r.location_count}`);
}
if (invOrphaned.length > 50) console.log(`  ...and ${invOrphaned.length - 50} more`);

// ── 5. Published variants excluded from sync due to incomplete dims/weight ───
const incompleteDims = publishedVariants.filter(v => {
  const hasDims = [v.weight ?? v.p_weight, v.height ?? v.p_height, v.width ?? v.p_width, v.length ?? v.p_length].every(x => x != null);
  return v.sku && !hasDims;
});
console.log(`\n=== 5. Published variants with INCOMPLETE weight/dimensions (silently excluded from every future /sync) (${incompleteDims.length}) ===`);
for (const v of incompleteDims.slice(0, 50)) {
  console.log(`  ${v.sku.padEnd(24)} ${v.product_title.slice(0, 40).padEnd(42)} in_wms=${wmsBySku.has(v.sku)}`);
}
if (incompleteDims.length > 50) console.log(`  ...and ${incompleteDims.length - 50} more`);

// ── Summary + JSON dump ───────────────────────────────────────────────────────
const summary = {
  generated_at: new Date().toISOString(),
  medusa_live_variants: medusaVariants.length,
  medusa_published_variants: publishedVariants.length,
  wms_products_rows: wmsRows.length,
  warehouse_inventory_skus: invRows.length,
  missing_from_wms: missingFromWms.map(v => v.sku),
  wms_orphaned: wmsOrphaned.map(r => r.variant_sku),
  managed_no_stock: managedNoStock.map(v => v.sku),
  inventory_orphaned: invOrphaned.map(r => r.product_sku),
  incomplete_dims: incompleteDims.map(v => v.sku),
};
const outPath = path.join(__dirname, 'catalogue-sync-audit-report.json');
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));

console.log('\n=== SUMMARY ===');
console.log(`Medusa live variants (any status):      ${summary.medusa_live_variants}`);
console.log(`Medusa published variants:               ${summary.medusa_published_variants}`);
console.log(`WMS wms_products rows:                    ${summary.wms_products_rows}`);
console.log(`WMS warehouse_inventory distinct SKUs:    ${summary.warehouse_inventory_skus}`);
console.log(`1. Never synced to WMS:                   ${missingFromWms.length}`);
console.log(`2. Stale WMS rows (deleted in Medusa):     ${wmsOrphaned.length}`);
console.log(`3. Managed variants w/ no stock row:       ${managedNoStock.length}`);
console.log(`4. Orphaned warehouse_inventory SKUs:      ${invOrphaned.length}`);
console.log(`5. Published w/ incomplete dims (sync gap):${incompleteDims.length}`);
console.log(`\nFull SKU lists written to ${outPath}`);

await medusaClient.end();
await wmsClient.end();
