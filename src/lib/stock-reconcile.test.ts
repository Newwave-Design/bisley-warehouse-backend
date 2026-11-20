import assert from 'node:assert/strict'
import test from 'node:test'
import { expectedRemaining, isReconciled, shippedQuantity } from './stock-reconcile.ts'

test('a kit component stock-out is the shipment, so the part reconciles', () => {
  const oakHandles = { booked: 207, orderShipped: 0, postedStockOut: 96, wms: 111 }
  assert.equal(shippedQuantity(oakHandles), 96)
  assert.equal(expectedRemaining(oakHandles), 111)
  assert.equal(isReconciled(oakHandles), true)
})

test('ignoring the posted component movement is the mismatch', () => {
  const oakHandles = { booked: 207, orderShipped: 0, postedStockOut: 0, wms: 111 }
  assert.equal(isReconciled(oakHandles), false)
})

test('a part sold on its own order still uses that order when the stock-out matches it', () => {
  const filer = { booked: 5, orderShipped: 2, postedStockOut: 2, wms: 3 }
  assert.equal(isReconciled(filer), true)
})

test('a product shipped with no stock-out and no check-in stays outstanding', () => {
  const sample = { booked: 0, orderShipped: 13, postedStockOut: 0, wms: 0 }
  assert.equal(shippedQuantity(sample), 13)
  assert.equal(isReconciled(sample), false)
})

test('a dispatched return reduces what should still be held', () => {
  const oakTop = { booked: 21, orderShipped: 0, returnShipped: 1, postedStockOut: 1, wms: 20 }
  assert.equal(shippedQuantity(oakTop), 1)
  assert.equal(expectedRemaining(oakTop), 20)
  assert.equal(isReconciled(oakTop), true)
})

test('leaving a return out of the shipment count shows a unit still held', () => {
  const oakTop = { booked: 21, orderShipped: 0, returnShipped: 0, postedStockOut: 0, wms: 20 }
  assert.equal(isReconciled(oakTop), false)
})

test('an adjustment that is not a kit stock-out stays outstanding', () => {
  const trays = { booked: 13, orderShipped: 2, postedStockOut: 2, wms: 10 }
  assert.equal(isReconciled(trays), false)
})
