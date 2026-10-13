// Characterization of the deliver spine (#252, part 6 of 6).
//
// Runs `deliverSpine` over a scenario grid with fully scripted ports and records
// ONE ordered timeline of every observable call per scenario: state reads and
// appends, `sh` calls, hook invocations, prepare/finish steps, runWave calls and
// the terminal result. Each timeline is canonicalized (sorted keys, constant
// timestamps) and hashed; hashes are compared to harness/test/fixtures/
// spine-golden.json, which was generated from the UNREFACTORED spine. Pinned
// scenarios additionally store the whole transcript. A refactor that preserves
// behavior leaves every hash and transcript unchanged.
//
//   node --test harness/test/spine-characterization.test.js
//   UPDATE_GOLDEN=1 node --test harness/test/spine-characterization.test.js   # regenerate (never after refactoring)
//
// No filesystem (beyond the golden file and mismatch dumps) and no processes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverSpine } from '../spine.js';
import { loadMatrix } from '../matrix.js';
import { fingerprint } from '../fingerprint.js';
import { validateTransition } from '../transitions.js';
import { reduce } from '../events.js';

const MATRIX = loadMatrix();
const GOLDEN_URL = new URL('./fixtures/spine-golden.json', import.meta.url);
const GOLDEN_VERSION = 1;
const HASH_LENGTH = 20; // hex chars of the SHA-256 kept per scenario
const FEATURE = 'demo';
const FIXED_TS = 'T';
const MIN_PINNED = 40;
const MAX_GOLDEN_BYTES = 300 * 1024;
const MAX_REPORTED_MISMATCHES = 10;

// ── Canonicalization and hashing ──

/** Deep-copy `v` with sorted keys, every `ts` replaced by a constant, and
 * undefined made visible (so present-and-undefined differs from absent). */
function canon(v) {
  if (v === undefined) return { $undefined: true };
  if (typeof v === 'function') return '[function]';
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return Array.from(v, canon);
  const out = {};
  for (const key of Object.keys(v).sort()) {
    out[key] = key === 'ts' && typeof v[key] === 'string' ? FIXED_TS : canon(v[key]);
  }
  return out;
}

function hashTimeline(timeline) {
  return createHash('sha256').update(JSON.stringify(timeline)).digest('hex').slice(0, HASH_LENGTH);
}

// ── Scripted ports ──

const PASS_GATE = { passed: true, reason: 'ok', satisfiedBy: { actor: 'architect' } };
const NOOP_HOOK_RESULT = () => ({ ran: [], veto: null, failures: [] });

/** The nth scripted value, clamped to the last; `fallback` when none scripted. */
function pick(list, n, fallback) {
  if (!Array.isArray(list) || list.length === 0) return fallback;
  return list[Math.min(n, list.length - 1)];
}

/** Return the scripted value, or throw when it is `{ throws }`. */
function playback(entry) {
  if (entry && typeof entry === 'object' && 'throws' in entry) throw new Error(entry.throws);
  return entry;
}

function makeState(spec, appended, rec) {
  let gateCalls = 0;
  return {
    async gate(feature, name) {
      rec({ k: 'gate', feature, name });
      return pick(spec.gate, gateCalls++, PASS_GATE);
    },
    append(event) {
      rec({ k: 'append', event });
      validateTransition(event, { history: appended });
      appended.push(event);
    },
    plan(feature) {
      rec({ k: 'plan', feature });
      return spec.plan === undefined ? { waves: [{ n: 1 }, { n: 2 }] } : spec.plan;
    },
    history(feature) {
      rec({ k: 'history', feature });
      return [...appended];
    },
  };
}

function makeSh(spec, rec) {
  const counts = {};
  return (script, arg) => {
    rec({ k: 'sh', script, arg });
    counts[script] = (counts[script] || 0) + 1;
    const handler = spec.sh?.[script];
    return typeof handler === 'function' ? handler(arg, counts[script]) : (handler ?? { status: 0 });
  };
}

function makeRunWave(spec, env, rec) {
  let calls = 0;
  return async (wave, ctx) => {
    const i = calls++;
    rec({ k: 'runWave', wave, ctx });
    if (spec.onWave) spec.onWave(i, env);
    const out = spec.outcomes?.[i] ?? 'success';
    if (typeof out !== 'string') return out;
    return spec.usage === undefined ? { outcome: out } : { outcome: out, usage: { total: spec.usage } };
  };
}

function makeRunHooks(spec, rec) {
  const counts = {};
  return (point, ctx) => {
    rec({ k: 'hook', point, ctx });
    counts[point] = (counts[point] || 0) + 1;
    const handler = spec.hooks?.[point];
    if (typeof handler === 'function') return handler(counts[point], ctx);
    return handler ?? NOOP_HOOK_RESULT();
  };
}

function makeApprovalIntact(spec, rec) {
  let calls = 0;
  return () => {
    rec({ k: 'intact' });
    const n = calls++;
    return spec.intact === undefined ? { ok: true } : playback(pick(spec.intact, n, undefined));
  };
}

function makeFinish(spec, rec) {
  const step = (name) => async () => {
    rec({ k: 'finish', step: name });
    const fn = spec.finish[name];
    return fn ? fn() : { ok: true, data: {} };
  };
  return { beforePr: step('beforePr'), afterPr: step('afterPr') };
}

function makeTestWave(spec, rec) {
  let calls = 0;
  return {
    paths: spec.testWave.paths,
    missing(paths) {
      rec({ k: 'missing', paths });
      return playback(pick(spec.testWave.missing, calls++, []));
    },
  };
}

/** Build one scenario's ports and the deliverSpine argument. */
function buildRun(spec) {
  const timeline = [];
  const rec = (entry) => timeline.push(canon(entry));
  const appended = [...(spec.seed || [])];
  const env = { appended };
  const args = {
    feature: FEATURE,
    state: makeState(spec, appended, rec),
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: makeRunWave(spec, env, rec),
    sh: makeSh(spec, rec),
    now: () => FIXED_TS,
    runHooks: makeRunHooks(spec, rec),
    approvalIntact: makeApprovalIntact(spec, rec),
    hookPreflight: () => {
      rec({ k: 'preflight' });
      if (spec.preflightThrows) throw new Error(spec.preflightThrows);
    },
    ...spec.opts,
  };
  if (spec.resume) args.resume = spec.resume;
  if (spec.prepare) {
    args.prepare = async () => {
      rec({ k: 'prepare' });
      return spec.prepare();
    };
  }
  if (spec.finish) args.finish = makeFinish(spec, rec);
  if (spec.testWave) args.testWave = makeTestWave(spec, rec);
  return { args, appended, timeline, rec };
}

/** Run one scenario against the real spine; returns its ordered timeline. */
async function runScenario(spec) {
  const { args, appended, timeline, rec } = buildRun(spec);
  try {
    rec({ k: 'result', result: await deliverSpine(args) });
  } catch (err) {
    rec({ k: 'throw', name: err.name, message: err.message });
  }
  rec({ k: 'final', reduce: reduce(appended) });
  return timeline;
}

// ── Scenario grid (AC#3) ──

const OUTCOMES = ['success', 'fail-tests', 'fail-scope', 'fail-timeout', 'fail-protocol', 'abort-user'];
const OUTCOME_ABBREV = {
  success: 's', 'fail-tests': 'ft', 'fail-scope': 'fs', 'fail-timeout': 'fto', 'fail-protocol': 'fp', 'abort-user': 'au',
};
const MAX_SEQUENCE_LENGTH = 3;

const SCRIPT = {
  presence: 'scripts/check-tests-present.sh',
  verify: 'scripts/check-verify.sh',
  scope: 'scripts/check-scope.sh',
  tip: 'scripts/default-tip.sh',
  openPr: 'scripts/open-pr.sh',
};

const GATE_CONFIGS = {
  none: {},
  presence: { sh: { [SCRIPT.presence]: { status: 1, stdout: 'missing tests' } } },
  vpass: { opts: { waveVerify: { 1: 'npm test', 2: 'npm run lint' } }, sh: { [SCRIPT.verify]: { status: 0, stdout: 'ok' } } },
  vfail: { opts: { waveVerify: { 1: 'npm test', 2: 'npm run lint' } }, sh: { [SCRIPT.verify]: { status: 1, stdout: 'FAIL x' } } },
  vtime: { opts: { waveVerify: { 1: 'npm test', 2: 'npm run lint' } }, sh: { [SCRIPT.verify]: { status: 124, stdout: 'killed' } } },
  scope: { sh: { [SCRIPT.scope]: { status: 1, stdout: 'out of scope' } } },
  pmoved: { opts: { pushGuard: true }, sh: { [SCRIPT.tip]: (_arg, n) => ({ status: 0, stdout: `sha${n}\n` }) } },
  punread: { opts: { pushGuard: true }, sh: { [SCRIPT.tip]: { status: 2, stdout: '' } } },
};

/** Every sequence of 1..MAX_SEQUENCE_LENGTH outcomes over OUTCOMES. */
function outcomeSequences() {
  let level = [[]];
  const all = [];
  for (let len = 1; len <= MAX_SEQUENCE_LENGTH; len += 1) {
    level = level.flatMap((seq) => OUTCOMES.map((o) => [...seq, o]));
    all.push(...level);
  }
  return all;
}

function gridScenarios() {
  const scenarios = [];
  for (const [gateKey, config] of Object.entries(GATE_CONFIGS)) {
    for (const seq of outcomeSequences()) {
      const id = `g:${gateKey}:${seq.map((o) => OUTCOME_ABBREV[o]).join('.')}`;
      scenarios.push({ id, spec: { ...config, outcomes: seq } });
    }
  }
  return scenarios;
}

// ── Targeted scenarios ──

const W1 = { waves: [{ n: 1 }] };
const W3 = { waves: [{ n: 1 }, { n: 2 }, { n: 3 }] };
const APPROVED = { feature: FEATURE, type: 'approved', actor: 'architect', role: 'architect', ts: FIXED_TS };
const BLOCKED_GATE = { passed: false, reason: 'needs an approved event', satisfiedBy: null };

const ev = (type, data) => ({ feature: FEATURE, type, actor: 'harness', ts: FIXED_TS, ...(data ? { data } : {}) });
const DELIVER_STARTED = ev('deliver-started');
const started = (wave, attempt) => ev('wave-started', { wave, attempt });
const attemptOf = (wave, attempt, outcome, extra = {}) => ev('wave-attempt', { wave, attempt, outcome, ...extra });
const completed = (wave) => ev('wave-complete', { wave });
const STOPPED = ev('deliver-stopped', { class: 'needs-decision', reason: 'fail-timeout', decision: 'd', wave: 1 });
const STUCK_PRINT = fingerprint({ outcome: 'fail-tests' });

/** A failing wave result whose `summary` makes its fingerprint distinct. */
const failing = (summary, extra = {}) => ({ outcome: 'fail-tests', summary, ...extra });
const veto = (hook, outcome) => ({ ran: [], veto: { hook, outcome }, failures: [] });
const observed = (point) => ({ ran: [{ hook: `obs-${point}`, outcome: 'noted' }], veto: null, failures: [] });
const hookFailure = { ran: [], veto: null, failures: [{ hook: 'flaky', reason: 'exit 3' }] };
const RESUME = {
  context: 'use the v2 api',
  recordedBy: 'architect',
  stop: { class: 'needs-decision', reason: 'fail-timeout', decision: 'd', wave: 1 },
};
const PREPARED = { ok: true, data: { base: 'main', merged: true, fastForwarded: false, committed: false, pushed: false } };
const THROWING_TASKS = new Proxy([{ title: 'x', status: 'failed' }], {
  get(target, prop, receiver) {
    if (prop === 'find') throw new Error('tasks unreadable');
    return Reflect.get(target, prop, receiver);
  },
});
const throwing = (value) => () => {
  throw value;
};
/** Fails only the nth call of a script. */
const failNth = (n, result) => (_arg, count) => (count === n ? result : { status: 0 });

const TARGETED = {
  // ── Plain runs and plan shapes
  'happy-1w': { plan: W1 },
  'happy-2w': {},
  'happy-3w-metadata': {
    plan: { waves: [{ n: 1 }, { n: 2, model: 'wave-model' }, { n: 3 }] },
    opts: {
      waveModels: { 1: 'm-a', 2: '', 3: 7 },
      waveCapabilities: { 2: ['read', 'write'], 3: 'nope' },
      waveTasks: { 1: { type: 'parallel', tasks: [{ title: 'T', files: 'a.js', what: 'w', validate: 'v' }] } },
    },
  },
  'plan-empty': { plan: { waves: [] } },
  'plan-null': { plan: null },
  'plan-no-waves-key': { plan: {} },
  'gate-blocked': { gate: [BLOCKED_GATE] },
  'no-changes-outcome': { outcomes: ['no-changes'] },
  'unknown-outcome': { outcomes: ['bogus'] },
  'preflight-throws': { preflightThrows: 'hooks dir malformed' },
  // ── Attempt loop: retry, doom loop, exhaustion
  'max-attempts-1': { opts: { maxAttempts: 1 }, outcomes: [failing('a')] },
  'revision-then-success': {
    outcomes: [failing('a', { tasks: [{ title: 'T1', status: 'blocked_code', error: 'boom' }] }), 'success'],
    hooks: { 'on-retry': observed('on-retry') },
  },
  'revision-exhausted': {
    outcomes: [failing('a'), failing('b'), failing('c')],
    hooks: { 'on-error': observed('on-error') },
  },
  'doom-loop': { outcomes: ['fail-tests', 'fail-tests'], hooks: { 'on-error': observed('on-error') } },
  'doom-loop-post-veto': { hooks: { 'post-wave': veto('h1', 'fail-tests') } },
  'doom-loop-presence-gate': { sh: GATE_CONFIGS.presence.sh },
  'capture-failed': { outcomes: [{ outcome: 'fail-tests', summary: 'a', tasks: THROWING_TASKS }, 'success'] },
  'result-extras': {
    outcomes: [
      { outcome: 'success', usage: { total: 5, input: 2 }, tasks: [{ title: 'a', status: 'complete' }], permissions: [{ tool: 'x', decision: 'allow' }] },
      { outcome: 'success', permissions: [] },
    ],
  },
  'fail-timeout-surface': { outcomes: ['fail-timeout'], hooks: { 'on-error': observed('on-error') } },
  // ── Approval
  'approval-gate-lost-w1': { gate: [PASS_GATE, BLOCKED_GATE] },
  'approval-gate-lost-w2': { gate: [PASS_GATE, PASS_GATE, BLOCKED_GATE] },
  'approval-port-not-intact': { intact: [{ ok: true }, { ok: false, reason: 'plan edited' }] },
  'approval-port-no-reason': { intact: [{ ok: false }] },
  'approval-port-throws': { intact: [{ throws: 'port down' }] },
  'approval-port-undefined': { intact: [undefined] },
  'approval-during-w1': { onWave: (i, env) => i === 0 && env.appended.push(APPROVED) },
  'approval-during-last-wave': { plan: W1, onWave: (i, env) => i === 0 && env.appended.push(APPROVED) },
  'approval-during-last-wave-2w': { onWave: (i, env) => i === 1 && env.appended.push(APPROVED) },
  'approval-during-test-wave': {
    onWave: (i, env) => i === 2 && env.appended.push(APPROVED),
    testWave: { paths: ['a.test.js'], missing: [['a.test.js'], []] },
  },
  // ── Token budget
  'budget-under': { plan: W3, opts: { tokenBudget: 100 }, usage: 40 },
  'budget-at': { plan: W3, opts: { tokenBudget: 80 }, usage: 40 },
  'budget-over': { opts: { tokenBudget: 50 }, usage: 80 },
  'budget-zero': { opts: { tokenBudget: 0 }, usage: 1000000 },
  'budget-negative': { opts: { tokenBudget: -5 }, usage: 1000000 },
  'budget-no-usage': { opts: { tokenBudget: 10 } },
  'budget-resumed-seed': {
    seed: [DELIVER_STARTED, started(1, 1), attemptOf(1, 1, 'success', { usage: { total: 100 } }), completed(1)],
    opts: { tokenBudget: 100 },
    sh: { [SCRIPT.presence]: { status: 1 } },
  },
  // ── Failed-attempt cap
  'cap-hit': { opts: { maxFailedAttempts: 2, maxAttempts: 5 }, outcomes: [failing('a'), failing('b'), failing('c')] },
  'cap-zero': { opts: { maxFailedAttempts: 0 }, outcomes: [failing('a'), failing('b'), failing('c')] },
  'cap-non-integer': { opts: { maxFailedAttempts: 1.5 }, outcomes: [failing('a'), 'success'] },
  'cap-before-pre-wave-hook': { opts: { maxFailedAttempts: 1 }, outcomes: [failing('a'), 'success'], hooks: { 'pre-wave': observed('pre-wave') } },
  'cap-across-waves': { opts: { maxFailedAttempts: 2 }, outcomes: [failing('a'), 'success', failing('b'), 'success'] },
  'cap-seeded': {
    seed: [DELIVER_STARTED, started(1, 1), attemptOf(1, 1, 'fail-tests'), started(1, 2), attemptOf(1, 2, 'fail-tests')],
    opts: { maxFailedAttempts: 2 },
  },
  'cap-reset-by-stop': {
    seed: [DELIVER_STARTED, started(1, 1), attemptOf(1, 1, 'fail-tests'), started(1, 2), attemptOf(1, 2, 'fail-tests'), STOPPED],
    opts: { maxFailedAttempts: 2 },
  },
  // ── Hooks
  'hook-pre-veto': { hooks: { 'pre-wave': veto('guard', 'abort-user') } },
  'hook-pre-veto-invalid': { hooks: { 'pre-wave': veto('guard', 'bogus') } },
  'hook-pre-veto-surface': { hooks: { 'pre-wave': veto('guard', 'fail-timeout') } },
  'hook-pre-veto-revision': { hooks: { 'pre-wave': veto('guard', 'fail-tests') } },
  'hook-pre-veto-attempt2': { outcomes: [failing('a'), 'success'], hooks: { 'pre-wave': (n) => (n >= 2 ? veto('late', 'fail-protocol') : NOOP_HOOK_RESULT()) } },
  'hook-pre-veto-with-observations': { hooks: { 'pre-wave': { ran: [{ hook: 'o', outcome: 'x' }], veto: { hook: 'guard', outcome: 'abort-user' }, failures: [{ hook: 'f', reason: 'r' }] } } },
  'hook-post-veto-abort': { hooks: { 'post-wave': veto('guard', 'fail-protocol') } },
  'hook-post-veto-demote-success': { outcomes: ['success', 'success'], hooks: { 'post-wave': (n) => (n === 1 ? veto('vh', 'fail-tests') : NOOP_HOOK_RESULT()) } },
  'hook-post-veto-invalid': { hooks: { 'post-wave': veto('guard', 'zzz') } },
  'hook-post-veto-surface': { hooks: { 'post-wave': veto('guard', 'fail-timeout') } },
  'hook-post-veto-skips-gates': { hooks: { 'post-wave': veto('guard', 'abort-user') }, sh: GATE_CONFIGS.presence.sh },
  'hook-observe-all': {
    outcomes: [failing('a'), 'success'],
    hooks: Object.fromEntries(['pre-wave', 'post-wave', 'on-outcome', 'on-retry', 'wave-complete', 'on-error'].map((p) => [p, observed(p)])),
  },
  'hook-observe-failures': { outcomes: ['fail-scope'], hooks: { 'on-outcome': hookFailure, 'on-error': hookFailure } },
  'hook-runner-returns-null': { outcomes: [failing('a'), 'success'], hooks: Object.fromEntries(['pre-wave', 'post-wave', 'on-outcome', 'on-retry', 'wave-complete'].map((p) => [p, () => null])) },
  // ── Gates and demotions
  'testsbywave-scoped': { opts: { testsByWave: { 1: ['a.test.js'], 2: ['b.test.js', 'a.test.js'] } } },
  'testsbywave-empty-union': { opts: { testsByWave: {} } },
  'testsbywave-presence-fails': { opts: { testsByWave: { 1: ['a.test.js'] } }, sh: GATE_CONFIGS.presence.sh },
  'verify-pass-scope-fail': { ...GATE_CONFIGS.vpass, sh: { ...GATE_CONFIGS.vpass.sh, [SCRIPT.scope]: { status: 1, stdout: 'x' } } },
  'verify-skipped-for-unlisted-wave': { opts: { waveVerify: { 2: 'npm test' } } },
  'push-first-read-fails': { opts: { pushGuard: true }, sh: { [SCRIPT.tip]: (_arg, n) => (n === 1 ? { status: 1, stdout: '' } : { status: 0, stdout: 'a' }) } },
  'push-second-read-fails': { opts: { pushGuard: true }, sh: { [SCRIPT.tip]: (_arg, n) => (n === 2 ? { status: 3, stdout: '' } : { status: 0, stdout: 'a' }) } },
  'push-unchanged': { opts: { pushGuard: true }, sh: { [SCRIPT.tip]: { status: 0, stdout: 'abc\n' } } },
  'push-whitespace-only': { opts: { pushGuard: true }, sh: { [SCRIPT.tip]: (_arg, n) => ({ status: 0, stdout: n % 2 ? 'abc\n' : 'abc ' }) } },
  'push-moved-overrides-veto': { ...GATE_CONFIGS.pmoved, hooks: { 'post-wave': veto('guard', 'fail-tests') } },
  'push-moved-on-failing-outcome': { ...GATE_CONFIGS.pmoved, outcomes: ['fail-tests'] },
  // ── Multi-wave
  'multi-w2-scope-fails': { plan: W3, sh: { [SCRIPT.scope]: failNth(2, { status: 1, stdout: 'bad' }) } },
  'multi-w2-retry-then-ok': { plan: W3, outcomes: ['success', failing('a'), 'success', 'success'] },
  'multi-w3-presence-fails': { plan: W3, sh: { [SCRIPT.presence]: failNth(3, { status: 1, stdout: 'm' }) } },
  // ── Resume
  'resume-skip-completed': { seed: [DELIVER_STARTED, started(1, 1), attemptOf(1, 1, 'success'), completed(1)] },
  'resume-verify-fails': { seed: [DELIVER_STARTED, completed(1)], sh: GATE_CONFIGS.presence.sh },
  'resume-verify-scoped': { seed: [DELIVER_STARTED, completed(1)], opts: { testsByWave: { 1: ['a.test.js'], 2: ['b.test.js'] } } },
  'resume-verify-empty-union': { seed: [DELIVER_STARTED, completed(1)], opts: { testsByWave: { 2: ['b.test.js'] } } },
  'resume-all-complete': { seed: [DELIVER_STARTED, completed(1), completed(2)] },
  'resume-orphan': { seed: [DELIVER_STARTED, started(1, 1)], hooks: { 'on-error': observed('on-error') } },
  'resume-orphan-two-attempts': { seed: [DELIVER_STARTED, started(1, 1), started(1, 2)] },
  'resume-orphan-after-complete': { seed: [DELIVER_STARTED, completed(1), started(2, 1)] },
  'resume-operator-context': { resume: RESUME, outcomes: [failing('a'), 'success', 'success'] },
  'resume-operator-context-skipped-wave': {
    seed: [DELIVER_STARTED, completed(1)],
    resume: { ...RESUME, stop: { class: 'failed', reason: 'budget', decision: 'd' } },
  },
  'resume-operator-context-prepare': { resume: RESUME, prepare: () => PREPARED },
  'resume-seed-doom': { seed: [DELIVER_STARTED, started(1, 1), attemptOf(1, 1, 'fail-tests', { fingerprint: STUCK_PRINT })], outcomes: ['fail-tests'] },
  'resume-seed-legacy-attempt': { seed: [DELIVER_STARTED, started(1, 1), attemptOf(1, 1, 'fail-tests')], outcomes: ['fail-tests', 'success'] },
  'resume-seed-after-wave-failed': {
    seed: [DELIVER_STARTED, started(1, 1), attemptOf(1, 1, 'fail-tests', { fingerprint: STUCK_PRINT }), ev('wave-failed', { wave: 1, action: 'revision' })],
    outcomes: ['fail-tests', 'success'],
  },
  'resume-seed-attempts-exhausted': {
    seed: [DELIVER_STARTED, ...[1, 2, 3].flatMap((n) => [started(1, n), attemptOf(1, n, 'fail-tests')])],
  },
  // ── Prepare and finish ports
  'prepare-ok': { prepare: () => PREPARED },
  'prepare-conflict': { prepare: () => ({ ok: false, stopped: 'merge-conflict', detail: 'conflict in a.js', base: 'main', branch: 'rad/x' }) },
  'prepare-failed': { prepare: () => ({ ok: false, stopped: 'prepare-failed', detail: 'fetch failed' }) },
  'prepare-throws': { prepare: throwing(new Error('network down')) },
  'prepare-throws-string': { prepare: throwing('plain string') },
  'prepare-undefined': { prepare: () => undefined },
  'finish-ok': { finish: {} },
  'finish-before-fails': { finish: { beforePr: () => ({ ok: false, detail: 'push rejected' }) } },
  'finish-before-throws': { finish: { beforePr: throwing(new Error('gh missing')) } },
  'finish-before-malformed': { finish: { beforePr: () => undefined } },
  'finish-before-no-detail': { finish: { beforePr: () => ({ ok: false }) } },
  'finish-after-fails': { finish: { afterPr: () => ({ ok: false, detail: 'label failed' }) } },
  'finish-after-throws': { finish: { afterPr: throwing(new Error('label api')) } },
  'finish-skipped-on-scope-fail': { finish: {}, sh: { [SCRIPT.scope]: failNth(3, { status: 1 }) } },
  'post-check-scope-fails': { sh: { [SCRIPT.scope]: failNth(3, { status: 1 }) } },
  'post-check-open-pr-fails': { sh: { [SCRIPT.openPr]: { status: 3 } } },
  // ── End-of-run test wave
  'testwave-written': { testWave: { paths: ['a.test.js', 'b.test.js'], missing: [['a.test.js'], []] } },
  'testwave-none-missing': { testWave: { paths: ['a.test.js'], missing: [[], []] } },
  'testwave-still-missing': { testWave: { paths: ['a.test.js', 'b.test.js'], missing: [['a.test.js'], ['a.test.js', 'b.test.js']] } },
  'testwave-pre-throws': { testWave: { paths: ['a.test.js'], missing: [{ throws: 'fs gone' }] } },
  'testwave-non-array': { testWave: { paths: ['a.test.js'], missing: ['nope'] } },
  'testwave-post-throws': { testWave: { paths: ['a.test.js'], missing: [['a.test.js'], { throws: 'fs gone' }] } },
  'testwave-wave-fails': { outcomes: ['success', 'success', 'fail-timeout'], testWave: { paths: ['a.test.js'], missing: [['a.test.js'], []] } },
  'testwave-already-completed': {
    seed: [DELIVER_STARTED, completed(1), completed(2), completed(3)],
    testWave: { paths: ['a.test.js'], missing: [['a.test.js'], ['a.test.js']] },
  },
  'testwave-with-testsbywave': {
    opts: { testsByWave: { 1: ['x.test.js'] } },
    testWave: { paths: ['a.test.js'], missing: [['a.test.js'], []] },
  },
  'testwave-presence-fails': {
    sh: { [SCRIPT.presence]: failNth(3, { status: 1, stdout: 'missing a' }) },
    testWave: { paths: ['a.test.js'], missing: [['a.test.js'], []] },
  },
};

/** Targeted scenarios whose full transcript is pinned: together they reach every
 * stop reason and every branch of the attempt loop while keeping the golden
 * file small. Every other scenario is compared by hash only. */
const PINNED_TARGETED = new Set([
  'happy-1w', 'plan-empty', 'gate-blocked', 'no-changes-outcome', 'unknown-outcome', 'preflight-throws',
  'max-attempts-1', 'revision-then-success', 'doom-loop', 'doom-loop-post-veto', 'capture-failed', 'fail-timeout-surface',
  'approval-gate-lost-w2', 'approval-port-not-intact', 'approval-port-throws', 'approval-during-w1', 'approval-during-last-wave',
  'budget-at', 'budget-resumed-seed', 'cap-hit', 'cap-seeded', 'cap-reset-by-stop',
  'hook-pre-veto', 'hook-pre-veto-invalid', 'hook-observe-failures', 'hook-post-veto-abort', 'hook-post-veto-demote-success',
  'testsbywave-presence-fails', 'verify-pass-scope-fail', 'push-first-read-fails', 'push-moved-overrides-veto',
  'resume-skip-completed', 'resume-verify-fails', 'resume-all-complete', 'resume-orphan', 'resume-orphan-two-attempts',
  'resume-operator-context-skipped-wave', 'resume-seed-doom', 'resume-seed-attempts-exhausted',
  'prepare-ok', 'prepare-conflict', 'prepare-failed', 'prepare-throws', 'finish-ok', 'finish-before-fails',
  'finish-after-fails', 'post-check-scope-fails', 'post-check-open-pr-fails',
  'testwave-written', 'testwave-still-missing', 'testwave-pre-throws', 'testwave-non-array',
]);

/** Grid scenarios pinned as well: one per gate configuration plus each outcome. */
const PINNED_GRID = [
  'g:none:s.s', 'g:none:fs', 'g:none:fto', 'g:none:fp', 'g:none:au', 'g:presence:s', 'g:vpass:s', 'g:vfail:s',
  'g:vtime:s', 'g:scope:s', 'g:pmoved:s', 'g:punread:s',
];

function targetedScenarios() {
  for (const key of PINNED_TARGETED) assert.ok(key in TARGETED, `pinned targeted scenario exists: ${key}`);
  return Object.entries(TARGETED).map(([key, spec]) => ({ id: `t:${key}`, spec, pinned: PINNED_TARGETED.has(key) }));
}

function allScenarios() {
  const pinnedGrid = new Set(PINNED_GRID);
  const grid = gridScenarios().map((s) => ({ ...s, pinned: pinnedGrid.has(s.id) }));
  const all = [...grid, ...targetedScenarios()];
  assert.equal(new Set(all.map((s) => s.id)).size, all.length, 'scenario ids are unique');
  for (const id of PINNED_GRID) assert.ok(all.some((s) => s.id === id), `pinned grid id exists: ${id}`);
  return all;
}

// ── Golden file ──

function formatGolden(hashes, pinned) {
  const hashLines = Object.keys(hashes).sort().map((id) => `${JSON.stringify(id)}:${JSON.stringify(hashes[id])}`);
  const pinnedBlocks = Object.keys(pinned).sort().map((id) => {
    const entries = pinned[id].map((entry) => JSON.stringify(entry)).join(',\n');
    return `${JSON.stringify(id)}:[\n${entries}\n]`;
  });
  return [
    '{', `"version":${GOLDEN_VERSION},`, `"hashLength":${HASH_LENGTH},`,
    '"hashes":{', hashLines.join(',\n'), '},',
    '"pinned":{', pinnedBlocks.join(',\n'), '}', '}', '',
  ].join('\n');
}

function dumpMismatch(id, timeline) {
  const file = join(tmpdir(), `spine-characterization-${id.replace(/[^\w.-]/g, '_')}.json`);
  writeFileSync(file, JSON.stringify(timeline, null, 1));
  return file;
}

/** Run every scenario once; returns { hashes, pinned, timelines-by-id for pinned }. */
async function recordAll() {
  const hashes = {};
  const pinned = {};
  for (const { id, spec, pinned: isPinned } of allScenarios()) {
    const timeline = await runScenario(spec);
    hashes[id] = hashTimeline(timeline);
    if (isPinned) pinned[id] = timeline;
  }
  return { hashes, pinned };
}

function compareToGolden(actual, golden) {
  const problems = [];
  const ids = new Set([...Object.keys(actual.hashes), ...Object.keys(golden.hashes)]);
  for (const id of [...ids].sort()) {
    if (golden.hashes[id] === undefined) problems.push(`${id}: no golden entry`);
    else if (actual.hashes[id] === undefined) problems.push(`${id}: golden entry has no scenario`);
    else if (actual.hashes[id] !== golden.hashes[id]) {
      const note = actual.pinned[id] ? ` (timeline written to ${dumpMismatch(id, actual.pinned[id])})` : '';
      problems.push(`${id}: timeline hash differs from golden${note}`);
    }
  }
  for (const id of Object.keys(golden.pinned)) {
    if (!actual.pinned[id]) problems.push(`${id}: pinned in golden but not pinned now`);
    else if (JSON.stringify(actual.pinned[id]) !== JSON.stringify(golden.pinned[id])) {
      problems.push(`${id}: pinned transcript differs (actual written to ${dumpMismatch(id, actual.pinned[id])})`);
    }
  }
  return problems;
}

// ── Tests ──

test('spine timelines match the golden characterization', async () => {
  const actual = await recordAll();
  if (process.env.UPDATE_GOLDEN === '1') {
    writeFileSync(GOLDEN_URL, formatGolden(actual.hashes, actual.pinned));
    return;
  }
  const golden = JSON.parse(readFileSync(GOLDEN_URL, 'utf8'));
  assert.equal(golden.version, GOLDEN_VERSION);
  assert.equal(golden.hashLength, HASH_LENGTH);
  const problems = compareToGolden(actual, golden);
  assert.deepEqual(problems.slice(0, MAX_REPORTED_MISMATCHES), [], `${problems.length} scenario(s) differ from golden`);
});

test('the golden file stays small and pins enough scenarios', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_URL, 'utf8'));
  assert.ok(readFileSync(GOLDEN_URL).length < MAX_GOLDEN_BYTES, 'golden file under 300 KB');
  assert.ok(Object.keys(golden.pinned).length >= MIN_PINNED, `at least ${MIN_PINNED} pinned scenarios`);
});

const REQUIRED_STOPS = [
  'gate', 'approval-changed', 'token-budget', 'resume-verify', 'failed-attempt-cap', 'hook-veto', 'doom-loop',
  'matrix', 'budget', 'finish-failed', 'merge-conflict', 'prepare-failed', 'tests-missing', 'post-check',
];

test('pinned scenarios exercise every stop reason and the attempt-loop branches', async () => {
  const stops = new Set();
  const kinds = new Set();
  for (const { spec, pinned } of allScenarios()) {
    if (!pinned) continue;
    const timeline = await runScenario(spec);
    const result = timeline.find((e) => e.k === 'result');
    if (result?.result.stopped) stops.add(result.result.stopped);
    for (const e of timeline) {
      if (e.k === 'append') kinds.add(e.event.type);
    }
  }
  for (const stop of REQUIRED_STOPS) assert.ok(stops.has(stop), `a pinned scenario stops with ${stop}`);
  for (const type of ['wave-complete', 'wave-failed', 'hook-veto', 'hook-observed', 'hook-failed', 'capture-failed',
    'push-check-unavailable', 'run-resumed', 'run-prepared', 'pr-opened']) {
    assert.ok(kinds.has(type), `a pinned scenario appends ${type}`);
  }
});

/** The ordered observable-call labels of a timeline, for hand reading. */
function labels(timeline) {
  return timeline.map((e) => {
    if (e.k === 'append') return `append:${e.event.type}`;
    if (e.k === 'hook') return `hook:${e.point}`;
    if (e.k === 'sh') return `sh:${e.script.replace('scripts/', '')}`;
    if (e.k === 'gate') return `gate:${e.name}`;
    return e.k;
  });
}

test('a one-wave success produces the expected ordered timeline', async () => {
  const timeline = await runScenario(TARGETED['happy-1w']);
  assert.deepEqual(labels(timeline), [
    'gate:approved', 'append:deliver-started', 'preflight', 'plan', 'history',
    'history', 'gate:approved', 'intact', // approval re-check before wave 1
    'hook:pre-wave', 'append:wave-started', 'runWave', 'hook:post-wave',
    'sh:check-tests-present.sh', 'sh:check-scope.sh', 'append:wave-attempt',
    'hook:on-outcome', 'hook:wave-complete', 'append:wave-complete',
    'history', // approvedDuringRun after the last wave
    'sh:check-scope.sh', 'sh:open-pr.sh', 'append:pr-opened', 'result', 'final',
  ]);
  const attempt = timeline.find((e) => e.k === 'runWave');
  assert.deepEqual(attempt.ctx, { attempt: 1, priorFailure: null });
  assert.deepEqual(timeline.find((e) => e.k === 'result').result, { ok: true, waves: 1 });
});
