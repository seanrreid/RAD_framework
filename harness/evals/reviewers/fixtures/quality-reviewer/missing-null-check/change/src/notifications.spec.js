import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShippedEmail } from './notifications.js';

const users = [{ id: 'u1', email: 'ada@example.com' }];

test('addresses the email to the ordering customer', () => {
  const email = buildShippedEmail(users, { id: 'o9', customerId: 'u1' });
  assert.equal(email.to, 'ada@example.com');
  assert.match(email.subject, /Order o9 has shipped/);
});

test('rejects a non-array user list', () => {
  assert.throws(() => buildShippedEmail(null, { id: 'o9', customerId: 'u1' }), TypeError);
});
