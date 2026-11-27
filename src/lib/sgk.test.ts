import assert from 'node:assert/strict'
import test from 'node:test'
import { sgkCsv, sgkDate, sgkDriverNotes, sgkItems, sgkOrderNo, sgkPhones, sgkRows, SGK_COLUMNS } from './sgk.js'

test('order number is 6 digits then OV', () => {
  assert.equal(sgkOrderNo('PL-20261001-0161'), '000161OV')
  assert.equal(sgkOrderNo('PL-20261001-12'), '000012OV')
  assert.equal(sgkOrderNo('nonsense'), '')
})

test('dates are dd/mm/yyyy in London time', () => {
  assert.equal(sgkDate('2026-11-25T23:30:00Z'), '25/11/2026')
  assert.equal(sgkDate('2026-06-30T23:30:00Z'), '01/07/2026')
  assert.equal(sgkDate(null), '')
})

test('a mobile goes in the mobile column, a landline in Tel 1', () => {
  assert.deepEqual(sgkPhones('+44 7825 355231'), { tel1: '', mobile: '07825355231' })
  assert.deepEqual(sgkPhones('01873 900095'), { tel1: '01873900095', mobile: '' })
  assert.deepEqual(sgkPhones(''), { tel1: '', mobile: '' })
})

test('cartons that share a SKU become one row with the count', () => {
  const items = sgkItems([
    { itemSku: 'MDTM1400-562', title: 'MultiDesk · MDTM1400 · 562 White' },
    { itemSku: 'MDHLEG-1', title: 'Pair of hairpin legs 1' },
    { itemSku: 'MDHLEG-1', title: 'Pair of hairpin legs 2' },
    { title: 'Custom box' },
  ])
  assert.deepEqual(items.map((item) => [item.code, item.qty]), [['MDTM1400-562', 1], ['MDHLEG-1', 2], ['', 1]])
  assert.equal(items[1].desc, 'Pair of hairpin legs')
})

test('rows repeat the order and leave order notes blank', () => {
  const rows = sgkRows({
    pickListNumber: 'PL-20261001-0161',
    orderDate: '2026-11-20T10:00:00Z',
    customerName: 'Sam Jones',
    email: 'sam@example.com',
    phone: '',
    shippingAddress: { first_name: 'Sam', last_name: 'Jones', address_1: '1 High St', address_2: 'Flat 2', city: 'Bath', postal_code: 'ba1 1aa', phone: '07700 900123', company: 'Jones Ltd' },
    driverNotes: 'Leave in the\nshed, 2nd floor',
    pieces: [{ itemSku: 'A', title: 'Desk' }, { itemSku: 'B', title: 'Leg 1' }, { itemSku: 'B', title: 'Leg 2' }],
  })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].Order_No, '000161OV')
  assert.equal(rows[1].Order_No, '000161OV')
  assert.equal(rows[0].Retailer, 'OVARA000000000001')
  assert.equal(rows[0].Order_Type, 'delivery')
  assert.equal(rows[0].Order_Notes, '')
  assert.equal(rows[0].Driver_Notes, 'Hallway delivery. Leave in the shed, 2nd floor')
  assert.equal(rows[1].Driver_Notes, rows[0].Driver_Notes)
  assert.equal(rows[0].Del_Addr_1, 'Jones Ltd')
  assert.equal(rows[0].Del_Addr_2, '1 High St')
  assert.equal(rows[0].Del_Addr_3, 'Flat 2')
  assert.equal(rows[0].Postal_Code, 'BA1 1AA')
  assert.equal(rows[0].Contact_Tel_Mob, '07700900123')
  assert.equal(rows[1].Item_Qty, '2')
})

test('csv has the template header, quotes commas and keeps leading zeros', () => {
  const [row] = sgkRows({ pickListNumber: 'PL-20261001-0001', orderDate: null, customerName: 'A, B', email: '', phone: '07700900123', shippingAddress: {}, driverNotes: 'say "hi"', pieces: [{ itemSku: 'X', title: 'T' }] })
  const csv = sgkCsv([row])
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n')
  assert.equal(lines[0], SGK_COLUMNS.join(','))
  assert.ok(lines[1].includes('"A, B"'))
  assert.ok(lines[1].includes('"Hallway delivery. say ""hi"""'))
  assert.ok(lines[1].includes(',07700900123,'))
})

test('a row weighs every carton on it together', () => {
  const items = sgkItems([
    { itemSku: 'A', title: 'Desk', weightKg: '17' },
    { itemSku: 'B', title: 'Leg 1', weightKg: '6' },
    { itemSku: 'B', title: 'Leg 2', weightKg: '6.4' },
    { itemSku: 'C', title: 'Box 1', weightKg: '5' },
    { itemSku: 'C', title: 'Box 2' },
  ])
  assert.deepEqual(items.map((item) => item.weightKg), ['17', '12.4', ''])
  const rows = sgkRows({ pickListNumber: 'PL-20261001-0161', orderDate: null, customerName: 'A', email: '', phone: '', shippingAddress: {}, driverNotes: '', pieces: [{ itemSku: 'B', title: 'Leg 1', weightKg: '6' }, { itemSku: 'B', title: 'Leg 2', weightKg: '6' }] })
  assert.equal(rows[0].Item_Wgt, '12')
})

test('sgkItems puts one type of unit on each row, whatever the colour', () => {
  const items = sgkItems([
    { itemSku: 'BA3-av1', title: 'BA3 Black' },
    { itemSku: 'MDHLEG-ba5', title: 'Pair of legs' },
    { itemSku: 'BA3-bn6', title: 'BA3 Blue' },
  ])
  assert.equal(items.length, 2)
  assert.equal(items[0].qty, 2)
  assert.equal(items[1].code, 'MDHLEG-ba5')
})

test('every row is dated the export day and carries the standard driver notes', () => {
  const rows = sgkRows({ pickListNumber: 'PL-20261001-0161', orderDate: '2026-10-01T10:00:00Z', customerName: 'A', email: '', phone: '', shippingAddress: {}, driverNotes: '', pieces: [{ itemSku: 'A', title: 'Desk' }, { itemSku: 'B', title: 'Leg' }] }, new Date('2026-11-27T15:00:00Z'))
  assert.deepEqual(rows.map((row) => row.Order_Date), ['27/11/2026', '27/11/2026'])
  assert.deepEqual(rows.map((row) => row.Driver_Notes), Array(2).fill('Hallway delivery'))
})

test('driver notes: hallway by default, the tagged services when an order has them', () => {
  assert.equal(sgkDriverNotes(''), 'Hallway delivery')
  assert.equal(sgkDriverNotes('', { roomOfChoice: true, takePackagingAway: true, packagingInspection: true }), 'Room of choice, take packaging away, packaging inspection')
  assert.equal(sgkDriverNotes('Gate code 1234', { takePackagingAway: true }), 'Hallway delivery, take packaging away. Gate code 1234')
})

test('an order upgraded to room of choice says so on every row', () => {
  const rows = sgkRows({ pickListNumber: 'PL-20261001-0161', orderDate: null, customerName: 'A', email: '', phone: '', shippingAddress: {}, driverNotes: 'Ring first', roomOfChoice: true, pieces: [{ itemSku: 'A', title: 'Desk' }] })
  assert.equal(rows[0].Driver_Notes, 'Room of choice. Ring first')
})
