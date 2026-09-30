import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from './slugify.js';

test('lowercases and hyphenates words', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('collapses punctuation runs and trims edge hyphens', () => {
  assert.equal(slugify('  Ship it!!  (v2) '), 'ship-it-v2');
});

test('caps the slug at 60 characters without a trailing hyphen', () => {
  const slug = slugify('word '.repeat(30));
  assert.ok(slug.length <= 60);
  assert.ok(!slug.endsWith('-'));
});

test('rejects a title with no slug-able characters', () => {
  assert.throws(() => slugify('!!!'), RangeError);
});

test('rejects an empty title', () => {
  assert.throws(() => slugify(''), RangeError);
});

test('rejects a non-string title', () => {
  assert.throws(() => slugify(undefined), TypeError);
});
