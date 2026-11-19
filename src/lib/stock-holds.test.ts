import assert from 'node:assert/strict'
import test from 'node:test'
import { applyKitStock, planHolds, type HoldDemand } from './stock-holds.ts'

function line(partial: Partial<HoldDemand> & Pick<HoldDemand, 'itemId' | 'sku' | 'orderedAt'>): HoldDemand {
  return {
    pickListNumber: partial.itemId,
    lineNumber: 1,
    required: 1,
    picked: 0,
    parts: [],
    scanned: new Map(),
    ...partial,
  }
}

test('an older kit keeps the parts that are in stock', () => {
  const older = line({
    itemId: 'older',
    sku: 'DESK',
    orderedAt: 1,
    parts: [
      { sku: 'TOP', per: 1 },
      { sku: 'LEG', per: 1 },
    ],
  })
  const newer = line({ itemId: 'newer', sku: 'TOP', orderedAt: 2 })
  const holds = planHolds([newer, older], new Map([['TOP', 1], ['LEG', 0]]))
  const qty = (itemId: string, sku: string) => holds.find((hold) => hold.itemId === itemId && hold.sku === sku)?.qty ?? 0
  assert.equal(qty('older', 'TOP'), 1)
  assert.equal(qty('older', 'LEG'), 0)
  assert.equal(qty('newer', 'TOP'), 0)
})

const fiveTrays = [{ sku: '227P5-000', parts: [{ sku: '227P1-000', per: 5 }] }]

test('a 5-pack of trays covers five singles', () => {
  const stock = applyKitStock(new Map([['227P5-000', 1]]), fiveTrays)
  const singles = line({ itemId: 'singles', sku: '227P1-000', orderedAt: 1, required: 5 })
  const holds = planHolds([singles], stock)
  assert.equal(holds.find((hold) => hold.itemId === 'singles')?.qty, 5)
})

test('an older pack order keeps the five singles', () => {
  const stock = applyKitStock(new Map([['227P5-000', 1]]), fiveTrays)
  const pack = line({ itemId: 'pack', sku: '227P5-000', orderedAt: 1, parts: fiveTrays[0].parts })
  const singles = line({ itemId: 'singles', sku: '227P1-000', orderedAt: 2, required: 5 })
  const holds = planHolds([singles, pack], stock)
  const qty = (itemId: string) => holds.find((hold) => hold.itemId === itemId && hold.sku === '227P1-000')?.qty ?? 0
  assert.equal(qty('pack'), 5)
  assert.equal(qty('singles'), 0)
})

test('five loose singles cover a pack order', () => {
  const pack = line({ itemId: 'pack', sku: '227P5-000', orderedAt: 1, parts: fiveTrays[0].parts })
  const holds = planHolds([pack], new Map([['227P1-000', 5]]))
  assert.equal(holds.find((hold) => hold.itemId === 'pack')?.qty, 5)
})

test('one opened pack leaves the spare singles for later single orders', () => {
  const stock = applyKitStock(new Map([['226P5-000', 1], ['226P1-000', 0]]), [{ sku: '226P5-000', parts: [{ sku: '226P1-000', per: 5 }] }])
  const first = line({ itemId: 'first', sku: '226P1-000', orderedAt: 1, required: 1 })
  const pack = line({ itemId: 'pack', sku: '226P5-000', orderedAt: 4, parts: [{ sku: '226P1-000', per: 5 }] })
  const later = line({ itemId: 'later', sku: '226P1-000', orderedAt: 3, required: 4 })
  const holds = planHolds([pack, later, first], stock)
  const qty = (itemId: string) => holds.find((hold) => hold.itemId === itemId)?.qty ?? 0
  assert.equal(qty('first'), 1)
  assert.equal(qty('later'), 4)
  assert.equal(qty('pack'), 0)
})

test('loose singles and a pack together cover both orders', () => {
  const stock = applyKitStock(new Map([['225P1-000', 2], ['225P5-000', 1]]), [{ sku: '225P5-000', parts: [{ sku: '225P1-000', per: 5 }] }])
  const singles = line({ itemId: 'singles', sku: '225P1-000', orderedAt: 1, required: 2 })
  const pack = line({ itemId: 'pack', sku: '225P5-000', orderedAt: 2, parts: [{ sku: '225P1-000', per: 5 }] })
  const holds = planHolds([pack, singles], stock)
  const qty = (itemId: string) => holds.find((hold) => hold.itemId === itemId)?.qty ?? 0
  assert.equal(qty('singles'), 2)
  assert.equal(qty('pack'), 5)
})
