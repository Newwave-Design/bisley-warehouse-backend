import assert from 'node:assert/strict'
import test from 'node:test'
import { availableAfterReservation, coveredAwaitingLists, planReservations, type ArrivalLine, type ShelfStock } from './assign-arrived-stock.ts'

function line(partial: Partial<ArrivalLine> & Pick<ArrivalLine, 'itemId' | 'sku' | 'orderedAt'>): ArrivalLine {
  return {
    pickListId: partial.pickListId ?? partial.itemId,
    pickListNumber: partial.pickListNumber ?? partial.itemId,
    lineNumber: partial.lineNumber ?? 1,
    needed: partial.needed ?? 1,
    status: partial.status ?? 'AWAITING_STOCK',
    ...partial,
  }
}

function shelf(partial: Partial<ShelfStock> & Pick<ShelfStock, 'sku'>): ShelfStock {
  return { shelf: 1, reserved: 0, bonded: false, ...partial }
}

test('free units go to the older order and stop at what is available', () => {
  const adds = planReservations(
    [line({ itemId: 'newer', sku: 'H296NL-av1', orderedAt: 2 }), line({ itemId: 'older', sku: 'H296NL-av1', orderedAt: 1 })],
    [shelf({ sku: 'H296NL-av1', shelf: 1, reserved: 0 })],
  )
  assert.deepEqual(adds, [{ sku: 'H296NL-av1', add: 1 }])
})

test('units already reserved stay with the older order, and only the free remainder is assigned', () => {
  const adds = planReservations(
    [
      line({ itemId: 'older', sku: 'FLDL04-bx6', orderedAt: 1, needed: 2 }),
      line({ itemId: 'newer', sku: 'FLDL04-bx6', orderedAt: 2, needed: 2 }),
    ],
    [shelf({ sku: 'FLDL04-bx6', shelf: 3, reserved: 2 })],
  )
  assert.deepEqual(adds, [{ sku: 'FLDL04-bx6', add: 1 }])
  assert.equal(availableAfterReservation(3, 2 + 1), 0)
})

test('nothing is assigned when reserved is already at the shelf', () => {
  const adds = planReservations(
    [line({ itemId: 'older', sku: 'FFPFA3-bc6', orderedAt: 1, needed: 6 })],
    [shelf({ sku: 'FFPFA3-bc6', shelf: 5, reserved: 6, bonded: true })],
  )
  assert.deepEqual(adds, [])
  assert.equal(availableAfterReservation(5, 6), 0)
})

test('bonded stock is reserved to the older order before the remainder is available', () => {
  const adds = planReservations(
    [line({ itemId: 'older', sku: 'SFA4GRP25', orderedAt: 1, needed: 2 })],
    [shelf({ sku: 'SFA4GRP25', shelf: 5, reserved: 0, bonded: true })],
  )
  assert.deepEqual(adds, [{ sku: 'SFA4GRP25', add: 2 }])
  assert.equal(availableAfterReservation(5, 2), 3)
})

test('a newer awaiting order is not released onto stock an older order still needs', () => {
  const lines = [
    line({ itemId: 'older', pickListId: 'old-list', sku: 'CB5-at5', orderedAt: 1, needed: 4, status: 'PENDING' }),
    line({ itemId: 'newer', pickListId: 'new-list', sku: 'CB5-at5', orderedAt: 2, needed: 4, status: 'AWAITING_STOCK' }),
  ]
  assert.deepEqual(coveredAwaitingLists(lines, new Map([['CB5-at5', 4]])), [])
  assert.deepEqual(coveredAwaitingLists(lines, new Map([['CB5-at5', 8]])), ['new-list'])
})
