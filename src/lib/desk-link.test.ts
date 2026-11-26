import assert from 'node:assert/strict';
import test from 'node:test';
import { claimEmail } from './desk-link.js';

const pack = { rma: 'RMA-1', order: 'PL-20261115-0665', customer: 'Neel Madsen', consignment: 'L9804305', text: 'Claim pack RMA-1' };

test('a carrier claim names the consignment', () => {
  const mail = claimEmail({ ...pack, kind: 'carrier' }, '');
  assert.equal(mail.subject, 'Damage claim RMA-1: consignment L9804305, order PL-20261115-0665');
  assert.match(mail.body, /damaged in transit/);
  assert.match(mail.body, /Claim pack RMA-1$/);
});

test('a Bisley claim names the order and customer, and a typed note leads', () => {
  const mail = claimEmail({ ...pack, kind: 'bisley' }, 'Hi Sue, another chipped cabinet.');
  assert.equal(mail.subject, 'Damage claim RMA-1: order PL-20261115-0665, Neel Madsen');
  assert.ok(mail.body.startsWith('Hi Sue, another chipped cabinet.\n\nClaim pack RMA-1'));
});
