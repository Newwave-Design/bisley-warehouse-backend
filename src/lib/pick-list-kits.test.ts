import assert from 'node:assert/strict'
import test from 'node:test'
import { sellableTrayCount } from './pick-list-kits.ts'

test('a single tray can be sold from a 5-pack', () => {
  const onHand = new Map([['227P1-000', 0], ['227P5-000', 15]])
  assert.equal(sellableTrayCount('227P1-000', onHand), 75)
  assert.equal(sellableTrayCount('227P5-000', onHand), 15)
})

test('loose singles and packs are one pool', () => {
  const onHand = new Map([['226P1-000', 4], ['226P5-000', 11]])
  assert.equal(sellableTrayCount('226P1-000', onHand), 59)
  assert.equal(sellableTrayCount('226P5-000', onHand), 11)
})

test('five loose singles make one pack', () => {
  const onHand = new Map([['225P1-000', 12], ['225P5-000', 2]])
  assert.equal(sellableTrayCount('225P5-000', onHand), 4)
  assert.equal(sellableTrayCount('225P1-000', onHand), 22)
})

test('other products are left to their own count', () => {
  assert.equal(sellableTrayCount('H123NL-bx6', new Map([['H123NL-bx6', 3]])), null)
})

test('PIT522 pack is PIT522P5-000 and counts as five singles', () => {
  const onHand = new Map([['PIT522P1-000', 0], ['PIT522P5-000', 2]])
  assert.equal(sellableTrayCount('PIT522P1-000', onHand), 10)
  assert.equal(sellableTrayCount('PIT522P5-000', onHand), 2)
})
