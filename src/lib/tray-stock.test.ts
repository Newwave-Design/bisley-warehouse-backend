import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bookingSkusIncludingTraySingles,
  convertPackToSingles,
  convertSinglesToPack,
  receiveTray,
  shipTray,
} from './tray-stock.ts'

const empty = { singles: 0, packs: 0 }

test('scan-in as a single adds singles and leaves packs alone', () => {
  const stock = receiveTray(empty, '222P1-000', 3)
  assert.deepEqual(stock, { singles: 3, packs: 0 })
})

test('scan-in as a five-pack adds packs and does not unpack them', () => {
  const stock = receiveTray({ singles: 2, packs: 1 }, '225P5-000', 2)
  assert.deepEqual(stock, { singles: 2, packs: 3 })
})

test('five singles convert into one pack', () => {
  const stock = convertSinglesToPack({ singles: 7, packs: 1 })
  assert.deepEqual(stock, { singles: 2, packs: 2 })
  assert.equal(convertSinglesToPack({ singles: 4, packs: 1 }), null)
})

test('one pack converts into five singles', () => {
  const stock = convertPackToSingles({ singles: 1, packs: 2 })
  assert.deepEqual(stock, { singles: 6, packs: 1 })
  assert.equal(convertPackToSingles({ singles: 4, packs: 0 }), null)
})

test('shipping a single from pack stock opens one pack and leaves the other four', () => {
  const result = shipTray({ singles: 0, packs: 7 }, '222P1-000', 1)
  assert.deepEqual(result, { stock: { singles: 4, packs: 6 }, short: 0 })
})

test('shipping a five-pack takes one pack', () => {
  const fromPacks = shipTray({ singles: 4, packs: 2 }, '226P5-000', 1)
  assert.deepEqual(fromPacks, { stock: { singles: 4, packs: 1 }, short: 0 })
  const fromSingles = shipTray({ singles: 12, packs: 0 }, '225P5-000', 1)
  assert.deepEqual(fromSingles, { stock: { singles: 7, packs: 0 }, short: 0 })
})

test('a single left off the collection booking is still taken, and the pack is opened', () => {
  const skus = bookingSkusIncludingTraySingles(
    ['H125NL-bc6', 'H296NL-bc6'],
    [
      { sku: 'H125NL-bc6', quantity: 1 },
      { sku: '222P1-000', quantity: 1 },
    ],
  )
  assert.ok(skus.includes('222P1-000'))
  assert.ok(skus.includes('H125NL-bc6'))
  const result = shipTray({ singles: 0, packs: 7 }, '222P1-000', 1)
  assert.deepEqual(result.stock, { singles: 4, packs: 6 })
  assert.equal(result.short, 0)
})
