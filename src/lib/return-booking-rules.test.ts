import assert from 'node:assert/strict'
import test from 'node:test'
import { outcomeChange } from './return-booking-rules.js'

test('a replacement creates a plan-picks order and a refund does not', () => {
  assert.deepEqual(outcomeChange(null, 'replace'), { ok: true, createOrder: true, releaseOrder: false })
  assert.deepEqual(outcomeChange(null, 'refund'), { ok: true, createOrder: false, releaseOrder: true })
})

test('a booked refund or replacement choice stays fixed', () => {
  const switched = outcomeChange({ status: 'booked', outcome: 'replace' }, 'refund')
  assert.equal(switched.ok, false)
  assert.match(switched.ok ? '' : switched.error, /Cancel the collection/)
  const unset = outcomeChange({ status: 'booked' }, 'replace')
  assert.equal(unset.ok, false)
  assert.deepEqual(outcomeChange({ status: 'booked', outcome: 'refund' }, 'refund'), {
    ok: true,
    createOrder: false,
    releaseOrder: false,
  })
})

test('an unbooked replacement can be changed to a refund, which drops the order', () => {
  assert.deepEqual(outcomeChange({ status: 'requested', outcome: 'replace' }, 'refund'), {
    ok: true,
    createOrder: false,
    releaseOrder: true,
  })
})

test('collect only creates no order and releases any replacement', () => {
  assert.deepEqual(outcomeChange(null, 'collect'), { ok: true, createOrder: false, releaseOrder: true })
  assert.equal(outcomeChange({ status: 'booked', outcome: 'collect' }, 'collect').ok, true)
  assert.equal(outcomeChange({ status: 'booked', outcome: 'collect' }, 'replace').ok, false)
})
