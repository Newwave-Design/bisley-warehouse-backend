import assert from 'node:assert/strict'
import test from 'node:test'
import { normaliseCode, planCustomArrivals, suggestParts, type CustomLine, type FreeStock } from './custom-arrivals-plan.ts'

const line = (id: string, code: string, needed: number, orderedAt: number, extra: Partial<CustomLine> = {}): CustomLine => ({
  itemId: id, orderedAt, pickListNumber: `PL-${id}`, lineNumber: 1, code, needed, ...extra,
})
const stock = (...rows: Array<[string, number]>): FreeStock[] => rows.map(([sku, free]) => ({ sku, free }))
const arrival = (itemId: string, sku: string, qty: number, manual = false) => ({ itemId, sku, qty, manual })

test('the oldest order gets the part first', () => {
  const plan = planCustomArrivals([line('new', 'PTRKCASTW', 1, 200), line('old', 'PTRKCASTW', 1, 100)], stock(['PTRKCASTW', 1]))
  assert.deepEqual(plan, [arrival('old', 'PTRKCASTW', 1)])
})

test('one arrival is shared out across orders until it runs out', () => {
  const plan = planCustomArrivals([line('a', 'P400496P2', 4, 100), line('b', 'P400496P2', 4, 200)], stock(['P400496P2', 6]))
  assert.deepEqual(plan, [arrival('a', 'P400496P2', 4), arrival('b', 'P400496P2', 2)])
})

test('a line is never given more than it still needs', () => {
  assert.deepEqual(planCustomArrivals([line('a', 'ROSFF', 1, 100)], stock(['ROSFF', 9])), [arrival('a', 'ROSFF', 1)])
})

test('nothing arrived, or a different part, means nothing is assigned', () => {
  assert.deepEqual(planCustomArrivals([line('a', 'ROSFF', 1, 100)], []), [])
  assert.deepEqual(planCustomArrivals([line('a', 'ROSFF', 1, 100)], stock(['ROSFF', 0])), [])
  assert.deepEqual(planCustomArrivals([line('a', 'ROSFF', 1, 100)], stock(['PTRKCASTW', 5])), [])
})

test('lines with no part code or nothing left to supply are ignored', () => {
  const plan = planCustomArrivals([line('a', '', 1, 100), line('b', 'ROSFF', 0, 100), line('c', 'ROSFF', 1, 300)], stock(['ROSFF', 5]))
  assert.deepEqual(plan, [arrival('c', 'ROSFF', 1)])
})

test('equal order dates fall back to order number, so the result is stable', () => {
  const plan = planCustomArrivals(
    [line('x', 'ROSFF', 1, 100, { pickListNumber: 'PL-2' }), line('y', 'ROSFF', 1, 100, { pickListNumber: 'PL-1' })],
    stock(['ROSFF', 1]),
  )
  assert.deepEqual(plan, [arrival('y', 'ROSFF', 1)])
})

// ---- the SKU on the order is slightly different to the SKU scanned in ----

test('case and separators are tidied: PLKCSYT10/6 on the order matches PLKCSYT10-6 on the shelf', () => {
  assert.deepEqual(planCustomArrivals([line('a', 'plkcsyt10/6', 1, 100)], stock(['PLKCSYT10-6', 2])), [arrival('a', 'PLKCSYT10-6', 1)])
  assert.deepEqual(planCustomArrivals([line('a', 'BIC10BSPS:T5', 1, 100)], stock(['BIC10BSPS-T5', 1])), [arrival('a', 'BIC10BSPS-T5', 1)])
  assert.deepEqual(planCustomArrivals([line('a', 'BIC10 BSPS T5', 1, 100)], stock(['BIC10BSPS:T5', 1])), [])
  assert.equal(normaliseCode(' rosff-001 '), 'ROSFF')
})

test('the allocation records the SKU as stocked, not as typed on the order', () => {
  const [row] = planCustomArrivals([line('a', 'Ptrkcastw', 1, 100)], stock(['PTRKCASTW', 1]))
  assert.equal(row.sku, 'PTRKCASTW')
})

test('the same part stocked under two spellings is used from the bigger pile', () => {
  const [row] = planCustomArrivals([line('a', 'PLKCSYT10/6', 1, 100)], stock(['PLKCSYT10/6', 1], ['PLKCSYT10-6', 4]))
  assert.equal(row.sku, 'PLKCSYT10-6')
})

test('a coloured stock SKU is NOT linked automatically to a plain code', () => {
  assert.deepEqual(planCustomArrivals([line('a', 'ROSFF', 1, 100)], stock(['ROSFF-AV1', 3], ['ROSFF-AT5', 3])), [])
})

test('PFBBSPSFP1 never takes PFBBSPSFP10, a different part', () => {
  assert.deepEqual(planCustomArrivals([line('a', 'PFBBSPSFP1', 1, 100)], stock(['PFBBSPSFP10', 5])), [])
  assert.deepEqual(suggestParts('PFBBSPSFP1', stock(['PFBBSPSFP10', 5])), [])
})

test('suggestions: colours of the same part, then a similar one, never the exact match', () => {
  const s = suggestParts('ROSFF', stock(['ROSFF', 9], ['ROSFF-AV1', 2], ['ROSFF-AT5', 5], ['ROSFF-333', 0], ['PTRKCASTW', 4]))
  assert.deepEqual(s.map((x) => [x.sku, x.reason]), [['ROSFF-AT5', 'COLOUR'], ['ROSFF-AV1', 'COLOUR']])
  const similar = suggestParts('PLKCSYT10/34', stock(['PLKCSYT10/6', 1]))
  assert.deepEqual(similar, [{ sku: 'PLKCSYT10/6', free: 1, reason: 'SIMILAR' }])
})

test('suggestions work the other way too: the order has the colour, the shelf has the plain part', () => {
  assert.deepEqual(suggestParts('ROSFF-AV1', stock(['ROSFF', 2])).map((x) => x.reason), ['COLOUR'])
})

test('a person-confirmed link is honoured first, even over an older exact match', () => {
  const plan = planCustomArrivals(
    [line('old', 'ROSFF', 1, 100), line('new', 'ROSFF', 1, 200)],
    stock(['ROSFF', 1], ['ROSFF-AV1', 1]),
    [{ itemId: 'new', sku: 'ROSFF-AV1' }],
  )
  assert.deepEqual(plan, [arrival('new', 'ROSFF-AV1', 1, true), arrival('old', 'ROSFF', 1)])
})

test('a link to a SKU with nothing on the shelf gives nothing, and the line can still match normally', () => {
  const plan = planCustomArrivals([line('a', 'ROSFF', 1, 100)], stock(['ROSFF', 1], ['ROSFF-AV1', 0]), [{ itemId: 'a', sku: 'ROSFF-AV1' }])
  assert.deepEqual(plan, [arrival('a', 'ROSFF', 1)])
})

test('a link to a line that is no longer open is ignored', () => {
  assert.deepEqual(planCustomArrivals([], stock(['ROSFF', 1]), [{ itemId: 'gone', sku: 'ROSFF' }]), [])
})

test('running the plan twice gives the same answer', () => {
  const lines = [line('a', 'P400496P2', 4, 100), line('b', 'P400496P2', 4, 200)]
  const s = stock(['P400496P2', 6])
  assert.deepEqual(planCustomArrivals(lines, s), planCustomArrivals(lines, s))
})
