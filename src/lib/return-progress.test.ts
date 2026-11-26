import assert from 'node:assert/strict';
import test from 'node:test';
import { returnProgress, isoDay } from './return-progress.js';

const booked = { courier: 'DX', waybill: 'C3467200', collection_date: '25/11/2026', service_name: '48 hour' };

test('no collection means it still has to be booked', () => {
  const p = returnProgress({ desk_status: 'due_back', how_back: 'post' }, null, '2026-11-26');
  assert.equal(p.step, 0);
  assert.equal(p.label, 'Collection to book');
});

test('a collection in the future is booked', () => {
  const p = returnProgress({ desk_status: 'due_back' }, { ...booked, collection_date: '03/12/2026' }, '2026-11-26');
  assert.equal(p.step, 1);
  assert.equal(p.label, 'Collection booked');
  assert.match(p.detail, /DX · 3 Dec · waybill C3467200/);
});

test('a collection day that has passed is not called collected', () => {
  const p = returnProgress({ desk_status: 'due_back' }, booked, '2026-11-26');
  assert.equal(p.step, 2);
  assert.equal(p.label, 'Collection day passed');
});

test('stored stages win once the goods arrive', () => {
  assert.equal(returnProgress({ desk_status: 'to_inspect' }, booked, '2026-11-26').step, 3);
  assert.equal(returnProgress({ desk_status: 'to_decide' }, booked, '2026-11-26').step, 4);
  assert.equal(returnProgress({ desk_status: 'to_refund' }, null, '2026-11-26').label, 'Refund to pay');
  assert.equal(returnProgress({ desk_status: 'closed' }, null, '2026-11-26').step, 5);
});

test('goods the customer keeps go straight to decide', () => {
  assert.equal(returnProgress({ desk_status: 'due_back', how_back: 'kept' }, null, '2026-11-26').label, 'To decide');
});

test('dates read both ways', () => {
  assert.equal(isoDay('25/11/2026'), '2026-11-25');
  assert.equal(isoDay('2026-11-25'), '2026-11-25');
  assert.equal(isoDay(''), null);
});
