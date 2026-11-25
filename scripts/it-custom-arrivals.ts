// Integration test for custom part matching: real schema, one transaction, always rolled back. Run from this folder: npx tsx scripts/it-custom-arrivals.ts
import { Pool } from 'pg';
import fs from 'node:fs';
import * as dotenv from 'dotenv';
import { matchCustomArrivals, linkCustomArrival, unlinkCustomArrival, suggestionsFor } from '../src/lib/custom-arrivals.ts';
import { applyDispatchStock } from '../src/lib/dispatch-stock.ts';
dotenv.config({ path: '.env.local' });
const pool = new Pool({ connectionString: process.env.WAREHOUSE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
const c = await pool.connect();
let fails = 0;
const ok = (n: string, v: unknown) => { console.log(v ? 'PASS' : 'FAIL', n); if (!v) fails++; };
const one = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows[0];
try {
  await c.query('BEGIN');
  const schema = fs.readFileSync('src/db/schema.ts', 'utf8');
  const ddl = schema.match(/CREATE TABLE IF NOT EXISTS custom_line_arrivals[\s\S]*?idx_custom_line_arrivals_sku[^;]*;/)![0];
  await c.query(`SET LOCAL lock_timeout = '3s'`);
  if (!(await one(`select to_regclass('custom_line_arrivals') as t`)).t) await c.query(ddl);

  const loc = (await one(`select id from warehouse_locations where location_code='HOLDING'`)).id;
  const user = (await one(`select id from warehouse_users limit 1`)).id;
  const liab = (await one(`select liability_status from warehouse_inventory where liability_status is not null limit 1`))?.liability_status ?? 'OWNED';
  let seq = 0;
  const order = async (num: string, daysAgo: number, paid: boolean) => (await one(
    `insert into pick_lists (medusa_order_id, pick_list_number, status, payment_status, created_at) values ($1,$2,'PENDING',$3, now() - ($4 || ' days')::interval) returning id`,
    ['zz-test-' + num, 'PL-ZZTEST-' + num, paid ? 'captured' : null, String(daysAgo)])).id as string;
  const lineOf = async (plId: string, title: string, qty = 1) => (await one(
    `insert into pick_list_items (pick_list_id, line_number, product_sku, quantity_required, is_custom, item_title) values ($1,$2,'CUSTOM',$3,true,$4) returning id`,
    [plId, ++seq, qty, title])).id as string;
  const stock = (sku: string, qty: number) => c.query(
    `insert into warehouse_inventory (location_id, product_sku, colour_code, quantity, liability_status) values ($1,$2,'',$3,$4)`, [loc, sku, qty, liab]);
  const arrival = async (id: string) => one(`select sku, qty, manual, consumed_at is not null as consumed from custom_line_arrivals where pick_list_item_id=$1`, [id]);
  const shelf = async (sku: string) => Number((await one(`select coalesce(sum(quantity),0)::int q from warehouse_inventory where upper(product_sku)=upper($1)`, [sku])).q);

  const oldOrder = await order('OLD', 10, true), newOrder = await order('NEW', 2, true), unpaid = await order('UNPAID', 5, false);
  const a1 = await lineOf(oldOrder, 'Widget ZZTESTAAA (pack of 1)');
  const a2 = await lineOf(newOrder, 'Widget ZZTESTAAA (pack of 1)');
  const b1 = await lineOf(oldOrder, 'Lock ZZTESTB10/6 (tambour)');
  const c1 = await lineOf(oldOrder, 'Frame ZZTESTCCC (black)');
  const d1 = await lineOf(unpaid, 'Part ZZTESTDDD (spare)');
  const e1 = await lineOf(oldOrder, 'Delivery fee ZZTESTEEE');

  // nothing on the shelf yet
  await matchCustomArrivals(c);
  ok('no stock: nothing assigned', (await c.query(`select count(*) n from custom_line_arrivals`)).rows[0].n === '0');

  await stock('ZZTESTAAA', 1); await stock('ZZTESTB10-6', 2); await stock('ZZTESTCCC-AV1', 1); await stock('ZZTESTDDD', 1); await stock('ZZTESTEEE', 1);
  await matchCustomArrivals(c);
  const A1 = await arrival(a1), A2 = await arrival(a2);
  ok('exact code: the OLDEST order gets the single part', A1?.qty === 1 && A1.sku === 'ZZTESTAAA' && !A2);
  const B1 = await arrival(b1);
  ok('order says ZZTESTB10/6, shelf has ZZTESTB10-6: matched automatically, SKU recorded as stocked', B1?.sku === 'ZZTESTB10-6' && B1.qty === 1);
  ok('order says ZZTESTCCC, shelf has ZZTESTCCC-AV1: NOT linked automatically', !(await arrival(c1)));
  const sug = (await suggestionsFor(c, [{ id: c1, code: 'ZZTESTCCC' }])).get(c1)!;
  ok('...but the colour is suggested for a person to confirm', sug.length === 1 && sug[0].sku === 'ZZTESTCCC-AV1' && sug[0].reason === 'COLOUR');
  ok('unpaid order gets nothing', !(await arrival(d1)));
  ok('a delivery-charge line is never matched', !(await arrival(e1)));

  const bad = await linkCustomArrival(c1, 'ZZTESTNOPE', c);
  ok('linking a SKU with no stock is refused', !bad.ok && bad.status === 409);
  const good = await linkCustomArrival(c1, 'zztestccc-av1', c);
  const C1 = await arrival(c1);
  ok('a person confirms the colour: linked as manual', good.ok && C1?.sku === 'ZZTESTCCC-AV1' && C1.manual === true && C1.qty === 1);
  await matchCustomArrivals(c);
  ok('the link survives the next automatic match', (await arrival(c1))?.manual === true);
  await unlinkCustomArrival(c1, c);
  await matchCustomArrivals(c);
  ok('unlinking returns the part to the shelf, nothing auto-relinks', !(await arrival(c1)));
  await linkCustomArrival(c1, 'ZZTESTCCC-AV1', c);

  // repeat runs change nothing
  const snap = async () => JSON.stringify((await c.query(`select pick_list_item_id, sku, qty, manual from custom_line_arrivals order by 1`)).rows);
  const before = await snap();
  await matchCustomArrivals(c); await matchCustomArrivals(c);
  ok('running the match again changes nothing', before === (await snap()));

  // ship the old order's lines: parts leave the shelf, once
  await c.query(`update pick_list_items set quantity_picked = 1, status='PICKED' where id = any($1)`, [[a1, b1, c1]]);
  const shelfA = await shelf('ZZTESTAAA'), shelfB = await shelf('ZZTESTB10-6'), shelfC = await shelf('ZZTESTCCC-AV1');
  await applyDispatchStock(c as any, { id: oldOrder, medusa_order_id: 'zz-test-OLD' }, user);
  ok('shipping takes the parts off the shelf', (await shelf('ZZTESTAAA')) === shelfA - 1 && (await shelf('ZZTESTB10-6')) === shelfB - 1 && (await shelf('ZZTESTCCC-AV1')) === shelfC - 1);
  ok('...marks the arrivals consumed', (await arrival(a1))?.consumed === true && (await arrival(c1))?.consumed === true);
  const mv = (await c.query(`select movement_type, quantity from warehouse_movements where pick_list_item_id=$1 order by movement_type`, [a1])).rows;
  ok('...logs the sale once as DISPATCH (Stock Sold) and the shelf use as ADJUST', mv.length === 2 && mv[0].movement_type === 'ADJUST' && mv[1].movement_type === 'DISPATCH');
  await c.query(`update pick_lists set status='DISPATCHED' where id=$1`, [oldOrder]);
  await applyDispatchStock(c as any, { id: oldOrder, medusa_order_id: 'zz-test-OLD' }, user);
  ok('shipping the same order again takes nothing twice', (await shelf('ZZTESTAAA')) === shelfA - 1);
  await matchCustomArrivals(c);
  ok('the second order does NOT get a part that already shipped', !(await arrival(a2)));
  ok('shipped history is kept', (await arrival(a1))?.consumed === true);

  // a new delivery of the part: the waiting order gets it
  await c.query("update warehouse_inventory set quantity = quantity + 1 where product_sku = 'ZZTESTAAA'");
  await matchCustomArrivals(c);
  ok('new stock arrives: the waiting order now gets it', (await arrival(a2))?.qty === 1);

  // bookkeeping failure must never stop an order shipping
  const failOrder = await order('FAIL', 1, true);
  const f1 = await lineOf(failOrder, 'Thing ZZTESTFFF');
  await c.query(`update pick_list_items set quantity_picked = 1 where id=$1`, [f1]);
  await c.query('DROP TABLE custom_line_arrivals');
  let threw = false;
  try { await applyDispatchStock(c as any, { id: failOrder, medusa_order_id: 'zz-test-FAIL' }, user); } catch { threw = true; }
  ok('custom_line_arrivals missing: the order still ships (no error)', !threw);
  ok('...and the sale is still logged', (await one(`select count(*)::int n from warehouse_movements where pick_list_item_id=$1 and movement_type='DISPATCH'`, [f1])).n === 1);
} catch (e) { console.error('ERROR', e); fails++; }
finally {
  await c.query('ROLLBACK'); c.release();
  const left = await pool.query(`select to_regclass('custom_line_arrivals') t, (select count(*) from pick_lists where medusa_order_id like 'zz-test-%')::int p, (select count(*) from warehouse_inventory where product_sku like 'ZZTEST%')::int s`);
  console.log('after rollback:', JSON.stringify(left.rows[0]), fails ? `${fails} FAILED` : 'ALL PASSED');
  await pool.end();
}
