// #119 regression fence — written BEFORE the spine change; must pass unchanged after it.
//
// Replays committed, historical-shaped event logs (TODAY's shapes: wave-attempt
// carries no `attempt` and no `fingerprint`, and there are no `wave-started`
// events) through the read-side folds, the approval gate, and the stop-condition
// matrix. All scenarios live in ONE fixture (historical.jsonl), one `feature`
// per scenario; the loader splits it by `feature`, preserving line order. Every
// expected value is a HAND-WRITTEN literal derived from the fixture lines (cited
// as "L<n>" = line n of that scenario's history). Never recompute
// an expectation with the code under test. If a later change makes one of these
// fail, that change altered how legacy logs are read — which #119 forbids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reduce,
  resumeFrom,
  outcomeCounts,
  retryCounts,
  failReasonCounts,
  findOrphanAttempts,
} from '../events.js';
import { evaluateGate, loadGates } from '../gates.js';
import { resolveOutcome, loadMatrix } from '../matrix.js';

const FIXTURE_PATH = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'replay', 'historical.jsonl');
// Scenario name -> the `feature` its events carry in the combined fixture.
const SCENARIO_FEATURES = {
  'approvals-only': 'replay-approvals',
  historical: 'replay-legacy',
  'hook-veto': 'replay-veto',
  outcomes: 'replay-outcomes',
  stops: 'replay-stops',
};
const ARCHITECT = 'sean@torchcodelab.com';
const GATE_PASSED_REASON = 'satisfied by approved event from role:architect';

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function loadAllEvents() {
  const raw = readFileSync(FIXTURE_PATH, 'utf8');
  return raw.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

/** One scenario's history: the combined fixture filtered to its feature, order preserved. */
function loadReplay(name) {
  const feature = SCENARIO_FEATURES[name];
  if (!feature) throw new Error(`replay fixture: unknown scenario '${name}'`);
  const history = loadAllEvents().filter((event) => event.feature === feature);
  if (history.length === 0) throw new Error(`replay fixture: no events for feature '${feature}' (scenario '${name}')`);
  return deepFreeze(history);
}

/** Outcome-count literal: every one of the 7 outcomes + unknown + total, zero unless given. */
function outcomes(overrides) {
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

/** The recorded wave-attempt outcomes, in history order, mapped to matrix actions. */
function recordedActions(history, matrix) {
  return history
    .filter((event) => event.type === 'wave-attempt')
    .map((event) => [event.data.outcome, resolveOutcome('implement', event.data.outcome, matrix).action]);
}

const EXPECTED = {
  // (a) approvals only: research → plan → two approvals (direct, then proxy).
  'approvals-only': {
    // L1 research-created, L2 plan-created, L3/L4 approved → highest phase 'approved'.
    reduce: {
      phase: 'approved',
      markers: ['research-created', 'plan-created', 'approved'],
      approvals: [
        { actor: ARCHITECT, ts: '2026-06-02T09:00:00.000Z', role: 'architect', recordedBy: ARCHITECT }, // L3
        { actor: ARCHITECT, ts: '2026-06-03T09:00:00.000Z', role: 'architect', recordedBy: 'dev@example.com' }, // L4
      ],
    },
    resume: [], // no wave-complete lines
    // First approved with role architect is L3 (direct: recordedBy = actor).
    gate: { passed: true, satisfiedBy: { actor: ARCHITECT, role: 'architect', recordedBy: ARCHITECT } },
    actions: [], // no wave-attempt lines
    outcomeCounts: outcomes({}),
    retryCounts: { total: 0, retriedWaves: 0, perWave: {} },
    failReasonCounts: { total: 0, reasons: {} },
  },

  // (b) legacy delivery: wave 1 fail-tests (L4) → success (L5) → complete (L6);
  //     wave 2 fail-scope (L7) → wave-failed {action: abort} (L8).
  historical: {
    reduce: {
      phase: 'in-progress', // L3–L8 all map to in-progress; nothing later
      markers: ['plan-created', 'approved', 'deliver-started', 'wave-attempt', 'wave-complete', 'wave-failed'],
      approvals: [{ actor: ARCHITECT, ts: '2026-07-01T12:00:00.000Z', role: 'architect', recordedBy: ARCHITECT }], // L2
    },
    resume: [1], // L6 wave-complete {wave: 1}
    gate: { passed: true, satisfiedBy: { actor: ARCHITECT, role: 'architect', recordedBy: ARCHITECT } }, // L2
    actions: [
      ['fail-tests', 'revision'], // L4
      ['success', 'advance'], // L5
      ['fail-scope', 'abort'], // L7
    ],
    // Pairs: wave 1 last = success (L5); wave 2 last = fail-scope (L7) → 1 + 1 = 2 pairs.
    outcomeCounts: outcomes({ success: 1, 'fail-scope': 1, total: 2 }),
    // Attempts: wave 1 × 2 (L4, L5) + wave 2 × 1 (L7) = 3; only wave 1 has > 1.
    retryCounts: { total: 3, retriedWaves: 1, perWave: { 1: 2, 2: 1 } },
    // L8 carries `action`, no `reason` → bucketed unknown.
    failReasonCounts: { total: 1, reasons: { unknown: 1 } },
  },

  // (c) post-wave hook veto: hook-veto (L3) + provenance-tagged attempt (L4) → abort (L5).
  'hook-veto': {
    reduce: {
      phase: 'in-progress',
      markers: ['approved', 'deliver-started', 'hook-veto', 'wave-attempt', 'wave-failed'],
      approvals: [{ actor: ARCHITECT, ts: '2026-07-10T12:00:00.000Z', role: 'architect', recordedBy: ARCHITECT }], // L1
    },
    resume: [], // no wave-complete
    gate: { passed: true, satisfiedBy: { actor: ARCHITECT, role: 'architect', recordedBy: ARCHITECT } }, // L1
    actions: [['abort-user', 'abort']], // L4
    outcomeCounts: outcomes({ 'abort-user': 1, total: 1 }), // one pair (wave 1), last = abort-user
    retryCounts: { total: 1, retriedWaves: 0, perWave: { 1: 1 } }, // L4 only
    failReasonCounts: { total: 1, reasons: { unknown: 1 } }, // L5: action, no reason
  },

  // (d) all 7 outcomes across waves and five deliver runs.
  outcomes: {
    reduce: {
      phase: 'in-progress',
      markers: ['approved', 'deliver-started', 'wave-attempt', 'wave-complete', 'wave-failed'],
      approvals: [{ actor: ARCHITECT, ts: '2026-08-01T12:00:00.000Z', role: 'architect', recordedBy: ARCHITECT }], // L1
    },
    resume: [1, 2], // L5 wave-complete {1}, L19 wave-complete {2}
    gate: { passed: true, satisfiedBy: { actor: ARCHITECT, role: 'architect', recordedBy: ARCHITECT } }, // L1
    actions: [
      ['fail-tests', 'revision'], // L3
      ['success', 'advance'], // L4
      ['no-changes', 'abort'], // L6
      ['fail-protocol', 'abort'], // L9
      ['fail-timeout', 'surface'], // L12
      ['abort-user', 'abort'], // L15
      ['success', 'advance'], // L18
      ['fail-scope', 'abort'], // L20
    ],
    // Pairs: wave 1 last success (L4), wave 2 last success (L18), wave 3 last fail-scope (L20).
    outcomeCounts: outcomes({ success: 2, 'fail-scope': 1, total: 3 }),
    // wave 1: L3, L4 = 2; wave 2: L6, L9, L12, L15, L18 = 5; wave 3: L20 = 1; 2 + 5 + 1 = 8.
    retryCounts: { total: 8, retriedWaves: 2, perWave: { 1: 2, 2: 5, 3: 1 } },
    // wave-failed at L7, L10, L13, L16, L21 = 5, all action-only → unknown 5.
    failReasonCounts: { total: 5, reasons: { unknown: 5 } },
  },

  // (e) non-matrix stops: doom-loop (L5), budget-exhausted (L10), token-budget (L14).
  stops: {
    reduce: {
      phase: 'in-progress',
      markers: ['approved', 'deliver-started', 'wave-attempt', 'wave-failed', 'wave-complete'],
      approvals: [{ actor: ARCHITECT, ts: '2026-08-10T12:00:00.000Z', role: 'architect', recordedBy: ARCHITECT }], // L1
    },
    resume: [1], // L13 wave-complete {1}; wave 2 only has L14 wave-failed
    gate: { passed: true, satisfiedBy: { actor: ARCHITECT, role: 'architect', recordedBy: ARCHITECT } }, // L1
    actions: [
      ['fail-tests', 'revision'], // L3
      ['fail-tests', 'revision'], // L4
      ['fail-tests', 'revision'], // L7
      ['fail-tests', 'revision'], // L8
      ['fail-tests', 'revision'], // L9
      ['success', 'advance'], // L12
    ],
    outcomeCounts: outcomes({ success: 1, total: 1 }), // one pair (wave 1), last = success (L12)
    // wave 1: L3, L4, L7, L8, L9, L12 = 6 attempts.
    retryCounts: { total: 6, retriedWaves: 1, perWave: { 1: 6 } },
    // One wave-failed per reason: L5 + L10 + L14 = 3.
    failReasonCounts: { total: 3, reasons: { 'doom-loop': 1, 'budget-exhausted': 1, 'token-budget': 1 } },
  },
};

const GATES = loadGates();
const MATRIX = loadMatrix();

for (const [name, expected] of Object.entries(EXPECTED)) {
  test(`replay ${name}: reduce / resumeFrom match committed literals`, () => {
    const history = loadReplay(name);
    assert.deepStrictEqual(reduce(history), expected.reduce);
    assert.deepStrictEqual([...resumeFrom(history)].sort((a, b) => a - b), expected.resume);
  });

  test(`replay ${name}: evaluateGate('approved') matches committed literal`, () => {
    const result = evaluateGate('approved', loadReplay(name), GATES);
    assert.equal(result.passed, expected.gate.passed);
    assert.equal(result.reason, GATE_PASSED_REASON);
    assert.deepStrictEqual(result.satisfiedBy, expected.gate.satisfiedBy);
  });

  test(`replay ${name}: resolveOutcome action for every recorded outcome`, () => {
    assert.deepStrictEqual(recordedActions(loadReplay(name), MATRIX), expected.actions);
  });

  test(`replay ${name}: outcomeCounts / retryCounts / failReasonCounts match committed literals`, () => {
    const history = loadReplay(name);
    assert.deepStrictEqual(outcomeCounts(history), expected.outcomeCounts);
    assert.deepStrictEqual(retryCounts(history), expected.retryCounts);
    assert.deepStrictEqual(failReasonCounts(history), expected.failReasonCounts);
  });

  test(`replay ${name}: a legacy log (no wave-started) yields no orphan attempts`, () => {
    assert.deepStrictEqual(findOrphanAttempts(loadReplay(name)), []);
  });
}
