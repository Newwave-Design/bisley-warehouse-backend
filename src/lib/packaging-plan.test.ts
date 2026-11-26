import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPackagingPlan, defaultHorizons, sizeText, type PlanOrderIn } from './packaging-plan.ts'

const horizons = defaultHorizons('2026-11-26')
const stock = [
  { code: 'BOX-7', name: 'Box 7', kind: 'box' as const, onHand: 2 },
  { code: 'SLV-4', name: 'Sleeve 4', kind: 'sleeve' as const, onHand: 0 },
  { code: 'TRA-4', name: 'Tray 4', kind: 'tray' as const, onHand: 0 },
]
const need = (code: string, qty: number, kind: 'box' | 'sleeve' | 'tray' = 'box') => ({ code, name: code, kind, qty })
function order(n: number, at: number, due: string | null, needs: ReturnType<typeof need>[], extra: Partial<PlanOrderIn> = {}): PlanOrderIn {
  return { id: `id${n}`, number: `#${n}`, orderedAt: at, due, inStock: true, needs, undefinedSkus: [], ...extra }
}

test('horizons start at the coming 24 Dec and run to end Feb', () => {
  assert.deepEqual(horizons.map((h) => h.date), ['2026-12-24', '2026-12-31', '2027-01-31', '2027-02-28'])
})

test('shelf stock goes to the oldest orders and the rest is to order', () => {
  const plan = buildPackagingPlan({
    orders: [order(2, 2, '2026-12-10', [need('BOX-7', 1)]), order(1, 1, '2026-12-01', [need('BOX-7', 1)]), order(3, 3, '2026-12-20', [need('BOX-7', 1)])],
    stock, onOrder: [], horizons,
  })
  const row = plan.rows.find((r) => r.code === 'BOX-7')!
  assert.equal(row.to_order, 1)
  assert.deepEqual(row.unlocked_by_buying, ['#3'])
  assert.deepEqual(row.blocked_orders.map((o) => o.number), ['#3'])
  assert.equal(row.flag, 'red')
})

test('what is already on order is taken off the quantity to buy', () => {
  const plan = buildPackagingPlan({
    orders: [order(1, 1, '2026-12-01', [need('BOX-7', 4)])],
    stock, onOrder: [{ code: 'BOX-7', qty: 2, dueOn: '2026-12-15' }], horizons,
  })
  const row = plan.rows[0]
  assert.equal(row.to_order, 0)
  assert.equal(row.on_order, 2)
  assert.equal(row.blocked_orders[0].covered, 'on_order')
  assert.equal(row.late_on_order, true)
  assert.equal(row.flag, 'amber')
  assert.equal(plan.orders[0].missing[0].status, 'on_order')
})

test('a sleeve and tray only unlock an order together', () => {
  const plan = buildPackagingPlan({
    orders: [order(1, 1, '2027-01-10', [need('SLV-4', 1, 'sleeve'), need('TRA-4', 1, 'tray')])],
    stock, onOrder: [], horizons,
  })
  assert.equal(plan.rows.find((r) => r.code === 'SLV-4')!.only_blocker.length, 0)
  assert.equal(plan.rows.find((r) => r.code === 'TRA-4')!.only_blocker.length, 0)
  assert.equal(plan.summary.unlocked_by_buying, 1)
})

test('a pack that is the only thing missing is listed as the only blocker', () => {
  const plan = buildPackagingPlan({ orders: [order(1, 1, '2026-12-01', [need('BOX-7', 3)])], stock, onOrder: [], horizons })
  assert.deepEqual(plan.rows[0].only_blocker, ['#1'])
})

test('an order with an undefined product is not counted as unlocked by buying', () => {
  const plan = buildPackagingPlan({
    orders: [order(1, 1, '2026-12-01', [need('BOX-7', 3)], { undefinedSkus: ['PFHAOKNHCPK1'] })],
    stock, onOrder: [], horizons,
  })
  assert.equal(plan.summary.blocked_orders, 1)
  assert.equal(plan.summary.unlocked_by_buying, 0)
  assert.equal(plan.summary.still_blocked_by_setup, 1)
  assert.deepEqual(plan.setup_issues, [{ sku: 'PFHAOKNHCPK1', orders: ['#1'] }])
})

test('need by each date adds up the orders due by then', () => {
  const plan = buildPackagingPlan({
    orders: [order(1, 1, '2026-12-01', [need('BOX-7', 2)]), order(2, 2, '2027-01-15', [need('BOX-7', 5)])],
    stock, onOrder: [], horizons,
  })
  const row = plan.rows[0]
  assert.deepEqual(row.need_by.map((s) => s.need), [2, 2, 7, 7])
  assert.deepEqual(row.need_by.map((s) => s.short), [0, 0, 5, 5])
})

const merged = [
  { code: 'BOX-19', name: 'Box 19', kind: 'box' as const, onHand: 44, unitCost: 6.82, size: '750L 555W 790H', sizeUpdated: '2026-11-18' },
  { code: 'BOX-18', name: 'Box 18', kind: 'box' as const, onHand: 0, mergeInto: 'BOX-19', runDown: false },
  { code: 'BOX-14', name: 'Box 14', kind: 'box' as const, onHand: 49, mergeInto: 'BOX-19', runDown: true, unitCost: 6.58 },
  { code: 'BOX-13', name: 'Box 13', kind: 'box' as const, onHand: 58, unitCost: 5.63 },
  { code: 'BOX-17', name: 'Box 17', kind: 'box' as const, onHand: 56, mergeInto: 'BOX-13', runDown: true },
]

test('box 18 demand comes out of box 19 stock', () => {
  const plan = buildPackagingPlan({ orders: [order(1, 1, '2026-12-01', [need('BOX-18', 10)])], stock: merged, onOrder: [], horizons })
  assert.equal(plan.orders.length, 0)
  assert.equal(plan.rows.find((r) => r.code === 'BOX-19')?.to_order ?? 0, 0)
  assert.deepEqual(plan.rows.find((r) => r.code === 'BOX-19')?.merged_from, [{ code: 'BOX-18', qty: 10 }])
})

test('box 18 demand beyond box 19 stock is ordered as box 19, and the order shows why', () => {
  const plan = buildPackagingPlan({ orders: [order(1, 1, '2026-12-01', [need('BOX-18', 50)])], stock: merged, onOrder: [], horizons })
  const row = plan.rows.find((r) => r.code === 'BOX-19')!
  assert.equal(row.to_order, 6)
  assert.equal(row.line_cost, 40.92)
  assert.equal(plan.rows.find((r) => r.code === 'BOX-18')?.to_order ?? 0, 0)
  assert.equal(plan.orders[0].missing[0].via, 'BOX-18')
  assert.equal(plan.summary.total_cost, 40.92)
})

test('box 14 runs down its own stock first, then box 19 supplies the rest', () => {
  const plan = buildPackagingPlan({ orders: [order(1, 1, '2026-12-01', [need('BOX-14', 60)])], stock: merged, onOrder: [], horizons })
  assert.equal(plan.rows.find((r) => r.code === 'BOX-14')?.to_order ?? 0, 0)
  assert.equal(plan.rows.find((r) => r.code === 'BOX-19')?.to_order ?? 0, 0)
  assert.deepEqual(plan.rows.find((r) => r.code === 'BOX-19')?.merged_from, [{ code: 'BOX-14', qty: 11 }])
})

test('box 17 passes what it cannot cover to box 13', () => {
  const plan = buildPackagingPlan({ orders: [order(1, 1, '2026-12-01', [need('BOX-17', 70)])], stock: merged, onOrder: [], horizons })
  assert.deepEqual(plan.rows.find((r) => r.code === 'BOX-13')?.merged_from, [{ code: 'BOX-17', qty: 14 }])
  assert.equal(plan.rows.find((r) => r.code === 'BOX-13')?.to_order ?? 0, 0)
})

test('a pack with no price is counted as missing a cost', () => {
  const plan = buildPackagingPlan({ orders: [order(1, 1, '2026-12-01', [need('BOX-7', 5)])], stock, onOrder: [], horizons })
  assert.equal(plan.summary.rows_missing_cost, 1)
  assert.equal(plan.summary.total_cost, 0)
})

test('size text prefers the outer size and falls back to the internal size', () => {
  assert.equal(sizeText({ box_size_formula: '560L 540W 790H, 1,100L&W' }), '560L 540W 790H')
  assert.equal(sizeText({ internal_length_mm: 420, internal_width_mm: 300, internal_height_mm: 335 }), '420 x 300 x 335 internal')
  assert.equal(sizeText({}), null)
})
