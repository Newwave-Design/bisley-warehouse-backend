import assert from 'node:assert/strict'
import test from 'node:test'
import { AddressError, cleanAddressPatch, describeAddressChange } from './delivery-address.js'

test('only known fields are kept, trimmed, and a postcode is upper-cased', () => {
  assert.deepEqual(cleanAddressPatch({ address_1: '  147a   Knollys Road ', postal_code: 'sw16 2jp', evil: 'x' }), { address_1: '147a Knollys Road', postal_code: 'SW16 2JP' })
})

test('nothing to change, an empty street, and a bad UK postcode are refused', () => {
  assert.throws(() => cleanAddressPatch({}), AddressError)
  assert.throws(() => cleanAddressPatch({ address_1: ' ' }), AddressError)
  assert.throws(() => cleanAddressPatch({ country_code: 'GB', postal_code: 'NOT A CODE' }), AddressError)
  assert.throws(() => cleanAddressPatch({ country_code: 'United Kingdom' }), AddressError)
})

test('a field left out is left alone and a second line can be cleared', () => {
  const patch = cleanAddressPatch({ address_2: '' })
  assert.deepEqual(patch, { address_2: '' })
})

test('the history line names what changed and ignores what did not', () => {
  const line = describeAddressChange({ address_1: '147a J=Knollys Road', city: 'London' }, { address_1: '147a Knollys Road', city: 'London' })
  assert.equal(line, 'Delivery address corrected: address 1 "147a J=Knollys Road" to "147a Knollys Road"')
  assert.equal(describeAddressChange({ city: 'London' }, { city: 'London' }), 'Delivery address confirmed, nothing changed')
})
