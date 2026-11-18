import assert from 'node:assert/strict'
import test from 'node:test'
import { fivePackTraySku, singleTrayFromFivePack } from './insert-trays.ts'

test('a single insert tray reorders as its 5-pack', () => {
  assert.equal(fivePackTraySku('225P1-000'), '225P5-000')
  assert.equal(fivePackTraySku('PIT451P1-ab1'), 'PIT451P5-ab1')
  assert.equal(fivePackTraySku('DUBLINP1-000'), null)
})

test('scanning a 5-pack stays the 5-pack', () => {
  assert.equal(singleTrayFromFivePack('225P5-000'), null)
  assert.equal(singleTrayFromFivePack('PIT580P5-ab1'), null)
  assert.equal(singleTrayFromFivePack('225p5-000'), null)
  assert.equal(singleTrayFromFivePack('225P1-000'), null)
  assert.equal(singleTrayFromFivePack('MDHLEG-018'), null)
})
