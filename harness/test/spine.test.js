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

  // check-tests now runs per-wave (once per advancing wave), then the end
  // post-checks are scope + open-pr only — check-tests is no longer at the end.
  assert.deepEqual(
    shCalls.map((c) => c.script),
    [
      'scripts/check-tests.sh', // wave 1 gate
      'scripts/check-tests.sh', // wave 2 gate
      'scripts/check-scope.sh', // end post-check
      'scripts/open-pr.sh', // end post-check
    ],
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

test('(b2) a failing end post-check (check-scope) halts before pr-opened', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  const runWave = async () => ({ outcome: 'success' });
  // Per-wave check-tests passes (status 0); the end check-scope post-check fails.
  const sh = (script) => (script.endsWith('check-scope.sh') ? { status: 1 } : { status: 0 });
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
  assert.equal(result.check, 'check-scope.sh');
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

test('(f) a fail-timeout outcome surfaces via the matrix (stopped:matrix, action:surface)', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  const runWave = async () => ({ outcome: 'fail-timeout' }); // matrix → surface
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
  assert.equal(result.action, 'surface');
  assert.ok(!state.appended.some((e) => e.type === 'pr-opened'));
});

test('(g) budget exhaustion: distinct-fingerprint failures hit the cap, not the doom-loop', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  // Each attempt is a revision-triggering failure with a DISTINCT summary, so no
  // two fingerprints match — the doom-loop never trips and the MAX_ATTEMPTS cap
  // is what stops the wave.
  let i = 0;
  let runWaveCalls = 0;
  const runWave = async () => {
    runWaveCalls += 1;
    return { outcome: 'fail-tests', summary: `distinct failure ${i++}` };
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
  assert.equal(result.stopped, 'budget');
  assert.equal(result.ok, false);
  assert.equal(result.wave, 1);
  assert.equal(runWaveCalls, 3); // MAX_ATTEMPTS
  assert.ok(state.appended.some((e) => e.type === 'wave-failed'));
  assert.ok(!state.appended.some((e) => e.type === 'pr-opened'));
});

test('(g2) injected maxAttempts overrides the default budget', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  let i = 0;
  let runWaveCalls = 0;
  const runWave = async () => {
    runWaveCalls += 1;
    return { outcome: 'fail-tests', summary: `distinct failure ${i++}` };
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
    maxAttempts: 2,
  });
  assert.equal(result.stopped, 'budget');
  assert.equal(runWaveCalls, 2); // honored the injected cap, not the default 3
});

test('(h) null plan: no waves → post-checks run and pr-opened, ok with waves:0', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: null });
  let runWaveCalls = 0;
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: async () => {
      runWaveCalls += 1;
      return { outcome: 'success' };
    },
    sh: () => ({ status: 0 }),
    now: fixedClock(),
  });
  assert.deepEqual(result, { ok: true, waves: 0 });
  assert.equal(runWaveCalls, 0);
  const types = state.appended.map((e) => e.type);
  assert.deepEqual(types, ['deliver-started', 'pr-opened']);
});

test('(i) empty waves array behaves like null plan', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [] } });
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: async () => ({ outcome: 'success' }),
    sh: () => ({ status: 0 }),
    now: fixedClock(),
  });
  assert.deepEqual(result, { ok: true, waves: 0 });
});

test('(j) per-wave gate: runWave advances but check-tests fails → wave NOT recorded complete, re-enters matrix (fail-tests → revision)', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  // runWave always claims success; the per-wave gate fails identically each time,
  // so the wave is demoted to fail-tests (→ revision) and never advances. The
  // identical gate failure trips the doom-loop breaker on the second attempt.
  let runWaveCalls = 0;
  const runWave = async () => {
    runWaveCalls += 1;
    return { outcome: 'success' };
  };
  let gateCalls = 0;
  const sh = (script) => {
    if (script.endsWith('check-tests.sh')) {
      gateCalls += 1;
      return { status: 1 }; // regression at this wave
    }
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
  // Demoted to fail-tests → revision; identical fingerprint twice → doom-loop.
  assert.equal(result.stopped, 'doom-loop');
  assert.equal(result.ok, false);
  assert.equal(result.wave, 1);
  assert.equal(result.outcome, 'fail-tests'); // demoted, not 'success'
  assert.equal(runWaveCalls, 2); // bounded by the doom-loop breaker
  assert.equal(gateCalls, 2); // the per-wave gate ran on each advancing attempt
  // The wave never advanced: no wave-complete, no pr-opened.
  assert.ok(!state.appended.some((e) => e.type === 'wave-complete'));
  assert.ok(!state.appended.some((e) => e.type === 'pr-opened'));
  // The recorded attempt outcomes reflect the demotion, not the raw success.
  const attempts = state.appended.filter((e) => e.type === 'wave-attempt');
  assert.ok(attempts.every((e) => e.data.outcome === 'fail-tests'));
});

test('(k) resume verify: cumulative check-tests runs exactly once before the first non-skipped wave; failing it returns stopped:resume-verify', async () => {
  // History seeded with wave-complete for waves 1 and 2 → resume; wave 3 pending.
  const plan = { waves: [{ n: 1 }, { n: 2 }, { n: 3 }] };
  const state = makeFakeState({ gateResult: passingGate, plan });
  state.appended.push(
    { feature: 'demo', type: 'wave-complete', data: { wave: 1 } },
    { feature: 'demo', type: 'wave-complete', data: { wave: 2 } },
  );

  let runWaveCalls = 0;
  const runWave = async () => {
    runWaveCalls += 1;
    return { outcome: 'success' };
  };
  let cumulativeChecks = 0;
  const sh = (script) => {
    if (script.endsWith('check-tests.sh')) {
      cumulativeChecks += 1;
      return { status: 1 }; // prior cumulative work is broken
    }
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
  assert.deepEqual(result, { stopped: 'resume-verify', ok: false });
  // Escalated before touching wave 3 — the cumulative gate ran exactly once, and
  // runWave was never called (we did not build on a broken base).
  assert.equal(cumulativeChecks, 1);
  assert.equal(runWaveCalls, 0);
  assert.ok(!state.appended.some((e) => e.type === 'pr-opened'));
});

test('(k2) resume verify passes once, then wave 3 runs and the spine completes', async () => {
  const plan = { waves: [{ n: 1 }, { n: 2 }, { n: 3 }] };
  const state = makeFakeState({ gateResult: passingGate, plan });
  state.appended.push(
    { feature: 'demo', type: 'wave-complete', data: { wave: 1 } },
    { feature: 'demo', type: 'wave-complete', data: { wave: 2 } },
  );
  let runWaveCalls = 0;
  const runWave = async () => {
    runWaveCalls += 1;
    return { outcome: 'success' };
  };
  const checkTestsCalls = [];
  const sh = (script) => {
    if (script.endsWith('check-tests.sh')) checkTestsCalls.push(script);
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
  assert.deepEqual(result, { ok: true, waves: 3 });
  assert.equal(runWaveCalls, 1); // only the single non-skipped wave (3) ran
  // check-tests fired twice: once for the resume verify, once for wave 3's gate.
  assert.equal(checkTestsCalls.length, 2);
});

test('(l) fresh run: nothing skipped → no cumulative resume-verify gate (only per-wave gates)', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  const runWave = async () => ({ outcome: 'success' });
  const checkTestsCalls = [];
  const sh = (script) => {
    if (script.endsWith('check-tests.sh')) checkTestsCalls.push(script);
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
  assert.deepEqual(result, { ok: true, waves: 1 });
  // Exactly one check-tests call: the single wave's per-wave gate. No extra
  // cumulative verify, because nothing was skipped.
  assert.equal(checkTestsCalls.length, 1);
});

test('(m) end post-checks run check-scope + open-pr (and no longer check-tests at the end)', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  const runWave = async () => ({ outcome: 'success' });
  const shCalls = [];
  const sh = (script) => {
    shCalls.push(script);
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
  assert.deepEqual(result, { ok: true, waves: 1 });
  // The two end post-checks are scope then open-pr; check-tests is NOT among them.
  const endChecks = shCalls.slice(-2);
  assert.deepEqual(endChecks, ['scripts/check-scope.sh', 'scripts/open-pr.sh']);
  // check-tests appears only as the per-wave gate, never after open-pr.
  const openPrIdx = shCalls.indexOf('scripts/open-pr.sh');
  assert.ok(!shCalls.slice(openPrIdx).includes('scripts/check-tests.sh'));
});
