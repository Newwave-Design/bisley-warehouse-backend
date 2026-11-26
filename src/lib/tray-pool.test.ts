import test from 'node:test'
import assert from 'node:assert/strict'
import { pooledTrayQty, trayMate } from './tray-pool.ts'

test('a single counts five for every pack', () => {
  assert.equal(pooledTrayQty('225P1-000', 2, 1), 7)
  assert.equal(pooledTrayQty('225P1-000', 0, 4), 20)
})

test('a pack counts one for every five singles', () => {
  assert.equal(pooledTrayQty('225P5-000', 1, 2), 1)
  assert.equal(pooledTrayQty('225P5-000', 1, 12), 3)
  assert.equal(pooledTrayQty('225P5-000', 0, 4), 0)
})

test('other products keep their own count', () => {
  assert.equal(pooledTrayQty('H123NL-bx6', 3, 9), 3)
})

test('a negative other count adds nothing', () => {
  assert.equal(pooledTrayQty('225P1-000', 2, -3), 2)
})

test('the mate is the other form of the same tray', () => {
  assert.equal(trayMate('225P1-000'), '225P5-000')
  assert.equal(trayMate('PIT522P5-000'), 'PIT522P1-000')
  assert.equal(trayMate('H123NL-bx6'), null)
})
