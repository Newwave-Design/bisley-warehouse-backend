import assert from 'node:assert/strict'
import test from 'node:test'
import { approvalDecision, canMove, cleanLines, linesEditable, poTotal, receivedStatus } from './purchase-orders.ts'

test('a PO moves forward only through approval', () => {
  assert.equal(canMove('DRAFT', 'AWAITING_APPROVAL'), true)
  assert.equal(canMove('DRAFT', 'APPROVED'), false)
  assert.equal(canMove('DRAFT', 'SENT'), false)
  assert.equal(canMove('AWAITING_APPROVAL', 'APPROVED'), true)
  assert.equal(canMove('APPROVED', 'SENT'), true)
  assert.equal(canMove('SENT', 'APPROVED'), false)
  assert.equal(canMove('CLOSED', 'DRAFT'), false)
  assert.equal(canMove('CANCELLED', 'DRAFT'), false)
})

test('lines can change until it has gone to the supplier', () => {
  assert.equal(linesEditable('DRAFT'), true)
  assert.equal(linesEditable('APPROVED'), true)
  assert.equal(linesEditable('SENT'), false)
  assert.equal(linesEditable('PART_RECEIVED'), false)
})

test('only an approver approves, and not their own PO', () => {
  assert.deepEqual(approvalDecision({ hasPermission: false, approverId: 'a', creatorId: 'b' }).ok, false)
  assert.equal(approvalDecision({ hasPermission: true, approverId: 'a', creatorId: 'b' }).ok, true)
  assert.equal(approvalDecision({ hasPermission: true, approverId: 'a', creatorId: 'a' }).ok, false)
  assert.equal(approvalDecision({ hasPermission: true, approverId: 'a', creatorId: 'a', allowSelf: true }).ok, true)
  assert.equal(approvalDecision({ hasPermission: true, approverId: 'a', creatorId: null }).ok, true)
})

test('lines need a SKU, a whole quantity and a price', () => {
  const ok = cleanLines([{ sku: ' BA3-av1 ', quantity: 4, unit_price: '12.5' }])
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.lines[0].sku, 'BA3-av1')
  assert.equal(ok.lines[0].unit_price, 12.5)

  assert.ok(cleanLines([]).errors.length)
  assert.ok(cleanLines([{ sku: '', quantity: 1, unit_price: 1 }]).errors[0].includes('SKU is required'))
  assert.ok(cleanLines([{ sku: 'A1', quantity: 0, unit_price: 1 }]).errors[0].includes('quantity'))
  assert.ok(cleanLines([{ sku: 'A1', quantity: 1.5, unit_price: 1 }]).errors[0].includes('quantity'))
  assert.ok(cleanLines([{ sku: 'A1', quantity: 1 }]).errors[0].includes('price'))
  assert.ok(cleanLines([{ sku: 'A1', quantity: 1, unit_price: '' }]).errors[0].includes('price'))
  assert.ok(cleanLines([{ sku: 'A1', quantity: 1, unit_price: -2 }]).errors[0].includes('price'))
  assert.equal(cleanLines([{ sku: 'A1', quantity: 1, unit_price: 0 }]).errors.length, 0)
  assert.ok(cleanLines([{ sku: 'a b', quantity: 1, unit_price: 1 }]).errors[0].includes('not a valid SKU'))
})

test('the same SKU twice is refused, whatever the case', () => {
  const r = cleanLines([{ sku: 'A1', quantity: 1, unit_price: 1 }, { sku: 'a1', quantity: 2, unit_price: 1 }])
  assert.ok(r.errors[0].includes('twice'))
})

test('every problem is reported together', () => {
  const r = cleanLines([{ sku: '', quantity: 1, unit_price: 1 }, { sku: 'B2', quantity: 0, unit_price: 1 }])
  assert.equal(r.errors.length, 2)
})

test('total is quantity times price', () => {
  assert.equal(poTotal([{ quantity_ordered: 3, unit_price: '2.10' }, { quantity_ordered: 1, unit_price: 0.05 }]), 6.35)
})

test('receiving moves the PO between sent, part received and received', () => {
  assert.equal(receivedStatus([{ quantity_ordered: 5, quantity_received: 0 }]), 'SENT')
  assert.equal(receivedStatus([{ quantity_ordered: 5, quantity_received: 2 }, { quantity_ordered: 1, quantity_received: 1 }]), 'PART_RECEIVED')
  assert.equal(receivedStatus([{ quantity_ordered: 5, quantity_received: 5 }, { quantity_ordered: 1, quantity_received: 2 }]), 'RECEIVED')
})
