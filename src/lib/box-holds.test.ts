import assert from 'node:assert/strict'
import test from 'node:test'
import { planBoxHolds, type BoxDemand } from './box-holds.ts'

function line(partial: Partial<BoxDemand> & Pick<BoxDemand, 'itemId' | 'boxId' | 'orderedAt'>): BoxDemand {
  return {
    pickListNumber: partial.itemId,
    lineNumber: 1,
    required: 1,
    started: false,
    ...partial,
  }
}

test('the older order keeps the only box', () => {
  const holds = planBoxHolds(
    [
      line({ itemId: 'newer', boxId: 'box-4', orderedAt: 2 }),
      line({ itemId: 'older', boxId: 'box-4', orderedAt: 1 }),
    ],
    new Map([['box-4', 1]]),
  )
  const qty = (itemId: string) => holds.find((hold) => hold.itemId === itemId)?.qty ?? 0
  assert.equal(qty('older'), 1)
  assert.equal(qty('newer'), 0)
})

test('an order already being picked keeps its box ahead of an older order still waiting', () => {
  const holds = planBoxHolds(
    [
      line({ itemId: 'older', boxId: 'box-4', orderedAt: 1 }),
      line({ itemId: 'picking', boxId: 'box-4', orderedAt: 2, started: true }),
    ],
    new Map([['box-4', 1]]),
  )
  const qty = (itemId: string) => holds.find((hold) => hold.itemId === itemId)?.qty ?? 0
  assert.equal(qty('picking'), 1)
  assert.equal(qty('older'), 0)
})

test('a short shelf reserves what is left', () => {
  const holds = planBoxHolds(
    [line({ itemId: 'order', boxId: 'box-4', orderedAt: 1, required: 3 })],
    new Map([['box-4', 1]]),
  )
  assert.equal(holds[0]?.qty, 1)
})

test('two box codes are reserved separately', () => {
  const holds = planBoxHolds(
    [
      line({ itemId: 'order', boxId: 'box-3', orderedAt: 1 }),
      line({ itemId: 'order', boxId: 'box-5', orderedAt: 1, lineNumber: 2 }),
    ],
    new Map([['box-3', 4], ['box-5', 0]]),
  )
  const qty = (boxId: string) => holds.find((hold) => hold.boxId === boxId)?.qty ?? 0
  assert.equal(qty('box-3'), 1)
  assert.equal(qty('box-5'), 0)
})

test('a forced line gets the box before a started order', () => {
  const holds = planBoxHolds([
    line({ itemId: 'started', boxId: 'box', orderedAt: 1, started: true }),
    line({ itemId: 'forced', boxId: 'box', orderedAt: 9, forced: true }),
  ], new Map([['box', 1]]))
  assert.deepEqual(holds, [{ itemId: 'forced', boxId: 'box', qty: 1 }])
})
