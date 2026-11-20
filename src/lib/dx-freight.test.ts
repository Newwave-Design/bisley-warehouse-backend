import assert from 'node:assert/strict';
import { collectionPhone, dxGoodsDescription, dxPhone, quoteDxCollection } from './dx-freight.ts';

const quote = quoteDxCollection({
  pieces: 1,
  collectionPostcode: 'NP4 0HZ',
  deliveryPostcode: 'BS1 4ST',
  now: new Date('2026-11-20T10:00:00Z'),
});
const offered = quote.services.map((service) => service.name);
assert.deepEqual(offered.slice(0, 3), ['48 hour', 'Next day', '72 hour']);
assert.equal(quote.services.find((service) => service.ruleMatch)?.code, '48');

const long = dxGoodsDescription('MultiDesk 1800 Walnut pedestal return collection for Sydney');
assert.equal(long.length <= 30, true, long);
assert.equal(/^[\x20-\x7E]+$/.test(long), true);

const quoted = dxGoodsDescription("St David\u2019s cabinet");
assert.equal(quoted.includes('\u2019'), false);
assert.equal(quoted.length <= 30, true);

const empty = dxGoodsDescription('');
assert.equal(empty, 'Furniture');

const exact = dxGoodsDescription('1234567890123456789012345678901');
assert.equal(exact, '123456789012345678901234567890');
assert.equal(exact.length, 30);

assert.equal(dxPhone('+44 7518 579132'), '07518579132');
assert.equal(dxPhone('+447518579132'), '07518579132');
assert.equal(dxPhone('+44 (0) 7518 579132'), '07518579132');
assert.equal(collectionPhone('+44 7518 579132', '01873900095'), '07518579132');
assert.equal(collectionPhone('', '07518579132'), '07518579132');

console.log('dx return field checks passed');
