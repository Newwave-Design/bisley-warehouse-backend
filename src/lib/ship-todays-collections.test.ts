import assert from 'node:assert/strict';
import { collectionShipsAutomatically } from './ship-todays-collections.ts';

const today = '2026-11-12';

assert.equal(collectionShipsAutomatically('12/11/2026', today, false), false);
assert.equal(collectionShipsAutomatically('11/11/2026', today, false), true);
assert.equal(collectionShipsAutomatically('13/11/2026', today, false), false);
assert.equal(collectionShipsAutomatically('2026-11-11', today, false), true);
assert.equal(collectionShipsAutomatically('2026-11-12', today, false), false);
assert.equal(collectionShipsAutomatically('11/11/2026', today, true), false);
assert.equal(collectionShipsAutomatically('', today, false), false);
assert.equal(collectionShipsAutomatically(null, today, false), false);

console.log('collection ship checks passed');
