import assert from 'node:assert/strict'
import test from 'node:test'
import { apcAlreadyCancelled, apcAvailabilityItems, apcConsignmentSize, apcDutyItem, appropriateApcServices, northernIrelandPostcode } from './apc-service.ts'

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

test('six non-conveyable boxes are quoted as the four largest', () => {
  const small = { weightKg: 4, lengthCm: 40, widthCm: 30, heightCm: 20 }
  const boxes = [small, small, heavy, heavy, heavy, heavy]
  assert.deepEqual(apcAvailabilityItems(boxes, [0, 1, 2, 3, 4, 5]), [2, 3, 4, 5])
})

test('non-conveyable extra also goes out in fours', () => {
  const oversize = { weightKg: 20, lengthCm: 180, widthCm: 70, heightCm: 50 }
  const extra = [{ code: 'APCYC16', name: 'Non-conveyable extra', ruleMatch: false, ruleName: '' }]
  const chosen = appropriateApcServices(extra, Array.from({ length: 6 }, () => oversize))
  assert.equal(chosen[0]?.code, 'APCYC16')
  assert.equal(apcConsignmentSize('APCYC16'), 4)
  assert.deepEqual(apcAvailabilityItems(Array.from({ length: 6 }, () => oversize), [0, 1, 2, 3, 4, 5]).length, 4)
})

test('a Northern Ireland non-conveyable box uses the road service', () => {
  const ireland = [{ code: 'APCRDNC', name: 'ROAD SERVICE NON-CONVEYABLE', ruleMatch: true, ruleName: '' }]
  const box = { weightKg: 13.6, lengthCm: 56, widthCm: 43, heightCm: 94 }
  const chosen = appropriateApcServices(ireland, [box])
  assert.equal(chosen[0]?.code, 'APCRDNC')
  assert.equal(apcConsignmentSize('APCRDNC'), 4)
})

test('a Northern Ireland postcode needs a duty line', () => {
  assert.equal(northernIrelandPostcode('BT67 0FD'), true)
  assert.equal(northernIrelandPostcode('NP4 0HZ'), false)
  assert.equal(apcDutyItem('Multidrawer').HTSCode, '9403208000')
  assert.equal(apcDutyItem('Multidrawer').OriginCountry, 'GB')
})

test('six parcel boxes are quoted together', () => {
  const small = { weightKg: 4, lengthCm: 40, widthCm: 30, heightCm: 20 }
  const boxes = Array.from({ length: 6 }, () => small)
  assert.deepEqual(apcAvailabilityItems(boxes, boxes.map((_, index) => index)).length, 6)
})

test('timed products in one family keep their delivery window', () => {
  const parcel = [
    { code: 'APCND16', name: 'NEXT DAY', ruleMatch: false, ruleName: '' },
    { code: 'APCND12', name: 'NEXT DAY BY 12', ruleMatch: false, ruleName: '' },
    { code: 'APCND10', name: 'NEXT DAY BY 10:30', ruleMatch: false, ruleName: '' },
  ]
  const small = { weightKg: 4, lengthCm: 40, widthCm: 30, heightCm: 20 }
  const chosen = appropriateApcServices(parcel, [small])
  assert.deepEqual(chosen.map((row) => row.ruleName), [
    'Next day parcel',
    'Next day parcel by noon',
    'Next day parcel by 10:30',
  ])
})

test('a slower APC product keeps APC\'s own name', () => {
  const remote = [{ code: 'APCTDAY', name: '2-5 day parcel', ruleMatch: false, ruleName: '' }]
  const small = { weightKg: 4, lengthCm: 40, widthCm: 30, heightCm: 20 }
  const chosen = appropriateApcServices(remote, [small])
  assert.equal(chosen[0]?.ruleName, '2-5 day parcel')
})

test('lightweight and non-conveyable timed products name the window too', () => {
  const light = { weightKg: 2, lengthCm: 40, widthCm: 30, heightCm: 15 }
  const lightweight = appropriateApcServices([
    { code: 'APCLW16', name: 'LIGHTWEIGHT', ruleMatch: false, ruleName: '' },
    { code: 'APCLW12', name: 'LIGHTWEIGHT BY 12', ruleMatch: false, ruleName: '' },
  ], [light])
  assert.deepEqual(lightweight.map((row) => row.ruleName), ['Lightweight', 'Lightweight by noon'])

  const heavy = { weightKg: 12, lengthCm: 94, widthCm: 56, heightCm: 43 }
  const nonConveyable = appropriateApcServices([
    { code: 'APCNC16', name: 'NON CONVEYABLE', ruleMatch: false, ruleName: '' },
    { code: 'APCNC10', name: 'NON CONVEYABLE BY 10:30', ruleMatch: false, ruleName: '' },
  ], [heavy])
  assert.deepEqual(nonConveyable.map((row) => row.ruleName), ['Non-conveyable', 'Non-conveyable by 10:30'])
})

test('small boxes stay on the next day parcel', () => {
  const small = { weightKg: 4, lengthCm: 40, widthCm: 30, heightCm: 20 }
  const chosen = appropriateApcServices(services, Array.from({ length: 6 }, () => small))
  assert.equal(chosen[0]?.code, 'APCND16')
  assert.equal(apcConsignmentSize('APCND16'), null)
})

test('a refused APC cancel is not treated as cancelled', () => {
  assert.equal(apcAlreadyCancelled('Order cannot be cancelled as it has been collected'), false)
  assert.equal(apcAlreadyCancelled('Unable to cancel this consignment'), false)
  assert.equal(apcAlreadyCancelled('Order is already cancelled'), true)
  assert.equal(apcAlreadyCancelled('Consignment not found'), true)
  assert.equal(apcAlreadyCancelled('{"Orders":{"Order":{"Status":"CANCELLED"}}}'), true)
  assert.equal(apcAlreadyCancelled('Validation failed'), false)
})
