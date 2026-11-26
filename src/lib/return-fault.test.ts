import assert from 'node:assert/strict';
import test from 'node:test';
import { canRaiseClaim, claimKindForFault, evidenceChecklist, suggestFault } from './return-fault.js';

test('fault decides which claim it leads to', () => {
  assert.equal(claimKindForFault('courier'), 'carrier');
  assert.equal(claimKindForFault('manufacturing'), 'bisley');
  assert.equal(claimKindForFault('packing'), 'bisley');
  assert.equal(claimKindForFault('customer'), null);
  assert.equal(claimKindForFault(null), null);
});

test('no claim until the fault is set', () => {
  assert.equal(canRaiseClaim({ kind: 'carrier', fault: null, photoKinds: ['box'] }).ok, false);
  assert.equal(canRaiseClaim({ kind: 'carrier', fault: 'unknown', photoKinds: ['box'] }).ok, false);
});

test('the claim must match the fault', () => {
  assert.equal(canRaiseClaim({ kind: 'bisley', fault: 'courier', photoKinds: ['item'] }).ok, false);
  assert.equal(canRaiseClaim({ kind: 'carrier', fault: 'manufacturing', photoKinds: ['box'] }).ok, false);
});

test('a carrier claim needs a box or label photo, or a reason', () => {
  assert.equal(canRaiseClaim({ kind: 'carrier', fault: 'courier', photoKinds: ['item'] }).ok, false);
  assert.equal(canRaiseClaim({ kind: 'carrier', fault: 'courier', photoKinds: ['item', 'box'] }).ok, true);
  assert.equal(canRaiseClaim({ kind: 'carrier', fault: 'courier', photoKinds: ['label'] }).ok, true);
  assert.equal(canRaiseClaim({ kind: 'carrier', fault: 'courier', photoKinds: ['item'], override: 'Box thrown away before photos, driver note says dropped' }).ok, true);
  assert.equal(canRaiseClaim({ kind: 'carrier', fault: 'courier', photoKinds: ['item'], override: 'short' }).ok, false);
});

test('a Bisley claim needs a photo of the damage, or a reason', () => {
  assert.equal(canRaiseClaim({ kind: 'bisley', fault: 'manufacturing', photoKinds: [] }).ok, false);
  assert.equal(canRaiseClaim({ kind: 'bisley', fault: 'manufacturing', photoKinds: [null] }).ok, true);
  assert.equal(canRaiseClaim({ kind: 'bisley', fault: 'packing', photoKinds: [], override: 'Inspected in the warehouse, paint bubbling' }).ok, true);
});

test('a closed case cannot be claimed', () => {
  assert.equal(canRaiseClaim({ kind: 'carrier', fault: 'courier', photoKinds: ['box'], open: false }).ok, false);
});

test('the hint reads the box', () => {
  assert.equal(suggestFault({ notes: 'The package has obviously been dropped and the corner is dented' })?.fault, 'courier');
  assert.equal(suggestFault({ notes: 'The cabinet was well wrapped and the box was not damaged, but the paint is chipped' })?.fault, 'manufacturing');
  assert.equal(suggestFault({ courier_problem: 'refused' })?.fault, 'courier');
  assert.equal(suggestFault({ reason: 'Faulty' })?.fault, 'manufacturing');
  assert.equal(suggestFault({ notes: 'Legs damaged' }), null);
});

test('the checklist shows what a claim still needs', () => {
  const list = evidenceChecklist({ photoKinds: ['item'], reportedAt: null, tracking: 'C346', fault: 'courier' });
  const done = Object.fromEntries(list.map((row) => [row.key, row.ok]));
  assert.deepEqual(done, { item: true, box: false, label: false, reported: false, tracking: true, fault: true });
});
