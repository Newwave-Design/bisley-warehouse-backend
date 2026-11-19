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
