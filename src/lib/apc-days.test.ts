import assert from 'node:assert/strict'
import test from 'node:test'
import { collectionDateRefused, weekdayCollectionDates, weekdaysAfter } from './apc-days.js'

test('a Friday search starts today and skips the weekend', () => {
  const friday = new Date('2026-11-20T12:10:00Z')
  assert.deepEqual(weekdayCollectionDates(3, friday), ['20/11/2026', '23/11/2026', '24/11/2026'])
})

test('the day after a refused Friday is Monday', () => {
  assert.deepEqual(weekdaysAfter('20/11/2026', 2), ['23/11/2026', '24/11/2026'])
})

test('a same-day refusal is a date problem, not an address problem', () => {
  assert.equal(collectionDateRefused("Can't collect today"), true)
  assert.equal(collectionDateRefused('Order Cut Off Time Has Passed For Today'), true)
  assert.equal(collectionDateRefused('Address Line 1 is too long'), false)
})
