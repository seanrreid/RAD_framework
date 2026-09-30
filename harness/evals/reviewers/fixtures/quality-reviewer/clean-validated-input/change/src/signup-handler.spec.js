import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSignup, validateSignup } from './signup-handler.js';

const fakeUsers = { create: async (fields) => ({ id: 'u1', ...fields }) };

test('creates a user from a valid body', async () => {
  const res = await handleSignup({ email: 'Ada@Example.com', name: ' Ada ' }, fakeUsers);
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { id: 'u1' });
});

test('rejects a malformed email with 400', async () => {
  const res = await handleSignup({ email: 'nope', name: 'Ada' }, fakeUsers);
  assert.equal(res.status, 400);
});

test('rejects a missing body', () => {
  assert.deepEqual(validateSignup(null), ['request body must be a JSON object']);
});

test('rejects an empty name', () => {
  assert.equal(validateSignup({ email: 'a@b.co', name: '  ' }).length, 1);
});

test('propagates a persistence failure', async () => {
  const brokenUsers = { create: async () => { throw new Error('db down'); } };
  await assert.rejects(handleSignup({ email: 'a@b.co', name: 'Ada' }, brokenUsers), /db down/);
});
