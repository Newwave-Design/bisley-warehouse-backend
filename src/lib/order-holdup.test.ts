import assert from 'node:assert/strict'
import test from 'node:test'
import { collectionDayFor, describeHoldup, packNeeds, stageOf, type HoldupContext, type HoldupOrder } from './order-holdup.ts'

const ctx = (over: Partial<HoldupContext> = {}): HoldupContext => ({
  boxHolds: {},
  freePack: () => Number.POSITIVE_INFINITY,
  ordersAheadForSku: () => 0,
  readyAhead: 0,
  onPickListAhead: 0,
  today: '2026-11-23',
  ...over,
})

const order = (over: Partial<HoldupOrder> = {}): HoldupOrder => ({
  id: 'o1',
  number: 'PL-20261101-0300',
  status: 'PENDING',
  orderedAt: 0,
  plannedAt: null,
  deferred: false,
  paid: true,
  namedDelivery: null,
  flagNote: null,
  lines: [{ itemId: 'i1', sku: 'H2910NL-av1', title: 'Filing cabinet', required: 1, picked: 0, assigned: 1, packaging: null }],
  ...over,
})

test('the stage follows the status and whether it is on a pick list', () => {
  assert.equal(stageOf({ status: 'PENDING', plannedAt: null }), 'planning')
  assert.equal(stageOf({ status: 'PENDING', plannedAt: '2026-11-20' }), 'to_pick')
  assert.equal(stageOf({ status: 'AWAITING_STOCK', plannedAt: null }), 'planning')
  assert.equal(stageOf({ status: 'LABEL_PRINTED', plannedAt: null }), 'packed')
})

test('a ready order not on a pick list says how many ready orders are ahead', () => {
  const holdup = describeHoldup(order(), ctx({ readyAhead: 4 }))
  assert.equal(holdup.ready, true)
  assert.equal(holdup.headline, 'Ready to pick, not on a pick list yet. 4 older ready orders are ahead of it.')
})

test('missing stock names the SKU and the older orders waiting for it', () => {
  const holdup = describeHoldup(order({ lines: [{ itemId: 'i1', sku: 'H2910NL-av1', title: 'Cabinet', required: 2, picked: 0, assigned: 1, packaging: null }] }), ctx({ ordersAheadForSku: () => 3 }))
  assert.equal(holdup.ready, false)
  assert.deepEqual(holdup.waiting_on[0], { kind: 'stock', sku: 'H2910NL-av1', title: 'Cabinet', need: 2, assigned: 1, orders_ahead: 3 })
  assert.equal(holdup.headline, 'Waiting for stock: H2910NL-av1, 1 of 2 in for this order. 3 older orders are also waiting for it.')
})

test('a tray with no free stock holds the order up once the product is in', () => {
  const packaging = { method: 'sleeve_tray', items: [{ code: 'TRA-4', name: 'Tray 4', item_type: 'tray', qty: 1, stock_on_hand: 0 }] }
  const holdup = describeHoldup(order({ lines: [{ itemId: 'i1', sku: 'BS3-av1', title: 'Cabinet', required: 1, picked: 0, assigned: 1, packaging }] }), ctx({ freePack: () => 0 }))
  assert.equal(holdup.ready, false)
  assert.deepEqual(holdup.waiting_on[0], { kind: 'packaging', type: 'tray', code: 'TRA-4', name: 'Tray 4', need: 1, held: 0 })
  assert.equal(holdup.headline, 'Stock is in. Waiting for packaging: Tray 4.')
})

test('a held box counts, so a box covered by its hold does not hold the order up', () => {
  const packaging = { method: 'custom_box', items: [{ code: 'BOX-12', name: 'Box 12', item_type: 'box', qty: 1 }] }
  const lines = [{ itemId: 'i1', sku: 'H2910NL-av1', title: 'Cabinet', required: 1, picked: 0, assigned: 1, packaging }]
  assert.equal(describeHoldup(order({ lines }), ctx({ boxHolds: { i1: { 'BOX-12': 1 } } })).ready, true)
  assert.equal(describeHoldup(order({ lines }), ctx()).ready, false)
})

test('own box and packed orders need no packaging', () => {
  const lines = [{ itemId: 'i1', sku: 'X', title: 'X', required: 1, picked: 0, assigned: 1, packaging: { method: 'own_box', items: [] } }]
  assert.deepEqual(packNeeds(order({ lines })), [])
  const boxed = [{ itemId: 'i1', sku: 'X', title: 'X', required: 1, picked: 1, assigned: 1, packaging: { method: 'custom_box', items: [{ code: 'BOX-1', name: 'Box 1', item_type: 'box', qty: 1 }] } }]
  assert.deepEqual(packNeeds(order({ status: 'PACKED', lines: boxed })), [])
})

test('unpaid and on-hold orders say so first', () => {
  assert.equal(describeHoldup(order({ paid: false }), ctx()).headline, 'Not paid yet, so the warehouse will not pick it.')
  assert.equal(describeHoldup(order({ deferred: true }), ctx()).headline, 'On hold in the warehouse.')
})

test('a named delivery is ready but picked on the working day before', () => {
  assert.equal(collectionDayFor('2026-11-30'), '2026-11-27')
  const holdup = describeHoldup(order({ namedDelivery: '2026-11-30' }), ctx())
  assert.equal(holdup.ready, true)
  assert.equal(holdup.headline, 'Ready. Held for named delivery on Mon 30 Nov; it is picked for the Fri 27 Nov collection.')
})

test('shipped and cancelled orders have nothing waiting', () => {
  assert.equal(describeHoldup(order({ status: 'DISPATCHED' }), ctx()).headline, 'Shipped')
  assert.deepEqual(describeHoldup(order({ status: 'CANCELLED' }), ctx()).waiting_on, [])
})
