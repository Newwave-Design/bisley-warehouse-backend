import assert from 'node:assert/strict'
import test from 'node:test'
import { sgkCartonLabels } from './sgk-label.js'

test('one label per carton, numbered 1/N to N/N, with order number, customer and address', () => {
  const labels = sgkCartonLabels({
    orderNo: '000161OV', shopNumber: '161', name: 'Sam Jones', lines: ['1 High Street', 'Bath'], postcode: 'BA1 1AA', driverNotes: 'Leave in safe space',
    cartons: [{ title: 'MultiDesk', sku: 'MDTM' }, { title: 'Legs', sku: 'MDHLEG' }, { title: 'Drawer', sku: 'H296NL' }],
  })
  assert.equal(labels.length, 3)
  labels.forEach((label, index) => {
    assert.ok(label.startsWith('^XA') && label.trim().endsWith('^XZ'))
    assert.ok(label.includes(`^FD${index + 1}/3^FS`))
    for (const text of ['000161OV', 'Sam Jones', '1 High Street', 'BA1 1AA', '#161', 'Leave in safe space']) assert.ok(label.includes(text), text)
  })
})

test('ZPL control characters in a name cannot break the label', () => {
  const [label] = sgkCartonLabels({ orderNo: '000001OV', shopNumber: '1', name: 'A^B~C', lines: [], postcode: '', cartons: [{ title: 'x' }] })
  assert.ok(!label.includes('A^B'))
})
