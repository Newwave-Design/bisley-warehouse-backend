import test from 'node:test'
import assert from 'node:assert/strict'
import { slashShelfCount } from './pick-list-packaging.ts'

test('slashShelfCount turns the shelf count into a slash', () => {
  assert.equal(slashShelfCount('yecb0819-4s-bn6'), 'YECB0819/4S-BN6')
  assert.equal(slashShelfCount('YETB1012-2S'), 'YETB1012/2S')
  assert.equal(slashShelfCount('H123NL-bx6'), 'H123NL-BX6')
})
