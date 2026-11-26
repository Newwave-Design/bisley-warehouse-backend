import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCoverage, skuBelongsTo } from './packaging-coverage.ts'

const packs = [
  { code: 'BOX-33', item_type: 'box', stock_on_hand: 0, unit_cost: null, size: '610L 1,140W 2,430H', merge_into: null },
  { code: 'SLV-12', item_type: 'sleeve', stock_on_hand: 0, unit_cost: null, size: null, merge_into: null },
  { code: 'TRA-6', item_type: 'tray', stock_on_hand: 0, unit_cost: null, size: null, merge_into: null },
  { code: 'BOX-3', item_type: 'box', stock_on_hand: 75, unit_cost: 3.71, size: '545L 410W 445H', merge_into: null },
]
const bom = (product_code: string, option_rank: number, method: string, code: string | null, item_type: string | null) => ({ product_code, sku: null, option_rank, method, code, item_type })
const boms = [
  bom('YETB1019/4S', 1, 'box', 'BOX-33', 'box'),
  bom('YETB1019/4S', 2, 'sleeve_tray', 'SLV-12', 'sleeve'),
  bom('YETB1019/4S', 2, 'sleeve_tray', 'TRA-6', 'tray'),
  bom('H123NL', 1, 'box', 'BOX-3', 'box'),
]
const specs = [
  { product_code: 'YETB1019/4S', product_title: 'Tambour cupboard', method: 'box' },
  { product_code: 'H123NL', product_title: '3 drawer', method: 'box' },
  { product_code: 'PS3PB', product_title: 'Pedestal', method: 'own_box' },
]

test('a hyphenated SKU belongs to its slash product code', () => {
  assert.equal(skuBelongsTo('YETB1019-4S-aa31', 'YETB1019/4S'), true)
  assert.equal(skuBelongsTo('H123NL-bx6', 'H123NL'), true)
  assert.equal(skuBelongsTo('H1234NL-bx6', 'H123NL'), false)
})

test('first choice and alternatives are split by option rank', () => {
  const { products } = buildCoverage({ boms, packs, specs, openLines: [] })
  const row = products.find((p) => p.product === 'YETB1019/4S')!
  assert.deepEqual(row.first_choice, ['BOX-33'])
  assert.deepEqual(row.alternatives, [['SLV-12', 'TRA-6']])
})

test('a pack lists the products it is first choice for and the ones it is only an alternative for', () => {
  const { packs: out } = buildCoverage({ boms, packs, specs, openLines: [] })
  assert.deepEqual(out.find((p) => p.code === 'BOX-33')!.first_choice, ['YETB1019/4S'])
  const slv = out.find((p) => p.code === 'SLV-12')!
  assert.deepEqual(slv.first_choice, [])
  assert.deepEqual(slv.alternative_only, ['YETB1019/4S'])
})

test('open orders are counted once per product', () => {
  const lines = [
    { sku: 'YETB1019-4S-aa31', orderId: 'a' },
    { sku: 'YETB1019-4S-ba5', orderId: 'a' },
    { sku: 'YETB1019-4S-ba5', orderId: 'b' },
    { sku: 'H123NL-bx6', orderId: 'b' },
  ]
  const { products, packs: out } = buildCoverage({ boms, packs, specs, openLines: lines })
  assert.equal(products.find((p) => p.product === 'YETB1019/4S')!.open_orders, 2)
  assert.equal(products.find((p) => p.product === 'H123NL')!.open_orders, 1)
  assert.equal(out.find((p) => p.code === 'BOX-33')!.open_orders, 2)
})

test('a product with no BOM still appears with its method', () => {
  const { products } = buildCoverage({ boms, packs, specs, openLines: [] })
  const row = products.find((p) => p.product === 'PS3PB')!
  assert.equal(row.method, 'own_box')
  assert.deepEqual(row.first_choice, [])
})

test('packs sort box, sleeve, tray', () => {
  const { packs: out } = buildCoverage({ boms, packs, specs, openLines: [] })
  assert.deepEqual(out.map((p) => p.type), ['box', 'box', 'sleeve', 'tray'])
})
