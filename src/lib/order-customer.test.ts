import assert from 'node:assert/strict'
import { customerFromOrder } from './order-customer.js'

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

console.log('order-customer ok')
