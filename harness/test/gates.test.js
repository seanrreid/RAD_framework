import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGates, evaluateGate } from '../gates.js';

const approved = (extra = {}) => ({
  feature: 'f',
  type: 'approved',
  actor: 'architect',
  ts: 't',
  ...extra,
});

test("gate('approved'): direct architect approval passes", () => {
  const result = evaluateGate('approved', [approved()]);
  assert.equal(result.passed, true);
  assert.equal(result.requiredRole, 'architect');
  assert.deepEqual(result.satisfiedBy, { actor: 'architect' });
});

test("gate('approved'): proxy approval passes and satisfiedBy exposes both names", () => {
  const result = evaluateGate('approved', [
    approved({ actor: 'architect', recordedBy: 'dev' }),
  ]);
  assert.equal(result.passed, true);
  assert.deepEqual(result.satisfiedBy, { actor: 'architect', recordedBy: 'dev' });
});

test("gate('approved'): no-approval history fails with a clear reason", () => {
  const result = evaluateGate('approved', [
    { feature: 'f', type: 'plan-created', actor: 'dev', ts: 't' },
  ]);
  assert.equal(result.passed, false);
  assert.equal(result.satisfiedBy, null);
  assert.match(result.reason, /architect/);
});

test("gate('approved'): an approval from a non-architect actor does not satisfy", () => {
  const result = evaluateGate('approved', [approved({ actor: 'dev' })]);
  assert.equal(result.passed, false);
  assert.equal(result.satisfiedBy, null);
});

test('loadGates parses gates.yaml and declares the approved gate', () => {
  const gates = loadGates();
  assert.ok(gates.approved);
  assert.equal(gates.approved.eventType, 'approved');
  assert.equal(gates.approved.requiredRole, 'architect');
  assert.equal(gates.approved.condition, 'actor-has-role');
});

test('evaluateGate throws on an unknown gate name', () => {
  assert.throws(() => evaluateGate('no-such-gate', []), /No gate rule/);
});

test('evaluateGate honours an injected roleOf resolver', () => {
  // actor "alice" is not literally "architect" but the role map says she is.
  const gates = loadGates();
  const result = evaluateGate('approved', [approved({ actor: 'alice' })], gates, {
    roleOf: (a) => (a === 'alice' ? 'architect' : a),
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.satisfiedBy, { actor: 'alice' });
});
