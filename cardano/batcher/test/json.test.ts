// Exact JSON: every integer read from its own digits, every bigint written digit for digit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExact, stringifyExact } from '../src/json.ts';

test('integers past 2^53 survive a read and a write; other numbers stay numbers', () => {
  const text = '{"lp":9223372036854775807,"neg":-9007199254740993,"price":0.0577,"base":15.0,"small":7,"list":[1,2]}';
  const v = parseExact(text) as Record<string, unknown>;
  assert.equal(v.lp, 9_223_372_036_854_775_807n);
  assert.equal(v.neg, -9_007_199_254_740_993n);
  assert.equal(v.price, 0.0577);
  assert.equal(v.base, 15); // "15.0" is not written as an integer
  assert.equal(v.small, 7n);
  assert.deepEqual(v.list, [1n, 2n]);
  assert.equal(stringifyExact(v), '{"lp":9223372036854775807,"neg":-9007199254740993,"price":0.0577,"base":15,"small":7,"list":[1,2]}');
  // Plain JSON would have changed the pool.
  assert.notEqual(BigInt(JSON.parse(text).lp), 9_223_372_036_854_775_807n);
});
