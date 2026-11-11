import assert from 'node:assert/strict';
import { familyHasPackaging, packagingReorder, weeklyFromPlan, weeklyFromShipments } from './packaging-reorder.ts';

const due = packagingReorder({ stock: 30, weekly: 10, waiting: 0 });
assert.equal(due.orderNow, true);
assert.equal(due.orderQty, 10);
assert.equal(due.weeksLeft, 3);

const covered = packagingReorder({ stock: 50, weekly: 10, waiting: 0 });
assert.equal(covered.orderNow, false);
assert.equal(covered.orderQty, 0);
assert.equal(covered.orderInDays, 7);

const spike = packagingReorder({ stock: 20, weekly: 2, waiting: 40 });
assert.equal(spike.orderNow, true);
assert.equal(spike.orderQty, 20);

const hole = packagingReorder({ stock: -32, weekly: 5, waiting: 4 });
assert.equal(hole.orderNow, true);
assert.equal(hole.orderQty, 52);

const idle = packagingReorder({ stock: 0, weekly: 0, waiting: 0 });
assert.equal(idle.orderNow, false);

const first = new Date('2026-09-29T00:00:00Z');
const now = new Date('2026-11-11T00:00:00Z');
const weekly = weeklyFromShipments(32, first, now);
assert.ok(weekly > 5 && weekly < 6, `weekly ${weekly}`);
assert.ok(Math.abs(weeklyFromPlan(88) - 88 / (52 / 12)) < 0.001);

assert.equal(familyHasPackaging(['PFA3NH-AG8', 'PFHAWALNHCPK1'], (sku) => sku.startsWith('PFA3NH')), true);
assert.equal(familyHasPackaging(['PIT580'], () => false), false);
assert.equal(familyHasPackaging([], () => true), false);

console.log('packaging reorder checks passed');
