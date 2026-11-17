import assert from 'node:assert/strict'
import test from 'node:test'
import { planHolds, type HoldDemand } from './stock-holds.ts'

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
