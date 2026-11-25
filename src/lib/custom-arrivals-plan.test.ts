import assert from 'node:assert/strict'
import test from 'node:test'
import { planCustomArrivals, type CustomLine } from './custom-arrivals-plan.ts'

const line = (id: string, code: string, needed: number, orderedAt: number, extra: Partial<CustomLine> = {}): CustomLine => ({
  itemId: id, orderedAt, pickListNumber: `PL-${id}`, lineNumber: 1, code, needed, ...extra,
})

test('the oldest order gets the part first', () => {
  const plan = planCustomArrivals(
    [line('new', 'PTRKCASTW', 1, 200), line('old', 'PTRKCASTW', 1, 100)],
    new Map([['PTRKCASTW', 1]]),
  )
  assert.deepEqual(plan, [{ itemId: 'old', sku: 'PTRKCASTW', qty: 1 }])
})

test('one arrival is shared out across orders until it runs out', () => {
  const plan = planCustomArrivals(
    [line('a', 'P400496P2', 4, 100), line('b', 'P400496P2', 4, 200)],
    new Map([['P400496P2', 6]]),
  )
  assert.deepEqual(plan, [
    { itemId: 'a', sku: 'P400496P2', qty: 4 },
    { itemId: 'b', sku: 'P400496P2', qty: 2 },
  ])
})

test('a line is never given more than it still needs', () => {
  const plan = planCustomArrivals([line('a', 'ROSFF', 1, 100)], new Map([['ROSFF', 9]]))
  assert.deepEqual(plan, [{ itemId: 'a', sku: 'ROSFF', qty: 1 }])
})

test('nothing arrived means nothing is assigned', () => {
  assert.deepEqual(planCustomArrivals([line('a', 'ROSFF', 1, 100)], new Map()), [])
  assert.deepEqual(planCustomArrivals([line('a', 'ROSFF', 1, 100)], new Map([['ROSFF', 0]])), [])
})

test('a different part code does not take the stock', () => {
  assert.deepEqual(planCustomArrivals([line('a', 'ROSFF', 1, 100)], new Map([['PTRKCASTW', 5]])), [])
})

test('lines with no part code or nothing left to supply are ignored', () => {
  const plan = planCustomArrivals(
    [line('a', '', 1, 100), line('b', 'ROSFF', 0, 100), line('c', 'ROSFF', 1, 300)],
    new Map([['ROSFF', 5]]),
  )
  assert.deepEqual(plan, [{ itemId: 'c', sku: 'ROSFF', qty: 1 }])
})

test('equal order dates fall back to order number then line, so the result is stable', () => {
  const a = planCustomArrivals(
    [line('x', 'ROSFF', 1, 100, { pickListNumber: 'PL-2' }), line('y', 'ROSFF', 1, 100, { pickListNumber: 'PL-1' })],
    new Map([['ROSFF', 1]]),
  )
  assert.deepEqual(a, [{ itemId: 'y', sku: 'ROSFF', qty: 1 }])
})
