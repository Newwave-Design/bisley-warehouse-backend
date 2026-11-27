import assert from 'node:assert/strict';
import test from 'node:test';
import XLSX from 'xlsx';
import { arrivalWindow, confirmOpenLines, kindForSheet, matchReceipts, parseSheetRows, parseWorkbook, receiptInTrays, stillBonded, weekStarting } from './bisley-orders.ts';

test('sheet names map to order and bonded lines', () => {
  assert.equal(kindForSheet('1 – New orders'), 'order');
  assert.equal(kindForSheet('2 – Bonded stock'), 'bonded');
  assert.equal(kindForSheet('Notes'), null);
});

test('order lines use the reorder quantity and skip totals, custom lines and zero rows', () => {
  const rows = [
    ['Orders #613 to #692. Cut-off: 17 Nov 2026 16:52:44 GMT'],
    ['SKU', 'Name', 'Colour', 'Qty sold', 'Reorder qty', 'Unit cost', 'Line cost', 'Note'],
    ['H296NL-aa3', '29 Series', 'Anthracite', 1, 1, 91.5, 91.5, ''],
    ['164-ag8', 'BS', 'Regent', 1, 0, 182.92, 0, 'Already on order'],
    ['CUSTOM', 'Delivery to Northern Ireland (APC)', '', 1, 0, '', '', 'Cost missing'],
    ['MDHP-aa3', 'Plinth', 'Anthracite', 1, 4, 15.83, 63.32, 'Includes stock for waiting orders'],
    ['TOTAL', '', '', 51, 110, '', 9222.48, ''],
  ];
  const lines = parseSheetRows('order', rows);
  assert.deepEqual(lines.map((l) => [l.sku, l.quantity, l.line_cost_gbp]), [['H296NL-aa3', 1, 91.5], ['MDHP-aa3', 4, 63.32]]);
});

test('bonded lines use the quantity sold, and rows split by discount come back as one line', () => {
  const rows = [
    ['SKU', 'Name', 'Colour', 'Qty sold', 'Reorder qty', 'Unit cost', 'Cost reduction', 'Line cost', 'Note'],
    ['PFHAOKNHCPK1', 'PFA Handles', 'Oak', 22, 0, 4.5, '7.5%', 91.58, 'EARLY15'],
    ['PFHAOKNHCPK1', 'PFA Handles', 'Oak', 27, 0, 4.5, '5%', 115.42, 'Black Friday 10%'],
    ['TOTAL ex VAT', '', '', 49, 0, '', '', 207, ''],
  ];
  const lines = parseSheetRows('bonded', rows);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity, 49);
  assert.equal(lines[0].line_cost_gbp, 207);
  assert.match(lines[0].note ?? '', /EARLY15; Black Friday 10%/);
});

test('a workbook gives both sheets and the cut-off', () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Cut-off: 23 Nov 2026 19:55:28 GMT'],
    ['SKU', 'Qty sold', 'Reorder qty', 'Unit cost', 'Line cost'],
    ['FLDL04-cj4', 1, 1, 161.84, 149.7],
  ]), '1 – New orders');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['SKU', 'Qty sold', 'Reorder qty', 'Unit cost', 'Line cost'],
    ['H296NL-ag8', 3, 0, 91.5, 260.77],
  ]), '2 – Bonded stock');
  const parsed = parseWorkbook(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  assert.equal(parsed.cut_off, 'Cut-off: 23 Nov 2026 19:55:28 GMT');
  assert.deepEqual(parsed.lines.map((l) => [l.kind, l.sku, l.quantity]), [['order', 'FLDL04-cj4', 1], ['bonded', 'H296NL-ag8', 3]]);
});

test('receipts fill the oldest open line sent at least two weeks before the stock came in', () => {
  const day = (d: number) => Date.UTC(2026, 9, d); // October; day 32 = 1 Nov
  const received = matchReceipts(
    [
      { id: 'a', sku: 'H296NL-bc6', quantity: 5, sent_at: day(9) },
      { id: 'b', sku: 'h296nl-BC6', quantity: 1, sent_at: day(17) },
      { id: 'c', sku: 'MDHP-bc6', quantity: 5, sent_at: day(17) },
    ],
    [
      { sku: 'H296NL-bc6', quantity: 6, at: day(13) }, // 4 days after sheet a: other stock (bonded delivery), not this order
      { sku: 'H296NL-bc6', quantity: 4, at: day(24) },
      { sku: 'MDHP-bc6', quantity: 3, at: day(25) }, // 8 days after its sheet: too soon to be this order
      { sku: 'H296NL-bc6', quantity: 3, at: day(48) },
    ],
  );
  assert.equal(received.get('a'), 5);
  assert.equal(received.get('b'), 1);
  assert.equal(received.get('c'), 0);
});

test('dispatch notes confirm the oldest open lines for their SKU, less what is already scanned', () => {
  const notes = [
    { id: 'n2', arrives_on: '2026-12-09', title: 'Later', reference: null, lines: [{ sku: 'H296NL-BC6-001', quantity: 4, received: 0 }] },
    { id: 'n1', arrives_on: '2026-12-02', title: '507601', reference: 'NEW34909', lines: [{ sku: 'H296NL-BC6', quantity: 3, received: 1 }] },
  ];
  const confirmed = confirmOpenLines([{ id: 'old', sku: 'H296NL-bc6', open: 3 }, { id: 'new', sku: 'H296NL-bc6', open: 5 }, { id: 'x', sku: 'MDHP-bc6', open: 2 }], notes);
  assert.deepEqual(confirmed.get('old')?.map((p) => [p.note_id, p.units]), [['n1', 2], ['n2', 1]]);
  assert.deepEqual(confirmed.get('new')?.map((p) => [p.note_id, p.units]), [['n2', 3]]);
  assert.equal(confirmed.get('x'), undefined);
});

test('tray stock-ins are counted in single trays under the 5-pack code', () => {
  assert.deepEqual(receiptInTrays({ sku: '225P5-000', quantity: 2, at: 1 }), { sku: '225P5-000', quantity: 10, at: 1 });
  assert.deepEqual(receiptInTrays({ sku: 'PIT522P1-000', quantity: 2, at: 1 }), { sku: 'PIT522P5-000', quantity: 2, at: 1 });
  assert.deepEqual(receiptInTrays({ sku: 'H296NL-bc6', quantity: 2, at: 1 }), { sku: 'H296NL-bc6', quantity: 2, at: 1 });
});

test('arrival is the booked date, or the send date plus the palette lead time', () => {
  const sent = Date.UTC(2026, 10, 23, 21, 11);
  assert.deepEqual(arrivalWindow(sent, 'H296NL-bc6', null), { basis: 'palette_1', earliest: '2026-12-21', latest: '2027-01-04' });
  assert.deepEqual(arrivalWindow(sent, 'H296NL-cj4', null), { basis: 'palette_2', earliest: '2027-01-04', latest: '2027-01-18' });
  assert.deepEqual(arrivalWindow(sent, 'H296NL-cj4', '2026-12-02'), { basis: 'bisley_date', earliest: '2026-12-02', latest: '2026-12-02' });
});

test('weeks start on Monday', () => {
  assert.equal(weekStarting('2026-12-02'), '2026-11-30');
  assert.equal(weekStarting('2026-11-30'), '2026-11-30');
  assert.equal(weekStarting('2026-12-06'), '2026-11-30');
});

test('still bonded is starting units less paid off, and never below nothing', () => {
  assert.deepEqual(stillBonded(22, 9), { still: 13, over: 0 });
  assert.deepEqual(stillBonded(4, 9), { still: 0, over: 5 });
});
