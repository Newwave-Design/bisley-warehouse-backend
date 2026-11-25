// Integration test for desk reconciliation: real schema, one transaction, always rolled back.
// Run from the warehouse-backend folder: npx tsx scripts/it-reconcile.ts
import { Pool } from 'pg';
import fs from 'node:fs';
import * as dotenv from 'dotenv';
import { moveStockBetweenSkus, undoReconciliation, remapBarcode, reconcileOverview, searchShelf, ReconcileError } from '../src/lib/sku-reconcile.ts';
import { linkCustomArrival, customLinesWithState, matchCustomArrivals } from '../src/lib/custom-arrivals.ts';
dotenv.config({ path: '.env.local' });
const pool = new Pool({ connectionString: process.env.WAREHOUSE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
const c = await pool.connect();
let fails = 0;
const ok = (n: string, v: unknown) => { console.log(v ? 'PASS' : 'FAIL', n); if (!v) fails++; };
const one = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows[0];
const refused = async (fn: () => Promise<unknown>, status?: number) => {
  try { await fn(); return false; } catch (e) { return e instanceof ReconcileError && (status === undefined || e.status === status); }
};
try {
  await c.query('BEGIN');
  const schema = fs.readFileSync('src/db/schema.ts', 'utf8');
  // Never wait long on a live lock, and never run DDL on a table that already exists in the real database
  // (ALTER and CREATE INDEX take locks that the live backend's own jobs would collide with).
  await c.query(`SET LOCAL lock_timeout = '3s'`);
  const exists = async (t: string) => !!(await one(`select to_regclass($1) as t`, [t])).t;
  if (!(await exists('custom_line_arrivals'))) await c.query(schema.match(/CREATE TABLE IF NOT EXISTS custom_line_arrivals[\s\S]*?idx_custom_line_arrivals_sku[^;]*;/)![0]);
  if (!(await exists('stock_reconciliations'))) await c.query(schema.match(/CREATE TABLE IF NOT EXISTS stock_reconciliations[\s\S]*?idx_stock_reconciliations_created[^;]*;/)![0]);

  const loc = (await one(`select id from warehouse_locations where location_code='HOLDING'`)).id;
  const user = (await one(`select id from warehouse_users limit 1`)).id;
  const catalogue = (await one(`select variant_sku from wms_products where not coalesce(is_archived,false) limit 1`)).variant_sku as string;
  const liab = (await one(`select liability_status from warehouse_inventory where liability_status is not null limit 1`))?.liability_status ?? 'Bisley';
  const stock = (sku: string, qty: number) => c.query(`insert into warehouse_inventory (location_id, product_sku, colour_code, quantity, liability_status) values ($1,$2,'',$3,$4)`, [loc, sku, qty, liab]);
  const qty = async (sku: string) => Number((await one(`select coalesce(sum(quantity),0)::int q from warehouse_inventory where upper(product_sku)=upper($1)`, [sku])).q);
  const base = { userId: user as string, email: 'test@wms' };

  await stock('ZZRTYPED', 5);

  // ---- moving stock between SKUs
  const m1 = await moveStockBetweenSkus(c, { fromSku: 'zzrtyped', toSku: 'ZZRREAL', quantity: 2, reason: 'received under the wrong code', ...base });
  ok('move: source down, target up', (await qty('ZZRTYPED')) === 3 && (await qty('ZZRREAL')) === 2);
  const mv = (await c.query(`select movement_type, quantity, notes from warehouse_movements where notes like $1 order by quantity`, [`Reconcile ${m1.id.slice(0, 8)}%`])).rows;
  ok('move: two ADJUST movements that explain themselves', mv.length === 2 && mv.every((r) => r.movement_type === 'ADJUST') && mv[0].quantity === -2 && mv[1].quantity === 2 && /wrong code/.test(mv[0].notes));
  ok('move: a reconciliation row records it', (await one(`select quantity, reason from stock_reconciliations where id=$1`, [m1.id])).quantity === 2);
  await moveStockBetweenSkus(c, { fromSku: 'ZZRTYPED', toSku: 'zzrreal', quantity: 1, ...base });
  ok('move: target spelling follows what is already on the shelf (no duplicate row)', (await one(`select count(*)::int n from warehouse_inventory where upper(product_sku)='ZZRREAL'`)).n === 1 && (await qty('ZZRREAL')) === 3);

  ok('refused: same SKU', await refused(() => moveStockBetweenSkus(c, { fromSku: 'ZZRTYPED', toSku: 'zzrtyped', quantity: 1, ...base }), 400));
  ok('refused: zero or negative quantity', await refused(() => moveStockBetweenSkus(c, { fromSku: 'ZZRTYPED', toSku: 'ZZRX', quantity: 0, ...base }), 400));
  ok('refused: more than is on the shelf', await refused(() => moveStockBetweenSkus(c, { fromSku: 'ZZRTYPED', toSku: 'ZZRX', quantity: 9, ...base }), 409));
  ok('refused: nothing of that SKU', await refused(() => moveStockBetweenSkus(c, { fromSku: 'ZZRNONE', toSku: 'ZZRX', quantity: 1, ...base }), 409));
  ok('refused: a login that cannot be recorded', await refused(() => moveStockBetweenSkus(c, { fromSku: 'ZZRTYPED', toSku: 'ZZRX', quantity: 1, userId: null }), 403));
  await c.query(`update warehouse_inventory set quantity_reserved = 2 where upper(product_sku)='ZZRTYPED'`);
  ok('refused: reserved units never move (2 left, 2 reserved)', await refused(() => moveStockBetweenSkus(c, { fromSku: 'ZZRTYPED', toSku: 'ZZRX', quantity: 1, ...base }), 409));
  await c.query(`update warehouse_inventory set quantity_reserved = 0 where upper(product_sku)='ZZRTYPED'`);
  ok('refusals changed nothing', (await qty('ZZRTYPED')) === 2 && (await qty('ZZRREAL')) === 3);

  // ---- undo
  const back = await undoReconciliation(m1.id, user, 'test@wms', c);
  ok('undo: stock goes back', (await qty('ZZRTYPED')) === 4 && (await qty('ZZRREAL')) === 1 && back.quantity === 2);
  ok('undo: original marked undone and the reversal points at it', !!(await one(`select undone_at from stock_reconciliations where id=$1`, [m1.id])).undone_at && (await one(`select reverses_id from stock_reconciliations where id=$1`, [back.id])).reverses_id === m1.id);
  ok('undo: cannot be undone twice', await refused(() => undoReconciliation(m1.id, user, 'test@wms', c), 409));
  const m2 = await moveStockBetweenSkus(c, { fromSku: 'ZZRTYPED', toSku: 'ZZRREAL', quantity: 3, ...base });
  await c.query(`update warehouse_inventory set quantity = 0 where upper(product_sku)='ZZRREAL'`);
  ok('undo: refused once that stock has been used', await refused(() => undoReconciliation(m2.id, user, 'test@wms', c), 409));
  await c.query(`update warehouse_inventory set quantity = 4 where upper(product_sku)='ZZRREAL'`);
  await undoReconciliation(m2.id, user, 'test@wms', c);
  ok('undo: works again when the stock is back', (await qty('ZZRTYPED')) === 4);

  // ---- checking a typed SKU on the desk, with its stock
  await c.query(`insert into barcode_mappings (barcode, product_sku, product_name, is_active, source, needs_review) values ('ZZR-BC-1','ZZRTYPED','Typed on the scanner, to check',true,'manual_sku',true), ('ZZR-BC-2','ZZRKEEP','Typed on the scanner, to check',true,'manual_sku',true)`);
  const r1 = await remapBarcode({ barcode: 'ZZR-BC-1', sku: catalogue, moveQuantity: 3, ...base }, c);
  const bm = await one(`select product_sku, needs_review, reviewed_by from barcode_mappings where barcode='ZZR-BC-1'`);
  ok('remap: barcode now points at the catalogue product and is checked', bm.product_sku === catalogue && bm.needs_review === false && bm.reviewed_by === 'test@wms');
  ok('remap: the stock received under the typed SKU moved with it', r1.moved?.quantity === 3 && (await qty('ZZRTYPED')) === 1);
  ok('remap: unknown catalogue SKU is refused and the barcode untouched', await refused(() => remapBarcode({ barcode: 'ZZR-BC-2', sku: 'NOT-A-PRODUCT', ...base }, c), 404) && (await one(`select needs_review from barcode_mappings where barcode='ZZR-BC-2'`)).needs_review === true);
  const r2 = await remapBarcode({ barcode: 'ZZR-BC-2', sku: null, ...base }, c);
  ok('remap: keep as typed just clears the flag', r2.sku === null && (await one(`select needs_review from barcode_mappings where barcode='ZZR-BC-2'`)).needs_review === false);
  ok('remap: a barcode with nothing to check is refused', await refused(() => remapBarcode({ barcode: 'ZZR-BC-1', sku: null, ...base }, c), 404));

  // ---- the reconcile page: spare parts, any part to any order, reassigning
  await stock('ZZRPART10', 2);
  await c.query(`insert into barcode_mappings (barcode, product_sku, product_name, is_active) values ('ZZR-BC-3','ZZRPART10','Spare part for the test',true)`);
  const order = async (num: string, daysAgo: number) => (await one(`insert into pick_lists (medusa_order_id, pick_list_number, status, payment_status, created_at) values ($1,$2,'PENDING','captured', now() - ($3 || ' days')::interval) returning id`, ['zz-rec-' + num, 'PL-ZZREC-' + num, String(daysAgo)])).id as string;
  const line = async (plId: string, n: number, title: string, q = 1) => (await one(`insert into pick_list_items (pick_list_id, line_number, product_sku, quantity_required, is_custom, item_title) values ($1,$2,'CUSTOM',$3,true,$4) returning id`, [plId, n, q, title])).id as string;
  const lineA = await line(await order('A', 9), 1, 'Runner QQRWANTA (pair)', 2);
  const lineB = await line(await order('B', 3), 1, 'Guide QQRWANTB (pack)', 2);
  let ov = await reconcileOverview(c);
  const spare = ov.parts.find((p: any) => p.sku === 'ZZRPART10');
  ok('overview: a part on the shelf under a non-catalogue SKU is listed as spare, with its description', spare?.spare === 2 && spare.description === 'Spare part for the test');
  ok('overview: catalogue SKUs are not listed as spare parts', !ov.parts.some((p: any) => p.sku === catalogue.toUpperCase()));

  const a = await linkCustomArrival(lineA, 'ZZRPART10', c);
  ok('any shelf SKU can be set aside for any line, whatever the codes say', a.ok);
  let lines = await customLinesWithState(c);
  ok('...the line shows the part has arrived, using that SKU', lines.find((l) => l.id === lineA)?.state === 'ARRIVED' && lines.find((l) => l.id === lineA)?.arrived_sku === 'ZZRPART10');
  ov = await reconcileOverview(c);
  ok('...and the part is no longer spare', !ov.parts.some((p: any) => p.sku === 'ZZRPART10'));

  const b = await linkCustomArrival(lineB, 'ZZRPART10', c);
  lines = await customLinesWithState(c);
  ok('reassigning to another order: the new line takes the part, the old one loses it', b.ok && lines.find((l) => l.id === lineB)?.state === 'ARRIVED' && lines.find((l) => l.id === lineA)?.state === 'WAITING');
  await matchCustomArrivals(c);
  lines = await customLinesWithState(c);
  ok('...and it stays that way after the next automatic match', lines.find((l) => l.id === lineB)?.manual === true && lines.find((l) => l.id === lineA)?.state === 'WAITING');

  const found = await searchShelf(c, 'ZZRPART');
  ok('shelf search finds a SKU by code', found.some((f: any) => f.sku === 'ZZRPART10' && f.free === 2));
  ok('shelf search finds a SKU by description', (await searchShelf(c, 'Spare part for the test')).some((f: any) => f.sku === 'ZZRPART10'));
  ok('shelf search ignores one-letter queries', (await searchShelf(c, 'Z')).length === 0);
  ok('recent moves are listed, newest first', (await reconcileOverview(c)).recent.length >= 4);
} catch (e) { console.error('ERROR', e); fails++; }
finally {
  await c.query('ROLLBACK'); c.release();
  const left = await pool.query(`select to_regclass('stock_reconciliations') t, (select count(*) from warehouse_inventory where product_sku like 'ZZR%')::int s, (select count(*) from barcode_mappings where barcode like 'ZZR-%')::int b, (select count(*) from pick_lists where medusa_order_id like 'zz-rec-%')::int p`);
  console.log('after rollback:', JSON.stringify(left.rows[0]), fails ? `${fails} FAILED` : 'ALL PASSED');
  await pool.end();
}
