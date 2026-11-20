import assert from 'node:assert/strict'
import test from 'node:test'
import { applyLineEditToScans } from '../../lib/stock-in-edit.ts'

test('a review edit replaces the quantity on the scan that was stored', () => {
  const scans = applyLineEditToScans([{ id: 'scan', quantity: 23 }], 10)
  assert.deepEqual(scans, [{ id: 'scan', quantity: 10 }])
})

test('an edit that raises the total lands on the latest scan', () => {
  const scans = applyLineEditToScans([{ id: 'a', quantity: 1 }, { id: 'b', quantity: 1 }], 186)
  assert.equal(scans.reduce((sum, scan) => sum + scan.quantity, 0), 186)
  assert.equal(scans[1].quantity, 185)
})

test('an edit below the earlier scans keeps the whole total on the latest scan', () => {
  const scans = applyLineEditToScans([{ id: 'a', quantity: 10 }, { id: 'b', quantity: 5 }], 4)
  assert.deepEqual(scans, [{ id: 'a', quantity: 0 }, { id: 'b', quantity: 4 }])
})
