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

  // The test-presence gate now runs per-wave (once per advancing wave), then the
  // end post-checks are scope + open-pr only — check-tests-present is no longer
  // at the end.
  assert.deepEqual(
    shCalls.map((c) => c.script),
    [
      'scripts/check-tests-present.sh', // wave 1 gate
      'scripts/check-tests-present.sh', // wave 2 gate
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
  // The per-wave presence gate passes (status 0); the end check-scope post-check fails.
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

test('(j) per-wave gate: runWave advances but check-tests-present fails → wave NOT recorded complete, re-enters matrix (fail-tests → revision)', async () => {
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
    if (script.endsWith('check-tests-present.sh')) {
      gateCalls += 1;
      return { status: 1 }; // a promised test file is absent at this wave
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
    if (script.endsWith('check-tests-present.sh')) {
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

test('(k) resume verify: the cumulative presence check runs exactly once before the first non-skipped wave; failing it returns stopped:resume-verify', async () => {
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
    if (script.endsWith('check-tests-present.sh')) {
      cumulativeChecks += 1;
      return { status: 1 }; // a test file promised by prior waves is absent
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
    if (script.endsWith('check-tests-present.sh')) checkTestsCalls.push(script);
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
  // check-tests-present fired twice: once for the resume verify, once for wave 3's gate.
  assert.equal(checkTestsCalls.length, 2);
});

test('(l) fresh run: nothing skipped → no cumulative resume-verify gate (only per-wave gates)', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  const runWave = async () => ({ outcome: 'success' });
  const checkTestsCalls = [];
  const sh = (script) => {
    if (script.endsWith('check-tests-present.sh')) checkTestsCalls.push(script);
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
  // Exactly one check-tests-present call: the single wave's per-wave gate. No extra
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

test('(m) end post-checks run check-scope + open-pr (and no longer check-tests-present at the end)', async () => {
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
  // The two end post-checks are scope then open-pr; check-tests-present is NOT among them.
  const endChecks = shCalls.slice(-2);
  assert.deepEqual(endChecks, ['scripts/check-scope.sh', 'scripts/open-pr.sh']);
  // check-tests-present appears only as the per-wave gate, never after open-pr.
  const openPrIdx = shCalls.indexOf('scripts/open-pr.sh');
  assert.ok(!shCalls.slice(openPrIdx).includes('scripts/check-tests-present.sh'));
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
      'scripts/check-tests-present.sh',
      'scripts/check-tests-present.sh',
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

// ── Wave 3: veto reroute (Tasks 3.1/3.2/3.3) ────────────────────────────────

/**
 * A hook runner that returns a veto { hook, outcome } at the named point and a
 * neutral result everywhere else. Mirrors the runner's own return shape
 * (veto is { hook, outcome }|null). Records each call for flow assertions.
 */
function makeVetoSpy({ point, outcome, hook = `hooks/${point}/01.sh` }) {
  const calls = [];
  const runHooks = (p, ctx) => {
    calls.push({ point: p, ctx });
    if (p === point) {
      return {
        point: p,
        ran: [{ hook, exit: 0, vetoed: true, outcome }],
        veto: { hook, outcome },
        failures: [],
      };
    }
    return { point: p, ran: [], veto: null, failures: [] };
  };
  return { runHooks, calls };
}

test('(w3-a) a post-wave veto reroutes the outcome through the matrix and appends hook-veto', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  // The agent claims success, but a post-wave hook vetoes with fail-scope, which
  // the matrix resolves to `abort` — so the wave aborts via the existing vocab.
  const spy = makeVetoSpy({ point: 'post-wave', outcome: 'fail-scope' });
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
  // Rerouted per the matrix action for fail-scope (abort), not advanced.
  assert.equal(result.stopped, 'matrix');
  assert.equal(result.action, 'abort');
  assert.equal(result.outcome, 'fail-scope');
  // A hook-veto event was appended with the right provenance shape.
  const veto = state.appended.find((e) => e.type === 'hook-veto');
  assert.ok(veto, 'hook-veto event appended');
  assert.deepEqual(veto.data, {
    point: 'post-wave',
    hook: 'hooks/post-wave/01.sh',
    outcome: 'fail-scope',
    source: 'hook',
  });
  // The wave never advanced and no PR opened.
  assert.ok(!state.appended.some((e) => e.type === 'wave-complete'));
  assert.ok(!state.appended.some((e) => e.type === 'pr-opened'));
});

test('(w3-b) a pre-wave veto aborts BEFORE runWave — the agent never runs', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  const spy = makeVetoSpy({ point: 'pre-wave', outcome: 'fail-scope' });
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
    runHooks: spy.runHooks,
  });
  // The agent was never invoked.
  assert.equal(runWaveCalls, 0);
  assert.equal(result.stopped, 'hook-veto');
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'fail-scope');
  assert.equal(result.point, 'pre-wave');
  // hook-veto + wave-failed appended; no wave-attempt (the agent never ran).
  assert.ok(state.appended.some((e) => e.type === 'hook-veto'));
  assert.ok(state.appended.some((e) => e.type === 'wave-failed'));
  assert.ok(!state.appended.some((e) => e.type === 'wave-attempt'));
  assert.ok(!state.appended.some((e) => e.type === 'pr-opened'));
});

test('(w3-c) fail-closed: a veto carrying abort-user (the runner crash/invalid fallback) aborts the wave', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  // This is what the runner emits on a hook crash or out-of-vocabulary token.
  const spy = makeVetoSpy({ point: 'post-wave', outcome: 'abort-user' });
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
  // abort-user resolves to `abort` in the matrix → the wave aborts.
  assert.equal(result.stopped, 'matrix');
  assert.equal(result.action, 'abort');
  assert.equal(result.outcome, 'abort-user');
  assert.ok(!state.appended.some((e) => e.type === 'pr-opened'));
});

test('(w3-c2) fail-closed defense: an out-of-vocabulary veto token is coerced to abort-user before the matrix', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  // A malformed veto token must NEVER reach resolveOutcome (it would throw on an
  // unknown outcome). The spine coerces it fail-closed to abort-user.
  const spy = makeVetoSpy({ point: 'post-wave', outcome: 'not-a-real-outcome' });
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
  assert.equal(result.stopped, 'matrix');
  assert.equal(result.action, 'abort');
  assert.equal(result.outcome, 'abort-user'); // coerced, not the bad token
  const veto = state.appended.find((e) => e.type === 'hook-veto');
  assert.equal(veto.data.outcome, 'abort-user');
});

test('(w3-d) observe-only points cannot veto — a veto field on on-outcome/wave-complete is ignored, flow unchanged', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  // Both observe-only points "veto" fail-scope; the spine must ignore it entirely.
  const calls = [];
  const runHooks = (p, ctx) => {
    calls.push(p);
    if (p === 'on-outcome' || p === 'wave-complete') {
      const hook = `hooks/${p}/01.sh`;
      return {
        point: p,
        ran: [{ hook, exit: 0, vetoed: true, outcome: 'fail-scope' }],
        veto: { hook, outcome: 'fail-scope' },
        failures: [],
      };
    }
    return { point: p, ran: [], veto: null, failures: [] };
  };
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: async () => ({ outcome: 'success' }),
    sh: () => ({ status: 0 }),
    now: fixedClock(),
    runHooks,
  });
  // Flow is unchanged: the wave advances and the PR opens — the observe-only
  // veto field had no effect.
  assert.deepEqual(result, { ok: true, waves: 1 });
  assert.ok(state.appended.some((e) => e.type === 'wave-complete'));
  assert.ok(state.appended.some((e) => e.type === 'pr-opened'));
  // No hook-veto event was appended from an observe-only point.
  assert.ok(!state.appended.some((e) => e.type === 'hook-veto'));
});

test('(w3-e) provenance: a rerouted wave-attempt + wave-failed carry source/point/hook, distinguishable from agent-emitted', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  const spy = makeVetoSpy({ point: 'post-wave', outcome: 'fail-scope' });
  await deliverSpine({
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
  const attempt = state.appended.find((e) => e.type === 'wave-attempt');
  assert.equal(attempt.data.source, 'hook');
  assert.equal(attempt.data.point, 'post-wave');
  assert.equal(attempt.data.hook, 'hooks/post-wave/01.sh');
  assert.equal(attempt.data.outcome, 'fail-scope'); // the veto outcome, not success

  const failed = state.appended.find((e) => e.type === 'wave-failed');
  assert.equal(failed.data.source, 'hook');
  assert.equal(failed.data.point, 'post-wave');
  assert.equal(failed.data.hook, 'hooks/post-wave/01.sh');
});

test('(w3-f) no veto: agent-emitted wave-attempt carries NO provenance keys (distinguishable from a veto)', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  // A hook runner that observes but never vetoes.
  const spy = makeHookSpy({ ranPoints: new Set(ALL_POINTS) });
  await deliverSpine({
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
  const attempt = state.appended.find((e) => e.type === 'wave-attempt');
  // Agent-emitted: no provenance keys present at all.
  assert.equal(attempt.data.source, undefined);
  assert.equal(attempt.data.point, undefined);
  assert.equal(attempt.data.hook, undefined);
  assert.ok(!state.appended.some((e) => e.type === 'hook-veto'));
});
