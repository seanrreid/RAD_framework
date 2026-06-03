import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGates, evaluateGate } from '../gates.js';

const approved = (extra = {}) => ({
  feature: 'f',
  type: 'approved',
  actor: 'sean@torchcodelab.com',
  role: 'architect',
  ts: 't',
  ...extra,
});

test("gate('approved'): direct architect approval passes", () => {
  const result = evaluateGate('approved', [approved()]);
  assert.equal(result.passed, true);
  assert.equal(result.requiredRole, 'architect');
  assert.deepEqual(result.satisfiedBy, { actor: 'sean@torchcodelab.com', role: 'architect' });
});

test("gate('approved'): proxy approval passes and satisfiedBy exposes actor, role, and recordedBy", () => {
  const result = evaluateGate('approved', [
    approved({ actor: 'sean@torchcodelab.com', role: 'architect', recordedBy: 'dev' }),
  ]);
  assert.equal(result.passed, true);
  assert.deepEqual(result.satisfiedBy, { actor: 'sean@torchcodelab.com', role: 'architect', recordedBy: 'dev' });
});

test("gate('approved'): no-approval history fails with a clear reason", () => {
  const result = evaluateGate('approved', [
    { feature: 'f', type: 'plan-created', actor: 'dev', role: 'developer', ts: 't' },
  ]);
  assert.equal(result.passed, false);
  assert.equal(result.satisfiedBy, null);
  assert.match(result.reason, /architect/);
});

test("gate('approved'): an approved event with a non-architect role does not satisfy", () => {
  const result = evaluateGate('approved', [approved({ role: 'developer' })]);
  assert.equal(result.passed, false);
  assert.equal(result.satisfiedBy, null);
});

test("gate('approved'): an approved event with no role field does not satisfy", () => {
  const result = evaluateGate('approved', [
    { feature: 'f', type: 'approved', actor: 'architect', ts: 't' },
  ]);
  assert.equal(result.passed, false);
  assert.equal(result.satisfiedBy, null);
});

test('loadGates parses gates.yaml and declares the approved gate', () => {
  const gates = loadGates();
  assert.ok(gates.approved);
  assert.equal(gates.approved.eventType, 'approved');
  assert.equal(gates.approved.requiredRole, 'architect');
  assert.equal(gates.approved.condition, 'role-equals');
});

test('evaluateGate throws on an unknown gate name', () => {
  assert.throws(() => evaluateGate('no-such-gate', []), /No gate rule/);
});

test('evaluateGate honours an injected roleOf resolver (proxy-preservation)', () => {
  // role "senior-architect" should be accepted by a roleOf that maps it to "architect".
  const gates = loadGates();
  const result = evaluateGate(
    'approved',
    [approved({ actor: 'alice', role: 'senior-architect' })],
    gates,
    { roleOf: (r) => (r === 'senior-architect' ? 'architect' : r) },
  );
  assert.equal(result.passed, true);
  assert.deepEqual(result.satisfiedBy, { actor: 'alice', role: 'senior-architect' });
});
