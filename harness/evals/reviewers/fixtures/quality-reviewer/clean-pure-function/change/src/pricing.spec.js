import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderTotalCents, formatDollars } from './pricing.js';

test('charges full price below the bulk threshold', () => {
  assert.equal(orderTotalCents(250, 4), 1000);
});

test('applies the bulk discount at the threshold', () => {
  assert.equal(orderTotalCents(100, 10), 850);
});

test('rejects zero and negative quantities', () => {
  assert.throws(() => orderTotalCents(100, 0), RangeError);
  assert.throws(() => orderTotalCents(100, -1), RangeError);
});

test('rejects a fractional price', () => {
  assert.throws(() => orderTotalCents(9.5, 1), RangeError);
});

test('formats cents as dollars', () => {
  assert.equal(formatDollars(1234), '$12.34');
});
