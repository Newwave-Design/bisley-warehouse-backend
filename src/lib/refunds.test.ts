import assert from 'node:assert/strict'
import test from 'node:test'
import { checkRefundRequest, RefundError } from './refunds.js'

test('a valid part refund is accepted to the penny', () => {
  assert.deepEqual(checkRefundRequest({ amount: '12.5', reason: 'damaged' }), { amount: 12.5, reason: 'damaged', note: '' })
})

test('zero, negative and part-penny amounts are refused', () => {
  for (const amount of [0, -5, 'abc', 10.123]) {
    assert.throws(() => checkRefundRequest({ amount, reason: 'damaged' }), RefundError)
  }
})

test('an unknown reason is refused, and goodwill needs a note', () => {
  assert.throws(() => checkRefundRequest({ amount: 5, reason: 'because' }), RefundError)
  assert.throws(() => checkRefundRequest({ amount: 5, reason: 'goodwill' }), RefundError)
  assert.equal(checkRefundRequest({ amount: 5, reason: 'goodwill', note: 'Late by a week' }).note, 'Late by a week')
})
