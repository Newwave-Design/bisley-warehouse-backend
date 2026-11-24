import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalSku } from './colour-names.js'

test('a plinth stock code is the sold code, and nothing else changes', () => {
  assert.equal(canonicalSku('PLINTH-ab9'), 'MDHP-ab9')
  assert.equal(canonicalSku(' plinth-BX6 '), 'MDHP-bx6')
  assert.equal(canonicalSku('MDHP-ab9'), 'MDHP-ab9')
  assert.equal(canonicalSku('PLINTH-ab9-extra'), 'PLINTH-ab9-extra')
  assert.equal(canonicalSku('H2910NL-ab9'), 'H2910NL-ab9')
})
