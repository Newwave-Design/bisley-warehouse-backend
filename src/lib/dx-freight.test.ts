import assert from 'node:assert/strict';
import { dxGoodsDescription } from './dx-freight.ts';

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

console.log('dx return field checks passed');
