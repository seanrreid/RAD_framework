import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reduce,
  phaseOf,
  resumeFrom,
  totalUsage,
  outcomeCounts,
  failReasonCounts,
  retryCounts,
  hookVetoCounts,
  blockedReasonCounts,
  fileFailureCounts,
  FILE_FAILURE_MIN_FEATURES,
  waveReliability,
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

const ZERO_FILE_FAILURES = { files: {}, belowFloor: 0, minFeatures: 2 };
const ZERO_BLOCKED = { blocked_code: 0, blocked_spec: 0, blocked_intent: 0, enrichedAttempts: 0 };

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
    assert.deepEqual(blockedReasonCounts(history), ZERO_BLOCKED);
    assert.deepEqual(fileFailureCounts(history, { t: ['a.js'] }), ZERO_FILE_FAILURES);
  }
});

// ── Fold parity on historical logs (AC#5) ────────────────────────────────────
// `tasks` and `verify` are OPTIONAL, data-only keys on a `wave-attempt` event's
// `data`. This block is the GATE on the "additive at parity" claim: every fold
// this module exports must return the SAME result on a log that predates those
// keys — the expected values below are hand-computed against the pre-change
// behavior, not captured from a run. Every fold is named explicitly; a partial
// sweep would not gate the claim.

/** Recursively freeze so a fold that mutated its input would throw, not pass. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

// A realistic pre-change feature log: research → plan → approve → three waves
// (clean advance, retried advance, hook-vetoed failure) → PR. No `tasks`, no
// `verify`, anywhere.
const LEGACY_HISTORY = deepFreeze([
  { feature: 'legacy', type: 'research-created', actor: 'dev', ts: 't0' },
  { feature: 'legacy', type: 'plan-created', actor: 'dev', ts: 't1' },
  { feature: 'legacy', type: 'approved', actor: 'architect', role: 'architect', ts: 't2', data: { fingerprint: 'abc123' } },
  { feature: 'legacy', type: 'deliver-started', actor: 'harness', ts: 't3' },
  // Wave 1 — single attempt, advanced. wave-complete carries only { wave }.
  { feature: 'legacy', type: 'wave-attempt', actor: 'harness', ts: 't4', data: { wave: 1, outcome: 'success', usage: { input: 10, output: 5, total: 15 } } },
  { feature: 'legacy', type: 'wave-complete', actor: 'harness', ts: 't5', data: { wave: 1 } },
  // Wave 2 — retried; the second attempt carries no usage (command adapter).
  { feature: 'legacy', type: 'wave-attempt', actor: 'harness', ts: 't6', data: { wave: 2, outcome: 'fail-tests', usage: { input: 4, output: 2, total: 6 } } },
  { feature: 'legacy', type: 'wave-attempt', actor: 'harness', ts: 't7', data: { wave: 2, outcome: 'success' } },
  { feature: 'legacy', type: 'wave-complete', actor: 'harness', ts: 't8', data: { wave: 2, outcome: 'success' } },
  // Wave 3 — post-wave hook veto, then a reasoned terminal. Never completes.
  { feature: 'legacy', type: 'hook-veto', actor: 'harness', ts: 't9', data: { point: 'post-wave', hook: '20-scope.sh', outcome: 'abort-user', source: 'hook' } },
  { feature: 'legacy', type: 'wave-attempt', actor: 'harness', ts: 't10', data: { wave: 3, outcome: 'abort-user', usage: { input: 1, output: 1, total: 2 }, source: 'hook', point: 'post-wave', hook: '20-scope.sh' } },
  { feature: 'legacy', type: 'wave-failed', actor: 'harness', ts: 't11', data: { wave: 3, reason: 'abort-user' } },
  { feature: 'legacy', type: 'pr-opened', actor: 'harness', ts: 't12' },
]);

/** Hand-computed pre-change results — the parity baseline, asserted twice below. */
const EXPECTED = {
  reduce: {
    phase: 'delivered',
    markers: ['research-created', 'plan-created', 'approved', 'deliver-started', 'wave-attempt', 'wave-complete', 'hook-veto', 'wave-failed', 'pr-opened'],
    approvals: [{ actor: 'architect', ts: 't2', role: 'architect' }],
  },
  resumeFrom: new Set([1, 2]),
  totalUsage: { input: 15, output: 8, total: 23 },
  outcomeCounts: {
    success: 1,
    'fail-tests': 0,
    'fail-scope': 0,
    'fail-protocol': 0,
    'fail-timeout': 0,
    'no-changes': 0,
    'abort-user': 0,
    unknown: 1,
    total: 2,
  },
  failReasonCounts: { total: 1, reasons: { 'abort-user': 1 } },
  retryCounts: { total: 4, retriedWaves: 1, perWave: { 1: 1, 2: 2, 3: 1 } },
};

/** Assert all six folds against the parity baseline. Named one by one on purpose. */
function assertFoldParity(history, label) {
  assert.deepEqual(reduce(history), EXPECTED.reduce, `reduce ${label}`);
  assert.deepEqual(resumeFrom(history), EXPECTED.resumeFrom, `resumeFrom ${label}`);
  assert.deepEqual(totalUsage(history), EXPECTED.totalUsage, `totalUsage ${label}`);
  assert.deepEqual(outcomeCounts(history), EXPECTED.outcomeCounts, `outcomeCounts ${label}`);
  assert.deepEqual(failReasonCounts(history), EXPECTED.failReasonCounts, `failReasonCounts ${label}`);
  assert.deepEqual(retryCounts(history), EXPECTED.retryCounts, `retryCounts ${label}`);
}

test('AC#5 — all six folds match pre-change values on a log lacking tasks/verify', () => {
  // Guard the fixture itself: if either new key ever leaks into the "historical"
  // log the parity claim would be vacuous, so assert their total absence first.
  const serialized = JSON.stringify(LEGACY_HISTORY);
  assert.equal(serialized.includes('"tasks"'), false);
  assert.equal(serialized.includes('"verify"'), false);

  assertFoldParity(LEGACY_HISTORY, 'on the legacy history');
});

test('AC#5 — the same folds are unmoved when tasks/verify ARE present (additive)', () => {
  // Same log, with both optional keys attached to every wave-attempt. No fold
  // reads them, so every result must be identical to the legacy baseline.
  const augmented = deepFreeze(
    LEGACY_HISTORY.map((event) =>
      event.type === 'wave-attempt'
        ? {
            ...event,
            data: {
              ...event.data,
              tasks: [{ title: 'a task', status: 'complete' }],
              verify: { command: 'npm test', status: 0, passed: true },
            },
          }
        : event,
    ),
  );
  assertFoldParity(augmented, 'on the augmented history');
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

// ── Regression fence over the five insights folds on the fixture corpus ──────
// harness/test/fixtures/insights is laid out as a RAD_STATE_DIR: one
// <feature>/events.jsonl per feature (legacy = pre-#89 no `tasks`; enriched =
// `tasks` on every attempt; mixed = both shapes interleaved). The expected
// objects below are HAND-COMPUTED from the fixture lines — never recomputed
// from the folds under test — so any later change that moves an existing fold's
// output on these logs turns this test red.
const INSIGHTS_FIXTURE_DIR = fileURLToPath(new URL('./fixtures/insights/', import.meta.url));
const INSIGHTS_FIXTURE_FEATURES = ['legacy', 'enriched', 'mixed'];

/** Parse one fixture feature's events.jsonl (one event per non-empty line). */
function loadInsightsFixture(feature) {
  return readFileSync(join(INSIGHTS_FIXTURE_DIR, feature, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Outcome-count shape with every bucket zeroed, overridden per fixture. */
function outcomesWith(overrides) {
  return {
    success: 0,
    'fail-tests': 0,
    'fail-scope': 0,
    'fail-protocol': 0,
    'fail-timeout': 0,
    'no-changes': 0,
    'abort-user': 0,
    unknown: 0,
    total: 0,
    ...overrides,
  };
}

const FENCE_EXPECTED = {
  legacy: {
    // Usage: 140 + (80+20, no explicit total) = 240; the 2nd wave-2 and wave-3 attempts carry none.
    totalUsage: { input: 180, output: 60, total: 240 },
    // wave-complete 1 is 'success'; wave-complete 2 has no outcome → unknown.
    outcomeCounts: outcomesWith({ success: 1, unknown: 1, total: 2 }),
    // The wave-3 surface terminal records { wave, action } with no reason.
    failReasonCounts: { total: 1, reasons: { unknown: 1 } },
    retryCounts: { total: 4, retriedWaves: 1, perWave: { 1: 1, 2: 2, 3: 1 } },
    hookVetoCounts: { vetoes: 0, vetoedAttempts: 0 },
  },
  enriched: {
    // Usage: 250 + 150 + 75 + 50; the resumed wave-2 attempt carries none.
    totalUsage: { input: 420, output: 105, total: 525 },
    outcomeCounts: outcomesWith({ success: 2, total: 2 }),
    failReasonCounts: { total: 2, reasons: { 'budget-exhausted': 1, 'abort-user': 1 } },
    retryCounts: { total: 5, retriedWaves: 1, perWave: { 1: 1, 2: 3, 3: 1 } },
    // One post-wave veto: a hook-veto event AND a provenance-tagged attempt.
    hookVetoCounts: { vetoes: 1, vetoedAttempts: 1 },
  },
  mixed: {
    // Usage: 60 + 90 + (30+5, no explicit total) + (total-only 40) = 225.
    totalUsage: { input: 150, output: 35, total: 225 },
    outcomeCounts: outcomesWith({ success: 1, 'no-changes': 1, total: 2 }),
    // doom-loop terminal, then a pre-wave-veto abort with { wave, action } only.
    failReasonCounts: { total: 2, reasons: { 'doom-loop': 1, unknown: 1 } },
    retryCounts: { total: 5, retriedWaves: 2, perWave: { 1: 2, 2: 1, 3: 2 } },
    // Pre-wave veto: a hook-veto event with no tagged attempt.
    hookVetoCounts: { vetoes: 1, vetoedAttempts: 0 },
  },
};

test('regression fence — the five insights folds return committed literals on every fixture', () => {
  for (const feature of INSIGHTS_FIXTURE_FEATURES) {
    const history = deepFreeze(loadInsightsFixture(feature));
    assert.ok(history.length > 0, `${feature} fixture is non-empty`);
    for (const event of history) assert.equal(event.feature, feature, `${feature} fixture feature field`);
    const expected = FENCE_EXPECTED[feature];
    assert.deepStrictEqual(totalUsage(history), expected.totalUsage, `totalUsage on ${feature}`);
    assert.deepStrictEqual(outcomeCounts(history), expected.outcomeCounts, `outcomeCounts on ${feature}`);
    assert.deepStrictEqual(failReasonCounts(history), expected.failReasonCounts, `failReasonCounts on ${feature}`);
    assert.deepStrictEqual(retryCounts(history), expected.retryCounts, `retryCounts on ${feature}`);
    assert.deepStrictEqual(hookVetoCounts(history), expected.hookVetoCounts, `hookVetoCounts on ${feature}`);
  }
});

test('regression fence — the fixture corpus covers legacy, enriched, and mixed task shapes', () => {
  const attempts = (feature) => loadInsightsFixture(feature).filter((e) => e.type === 'wave-attempt');
  assert.equal(attempts('legacy').some((e) => 'tasks' in e.data), false, 'legacy has no tasks key');
  assert.equal(attempts('enriched').every((e) => Array.isArray(e.data.tasks)), true, 'enriched always has tasks');
  const mixed = attempts('mixed');
  assert.equal(mixed.some((e) => Array.isArray(e.data.tasks)), true, 'mixed has enriched attempts');
  assert.equal(mixed.some((e) => !('tasks' in e.data)), true, 'mixed has legacy attempts');
  const statuses = new Set(
    INSIGHTS_FIXTURE_FEATURES.flatMap((f) => attempts(f).flatMap((e) => (e.data.tasks || []).map((t) => t.status))),
  );
  for (const status of ['complete', 'done_with_concerns', 'blocked_code', 'blocked_spec', 'blocked_intent']) {
    assert.ok(statuses.has(status), `corpus carries a ${status} task`);
  }
});

// ── blockedReasonCounts (Wave 2, AC#3) ───────────────────────────────────────
// Expected values are HAND-COMPUTED from the fixture lines:
//   legacy   — no attempt carries `tasks` → zeroed, enrichedAttempts 0.
//   enriched — 5 attempts, all with tasks; blocked tasks: one blocked_code
//              (wave 2 try 1), one blocked_spec (wave 2 try 2), one
//              blocked_intent (wave 3); complete/done_with_concerns ignored.
//   mixed    — 5 attempts, 2 with tasks (wave 1 try 2: two completes; wave 3
//              try 1: one blocked_code); the 3 legacy attempts contribute nothing.
const BLOCKED_EXPECTED = {
  legacy: ZERO_BLOCKED,
  enriched: { blocked_code: 1, blocked_spec: 1, blocked_intent: 1, enrichedAttempts: 5 },
  mixed: { blocked_code: 1, blocked_spec: 0, blocked_intent: 0, enrichedAttempts: 2 },
};

test('blockedReasonCounts buckets per-task blocked statuses on every fixture', () => {
  for (const feature of INSIGHTS_FIXTURE_FEATURES) {
    const history = deepFreeze(loadInsightsFixture(feature));
    assert.deepStrictEqual(blockedReasonCounts(history), BLOCKED_EXPECTED[feature], `blockedReasonCounts on ${feature}`);
  }
});

test('blockedReasonCounts is zeroed on tasks-free attempts and ignores malformed task data', () => {
  const tasksFree = [{ type: 'wave-attempt', data: { wave: 1, outcome: 'success' } }, { type: 'wave-attempt' }];
  assert.deepStrictEqual(blockedReasonCounts(tasksFree), ZERO_BLOCKED);
  const malformed = deepFreeze([
    { type: 'wave-attempt', data: { wave: 1, tasks: [] } },
    { type: 'wave-attempt', data: { wave: 1, tasks: 'blocked_code' } },
    { type: 'wave-attempt', data: { wave: 2, tasks: [null, { status: 7 }, { status: 'blocked_other' }, { title: 'x' }] } },
    { type: 'wave-complete', data: { wave: 2, tasks: [{ status: 'blocked_code' }] } },
    null,
  ]);
  // Only the wave-2 attempt carries a non-empty tasks array; none of its entries is a known blocked status.
  assert.deepStrictEqual(blockedReasonCounts(malformed), { ...ZERO_BLOCKED, enrichedAttempts: 1 });
});

// ── fileFailureCounts (Wave 3, AC#4) ─────────────────────────────────────────
// Synthetic title -> File: mapping over the fixture corpus. Blocked tasks in the
// corpus (HAND-COUNTED from the fixture lines):
//   enriched — "Add blocked-task fold" blocked_code + blocked_spec (wave 2, two
//              tries); "Update rad-insights Step 4c" blocked_intent (wave 3).
//   mixed    — "Add blocked-task fold" blocked_code (wave 3 try 1).
//   legacy   — no `tasks` anywhere → contributes nothing.
// So: events.js = 3 (blocked-task fold) + 1 (Step 4c) = 4 over {enriched, mixed};
// events.test.js = 3 over {enriched, mixed}; rad-insights.md = 1 over {enriched}
// only → below the default floor of 2. "Add fixture corpus" never blocks.
const SYNTHETIC_TASK_FILES = {
  'Add blocked-task fold': ['harness/events.js', 'harness/test/events.test.js'],
  'Update rad-insights Step 4c': ['.claude/commands/shared/rad-insights.md', 'harness/events.js'],
  'Add fixture corpus': ['harness/test/fixtures/insights/legacy/events.jsonl'],
};

function loadAllInsightsFixtures() {
  return INSIGHTS_FIXTURE_FEATURES.flatMap((feature) => loadInsightsFixture(feature));
}

test('fileFailureCounts reports files failing in >= floor features with literal counts', () => {
  const history = deepFreeze(loadAllInsightsFixtures());
  assert.equal(FILE_FAILURE_MIN_FEATURES, 2);
  assert.deepStrictEqual(fileFailureCounts(history, deepFreeze({ ...SYNTHETIC_TASK_FILES })), {
    files: {
      'harness/events.js': { failures: 4, features: ['enriched', 'mixed'] },
      'harness/test/events.test.js': { failures: 3, features: ['enriched', 'mixed'] },
    },
    belowFloor: 1,
    minFeatures: 2,
  });
});

test('fileFailureCounts keeps a single-feature file below the floor', () => {
  const enrichedOnly = deepFreeze(loadInsightsFixture('enriched'));
  assert.deepStrictEqual(fileFailureCounts(enrichedOnly, SYNTHETIC_TASK_FILES), {
    files: {},
    belowFloor: 3,
    minFeatures: 2,
  });
  // An explicit floor of 1 surfaces every attributed file; the floor is echoed.
  const floorOne = fileFailureCounts(enrichedOnly, SYNTHETIC_TASK_FILES, 1);
  assert.equal(floorOne.minFeatures, 1);
  assert.deepStrictEqual(floorOne.files['.claude/commands/shared/rad-insights.md'], { failures: 1, features: ['enriched'] });
  // A malformed floor falls back to the named default rather than disabling it.
  for (const bad of [0, -1, 1.5, '3', null]) {
    assert.equal(fileFailureCounts([], {}, bad).minFeatures, FILE_FAILURE_MIN_FEATURES);
  }
});

test('fileFailureCounts is zeroed on missing/non-object taskFiles and unattributable attempts', () => {
  const history = deepFreeze(loadAllInsightsFixtures());
  for (const taskFiles of [undefined, null, 'x', 7, ['harness/events.js'], {}]) {
    assert.deepStrictEqual(fileFailureCounts(history, taskFiles), ZERO_FILE_FAILURES);
  }
  const unattributable = deepFreeze([
    { feature: 'a', type: 'wave-attempt', data: { wave: 1, outcome: 'fail-tests' } },
    { type: 'wave-attempt', data: { tasks: [{ title: 't', status: 'blocked_code' }] } },
    { feature: 'b', type: 'wave-attempt', data: { tasks: [{ title: 'other', status: 'blocked_code' }] } },
    { feature: 'c', type: 'wave-attempt', data: { tasks: [{ title: 't', status: 'complete' }, null, { status: 'blocked_code' }] } },
    { feature: 'd', type: 'wave-complete', data: { tasks: [{ title: 't', status: 'blocked_code' }] } },
    { feature: 'e', type: 'wave-attempt', data: { tasks: [{ title: 'constructor', status: 'blocked_code' }] } },
    null,
  ]);
  assert.deepStrictEqual(fileFailureCounts(unattributable, { t: ['a.js'] }), ZERO_FILE_FAILURES);
});

test('fileFailureCounts is pure — frozen inputs, no filesystem, only the mapping is consulted', () => {
  const history = deepFreeze(loadAllInsightsFixtures());
  const consulted = new Set();
  const mapping = new Proxy(deepFreeze({ ...SYNTHETIC_TASK_FILES }), {
    get(target, key) {
      consulted.add(key);
      return target[key];
    },
  });
  const first = fileFailureCounts(history, mapping);
  assert.deepStrictEqual(fileFailureCounts(history, mapping), first);
  // Only blocked task titles are looked up; the never-blocked title is not.
  assert.deepStrictEqual([...consulted].sort(), ['Add blocked-task fold', 'Update rad-insights Step 4c']);
  // The fold and its helpers name no filesystem API (events.js imports only hook-runner.js).
  const source = readFileSync(fileURLToPath(new URL('../events.js', import.meta.url)), 'utf8');
  const foldSource = source.slice(source.indexOf('export const FILE_FAILURE_MIN_FEATURES'));
  assert.doesNotMatch(foldSource, /\bfs\b|readFile|readdir|require\(|import /);
});

// ── waveReliability (Wave 4, AC#5) ───────────────────────────────────────────
// Expected values are HAND-COMPUTED from the fixture lines. Each (feature, wave)
// pair's attempts span every deliver run of that feature:
//   legacy   — w1: [success]; w2: [fail-tests, success]; w3: [fail-timeout]
//   enriched — w1: [success]; w2: [fail-tests, fail-scope, success] (two runs);
//              w3: [abort-user] (hook-vetoed attempt, still an attempt)
//   mixed    — w1: [fail-protocol, success]; w2: [no-changes]; w3: [fail-tests, fail-tests]
const ZERO_RELIABILITY = { perPosition: {}, features: 0 };
const slot = (attempts, firstAttemptSuccess, retried, samples) => ({ attempts, firstAttemptSuccess, retried, samples });
const RELIABILITY_PER_FEATURE = {
  legacy: { perPosition: { 1: slot(1, 1, 0, 1), 2: slot(2, 0, 1, 1), 3: slot(1, 0, 0, 1) }, features: 1 },
  enriched: { perPosition: { 1: slot(1, 1, 0, 1), 2: slot(3, 0, 1, 1), 3: slot(1, 0, 0, 1) }, features: 1 },
  mixed: { perPosition: { 1: slot(2, 0, 1, 1), 2: slot(1, 0, 0, 1), 3: slot(2, 0, 1, 1) }, features: 1 },
};

test('waveReliability returns literal per-position counts across the fixture corpus', () => {
  const history = deepFreeze(loadAllInsightsFixtures());
  assert.deepStrictEqual(waveReliability(history), {
    perPosition: { 1: slot(4, 2, 1, 3), 2: slot(6, 0, 2, 3), 3: slot(4, 0, 1, 3) },
    features: 3,
  });
});

test('waveReliability reports a single-feature history at its true n (no floor in the fold)', () => {
  for (const feature of INSIGHTS_FIXTURE_FEATURES) {
    const history = deepFreeze(loadInsightsFixture(feature));
    assert.deepStrictEqual(waveReliability(history), RELIABILITY_PER_FEATURE[feature], feature);
  }
});

test('waveReliability never reads usage — throwing usage getters and a guarding Proxy change nothing', () => {
  const expected = waveReliability(deepFreeze(loadAllInsightsFixtures()));
  const withThrowingGetters = loadAllInsightsFixtures().map((event) => {
    if (!event.data) return event;
    const data = { ...event.data };
    delete data.usage;
    Object.defineProperty(data, 'usage', {
      enumerable: true,
      get() {
        throw new Error('waveReliability must not read usage');
      },
    });
    return { ...event, data };
  });
  assert.deepStrictEqual(waveReliability(withThrowingGetters), expected);
  const read = new Set();
  const proxied = loadAllInsightsFixtures().map((event) =>
    event.data
      ? {
          ...event,
          data: new Proxy(event.data, {
            get(target, key) {
              read.add(key);
              if (key === 'usage') throw new Error('waveReliability must not read usage');
              return target[key];
            },
          }),
        }
      : event,
  );
  assert.deepStrictEqual(waveReliability(proxied), expected);
  assert.ok(!read.has('usage'));
  assert.deepStrictEqual([...read].sort(), ['outcome', 'wave']);
});

test('waveReliability is zeroed on empty / null / non-array / wave-attempt-free input', () => {
  for (const input of [[], null, undefined, 'x', 7, {}, { length: 2 }]) {
    assert.deepStrictEqual(waveReliability(input), ZERO_RELIABILITY);
  }
  const waveFree = deepFreeze([
    { feature: 'a', type: 'plan-created' },
    { feature: 'a', type: 'wave-complete', data: { wave: 1, outcome: 'success' } },
    { feature: 'a', type: 'wave-failed', data: { wave: 2, reason: 'doom-loop' } },
  ]);
  assert.deepStrictEqual(waveReliability(waveFree), ZERO_RELIABILITY);
  const unplaceable = deepFreeze([
    null,
    { type: 'wave-attempt', data: { wave: 1, outcome: 'success' } },
    { feature: '', type: 'wave-attempt', data: { wave: 1, outcome: 'success' } },
    { feature: 'a', type: 'wave-attempt' },
    { feature: 'a', type: 'wave-attempt', data: { outcome: 'success' } },
    { feature: 'a', type: 'wave-attempt', data: { wave: '1', outcome: 'success' } },
    { feature: 'a', type: 'wave-attempt', data: { wave: Number.NaN, outcome: 'success' } },
  ]);
  assert.deepStrictEqual(waveReliability(unplaceable), ZERO_RELIABILITY);
});

test('waveReliability keys pairs by feature — same wave in two features is two samples', () => {
  const history = deepFreeze([
    { feature: 'a', type: 'wave-attempt', data: { wave: 1 } },
    { feature: 'a', type: 'wave-attempt', data: { wave: 1, outcome: 'success' } },
    { feature: 'b', type: 'wave-attempt', data: { wave: 1, outcome: 'success' } },
  ]);
  // Feature a's first attempt has no outcome → not a first-attempt success.
  assert.deepStrictEqual(waveReliability(history), { perPosition: { 1: slot(3, 1, 1, 2) }, features: 2 });
});
