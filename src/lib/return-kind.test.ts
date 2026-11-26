import assert from 'node:assert/strict';
import test from 'node:test';
import { returnKind } from './return-kind.js';

test('change of mind is an ordinary return', () => {
  assert.equal(returnKind({ return_reason: 'Change of mind', how_back: 'post' }), 'return');
  assert.equal(returnKind({ return_reason: 'Customer return', items: [] }), 'return');
});

test('damaged, faulty, wrong item and missing part are damage', () => {
  for (const reason of ['Damaged', 'Faulty', 'Wrong item', 'Missing part', 'Courier problem']) {
    assert.equal(returnKind({ return_reason: reason }), 'damage', reason);
  }
});

test('a part refund where the customer keeps the goods is damage', () => {
  assert.equal(returnKind({ return_reason: 'Customer return', how_back: 'kept' }), 'damage');
});

test('a courier problem is damage, but a lost parcel is not', () => {
  assert.equal(returnKind({ courier_problem: 'refused' }), 'damage');
  assert.equal(returnKind({ courier_problem: 'lost', return_reason: 'Change of mind' }), 'return');
});

test('an item found damaged on inspection moves the return to damage', () => {
  assert.equal(returnKind({ return_reason: 'Change of mind', items: [{ item_condition: 'Unopened' }, { item_condition: 'Damaged' }] }), 'damage');
});
