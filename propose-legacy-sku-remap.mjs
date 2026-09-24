/**
 * READ-ONLY PROPOSAL — does not write anything.
 *
 * 23 warehouse_inventory rows are keyed by SKUs that predate the PFA2/PFA3 Home Filer kit
 * restructure in Medusa (bare "PFA2-{colour}" / "PFA3-{colour}") and a discontinued bare
 * "MDWLEG". These SKUs no longer match any live Medusa variant, so this physical stock is
 * currently invisible to Medusa/the storefront.
 *
 * Live Medusa kit structure confirmed 2026-09-24:
 *   PFA2OH-{colour} (Home Filer, Oak Handles)   = kit of [PFA2NH-{colour} body, HANDLE-OAK]
 *   PFA2SH-{colour} (Home Filer, Steel Handles)  = kit of [PFA2NH-{colour} body, HANDLE-STEEL?]
 *   PFA2WALH-{colour}                            = kit of [PFA2NH-{colour} body, HANDLE-?]
 *   PFA2NH-{colour} (body only, no handle)       = real stocked component
 *   (same pattern for PFA3)
 *
 * The old bare "PFA2-{colour}" stock most likely represents the BODY component (the physical
 * item Mark actually receives/counts) — i.e. should probably remap to PFA2NH-{colour} — but
 * this is a judgement call requiring warehouse operator confirmation, NOT something to guess
 * and auto-apply against real stock records.
 *
 * Run: node propose-legacy-sku-remap.mjs
 */
import * as dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env.local') });

const medusa = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const wms = new pg.Client({ connectionString: process.env.WAREHOUSE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
await medusa.connect(); await wms.connect();

const { rows: orphaned } = await wms.query(`
  SELECT product_sku, SUM(quantity)::int AS qty, COUNT(*)::int AS locations
  FROM warehouse_inventory
  GROUP BY product_sku
`);

// Build a live-SKU lookup from Medusa directly (avoids relying on wms_products being current).
const { rows: liveSkus } = await medusa.query(`
  SELECT v.sku FROM product_variant v JOIN product p ON p.id = v.product_id
  WHERE v.deleted_at IS NULL AND p.deleted_at IS NULL AND v.sku IS NOT NULL
`);
const liveSet = new Set(liveSkus.map(r => r.sku));

const trulyOrphaned = orphaned.filter(r => !liveSet.has(r.product_sku));

console.log(`${trulyOrphaned.length} orphaned warehouse_inventory SKUs found.\n`);
console.log('SKU'.padEnd(20), 'QTY'.padEnd(6), 'LOCATIONS'.padEnd(10), 'PROPOSED TARGET (needs your confirmation)');
for (const r of trulyOrphaned) {
  let proposed = '??? (unknown pattern — needs manual review)';
  const m = /^(PFA[23])-([a-z]{2}\d)$/.exec(r.product_sku);
  if (m) proposed = `${m[1]}NH-${m[2]}  (body/no-handle component)`;
  else if (r.product_sku === 'MDWLEG') proposed = 'MDWLEG-000  (self-colour oak, discontinued bare code)';
  console.log(r.product_sku.padEnd(20), String(r.qty).padEnd(6), String(r.locations).padEnd(10), proposed);
}

console.log(`
NOT applied automatically. To apply after you confirm the target SKUs are correct, for each
row run (adjust target as needed):
  UPDATE warehouse_inventory SET product_sku = '<TARGET_SKU>' WHERE product_sku = '<OLD_SKU>';
Then re-run audit-catalogue-sync.mjs to confirm 0 orphaned rows remain.
`);

await medusa.end(); await wms.end();
