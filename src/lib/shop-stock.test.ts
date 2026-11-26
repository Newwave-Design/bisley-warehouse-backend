import test from 'node:test'
import assert from 'node:assert/strict'
import { medusaKeyHeader, shopStockTarget } from './shop-stock.ts'

test('a secret key goes as Basic, a token as Bearer', () => {
  assert.equal(medusaKeyHeader('sk_abc'), 'Basic ' + Buffer.from('sk_abc:').toString('base64'))
  assert.equal(medusaKeyHeader('eyJhbGciOi.x.y'), 'Bearer eyJhbGciOi.x.y')
})

test('the shop sells stock not reserved to any order, and stocked = sellable + Medusa reservations', () => {
  // the desk tops from the live check
  assert.deepEqual(shopStockTarget({ free: 2, onhand: 21, medusaReserved: 19 }), { sellable: 2, stocked: 21 })
  assert.deepEqual(shopStockTarget({ free: 3, onhand: 7, medusaReserved: 3 }), { sellable: 3, stocked: 6 })
  assert.deepEqual(shopStockTarget({ free: 12, onhand: 14, medusaReserved: 3 }), { sellable: 11, stocked: 14 })
  assert.deepEqual(shopStockTarget({ free: 9, onhand: 26, medusaReserved: 17 }), { sellable: 9, stocked: 26 })
})

test('orders beyond stock sell nothing and never go negative', () => {
  assert.deepEqual(shopStockTarget({ free: 0, onhand: 3, medusaReserved: 6 }), { sellable: 0, stocked: 6 })
  assert.deepEqual(shopStockTarget({ free: -2, onhand: 0, medusaReserved: 15 }), { sellable: 0, stocked: 15 })
})

test('an order Medusa reserved that the warehouse has not yet keeps its unit', () => {
  // warehouse free 9 does not yet count the unpaid order, Medusa does: sell 8
  assert.equal(shopStockTarget({ free: 9, onhand: 20, medusaReserved: 12 }).sellable, 8)
})

test('no reservations: stocked is just what can be sold; unknown on hand falls back to free', () => {
  assert.deepEqual(shopStockTarget({ free: 5, onhand: 5, medusaReserved: 0 }), { sellable: 5, stocked: 5 })
  assert.deepEqual(shopStockTarget({ free: 5, onhand: null, medusaReserved: 2 }), { sellable: 5, stocked: 7 })
})
