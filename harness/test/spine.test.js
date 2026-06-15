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

test('(j2) per-wave gate doom-loop is model-variance-proof: gate fails identically while runWave rewords its output → aborts at the breaker, not the budget', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  // The model claims success but VARIES its summary every attempt; the gate fails
  // identically. The demotion fingerprint must key off the STABLE gate failure,
  // not the model's wording — otherwise each attempt hashes differently and the
  // run burns the whole budget instead of tripping the doom-loop on attempt 2.
  let i = 0;
  const runWave = async () => ({ outcome: 'success', summary: `reworded ${i++}` });
  let gateCalls = 0;
  const sh = (script) => {
    if (script.endsWith('check-tests.sh')) {
      gateCalls += 1;
      return { status: 1 }; // identical gate failure each attempt
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
  assert.equal(result.stopped, 'doom-loop'); // NOT 'budget' — the breaker tripped
  assert.equal(result.ok, false);
  assert.equal(gateCalls, 2); // aborted after 2, not all 3 (budget) attempts
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

test('(n) AC#3 token-budget breaker: cumulative usage over budget aborts before the over-budget wave runs', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }, { n: 2 }] } });
  // Wave 1 records usage that already meets/exceeds the low budget; the breaker
  // must fire before wave 2 starts, so runWave is called exactly once.
  const wavesRun = [];
  const runWave = async (wave) => {
    wavesRun.push(wave.n);
    return { outcome: 'success', usage: { input: 60, output: 60, total: 120 } };
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
    tokenBudget: 100,
  });
  assert.equal(result.stopped, 'token-budget');
  assert.equal(result.ok, false);
  assert.equal(result.wave, 2); // stopped at the wave it refused to start
  assert.equal(result.spent, 120);
  assert.equal(result.budget, 100);
  assert.deepEqual(wavesRun, [1]); // wave 2 never ran
  assert.ok(state.appended.some((e) => e.type === 'wave-failed' && e.data.reason === 'token-budget'));
  assert.ok(!state.appended.some((e) => e.type === 'pr-opened'));
});

test('(n2) AC#3 token-budget unset: behavior is unchanged (full run completes)', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: twoWaves });
  const runWave = async () => ({ outcome: 'success', usage: { input: 999999, output: 999999, total: 1999998 } });
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave,
    sh: () => ({ status: 0 }),
    now: fixedClock(),
    // tokenBudget omitted → breaker disabled even though usage is enormous.
  });
  assert.deepEqual(result, { ok: true, waves: 2 });
  assert.ok(!state.appended.some((e) => e.type === 'token-budget' || (e.type === 'wave-failed')));
});

test('(n3) AC#3 token-budget tolerates missing usage (no NaN) and never trips when under budget', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: twoWaves });
  // No usage field at all (command adapter without usage) → contributes 0.
  const runWave = async () => ({ outcome: 'success' });
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave,
    sh: () => ({ status: 0 }),
    now: fixedClock(),
    tokenBudget: 100,
  });
  assert.deepEqual(result, { ok: true, waves: 2 });
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

// ── Wave 2: lifecycle-hook integration (Tasks 2.1/2.2/2.3) ──────────────────

/**
 * A spy hook runner. Records each (point, ctx) call and, for the named points,
 * reports one hook that "ran" (so a hook-observed event is appended) plus an
 * optional failure (so a hook-failed event is appended). OBSERVE-ONLY: it never
 * vetoes — the veto reroute is Wave 3.
 */
function makeHookSpy({ ranPoints = new Set(), failPoints = new Set() } = {}) {
  const calls = [];
  const runHooks = (point, ctx) => {
    calls.push({ point, ctx });
    const ran = ranPoints.has(point)
      ? [{ hook: `hooks/${point}/01.sh`, exit: 0, vetoed: false, outcome: 'success' }]
      : [];
    const failures = failPoints.has(point)
      ? [{ hook: `hooks/${point}/01.sh`, reason: 'exit 1' }]
      : [];
    return { point, ran, veto: null, failures };
  };
  return { runHooks, calls };
}

const ALL_POINTS = ['pre-wave', 'post-wave', 'on-outcome', 'on-retry', 'on-error', 'wave-complete'];

test('(w2-a) hooks fire at all six lifecycle points across happy + retry + error runs', async () => {
  // A single happy-path run exercises pre-wave, post-wave, on-outcome, wave-complete.
  const happyState = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  const happySpy = makeHookSpy({ ranPoints: new Set(ALL_POINTS) });
  await deliverSpine({
    feature: 'demo',
    state: happyState,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: async () => ({ outcome: 'success' }),
    sh: () => ({ status: 0 }),
    now: fixedClock(),
    runHooks: happySpy.runHooks,
  });
  const happyPoints = happySpy.calls.map((c) => c.point);
  for (const p of ['pre-wave', 'post-wave', 'on-outcome', 'wave-complete']) {
    assert.ok(happyPoints.includes(p), `happy run fired ${p}`);
  }
  // Exactly once each for a single-attempt, single-wave advance.
  assert.equal(happyPoints.filter((p) => p === 'pre-wave').length, 1);
  assert.equal(happyPoints.filter((p) => p === 'wave-complete').length, 1);
  // Each ran hook produced a hook-observed event with the right provenance shape.
  const observed = happyState.appended.filter((e) => e.type === 'hook-observed');
  assert.ok(observed.length >= 4);
  for (const e of observed) {
    assert.equal(e.data.source, 'hook');
    assert.ok(ALL_POINTS.includes(e.data.point));
    assert.ok(typeof e.data.hook === 'string');
  }

  // A doom-loop run exercises on-retry (attempt 1) and on-error (the abort).
  const failState = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  const failSpy = makeHookSpy({ ranPoints: new Set(ALL_POINTS) });
  await deliverSpine({
    feature: 'demo',
    state: failState,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: async () => ({ outcome: 'fail-tests', summary: 'identical failure' }),
    sh: () => ({ status: 0 }),
    now: fixedClock(),
    runHooks: failSpy.runHooks,
  });
  const failPoints = failSpy.calls.map((c) => c.point);
  assert.ok(failPoints.includes('on-retry'), 'fail run fired on-retry');
  assert.ok(failPoints.includes('on-error'), 'fail run fired on-error');

  // Union across both runs covers all six points.
  const fired = new Set([...happyPoints, ...failPoints]);
  for (const p of ALL_POINTS) assert.ok(fired.has(p), `some run fired ${p}`);
});

test('(w2-a2) observe failures are recorded as hook-failed but NEVER alter wave flow (fail-open)', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  // Every observe-only point reports a failure; the happy path must still complete.
  const spy = makeHookSpy({
    ranPoints: new Set(ALL_POINTS),
    failPoints: new Set(['on-outcome', 'wave-complete']),
  });
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: async () => ({ outcome: 'success' }),
    sh: () => ({ status: 0 }),
    now: fixedClock(),
    runHooks: spy.runHooks,
  });
  // Flow is unchanged: the wave still advances and the PR still opens.
  assert.deepEqual(result, { ok: true, waves: 1 });
  assert.ok(state.appended.some((e) => e.type === 'wave-complete'));
  assert.ok(state.appended.some((e) => e.type === 'pr-opened'));
  // The failures were recorded, not swallowed.
  const failed = state.appended.filter((e) => e.type === 'hook-failed');
  assert.ok(failed.length >= 2);
  for (const e of failed) assert.equal(e.data.source, 'hook');
});

test('(w2-a3) hookPreflight runs exactly once at deliver-start; a malformed dir surfaces deterministically', async () => {
  // Pre-flight is invoked once, right after deliver-started.
  const okState = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  let preflightCalls = 0;
  await deliverSpine({
    feature: 'demo',
    state: okState,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: async () => ({ outcome: 'success' }),
    sh: () => ({ status: 0 }),
    now: fixedClock(),
    hookPreflight: () => { preflightCalls += 1; },
  });
  assert.equal(preflightCalls, 1);

  // A malformed hooks dir surfaces early (the spine lets the probe throw to the caller).
  const badState = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  await assert.rejects(
    deliverSpine({
      feature: 'demo',
      state: badState,
      docs: {},
      matrix: MATRIX,
      gates: {},
      runWave: async () => ({ outcome: 'success' }),
      sh: () => ({ status: 0 }),
      now: fixedClock(),
      hookPreflight: () => { throw new Error('hooks dir unreadable'); },
    }),
    /hooks dir unreadable/,
  );
  // Surfaced at deliver-start: no wave work happened (no wave-attempt, no pr-opened).
  assert.ok(!badState.appended.some((e) => e.type === 'wave-attempt'));
  assert.ok(!badState.appended.some((e) => e.type === 'pr-opened'));
});

test('(w2-b) BACKWARD-COMPAT SNAPSHOT: default no-op runHooks → event sequence byte-for-byte identical to the happy path (no hook-* events)', async () => {
  // This is the exact construction of test (b) but with NO runHooks/hookPreflight
  // injected — the defaults must reproduce the legacy sequence exactly.
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

  // The sh call order is unchanged.
  assert.deepEqual(
    shCalls.map((c) => c.script),
    [
      'scripts/check-tests.sh',
      'scripts/check-tests.sh',
      'scripts/check-scope.sh',
      'scripts/open-pr.sh',
    ],
  );

  // THE SNAPSHOT: the appended event-type sequence is byte-for-byte the same as
  // the legacy happy path — no hook-observed / hook-veto / hook-failed appear.
  const types = state.appended.map((e) => e.type);
  assert.deepEqual(types, [
    'deliver-started',
    'wave-attempt',
    'wave-complete',
    'wave-attempt',
    'wave-complete',
    'pr-opened',
  ]);
  assert.ok(!types.some((t) => t.startsWith('hook-')));
});
