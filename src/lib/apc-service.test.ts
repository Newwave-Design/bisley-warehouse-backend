import assert from 'node:assert/strict'
import test from 'node:test'
import { apcConsignmentSize, appropriateApcServices } from './apc-service.ts'

const services = [
  { code: 'APCND16', name: 'Next day parcel', ruleMatch: false, ruleName: '' },
  { code: 'APCNC16', name: 'Non-conveyable', ruleMatch: false, ruleName: '' },
]

const heavy = { weightKg: 12, lengthCm: 94, widthCm: 56, heightCm: 43 }

test('four non-conveyable boxes stay one APC service', () => {
  const chosen = appropriateApcServices(services, Array.from({ length: 4 }, () => heavy))
  assert.equal(chosen[0]?.code, 'APCNC16')
  assert.equal(apcConsignmentSize('APCNC16'), 4)
})

test('more than four non-conveyable boxes still offer the service so they can be split', () => {
  const chosen = appropriateApcServices(services, Array.from({ length: 6 }, () => heavy))
  assert.equal(chosen[0]?.code, 'APCNC16')
})

test('small boxes stay on the next day parcel', () => {
  const small = { weightKg: 4, lengthCm: 40, widthCm: 30, heightCm: 20 }
  const chosen = appropriateApcServices(services, Array.from({ length: 6 }, () => small))
  assert.equal(chosen[0]?.code, 'APCND16')
  assert.equal(apcConsignmentSize('APCND16'), null)
})
