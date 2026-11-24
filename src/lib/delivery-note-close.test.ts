import assert from 'node:assert/strict'
import test from 'node:test'
import { closeDecision } from './delivery-note-close.js'

const full = { complete: true, lines: [{ sku: 'A-001', quantity: 2, received: 2 }, { sku: 'B-001', quantity: 1, received: 1 }] }
const short = { complete: false, lines: [{ sku: 'A-001', quantity: 2, received: 2 }, { sku: 'B-001', quantity: 1, received: 0 }] }

test('a fully scanned delivery closes without a reason', () => {
  const result = closeDecision(full, false, {})
  assert.equal(result.ok, true)
  assert.match((result as { summary: string }).summary, /All 3 units scanned in/)
})

test('an open check-in blocks closing', () => {
  const result = closeDecision(full, true, {})
  assert.equal(result.ok, false)
  assert.equal((result as { status: number }).status, 409)
})

test('a short delivery needs the shortfall accepted and a reason', () => {
  const refused = closeDecision(short, false, {})
  assert.equal(refused.ok, false)
  assert.deepEqual((refused as { short: string[] }).short, ['B-001 0/1'])
  assert.equal(closeDecision(short, false, { acceptShortfall: true }).ok, false)
  assert.equal(closeDecision(short, false, { acceptShortfall: true, note: 'Supplier confirmed one unit will follow' }).ok, true)
})

test('more than expected is noted, and an empty note cannot be closed', () => {
  const over = { complete: true, lines: [{ sku: 'A-001', quantity: 1, received: 2 }] }
  assert.match((closeDecision(over, false, {}) as { summary: string }).summary, /more than expected on A-001 2\/1/)
  assert.equal(closeDecision({ complete: false, lines: [] }, false, {}).ok, false)
})
