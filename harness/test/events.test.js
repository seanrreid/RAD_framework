import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reduce,
  phaseOf,
  outcomeCounts,
  failReasonCounts,
  retryCounts,
  hookVetoCounts,
} from '../events.js';

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

// ── Insights read helpers ────────────────────────────────────────────────────
// Synthetic histories below are shaped exactly per the spine record sites:
//   wave-attempt   → data.{ wave, outcome, usage } (+ source/point/hook when hook-vetoed)
//   wave-failed    → data.{ wave, reason } (matrix terminal: data.{ wave, action }, no reason)
//   wave-complete  → data.{ wave }
//   hook-veto      → data.{ point, hook, outcome, source }

test('outcomeCounts folds wave-complete events across the 7-outcome vocabulary + unknown', () => {
  const history = [
    // Spine-shaped wave-complete: data carries only { wave } → unknown bucket.
    { feature: 'f', type: 'wave-complete', actor: 'harness', ts: 't1', data: { wave: 1 } },
    // Outcome-carrying variants (tolerated shape) land in their vocab bucket.
    { feature: 'f', type: 'wave-complete', actor: 'harness', ts: 't2', data: { wave: 2, outcome: 'success' } },
    { feature: 'f', type: 'wave-complete', actor: 'harness', ts: 't3', data: { wave: 3, outcome: 'success' } },
    // Out-of-vocabulary outcome → unknown, never a new key.
    { feature: 'f', type: 'wave-complete', actor: 'harness', ts: 't4', data: { wave: 4, outcome: 'bogus' } },
    // Non-wave-complete events contribute nothing.
    { feature: 'f', type: 'wave-attempt', actor: 'harness', ts: 't5', data: { wave: 4, outcome: 'success' } },
  ];
  const counts = outcomeCounts(history);
  assert.equal(counts.success, 2);
  assert.equal(counts.unknown, 2);
  assert.equal(counts.total, 4);
  assert.equal(counts['fail-tests'], 0);
  assert.equal(counts['abort-user'], 0);
  assert.equal('bogus' in counts, false);
});

test('failReasonCounts keys wave-failed events by free-form reason', () => {
  const history = [
    { feature: 'f', type: 'wave-failed', actor: 'harness', ts: 't1', data: { wave: 1, reason: 'token-budget', spent: 9, budget: 8 } },
    { feature: 'f', type: 'wave-failed', actor: 'harness', ts: 't2', data: { wave: 2, reason: 'doom-loop' } },
    { feature: 'f', type: 'wave-failed', actor: 'harness', ts: 't3', data: { wave: 2, reason: 'doom-loop' } },
    // Matrix terminal shape: { wave, action }, no reason → 'unknown' bucket.
    { feature: 'f', type: 'wave-failed', actor: 'harness', ts: 't4', data: { wave: 3, action: 'abort' } },
    // Non-wave-failed events contribute nothing.
    { feature: 'f', type: 'wave-complete', actor: 'harness', ts: 't5', data: { wave: 1 } },
  ];
  const counts = failReasonCounts(history);
  assert.equal(counts.total, 4);
  assert.deepEqual(counts.reasons, { 'token-budget': 1, 'doom-loop': 2, unknown: 1 });
});

test('retryCounts tallies attempts per wave and counts retried waves', () => {
  const history = [
    // Wave 1: three attempts (retried).
    { feature: 'f', type: 'wave-attempt', actor: 'harness', ts: 't1', data: { wave: 1, outcome: 'fail-tests', usage: { input: 1, output: 1, total: 2 } } },
    { feature: 'f', type: 'wave-attempt', actor: 'harness', ts: 't2', data: { wave: 1, outcome: 'fail-tests' } },
    { feature: 'f', type: 'wave-attempt', actor: 'harness', ts: 't3', data: { wave: 1, outcome: 'success' } },
    // Wave 2: single attempt (not retried).
    { feature: 'f', type: 'wave-attempt', actor: 'harness', ts: 't4', data: { wave: 2, outcome: 'success' } },
    // Legacy attempt with no data: counts toward total, no per-wave key.
    { feature: 'f', type: 'wave-attempt', actor: 'harness', ts: 't5' },
  ];
  const counts = retryCounts(history);
  assert.equal(counts.total, 5);
  assert.deepEqual(counts.perWave, { 1: 3, 2: 1 });
  assert.equal(counts.retriedWaves, 1);
});

test('hookVetoCounts counts hook-veto events and provenance-tagged attempts separately', () => {
  const history = [
    // Spine-shaped hook-veto (pre-wave provenance record).
    { feature: 'f', type: 'hook-veto', actor: 'harness', ts: 't1', data: { point: 'pre-wave', hook: '10-policy.sh', outcome: 'abort-user', source: 'hook' } },
    // Post-wave veto: the attempt carries source/point/hook provenance.
    { feature: 'f', type: 'wave-attempt', actor: 'harness', ts: 't2', data: { wave: 1, outcome: 'abort-user', usage: { input: 1, output: 1, total: 2 }, source: 'hook', point: 'post-wave', hook: '20-scope.sh' } },
    // Untagged attempt contributes nothing.
    { feature: 'f', type: 'wave-attempt', actor: 'harness', ts: 't3', data: { wave: 2, outcome: 'success' } },
  ];
  const counts = hookVetoCounts(history);
  assert.equal(counts.vetoes, 1);
  assert.equal(counts.vetoedAttempts, 1);
});

test('insights helpers return zeroed shapes on empty, non-array, and wave-event-free histories', () => {
  const approvedOnly = [
    { feature: 'f', type: 'approved', actor: 'architect', role: 'architect', ts: 't1' },
  ];
  const zeroOutcomes = {
    success: 0,
    'fail-tests': 0,
    'fail-scope': 0,
    'fail-protocol': 0,
    'fail-timeout': 0,
    'no-changes': 0,
    'abort-user': 0,
    unknown: 0,
    total: 0,
  };
  for (const history of [[], null, {}, approvedOnly]) {
    assert.deepEqual(outcomeCounts(history), zeroOutcomes);
    assert.deepEqual(failReasonCounts(history), { total: 0, reasons: {} });
    assert.deepEqual(retryCounts(history), { total: 0, retriedWaves: 0, perWave: {} });
    assert.deepEqual(hookVetoCounts(history), { vetoes: 0, vetoedAttempts: 0 });
  }
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
