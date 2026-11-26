import test from 'node:test'
import assert from 'node:assert/strict'
import { canScanIntoStock, decisionChangesStock, refundWaitsForInspection, soldStockTreatment, zipStore, claimFileName } from './returns-desk-rules.ts'

test('only a confirmed unopened item can be scanned into stock', () => {
  assert.equal(canScanIntoStock({ condition: 'Opened', itemScanned: true, bayScanned: true, confirmUnopened: true }).ok, false)
  assert.equal(canScanIntoStock({ condition: 'Unopened', itemScanned: true, bayScanned: false, confirmUnopened: true }).ok, false)
  assert.equal(canScanIntoStock({ condition: 'Unopened', itemScanned: true, bayScanned: true, confirmUnopened: true }).ok, true)
})

test('a decision does not change stock', () => {
  assert.equal(decisionChangesStock(), false)
})

test('lost and sealed refused refunds do not wait for inspection', () => {
  assert.equal(refundWaitsForInspection({ courierProblem: 'lost', holdRefund: true }), false)
  assert.equal(refundWaitsForInspection({ courierProblem: 'refused_sealed', holdRefund: true }), false)
  assert.equal(refundWaitsForInspection({ courierProblem: null, holdRefund: true }), true)
})

test('sold stock holds an open return and keeps a sent report', () => {
  assert.equal(soldStockTreatment({ reportSent: false, open: true, scannedIn: false }), 'held_out')
  assert.equal(soldStockTreatment({ reportSent: false, open: false, scannedIn: true }), 'bisley_stock')
  assert.equal(soldStockTreatment({ reportSent: false, open: false, scannedIn: false }), 'reported_sold')
  assert.equal(soldStockTreatment({ reportSent: true, open: false, scannedIn: true }), 'stays_reported')
})

test('a claim pack is a zip named for the return', () => {
  assert.equal(claimFileName('RMA-1', 'bisley'), 'RMA-1-bisley-claim.zip')
  const zip = zipStore('claim.txt', 'Bisley fault')
  assert.equal(zip.readUInt32LE(0), 0x04034b50)
  assert.ok(zip.includes(Buffer.from('Bisley fault')))
})

import { codeMatchesItem, nextDeskStatus, scanInUnits } from './returns-desk-rules.ts'

const line = (over: Record<string, unknown> = {}) => ({ item_condition: 'Unopened', quantity_requested: 1, quantity_received: 0, stock_scanned_at: null, ...over }) as Parameters<typeof nextDeskStatus>[0][number]

test('a scan puts back one unit and never more than are left on the line', () => {
  assert.deepEqual(scanInUnits({ quantity_requested: 3, quantity_received: 0 }), { ok: true, units: 1, left: 2 })
  assert.deepEqual(scanInUnits({ quantity_requested: 3, quantity_received: 2 }), { ok: true, units: 1, left: 0 })
  assert.equal(scanInUnits({ quantity_requested: 3, quantity_received: 3 }).ok, false)
  assert.equal(scanInUnits({ quantity_requested: 1, quantity_received: 1 }).ok, false)
  assert.equal(scanInUnits({ quantity_requested: 5, quantity_received: 0 }, 99).ok && (scanInUnits({ quantity_requested: 5, quantity_received: 0 }, 99) as { units: number }).units, 5)
})

test('the return only moves on when every line is dealt with', () => {
  assert.equal(nextDeskStatus([]), 'to_inspect')
  assert.equal(nextDeskStatus([line({ item_condition: null }), line()]), 'to_inspect')
  // one line scanned in, the other unopened and still to scan: stays at To inspect
  assert.equal(nextDeskStatus([line({ quantity_received: 1 }), line()]), 'to_inspect')
  // a partly scanned line of 3 is not done
  assert.equal(nextDeskStatus([line({ quantity_requested: 3, quantity_received: 1 })]), 'to_inspect')
  assert.equal(nextDeskStatus([line({ quantity_requested: 3, quantity_received: 3 })]), 'to_refund')
  assert.equal(nextDeskStatus([line({ quantity_received: 1 }), line({ item_condition: 'Damaged' })]), 'to_decide')
  assert.equal(nextDeskStatus([line({ item_condition: 'Faulty' })]), 'to_decide')
})

test('a scanned code must be the item or one of its barcodes', () => {
  assert.equal(codeMatchesItem('h2910nl-ab9 ', 'H2910NL-AB9', []), true)
  assert.equal(codeMatchesItem('5012345678900', 'H2910NL-ab9', ['H2910NL-ab9']), true)
  assert.equal(codeMatchesItem('5012345678900', 'H2910NL-ab9', ['OTHER-SKU']), false)
  assert.equal(codeMatchesItem('', 'H2910NL-ab9', ['H2910NL-ab9']), false)
  assert.equal(codeMatchesItem('anything', '', []), false)
})

import { deskAfterDecisions, decisionStockEffect, unitsToDecide, zipFiles } from './returns-desk-rules.ts'

test('units still needing a decision are the ones that did not go back in stock', () => {
  assert.equal(unitsToDecide({ quantity_requested: 3, quantity_received: 1 }), 2)
  assert.equal(unitsToDecide({ quantity_requested: 1, quantity_received: 1 }), 0)
  assert.equal(unitsToDecide({ quantity_requested: 2, quantity_received: null }), 2)
})

test('decisions: spares and seconds are held apart, write-off is recorded, claims touch no stock', () => {
  assert.equal(decisionStockEffect('write_off'), 'write_off')
  assert.equal(decisionStockEffect('spares'), 'held')
  assert.equal(decisionStockEffect('second'), 'held')
  assert.equal(decisionStockEffect('bisley_claim'), 'none')
  assert.equal(decisionStockEffect('carrier_claim'), 'none')
})

const d = (over: Record<string, unknown> = {}) => ({ item_condition: 'Damaged', quantity_requested: 1, quantity_received: 0, stock_scanned_at: null, decision: null, ...over }) as Parameters<typeof deskAfterDecisions>[0][number]

test('a return only moves on once every line is decided or back in stock', () => {
  assert.equal(deskAfterDecisions([d(), d({ decision: 'write_off' })], false), 'to_decide')
  assert.equal(deskAfterDecisions([d({ decision: 'write_off' }), d({ quantity_received: 1, item_condition: 'Unopened' })], false), 'to_refund')
  assert.equal(deskAfterDecisions([d({ decision: 'second' })], true), 'closed')
  assert.equal(deskAfterDecisions([d({ decision: 'carrier_claim' }), d({ decision: 'write_off' })], false), 'claim')
  assert.equal(deskAfterDecisions([d({ decision: 'carrier_claim' })], true), 'claim')
})

test('a zip of several files has every name and every body, and a valid end record', () => {
  const zip = zipFiles([{ name: 'claim.txt', data: Buffer.from('hello') }, { name: 'photos/1.jpg', data: Buffer.from([0xff, 0xd8, 1, 2, 3]) }])
  assert.equal(zip.readUInt32LE(0), 0x04034b50)
  assert.equal(zip.readUInt16LE(zip.length - 12), 2)
  assert.ok(zip.includes(Buffer.from('claim.txt')) && zip.includes(Buffer.from('photos/1.jpg')) && zip.includes(Buffer.from('hello')))
  const centralAt = zip.readUInt32LE(zip.length - 6)
  assert.equal(zip.readUInt32LE(centralAt), 0x02014b50)
})
