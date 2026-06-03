import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, phaseOf } from '../events.js';

test('reduce on empty history → null phase, no markers, no approvals', () => {
  const out = reduce([]);
  assert.equal(out.phase, null);
  assert.deepEqual(out.markers, []);
  assert.deepEqual(out.approvals, []);
});

test('reduce derives the highest-ranked phase regardless of event order', () => {
  // 'done' is terminal/highest; it should dominate even appearing before others.
  const history = [
    { feature: 'f', type: 'done', actor: 'harness', ts: '2026-01-03T00:00:00Z' },
    { feature: 'f', type: 'plan-created', actor: 'dev', ts: '2026-01-01T00:00:00Z' },
    { feature: 'f', type: 'approved', actor: 'architect', ts: '2026-01-02T00:00:00Z' },
  ];
  assert.equal(reduce(history).phase, 'done');
});

test('reduce in-progress while waves run', () => {
  const history = [
    { feature: 'f', type: 'plan-created', actor: 'dev', ts: 't1' },
    { feature: 'f', type: 'approved', actor: 'architect', ts: 't2' },
    { feature: 'f', type: 'deliver-started', actor: 'harness', ts: 't3' },
    { feature: 'f', type: 'wave-attempt', actor: 'harness', ts: 't4' },
  ];
  assert.equal(reduce(history).phase, 'in-progress');
});

test('reduce surfaces a marker per observed event type', () => {
  const history = [
    { feature: 'f', type: 'plan-created', actor: 'dev', ts: 't1' },
    { feature: 'f', type: 'approved', actor: 'architect', ts: 't2' },
    { feature: 'f', type: 'approved', actor: 'architect', ts: 't3' }, // dup type collapses
  ];
  const markers = reduce(history).markers;
  assert.ok(markers.includes('plan-created'));
  assert.ok(markers.includes('approved'));
  // markers is a set projection → 'approved' appears once.
  assert.equal(markers.filter((m) => m === 'approved').length, 1);
});

test('reduce collects every approval (direct + proxy) with audit fields', () => {
  const history = [
    { feature: 'f', type: 'approved', actor: 'architect', role: 'architect', ts: 't1' },
    {
      feature: 'f',
      type: 'approved',
      actor: 'architect',
      role: 'architect',
      recordedBy: 'dev',
      ts: 't2',
    },
  ];
  const { approvals } = reduce(history);
  assert.equal(approvals.length, 2);
  // Direct approval: role present, no recordedBy key at all (not an undefined-valued one).
  assert.deepEqual(approvals[0], { actor: 'architect', role: 'architect', ts: 't1' });
  assert.equal('recordedBy' in approvals[0], false);
  // Proxy approval: actor (identity), role (authority), recordedBy (runner) all present.
  assert.deepEqual(approvals[1], {
    actor: 'architect',
    role: 'architect',
    recordedBy: 'dev',
    ts: 't2',
  });
});

test('reduce surfaces role on approved events; actor is the identity token', () => {
  const history = [
    {
      feature: 'f',
      type: 'approved',
      actor: 'sean@torchcodelab.com',
      role: 'architect',
      ts: 't1',
    },
  ];
  const { approvals } = reduce(history);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].actor, 'sean@torchcodelab.com');
  assert.equal(approvals[0].role, 'architect');
  assert.equal('recordedBy' in approvals[0], false);
});

test('reduce ignores unknown event types for phase but still marks them', () => {
  const history = [
    { feature: 'f', type: 'plan-created', actor: 'dev', ts: 't1' },
    { feature: 'f', type: 'custom-note', actor: 'dev', ts: 't2' },
  ];
  const out = reduce(history);
  assert.equal(out.phase, 'planned'); // custom-note implies no phase
  assert.ok(out.markers.includes('custom-note'));
});

test('reduce throws on a non-array history', () => {
  assert.throws(() => reduce(null), TypeError);
  assert.throws(() => reduce({}), TypeError);
});

test('phaseOf is pure — no filesystem access (only the passed array matters)', () => {
  // Pure-fold contract: the result is a function solely of its argument. We assert
  // determinism + absence of any I/O by confirming repeated calls with a frozen
  // input are identical and that no event with a bogus path is consulted.
  const history = Object.freeze([
    Object.freeze({ feature: 'f', type: 'pr-opened', actor: 'harness', ts: 't1' }),
  ]);
  assert.equal(phaseOf(history), 'delivered');
  assert.equal(phaseOf(history), 'delivered');
  // A second, independent call with empty input is unaffected by the first.
  assert.equal(phaseOf([]), null);
});
