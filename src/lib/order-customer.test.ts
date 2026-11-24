import assert from 'node:assert/strict'
import test from 'node:test'
import { addressChanges, customerEmailChanged, customerFromOrder } from './order-customer.js'

const billingOnly = customerFromOrder({
  email: 'judy.tellingisat@gmail.com',
  customer: { email: 'judy.tellingisat@gmail.com' },
  shipping_address: { country_code: 'gb' },
  billing_address: {
    first_name: 'Elizabeth',
    last_name: 'Telling',
    address_1: '56 Hapil Close',
    city: 'Winscombe',
    postal_code: 'BS25 5AD',
  },
})
assert.equal(billingOnly.customerName, 'Elizabeth Telling')
assert.equal(billingOnly.customerEmail, 'judy.tellingisat@gmail.com')
assert.equal(billingOnly.shippingAddress.address_1, '56 Hapil Close')
assert.equal(billingOnly.shippingAddress.postal_code, 'BS25 5AD')
assert.equal(billingOnly.shippingAddress.country_code, 'gb')

const shippingWins = customerFromOrder({
  email: 'ada@example.com',
  shipping_address: { first_name: 'Ada', last_name: 'Lovelace', address_1: '1 Road', postal_code: 'B1 1AA', country_code: 'gb' },
  billing_address: { first_name: 'Other', last_name: 'Person', address_1: '2 Road', postal_code: 'SW1A 1AA' },
})
assert.equal(shippingWins.customerName, 'Ada Lovelace')
assert.equal(shippingWins.shippingAddress.address_1, '1 Road')

const emailOnly = customerFromOrder({ email: 'only@example.com', shipping_address: { country_code: 'gb' } })
assert.equal(emailOnly.customerName, 'only@example.com')

assert.equal(customerEmailChanged(['old@example.com'], 'new@example.com'), 'new@example.com')
assert.equal(customerEmailChanged(['new@example.com'], 'new@example.com'), null)
assert.equal(customerEmailChanged([' New@example.com '], 'new@example.com'), null)
assert.equal(customerEmailChanged([''], 'new@example.com'), 'new@example.com')
assert.equal(customerEmailChanged(['old@example.com'], '  '), null)
assert.equal(customerEmailChanged(['old@example.com', 'new@example.com'], 'new@example.com'), 'new@example.com')

console.log('order-customer ok')

test('a corrected street is copied and an unchanged address is left alone', () => {
  const shop = customerFromOrder({ shipping_address: { first_name: 'Amy', last_name: 'W', address_1: '147a Knollys Road', city: 'London', postal_code: 'SW16 2JP', country_code: 'gb', phone: '0123' } }).shippingAddress
  assert.deepEqual(addressChanges({ ...shop, address_1: '147a J=Knollys Road' }, shop), { address_1: '147a Knollys Road' })
  assert.deepEqual(addressChanges({ ...shop }, shop), {})
})

test('postcode spacing and country case are not changes', () => {
  const shop = customerFromOrder({ shipping_address: { first_name: 'A', last_name: 'B', address_1: '1 High St', city: 'Leeds', postal_code: 'LS1 4AB', country_code: 'gb' } }).shippingAddress
  assert.deepEqual(addressChanges({ ...shop, postal_code: 'LS14AB', country_code: 'GB' }, shop), {})
})

test('a half-filled shop address never wipes a good one, and a phone is never blanked', () => {
  const half = customerFromOrder({ shipping_address: { first_name: 'A', last_name: 'B', address_1: '', city: 'Leeds', postal_code: '' } }).shippingAddress
  assert.deepEqual(addressChanges({ address_1: '1 High St', city: 'Leeds', postal_code: 'LS1 4AB' }, half), {})
  const noPhone = customerFromOrder({ shipping_address: { first_name: 'A', last_name: 'B', address_1: '1 High St', city: 'Leeds', postal_code: 'LS1 4AB', country_code: 'gb', phone: '' } }).shippingAddress
  assert.deepEqual(addressChanges({ ...noPhone, phone: '0123' }, noPhone), {})
})

test('a second line can be cleared', () => {
  const shop = customerFromOrder({ shipping_address: { first_name: 'A', last_name: 'B', address_1: '1 High St', address_2: '', city: 'Leeds', postal_code: 'LS1 4AB', country_code: 'gb' } }).shippingAddress
  assert.deepEqual(addressChanges({ ...shop, address_2: 'Flat 2' }, shop), { address_2: '' })
})
