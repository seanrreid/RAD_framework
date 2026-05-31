import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint } from '../fingerprint.js';

test('fingerprint is a 64-char SHA-256 hex digest', () => {
  const fp = fingerprint({ failedCategories: ['tests'], errorSummary: 'boom' });
  assert.match(fp, /^[0-9a-f]{64}$/);
});

test('equivalent failures hash equal — category order, case, whitespace insensitive', () => {
  const a = fingerprint({
    failedCategories: ['tests', 'scope'],
    errorSummary: 'Two   checks   FAILED',
  });
  const b = fingerprint({
    failedCategories: ['scope', 'tests'], // reordered
    errorSummary: 'two checks failed', // normalized whitespace + case
  });
  assert.equal(a, b);
});

test('fingerprint accepts the alias field names (categories / summary)', () => {
  const a = fingerprint({ failedCategories: ['tests'], errorSummary: 'x' });
  const b = fingerprint({ categories: ['tests'], summary: 'x' });
  assert.equal(a, b);
});

test('duplicate categories are deduped (equivalent)', () => {
  const a = fingerprint({ categories: ['tests', 'tests'], summary: 'x' });
  const b = fingerprint({ categories: ['tests'], summary: 'x' });
  assert.equal(a, b);
});

test('materially different failures differ', () => {
  const base = fingerprint({ categories: ['tests'], summary: 'assertion failed' });
  const diffCategory = fingerprint({ categories: ['scope'], summary: 'assertion failed' });
  const diffSummary = fingerprint({ categories: ['tests'], summary: 'timeout exceeded' });
  assert.notEqual(base, diffCategory);
  assert.notEqual(base, diffSummary);
});

test('empty/undefined result hashes stably to the canonical empty preimage', () => {
  assert.equal(fingerprint(undefined), fingerprint({}));
  assert.equal(fingerprint({}), fingerprint({ categories: [], summary: '' }));
});
