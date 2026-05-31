import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverSpine } from '../spine.js';
import { loadMatrix } from '../matrix.js';

const MATRIX = loadMatrix();

/**
 * In-memory fake StateStore. Records appends; gate()/plan() are scripted per test.
 */
function makeFakeState({ gateResult, plan }) {
  const appended = [];
  return {
    appended,
    async gate() {
      return gateResult;
    },
    append(event) {
      appended.push(event);
    },
    plan() {
      return plan;
    },
    history() {
      return appended;
    },
    phase() {
      return null;
    },
    list() {
      return [];
    },
  };
}

const passingGate = { passed: true, reason: 'ok', satisfiedBy: { actor: 'architect' } };
const blockedGate = { passed: false, reason: 'needs an approved event', satisfiedBy: null };

const twoWaves = { waves: [{ n: 1 }, { n: 2 }] };

function fixedClock() {
  let i = 0;
  return () => `t${i++}`;
}

test('(a) blocked gate → {stopped:gate} and runWave never called', async () => {
  const state = makeFakeState({ gateResult: blockedGate, plan: twoWaves });
  let runWaveCalls = 0;
  const runWave = async () => {
    runWaveCalls += 1;
    return { outcome: 'success' };
  };
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave,
    sh: () => ({ status: 0 }),
    now: fixedClock(),
  });
  assert.deepEqual(result, { stopped: 'gate', gate: 'approved', reason: blockedGate.reason });
  assert.equal(runWaveCalls, 0);
  // Nothing destructive appended — not even deliver-started.
  assert.equal(state.appended.length, 0);
});

test('(b) happy path → all waves advance, post-checks called in order, pr-opened appended', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: twoWaves });
  const runWave = async () => ({ outcome: 'success' });
  const shCalls = [];
  const sh = (script, feature) => {
    shCalls.push({ script, feature });
    return { status: 0 };
  };
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave,
    sh,
    now: fixedClock(),
  });
  assert.deepEqual(result, { ok: true, waves: 2 });

  // Post-checks ran in declared order with the feature passed through.
  assert.deepEqual(
    shCalls.map((c) => c.script),
    ['scripts/check-scope.sh', 'scripts/check-tests.sh', 'scripts/open-pr.sh'],
  );
  assert.ok(shCalls.every((c) => c.feature === 'demo'));

  // Event trail: deliver-started, then per-wave attempt+complete, then pr-opened.
  const types = state.appended.map((e) => e.type);
  assert.deepEqual(types, [
    'deliver-started',
    'wave-attempt',
    'wave-complete',
    'wave-attempt',
    'wave-complete',
    'pr-opened',
  ]);
});

test('(b2) a failing post-check halts before pr-opened', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  const runWave = async () => ({ outcome: 'success' });
  const sh = (script) => (script.endsWith('check-tests.sh') ? { status: 1 } : { status: 0 });
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave,
    sh,
    now: fixedClock(),
  });
  assert.equal(result.stopped, 'post-check');
  assert.equal(result.check, 'check-tests.sh');
  assert.ok(!state.appended.some((e) => e.type === 'pr-opened'));
});

test('(c) retry-then-advance: a transient failure then success advances the wave', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  // First attempt fails with a revision-triggering outcome (distinct summary so
  // it is NOT a doom-loop), second attempt succeeds.
  const outcomes = [
    { outcome: 'fail-tests', summary: 'attempt one failure' },
    { outcome: 'success' },
  ];
  let i = 0;
  const runWave = async () => outcomes[i++];
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave,
    sh: () => ({ status: 0 }),
    now: fixedClock(),
  });
  assert.deepEqual(result, { ok: true, waves: 1 });
  const types = state.appended.map((e) => e.type);
  // deliver-started, attempt(fail), attempt(success), wave-complete, pr-opened
  assert.deepEqual(types, [
    'deliver-started',
    'wave-attempt',
    'wave-attempt',
    'wave-complete',
    'pr-opened',
  ]);
});

test('(d) doom-loop: the same failure twice in a row aborts with a structured failure', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  // Identical revision-triggering failure each attempt → same fingerprint twice.
  const runWave = async () => ({ outcome: 'fail-tests', summary: 'identical failure' });
  let runWaveCalls = 0;
  const wrapped = async (wave) => {
    runWaveCalls += 1;
    return runWave(wave);
  };
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: wrapped,
    sh: () => ({ status: 0 }),
    now: fixedClock(),
  });
  assert.equal(result.stopped, 'doom-loop');
  assert.equal(result.ok, false);
  assert.equal(result.wave, 1);
  // Bounded: aborted on the second identical attempt, no infinite loop.
  assert.equal(runWaveCalls, 2);
  assert.ok(state.appended.some((e) => e.type === 'wave-failed'));
  assert.ok(!state.appended.some((e) => e.type === 'pr-opened'));
});

test('(e) a matrix abort outcome stops the spine with stopped:matrix', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  const runWave = async () => ({ outcome: 'fail-scope' }); // matrix → abort
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave,
    sh: () => ({ status: 0 }),
    now: fixedClock(),
  });
  assert.equal(result.stopped, 'matrix');
  assert.equal(result.action, 'abort');
  assert.ok(!state.appended.some((e) => e.type === 'pr-opened'));
});
