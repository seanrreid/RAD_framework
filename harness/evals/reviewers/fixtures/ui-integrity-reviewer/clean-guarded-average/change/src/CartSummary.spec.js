import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discountPercent } from './CartSummary.jsx';

test('returns 0 for an empty cart instead of NaN', () => {
  assert.equal(discountPercent([]), 0);
});

test('returns 0 when every price is zero', () => {
  assert.equal(discountPercent([{ price: 0, qty: 2, discount: 0 }]), 0);
});

test('computes the percentage saved', () => {
  assert.equal(discountPercent([{ price: 10, qty: 2, discount: 1 }]), 10);
});
