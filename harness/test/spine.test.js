import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverSpine, failedAttemptsSinceStop, approvedDuringRun } from '../spine.js';
import { loadMatrix } from '../matrix.js';
import { fingerprint } from '../fingerprint.js';
import { validateTransition } from '../transitions.js';
import { phaseOf } from '../events.js';

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
      'scripts/check-scope.sh', // wave 1 scope gate (#77)
      'scripts/check-tests-present.sh', // wave 2 gate
      'scripts/check-scope.sh', // wave 2 scope gate (#77)
      'scripts/check-scope.sh', // end post-check
      'scripts/open-pr.sh', // end post-check
    ],
  );
  assert.ok(shCalls.every((c) => c.feature === 'demo'));

  // Event trail: deliver-started, then per-wave started+attempt+complete, then
  // pr-opened. `wave-started` precedes each runWave since #119 (durability).
  const types = state.appended.map((e) => e.type);
  assert.deepEqual(types, [
    'deliver-started',
    'wave-started',
    'wave-attempt',
    'wave-complete',
    'wave-started',
    'wave-attempt',
    'wave-complete',
    'pr-opened',
  ]);
});

/** An sh fake that fails ONLY the nth check-scope.sh call (1-based). Since #77
 * check-scope also runs per wave, so an END post-check failure is the last call. */
function failNthScope(n) {
  let scopeCalls = 0;
  return (script) => {
    if (!script.endsWith('check-scope.sh')) return { status: 0 };
    scopeCalls += 1;
    return { status: scopeCalls === n ? 1 : 0 };
  };
}

test('(b2) a failing end post-check (check-scope) halts before pr-opened', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  const runWave = async () => ({ outcome: 'success' });
  // The per-wave presence + scope gates pass; only the END check-scope post-check
  // (the second check-scope call of a one-wave run, #77) fails.
  const sh = failNthScope(2);
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
  // deliver-started, [started, attempt(fail)], [started, attempt(success)],
  // wave-complete, pr-opened — `wave-started` precedes each runWave since #119.
  assert.deepEqual(types, [
    'deliver-started',
    'wave-started',
    'wave-attempt',
    'wave-started',
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
      'scripts/check-scope.sh', // per-wave scope gate (#77)
      'scripts/check-tests-present.sh',
      'scripts/check-scope.sh', // per-wave scope gate (#77)
      'scripts/check-scope.sh',
      'scripts/open-pr.sh',
    ],
  );

  // THE SNAPSHOT: the appended event-type sequence is byte-for-byte the same as
  // the no-hooks happy path of the same version — no hook-observed / hook-veto /
  // hook-failed appear (`wave-started` is part of every run since #119).
  const types = state.appended.map((e) => e.type);
  assert.deepEqual(types, [
    'deliver-started',
    'wave-started',
    'wave-attempt',
    'wave-complete',
    'wave-started',
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

// ── Wave 5: executing verification gate + retry back-pressure (#89 / #90) ────
//
// The gate under test is EXECUTING, not presence-based: the spine hands a
// plan-declared command to scripts/check-verify.sh through the same injected
// `sh` port every other guardrail uses, and reads its REAL exit code. These
// cases pin the four properties that make that safe to ship: an absent
// declaration changes nothing, a declared command reaches the script (and only
// the script), a real failure demotes through the frozen matrix vocabulary, and
// the failure is carried into the next attempt's prompt.

/** The script the spine delegates verification to. Never invoked directly by the spine. */
const VERIFY_SCRIPT = 'scripts/check-verify.sh';
/** Exit code scripts/check-verify.sh RESERVES for "killed by the timeout". */
const VERIFY_TIMEOUT_STATUS = 124;
/** The frozen 7-outcome matrix vocabulary (harness/matrix.yaml). */
const FROZEN_OUTCOMES = new Set([
  'success',
  'fail-tests',
  'fail-scope',
  'fail-protocol',
  'fail-timeout',
  'no-changes',
  'abort-user',
]);

/**
 * An `sh` spy that records every (script, arg) pair and answers check-verify.sh
 * from a scripted per-call queue (so attempt 1 and attempt 2 can differ). Every
 * other script returns success.
 *
 * @param {Array<{status: number, stdout?: string}>} verifyResults - consumed in order;
 *   the last entry repeats once exhausted.
 */
function makeVerifyingSh(verifyResults = [{ status: 0 }]) {
  const calls = [];
  let i = 0;
  const sh = (script, arg) => {
    calls.push({ script, arg });
    if (script === VERIFY_SCRIPT) {
      const res = verifyResults[Math.min(i, verifyResults.length - 1)];
      i += 1;
      return res;
    }
    return { status: 0 };
  };
  return { sh, calls };
}

test('(w5-a) AC#1 absent Verify: declaring none is byte-for-byte today — no check-verify call, no `verify` key, identical event sequence', async () => {
  // Two runs of the SAME scenario: one with waveVerify omitted entirely (a
  // legacy caller), one with the empty map cli.js passes for a plan that
  // declares no `Verify:` anywhere. Both must reproduce the pre-verification
  // behavior exactly.
  const runOnce = async (extra) => {
    const state = makeFakeState({ gateResult: passingGate, plan: twoWaves });
    const spy = makeVerifyingSh();
    const result = await deliverSpine({
      feature: 'demo',
      state,
      docs: {},
      matrix: MATRIX,
      gates: {},
      runWave: async () => ({ outcome: 'success' }),
      sh: spy.sh,
      now: fixedClock(),
      ...extra,
    });
    return { state, spy, result };
  };

  const legacy = await runOnce({}); // waveVerify omitted
  const declaredNone = await runOnce({ waveVerify: {} }); // plan declares no Verify:

  assert.deepEqual(legacy.result, { ok: true, waves: 2 });
  assert.deepEqual(declaredNone.result, { ok: true, waves: 2 });

  // check-verify.sh was never invoked on either path.
  for (const run of [legacy, declaredNone]) {
    assert.ok(
      !run.spy.calls.some((c) => c.script === VERIFY_SCRIPT),
      'no verification command may run when none is declared',
    );
  }

  // The sh call order is the legacy one: per-wave presence + scope gates, then
  // the end post-checks. No check-verify call was inserted.
  assert.deepEqual(
    legacy.spy.calls.map((c) => c.script),
    [
      'scripts/check-tests-present.sh',
      'scripts/check-scope.sh', // per-wave scope gate (#77)
      'scripts/check-tests-present.sh',
      'scripts/check-scope.sh', // per-wave scope gate (#77)
      'scripts/check-scope.sh',
      'scripts/open-pr.sh',
    ],
  );

  // THE PARITY ASSERTION: the two appended event logs are deep-equal to each
  // other, and every wave-attempt carries exactly the legacy data keys — `verify`
  // is ABSENT, never present-and-undefined.
  assert.deepEqual(declaredNone.state.appended, legacy.state.appended);
  const attempts = legacy.state.appended.filter((e) => e.type === 'wave-attempt');
  assert.equal(attempts.length, 2);
  for (const e of attempts) {
    assert.ok(!('verify' in e.data), '`verify` key must be absent, not undefined');
    assert.ok(!('tasks' in e.data), '`tasks` key must be absent, not undefined');
    // `attempt` is recorded on every wave-attempt since #119; `verify`/`tasks`
    // (and `fingerprint`, success never fingerprints) stay absent.
    assert.deepEqual(Object.keys(e.data), ['wave', 'attempt', 'outcome', 'usage']);
  }
});

test('(w5-a2) AC#1 edge — a NON-empty waveVerify map still runs nothing for a wave absent from it', async () => {
  // The absent-declaration guarantee is per WAVE, not per plan: wave 2 declaring
  // a command must not cause wave 1 to run one.
  const state = makeFakeState({ gateResult: passingGate, plan: twoWaves });
  const spy = makeVerifyingSh([{ status: 0 }]);
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: async () => ({ outcome: 'success' }),
    sh: spy.sh,
    now: fixedClock(),
    waveVerify: { 2: 'npm test' },
  });
  assert.deepEqual(result, { ok: true, waves: 2 });
  const verifyCalls = spy.calls.filter((c) => c.script === VERIFY_SCRIPT);
  assert.equal(verifyCalls.length, 1, 'only the declaring wave runs a command');
  const attempts = state.appended.filter((e) => e.type === 'wave-attempt');
  assert.ok(!('verify' in attempts[0].data), 'wave 1 declared none → no verify key');
  assert.deepEqual(attempts[1].data.verify, { command: 'npm test', status: 0, passed: true });
});

test('(w5-b) AC#2 a declared command reaches check-verify.sh through the sh port — one argument, never executed by the spine', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  const spy = makeVerifyingSh([{ status: 0 }]);
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: async () => ({ outcome: 'success' }),
    sh: spy.sh,
    now: fixedClock(),
    waveVerify: { 1: 'npm test --prefix harness' },
  });
  assert.deepEqual(result, { ok: true, waves: 1 });

  // Delegated, not executed: the ONLY thing the spine passes is the command, as
  // check-verify.sh's single positional argument.
  const verifyCall = spy.calls.find((c) => c.script === VERIFY_SCRIPT);
  assert.ok(verifyCall, 'check-verify.sh was invoked');
  assert.equal(verifyCall.arg, 'npm test --prefix harness');

  // It runs AFTER the presence gate — the two checks are distinct and ordered
  // (issue #91), not merged.
  const order = spy.calls.map((c) => c.script);
  assert.ok(
    order.indexOf('scripts/check-tests-present.sh') < order.indexOf(VERIFY_SCRIPT),
    'presence gate runs before the executing gate',
  );

  // The event log records what was executed and what really happened.
  const attempt = state.appended.find((e) => e.type === 'wave-attempt');
  assert.deepEqual(attempt.data.verify, {
    command: 'npm test --prefix harness',
    status: 0,
    passed: true,
  });
});

test('(w5-b2) AC#2 a failed PRESENCE gate short-circuits: the declared command never runs', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  const calls = [];
  const sh = (script, arg) => {
    calls.push({ script, arg });
    return script.endsWith('check-tests-present.sh') ? { status: 1 } : { status: 0 };
  };
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: async () => ({ outcome: 'success' }),
    sh,
    now: fixedClock(),
    waveVerify: { 1: 'npm test' },
  });
  assert.equal(result.stopped, 'doom-loop'); // identical presence failure twice
  assert.ok(
    !calls.some((c) => c.script === VERIFY_SCRIPT),
    'no command is executed against a wave that never wrote its promised tests',
  );
});

test('(w5-c) AC#3 a failing verification demotes success → fail-tests through the matrix; the vocabulary gains nothing', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  // Attempt 1's command fails (exit 1); attempt 2's passes. The agent claims
  // success both times — only the executed exit code differs.
  const spy = makeVerifyingSh([
    { status: 1, stdout: '✗ Verification FAILED (exit 1): npm test' },
    { status: 0 },
  ]);
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
    sh: spy.sh,
    now: fixedClock(),
    waveVerify: { 1: 'npm test' },
  });
  // Demoted to fail-tests → revision → retried → advanced on the green run.
  assert.deepEqual(result, { ok: true, waves: 1 });
  assert.equal(runWaveCalls, 2);

  const attempts = state.appended.filter((e) => e.type === 'wave-attempt');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].data.outcome, 'fail-tests'); // demoted, not the claimed success
  assert.deepEqual(attempts[0].data.verify, { command: 'npm test', status: 1, passed: false });
  assert.equal(attempts[1].data.outcome, 'success');
  assert.deepEqual(attempts[1].data.verify, { command: 'npm test', status: 0, passed: true });
  // Every recorded outcome is a member of the FROZEN vocabulary — no new token.
  for (const e of attempts) assert.ok(FROZEN_OUTCOMES.has(e.data.outcome));
});

test('(w5-d) AC#7 a TIMED-OUT command maps to fail-timeout (surface), never fail-tests — and is not retried', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  const spy = makeVerifyingSh([
    { status: VERIFY_TIMEOUT_STATUS, stdout: '✗ Verification TIMED OUT after 600s: sleep 999' },
  ]);
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
    sh: spy.sh,
    now: fixedClock(),
    waveVerify: { 1: 'sleep 999' },
  });
  // fail-timeout resolves to `surface` — a terminal, not the revision loop.
  assert.equal(result.stopped, 'matrix');
  assert.equal(result.action, 'surface');
  assert.equal(result.outcome, 'fail-timeout');
  assert.notEqual(result.outcome, 'fail-tests');
  // A retry cannot fix a hang: the agent ran exactly once.
  assert.equal(runWaveCalls, 1);
  assert.equal(spy.calls.filter((c) => c.script === VERIFY_SCRIPT).length, 1);

  const attempt = state.appended.find((e) => e.type === 'wave-attempt');
  assert.equal(attempt.data.outcome, 'fail-timeout');
  assert.deepEqual(attempt.data.verify, {
    command: 'sleep 999',
    status: VERIFY_TIMEOUT_STATUS,
    passed: false,
  });
  assert.ok(!state.appended.some((e) => e.type === 'wave-complete'));
  assert.ok(!state.appended.some((e) => e.type === 'pr-opened'));
});

test('(w5-e) AC#4 priorFailure threading: attempt 1 gets null; attempt 2 carries the outcome, blocking task, and output excerpt', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  const EXCERPT = '✗ Verification FAILED (exit 1): npm test\n  2 tests failed';
  const spy = makeVerifyingSh([{ status: 1, stdout: EXCERPT }, { status: 0 }]);
  // The agent claims the wave succeeded but reports one blocked task — the
  // executed gate is what demotes it, and that task is what the retry is told about.
  const tasks = [
    { title: 'T1', status: 'complete', error: '—' },
    { title: 'T2', status: 'blocked_code', error: 'assertion failed in foo()' },
  ];
  const attemptCtxs = [];
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: async (wave, ctx) => {
      attemptCtxs.push(ctx);
      return { outcome: 'success', tasks };
    },
    sh: spy.sh,
    now: fixedClock(),
    waveVerify: { 1: 'npm test' },
  });
  assert.deepEqual(result, { ok: true, waves: 1 });
  assert.equal(attemptCtxs.length, 2);

  // Attempt 1: no prior failure exists — today's prompt, exactly.
  assert.deepEqual(attemptCtxs[0], { attempt: 1, priorFailure: null });

  // Attempt 2: the retry differs by more than model nondeterminism.
  assert.equal(attemptCtxs[1].attempt, 2);
  const prior = attemptCtxs[1].priorFailure;
  assert.equal(prior.attempt, 1);
  assert.equal(prior.outcome, 'fail-tests');
  assert.deepEqual(prior.task, {
    title: 'T2',
    status: 'blocked_code',
    error: 'assertion failed in foo()',
  });
  assert.equal(prior.excerpt, EXCERPT);
});

test('(w5-e2) AC#4 edge — empty gate output and a task-free result yield an excerpt-less, task-less capture (never empty strings)', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  // A failing command that printed nothing, and a result carrying no tasks at all.
  const spy = makeVerifyingSh([{ status: 1 }, { status: 0 }]);
  const attemptCtxs = [];
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: async (wave, ctx) => {
      attemptCtxs.push(ctx);
      return { outcome: 'success' };
    },
    sh: spy.sh,
    now: fixedClock(),
    waveVerify: { 1: 'npm test' },
  });
  assert.deepEqual(result, { ok: true, waves: 1 });
  const prior = attemptCtxs[1].priorFailure;
  assert.equal(prior.excerpt, undefined, 'empty output is omitted, not rendered as ""');
  assert.equal(prior.task, null, 'a result with no tasks names no blocking task');
  assert.equal(prior.outcome, 'fail-tests');
});

test('(w5-e3) AC#4 a non-array `tasks` cannot crash the capture — it degrades to no blocking task', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  const spy = makeVerifyingSh([{ status: 1, stdout: 'boom' }, { status: 0 }]);
  const attemptCtxs = [];
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: async (wave, ctx) => {
      attemptCtxs.push(ctx);
      return { outcome: 'success', tasks: 'not-an-array' };
    },
    sh: spy.sh,
    now: fixedClock(),
    waveVerify: { 1: 'npm test' },
  });
  assert.deepEqual(result, { ok: true, waves: 1 });
  assert.equal(attemptCtxs[1].priorFailure.task, null);
  assert.equal(attemptCtxs[1].priorFailure.excerpt, 'boom');
});

test('(w5-g) AC#8 capture is FAIL-OPEN: a capture failure logs its reason and attempt 2 still runs with the priorFailure-absent prompt', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  // A tasks array whose `find` throws — the one operation the capture performs on
  // it. Non-enumerable, so the value still serializes normally onto the event and
  // the doom-loop fingerprint (which reads only categories/summary) is unaffected.
  const boobyTrapped = [];
  Object.defineProperty(boobyTrapped, 'find', {
    value: () => {
      throw new Error('exploding tasks accessor');
    },
  });
  let i = 0;
  const attemptCtxs = [];
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    // Distinct summaries so the doom-loop breaker does not trip before attempt 2.
    runWave: async (wave, ctx) => {
      attemptCtxs.push(ctx);
      i += 1;
      return i === 1
        ? { outcome: 'fail-tests', summary: 'first failure', tasks: boobyTrapped }
        : { outcome: 'success' };
    },
    sh: () => ({ status: 0 }),
    now: fixedClock(),
  });

  // The wave still completed: losing the enrichment is never worse than never
  // having had it.
  assert.deepEqual(result, { ok: true, waves: 1 });
  assert.equal(attemptCtxs.length, 2);
  assert.equal(attemptCtxs[1].priorFailure, null, 'degraded to today\'s prompt');

  // The error was RECORDED with context, not swallowed.
  const captureFailed = state.appended.find((e) => e.type === 'capture-failed');
  assert.ok(captureFailed, 'a capture-failed event was appended');
  assert.deepEqual(captureFailed.data, {
    wave: 1,
    attempt: 1,
    outcome: 'fail-tests',
    what: 'prior-failure',
    reason: 'exploding tasks accessor',
  });
  assert.equal(captureFailed.actor, 'harness');
  // Fail-OPEN: the capture failure neither vetoed the wave nor added a failure terminal.
  assert.ok(!state.appended.some((e) => e.type === 'wave-failed'));
  assert.ok(state.appended.some((e) => e.type === 'pr-opened'));
});

// ── #119 durability: wave-started, attempt, fingerprint (Task 2.1) ──────────

/** Run a one-wave deliver with the given runWave/sh/extra ports. */
async function runOneWave({ plan = { waves: [{ n: 1 }] }, runWave, sh = () => ({ status: 0 }), ...extra }) {
  const state = makeFakeState({ gateResult: passingGate, plan });
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave,
    sh,
    now: fixedClock(),
    ...extra,
  });
  return { state, result };
}

test('(dur-a) AC#1 wave-started {wave, attempt} is appended immediately before each runWave', async () => {
  const typesAtRun = [];
  let state;
  let i = 0;
  const runWave = async () => {
    typesAtRun.push(state.appended.map((e) => e.type));
    i += 1;
    return i === 1 ? { outcome: 'fail-tests', summary: 'first' } : { outcome: 'success' };
  };
  state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  await deliverSpine({
    feature: 'demo', state, docs: {}, matrix: MATRIX, gates: {}, runWave,
    sh: () => ({ status: 0 }), now: fixedClock(),
  });
  // At each runWave call, the most recent event is that attempt's wave-started.
  assert.equal(typesAtRun.length, 2);
  for (const types of typesAtRun) assert.equal(types.at(-1), 'wave-started');
  const started = state.appended.filter((e) => e.type === 'wave-started');
  assert.deepEqual(started.map((e) => e.data), [{ wave: 1, attempt: 1 }, { wave: 1, attempt: 2 }]);
  assert.ok(started.every((e) => e.actor === 'harness' && !('model' in e.data)));
});

test('(dur-b) AC#1 model is recorded on wave-started only when the wave declares one', async () => {
  const { state } = await runOneWave({
    plan: { waves: [{ n: 1, model: 'claude-haiku-4-5' }, { n: 2 }] },
    runWave: async () => ({ outcome: 'success' }),
  });
  const started = state.appended.filter((e) => e.type === 'wave-started');
  assert.deepEqual(started.map((e) => e.data), [
    { wave: 1, attempt: 1, model: 'claude-haiku-4-5' },
    { wave: 2, attempt: 1 },
  ]);
});

test('(dur-c) AC#1 a pre-wave veto appends NO wave-started (the agent never ran)', async () => {
  const spy = makeVetoSpy({ point: 'pre-wave', outcome: 'fail-scope' });
  const { state, result } = await runOneWave({
    runWave: async () => ({ outcome: 'success' }),
    runHooks: spy.runHooks,
  });
  assert.equal(result.stopped, 'hook-veto');
  assert.ok(!state.appended.some((e) => e.type === 'wave-started'));
});

test('(dur-d) AC#2 every wave-attempt records attempt; retry/revision also records the doom-loop fingerprint', async () => {
  let i = 0;
  const failures = [
    { outcome: 'fail-tests', summary: 'first failure' },
    { outcome: 'fail-tests', summary: 'first failure' }, // identical → doom-loop
  ];
  const { state, result } = await runOneWave({ runWave: async () => failures[i++] });
  assert.equal(result.stopped, 'doom-loop');
  const attempts = state.appended.filter((e) => e.type === 'wave-attempt');
  assert.deepEqual(attempts.map((e) => e.data.attempt), [1, 2]);
  const expected = fingerprint(failures[0]);
  // The recorded digest IS the one the breaker compared: identical on both, and
  // equal to fingerprint() of the failing result.
  assert.deepEqual(attempts.map((e) => e.data.fingerprint), [expected, expected]);
});

test('(dur-e) AC#2 advance and terminal (abort/surface) attempts carry attempt but NO fingerprint key', async () => {
  const ok = await runOneWave({ runWave: async () => ({ outcome: 'success' }) });
  const aborted = await runOneWave({ runWave: async () => ({ outcome: 'fail-scope' }) });
  for (const { state } of [ok, aborted]) {
    const [attempt] = state.appended.filter((e) => e.type === 'wave-attempt');
    assert.equal(attempt.data.attempt, 1);
    assert.ok(!('fingerprint' in attempt.data), 'fingerprint must be absent, not undefined');
  }
});

test('(dur-f) AC#2 a post-wave veto attempt keeps its provenance keys alongside attempt', async () => {
  const spy = makeVetoSpy({ point: 'post-wave', outcome: 'fail-scope' });
  const { state } = await runOneWave({
    runWave: async () => ({ outcome: 'success' }),
    runHooks: spy.runHooks,
  });
  const [attempt] = state.appended.filter((e) => e.type === 'wave-attempt');
  assert.deepEqual(attempt.data, {
    wave: 1,
    attempt: 1,
    outcome: 'fail-scope',
    usage: undefined,
    source: 'hook',
    point: 'post-wave',
    hook: 'hooks/post-wave/01.sh',
  });
});

// ── wave-model-attribution: waveModels → wave-started.model (Task 1.1) ──────

test('(wm-a) AC#1 waveModels {1: model} → every wave-1 wave-started carries it, including the retry', async () => {
  let i = 0;
  const { state, result } = await runOneWave({
    runWave: async () => (i++ === 0 ? { outcome: 'fail-tests', summary: 'first' } : { outcome: 'success' }),
    waveModels: { 1: 'claude-haiku-4-5' },
  });
  assert.deepEqual(result, { ok: true, waves: 1 });
  const started = state.appended.filter((e) => e.type === 'wave-started');
  assert.deepEqual(started.map((e) => e.data), [
    { wave: 1, attempt: 1, model: 'claude-haiku-4-5' },
    { wave: 1, attempt: 2, model: 'claude-haiku-4-5' },
  ]);
});

test('(wm-b) AC#2 a wave absent from a NON-empty waveModels map records no model key', async () => {
  const { state } = await runOneWave({
    plan: twoWaves,
    runWave: async () => ({ outcome: 'success' }),
    waveModels: { 2: 'claude-opus-4-8' },
  });
  const [w1, w2] = state.appended.filter((e) => e.type === 'wave-started');
  assert.ok(!('model' in w1.data), 'wave 1 declared none → model key absent, not undefined');
  assert.equal(w2.data.model, 'claude-opus-4-8');
});

test('(wm-c) AC#2 waveModels omitted vs {} vs {1: ""} vs non-string → deep-equal sequences, no model key', async () => {
  const runWith = async (extra) =>
    (await runOneWave({ plan: twoWaves, runWave: async () => ({ outcome: 'success' }), ...extra })).state.appended;
  const omitted = await runWith({});
  const empty = await runWith({ waveModels: {} });
  const emptyString = await runWith({ waveModels: { 1: '' } });
  const nonString = await runWith({ waveModels: { 1: 42 } });
  assert.deepEqual(empty, omitted);
  assert.deepEqual(emptyString, omitted);
  assert.deepEqual(nonString, omitted);
  const started = omitted.filter((e) => e.type === 'wave-started');
  assert.equal(started.length, 2);
  assert.ok(started.every((e) => !('model' in e.data)));
});

// ── deliver-stop-contract: deliver-stopped at every terminal (#77, Task 1.2) ──

/** A fake state whose append enforces the real validateTransition, as the git
 * store does — so a sequence it accepts is a legal on-disk sequence. */
function makeValidatingState({ gateResult = passingGate, plan = { waves: [{ n: 1 }] } } = {}) {
  const state = makeFakeState({ gateResult, plan });
  const rawAppend = state.append;
  state.append = (event) => {
    validateTransition(event, { history: state.appended });
    rawAppend(event);
  };
  return state;
}

async function runStopped({ state = makeValidatingState(), runWave = async () => ({ outcome: 'success' }), sh = () => ({ status: 0 }), ...extra } = {}) {
  const result = await deliverSpine({
    feature: 'demo', state, docs: {}, matrix: MATRIX, gates: {}, runWave, sh, now: fixedClock(), ...extra,
  });
  return { state, result };
}

/** Assert the run ends with exactly one deliver-stopped, as the LAST event. */
function assertOneTrailingStop(state, expected) {
  const stops = state.appended.filter((e) => e.type === 'deliver-stopped');
  assert.equal(stops.length, 1, 'exactly one deliver-stopped');
  const last = state.appended[state.appended.length - 1];
  assert.equal(last.type, 'deliver-stopped', 'deliver-stopped is the last event');
  assert.equal(last.actor, 'harness');
  assert.equal(typeof last.ts, 'string');
  for (const [k, v] of Object.entries(expected)) assert.deepEqual(last.data[k], v, `data.${k}`);
  assert.equal(typeof last.data.decision, 'string');
  return last;
}

test('(stop-a) AC#2 every post-start terminal ends with exactly one classified deliver-stopped', async () => {
  const seededCompleted = () => {
    const s = makeValidatingState({ plan: { waves: [{ n: 1 }, { n: 2 }] } });
    s.appended.push({ feature: 'demo', type: 'deliver-started' }, { feature: 'demo', type: 'wave-complete', data: { wave: 1 } });
    return s;
  };
  const orphanState = () => {
    const s = makeValidatingState();
    s.appended.push({ feature: 'demo', type: 'deliver-started' }, { feature: 'demo', type: 'wave-started', data: { wave: 1, attempt: 1 } });
    return s;
  };
  let flip = 0;
  const cases = [
    { name: 'token-budget', args: { tokenBudget: 1, state: (() => { const s = makeValidatingState(); s.appended.push({ feature: 'demo', type: 'wave-attempt', data: { wave: 0, outcome: 'success', usage: { total: 5 } } }); return s; })() },
      expect: { class: 'needs-decision', reason: 'token-budget', wave: 1 } },
    { name: 'resume-verify', args: { state: seededCompleted(), sh: (s) => ({ status: s.endsWith('check-tests-present.sh') ? 1 : 0 }) },
      expect: { class: 'failed', reason: 'resume-verify' } },
    { name: 'orphan (matrix surface)', args: { state: orphanState() },
      expect: { class: 'needs-decision', reason: 'fail-timeout', wave: 1, action: 'surface', outcome: 'fail-timeout' } },
    { name: 'pre-wave hook-veto', args: { runHooks: makeVetoSpy({ point: 'pre-wave', outcome: 'abort-user' }).runHooks },
      expect: { class: 'failed', reason: 'abort-user', wave: 1, action: 'abort', outcome: 'abort-user' } },
    { name: 'doom-loop', args: { runWave: async () => ({ outcome: 'fail-tests', summary: 'same' }) },
      expect: { class: 'failed', reason: 'doom-loop', wave: 1, outcome: 'fail-tests' } },
    { name: 'matrix abort', args: { runWave: async () => ({ outcome: 'fail-scope' }) },
      expect: { class: 'failed', reason: 'fail-scope', wave: 1, action: 'abort', outcome: 'fail-scope' } },
    { name: 'matrix surface', args: { runWave: async () => ({ outcome: 'fail-timeout' }) },
      expect: { class: 'needs-decision', reason: 'fail-timeout', wave: 1, action: 'surface', outcome: 'fail-timeout' } },
    { name: 'budget', args: { maxAttempts: 2, runWave: async () => ({ outcome: 'fail-tests', summary: `s${flip++}` }) },
      expect: { class: 'failed', reason: 'budget', wave: 1 } },
    { name: 'post-check', args: { sh: failNthScope(2) },
      expect: { class: 'failed', reason: 'post-check' } },
  ];
  const seen = new Set();
  for (const c of cases) {
    const { state, result } = await runStopped(c.args);
    assert.equal(result.ok, false, c.name);
    seen.add(result.stopped);
    const stop = assertOneTrailingStop(state, c.expect);
    for (const key of ['wave', 'action', 'outcome']) {
      if (!(key in c.expect)) assert.ok(!(key in stop.data) || stop.data[key] === result[key], `${c.name}: ${key}`);
    }
  }
  // Every post-start `stopped` value the spine can return today is covered.
  assert.deepEqual([...seen].sort(), ['budget', 'doom-loop', 'hook-veto', 'matrix', 'post-check', 'resume-verify', 'token-budget']);
});

test('(stop-b) AC#2 deliver-stopped data carries class/reason/decision and only the known wave/action/outcome', async () => {
  const { state } = await runStopped({ sh: (s) => ({ status: s.endsWith('open-pr.sh') ? 3 : 0 }) });
  const stop = assertOneTrailingStop(state, { class: 'failed', reason: 'post-check' });
  assert.deepEqual(stop.data, { class: 'failed', reason: 'post-check', decision: 'post-check open-pr.sh exited 3' });
});

test('(stop-c) AC#2 pre-start gate stop appends nothing', async () => {
  const { state, result } = await runStopped({ state: makeValidatingState({ gateResult: blockedGate }) });
  assert.equal(result.stopped, 'gate');
  assert.deepEqual(state.appended, []);
});

test('(stop-d) AC#2 success appends no deliver-stopped and keeps the pre-existing sequence', async () => {
  const { state, result } = await runStopped({ state: makeValidatingState({ plan: twoWaves }) });
  assert.deepEqual(result, { ok: true, waves: 2 });
  assert.ok(!state.appended.some((e) => e.type === 'deliver-stopped'));
  assert.deepEqual(state.appended.map((e) => e.type), [
    'deliver-started', 'wave-started', 'wave-attempt', 'wave-complete',
    'wave-started', 'wave-attempt', 'wave-complete', 'pr-opened',
  ]);
});

test('(stop-e) AC#2 deliver-stopped establishes no phase; a re-run may append after it', async () => {
  const state = makeValidatingState();
  const first = await runStopped({ state, runWave: async () => ({ outcome: 'fail-scope' }) });
  assert.equal(first.result.stopped, 'matrix');
  const before = state.appended.slice(0, -1);
  assert.equal(phaseOf(state.appended), phaseOf(before), 'deliver-stopped moves no phase');
  // The re-run appends deliver-started etc. through the validating append — legal.
  const second = await runStopped({ state });
  assert.deepEqual(second.result, { ok: true, waves: 1 });
  assert.equal(state.appended[state.appended.length - 1].type, 'pr-opened');
});

test('(stop-f) an unclassifiable terminal throws out of the spine (never swallowed)', async () => {
  await assert.rejects(
    runStopped({ runWave: async () => ({ outcome: 'fail-timeout' }), matrix: { ...MATRIX, implement: { ...MATRIX.implement, 'fail-timeout': { action: 'escalate' } } } }),
    /classifyStop: unknown action/,
  );
});

// ── deliver-stop-contract: between-wave approval re-check (#77, Task 2.1) ──

/** A validating state whose `approved` gate passes for the first `passes`
 * calls, then fails — i.e. approval is revoked mid-run. */
function makeRevokingState({ passes, plan = twoWaves }) {
  const state = makeValidatingState({ plan });
  let calls = 0;
  state.gate = async () => {
    calls += 1;
    return calls <= passes ? passingGate : { passed: false, reason: 'plan fingerprint changed', satisfiedBy: null };
  };
  return state;
}

/** An approvalIntact port that is intact on its first call (the pre-wave-1
 * check), then delegates to `later` — i.e. the approval changes before wave 2. */
function intactOnlyOnFirstCall(later) {
  let calls = 0;
  return () => {
    calls += 1;
    return calls === 1 ? { ok: true } : later();
  };
}

function wave2Started(state) {
  return state.appended.some((e) => e.type === 'wave-started' && e.data.wave === 2);
}

test('(ac-a) AC#3 gate flips to failed before wave 2 → approval-changed, no wave-2 wave-started', async () => {
  // passes: entry gate + the pre-wave-1 re-check; the pre-wave-2 re-check fails.
  const { state, result } = await runStopped({ state: makeRevokingState({ passes: 2 }) });
  assert.equal(result.stopped, 'approval-changed');
  assert.equal(result.ok, false);
  assert.equal(result.wave, 2);
  assert.match(result.reason, /plan fingerprint changed/);
  assert.ok(!wave2Started(state), 'wave 2 never started');
  assertOneTrailingStop(state, { class: 'needs-decision', reason: 'approval-changed', wave: 2 });
});

test('(ac-b) AC#3 approvalIntact {ok:false} → approval-changed with its reason, no wave-2 wave-started', async () => {
  const { state, result } = await runStopped({
    state: makeValidatingState({ plan: twoWaves }),
    approvalIntact: intactOnlyOnFirstCall(() => ({ ok: false, reason: 'plan edited after approval' })),
  });
  assert.equal(result.stopped, 'approval-changed');
  assert.match(result.reason, /plan edited after approval/);
  assert.ok(!wave2Started(state));
  assertOneTrailingStop(state, { class: 'needs-decision', reason: 'approval-changed', wave: 2 });
});

test('(ac-c) AC#3 a throwing approvalIntact is NOT intact (fail-closed), message kept in reason', async () => {
  const { state, result } = await runStopped({
    state: makeValidatingState({ plan: twoWaves }),
    approvalIntact: intactOnlyOnFirstCall(() => {
      throw new Error('cannot read plan doc');
    }),
  });
  assert.equal(result.stopped, 'approval-changed');
  assert.match(result.reason, /cannot read plan doc/);
  assert.ok(!wave2Started(state));
  assertOneTrailingStop(state, { class: 'needs-decision', reason: 'approval-changed', wave: 2 });
});

test('(ac-d) AC#3 non-object / missing-ok approvalIntact results are not intact', async () => {
  for (const bad of [undefined, null, {}, { ok: 'yes' }]) {
    const { result } = await runStopped({ state: makeValidatingState({ plan: twoWaves }), approvalIntact: () => bad });
    assert.equal(result.stopped, 'approval-changed', JSON.stringify(bad));
  }
});

test('(ac-e) AC#3 default port → event sequence deep-equal to an explicit always-intact port', async () => {
  const baseline = await runStopped({ state: makeValidatingState({ plan: twoWaves }) });
  const explicit = await runStopped({ state: makeValidatingState({ plan: twoWaves }), approvalIntact: () => ({ ok: true }) });
  assert.deepEqual(baseline.result, { ok: true, waves: 2 });
  assert.deepEqual(explicit.state.appended, baseline.state.appended);
});

test('(ac-f) AC#3 a single-wave plan calls approvalIntact exactly once (before wave 1) and completes when ok', async () => {
  let portCalls = 0;
  const state = makeValidatingState({ plan: { waves: [{ n: 1 }] } });
  const { result } = await runStopped({ state, approvalIntact: () => { portCalls += 1; return { ok: true }; } });
  assert.deepEqual(result, { ok: true, waves: 1 });
  assert.equal(portCalls, 1);
});

test('(ac-g) AC#3 a resumed run checks approval before its first executed wave', async () => {
  const state = makeValidatingState({ plan: twoWaves });
  state.appended.push({ feature: 'demo', type: 'deliver-started' }, { feature: 'demo', type: 'wave-complete', data: { wave: 1 } });
  let portCalls = 0;
  const { result } = await runStopped({ state, approvalIntact: () => { portCalls += 1; return { ok: false, reason: 'plan edited after approval' }; } });
  assert.equal(result.stopped, 'approval-changed');
  assert.equal(result.wave, 2);
  assert.equal(portCalls, 1);
  assert.ok(!wave2Started(state), 'the remaining wave never started');
  assertOneTrailingStop(state, { class: 'needs-decision', reason: 'approval-changed', wave: 2 });
});

test('(ac-h) AC#3 approvalIntact {ok:false} on a fresh run → approval-changed before wave 1, no agent runs', async () => {
  let runWaveCalls = 0;
  const { state, result } = await runStopped({
    state: makeValidatingState({ plan: twoWaves }),
    approvalIntact: () => ({ ok: false, reason: 'plan edited after approval' }),
    runWave: async () => { runWaveCalls += 1; return { outcome: 'success' }; },
  });
  assert.equal(result.stopped, 'approval-changed');
  assert.equal(result.wave, 1);
  assert.match(result.reason, /plan edited after approval/);
  assert.equal(runWaveCalls, 0, 'runWave never called');
  assert.ok(!state.appended.some((e) => e.type === 'wave-started'), 'no wave-started');
  assertOneTrailingStop(state, { class: 'needs-decision', reason: 'approval-changed', wave: 1 });
});

// ── deliver-stop-contract: between-wave scope check (#77, Task 2.2) ──

/** An sh spy: records every (script, arg); `status(script, arg)` scripts the exit. */
function makeShSpy(status = () => 0) {
  const calls = [];
  const sh = (script, arg) => {
    calls.push({ script, arg });
    return { status: status(script, arg), stdout: `${script} out` };
  };
  return { sh, calls };
}

test('(sc-a) AC#4 scope fails after wave 1 → fail-scope recorded, matrix abort, failed, wave 2 never runs', async () => {
  const spy = makeShSpy((s) => (s === 'scripts/check-scope.sh' ? 1 : 0));
  let runs = 0;
  const { state, result } = await runStopped({
    state: makeValidatingState({ plan: twoWaves }),
    runWave: async () => { runs += 1; return { outcome: 'success' }; },
    sh: spy.sh,
  });
  assert.deepEqual(result, { stopped: 'matrix', ok: false, wave: 1, action: 'abort', outcome: 'fail-scope' });
  assert.equal(runs, 1, 'wave 2 never ran');
  const attempt = state.appended.find((e) => e.type === 'wave-attempt');
  assert.equal(attempt.data.outcome, 'fail-scope');
  assert.ok(!state.appended.some((e) => e.type === 'wave-complete'));
  assert.ok(!wave2Started(state));
  assertOneTrailingStop(state, { class: 'failed', reason: 'fail-scope', wave: 1, action: 'abort', outcome: 'fail-scope' });
  // The scope gate ran after the presence gate, with the same call shape as the end post-check.
  assert.deepEqual(spy.calls, [
    { script: 'scripts/check-tests-present.sh', arg: 'demo' },
    { script: 'scripts/check-scope.sh', arg: 'demo' },
  ]);
});

test('(sc-b) AC#4 scope passes → events deep-equal to baseline; only the sh spy sees the extra calls', async () => {
  const spy = makeShSpy();
  const withScope = await runStopped({ state: makeValidatingState({ plan: twoWaves }), sh: spy.sh });
  const baseline = await runStopped({ state: makeValidatingState({ plan: twoWaves }) });
  assert.deepEqual(withScope.result, { ok: true, waves: 2 });
  assert.deepEqual(withScope.state.appended, baseline.state.appended);
  assert.deepEqual(withScope.state.appended.map((e) => e.type), [
    'deliver-started', 'wave-started', 'wave-attempt', 'wave-complete',
    'wave-started', 'wave-attempt', 'wave-complete', 'pr-opened',
  ]);
  // Two per-wave scope calls + the retained end post-check.
  assert.equal(spy.calls.filter((c) => c.script === 'scripts/check-scope.sh').length, 3);
});

test('(sc-c) AC#4 scope check is not called after a failed attempt (retry then success calls it once)', async () => {
  const spy = makeShSpy();
  let i = 0;
  const { result } = await runStopped({
    runWave: async () => (i++ === 0 ? { outcome: 'fail-tests', summary: 'first' } : { outcome: 'success' }),
    sh: spy.sh,
  });
  assert.deepEqual(result, { ok: true, waves: 1 });
  const order = spy.calls.map((c) => c.script);
  // attempt 1 failed: no gate calls; attempt 2: presence + scope; then end post-checks.
  assert.deepEqual(order, [
    'scripts/check-tests-present.sh', 'scripts/check-scope.sh', 'scripts/check-scope.sh', 'scripts/open-pr.sh',
  ]);
});

test('(sc-d) AC#4 scope is not run when the presence gate or a declared Verify demoted the attempt', async () => {
  const presence = makeShSpy((s) => (s === 'scripts/check-tests-present.sh' ? 1 : 0));
  await runStopped({ sh: presence.sh, maxAttempts: 1 });
  assert.ok(!presence.calls.some((c) => c.script === 'scripts/check-scope.sh'));

  const verify = makeShSpy((s) => (s === 'scripts/check-verify.sh' ? 1 : 0));
  await runStopped({ sh: verify.sh, maxAttempts: 1, waveVerify: { 1: 'npm test' } });
  assert.ok(!verify.calls.some((c) => c.script === 'scripts/check-scope.sh'));
});

test('(sc-e) AC#4 scope runs AFTER a declared Verify passes, and its failure still demotes', async () => {
  const spy = makeShSpy((s) => (s === 'scripts/check-scope.sh' ? 2 : 0));
  const { state, result } = await runStopped({ sh: spy.sh, waveVerify: { 1: 'npm test' } });
  assert.equal(result.outcome, 'fail-scope');
  assert.deepEqual(spy.calls.map((c) => c.script), [
    'scripts/check-tests-present.sh', 'scripts/check-verify.sh', 'scripts/check-scope.sh',
  ]);
  const attempt = state.appended.find((e) => e.type === 'wave-attempt');
  assert.deepEqual(attempt.data.verify, { command: 'npm test', status: 0, passed: true });
  assert.equal(attempt.data.outcome, 'fail-scope');
});

// ── deliver-stop-contract: cumulative failed-attempt cap (#77, Task 2.3) ──

test('(cap-a) AC#5 failedAttemptsSinceStop counts non-success attempts across waves, reset by deliver-stopped', () => {
  const attempt = (wave, outcome) => ({ type: 'wave-attempt', data: { wave, outcome } });
  assert.equal(failedAttemptsSinceStop([]), 0);
  assert.equal(failedAttemptsSinceStop([attempt(1, 'fail-tests'), attempt(1, 'success'), attempt(2, 'fail-scope')]), 2);
  assert.equal(failedAttemptsSinceStop([attempt(1, 'fail-tests'), { type: 'deliver-stopped', data: {} }, attempt(2, 'fail-tests')]), 1);
  assert.equal(failedAttemptsSinceStop([attempt(1, 'fail-tests'), { type: 'deliver-stopped', data: {} }]), 0);
  assert.equal(failedAttemptsSinceStop([{ type: 'wave-started', data: { wave: 1 } }, attempt(1, 'success')]), 0);
});

test('(cap-b) AC#5 cap 2 → two failing attempts stop before the third (no third wave-started)', async () => {
  let n = 0;
  const { state, result } = await runStopped({
    maxFailedAttempts: 2,
    runWave: async () => ({ outcome: 'fail-tests', summary: `s${n++}` }),
  });
  assert.deepEqual(result, { stopped: 'failed-attempt-cap', ok: false, wave: 1, failed: 2, cap: 2 });
  assert.equal(n, 2, 'runWave called exactly twice');
  assert.equal(state.appended.filter((e) => e.type === 'wave-started').length, 2);
  const stop = assertOneTrailingStop(state, { class: 'needs-decision', reason: 'failed-attempt-cap', wave: 1 });
  assert.match(stop.data.decision, /2 failed attempts reached RAD_MAX_FAILED_ATTEMPTS=2/);
});

test('(cap-c) AC#5 the cap counts across waves, not per wave', async () => {
  // Each wave fails once then succeeds: 1 failure in wave 1 + 1 in wave 2 = 2 → stop before wave 2's retry.
  const calls = { 1: 0, 2: 0 };
  const { result } = await runStopped({
    state: makeValidatingState({ plan: twoWaves }),
    maxFailedAttempts: 2,
    runWave: async (wave) => (calls[wave.n]++ === 0 ? { outcome: 'fail-tests', summary: `w${wave.n}` } : { outcome: 'success' }),
  });
  assert.deepEqual(result, { stopped: 'failed-attempt-cap', ok: false, wave: 2, failed: 2, cap: 2 });
  assert.deepEqual(calls, { 1: 2, 2: 1 });
});

test('(cap-d) AC#5 a prior deliver-stopped resets the count (a re-run gets a fresh budget)', async () => {
  const state = makeValidatingState();
  state.appended.push(
    { feature: 'demo', type: 'deliver-started' },
    { feature: 'demo', type: 'wave-attempt', data: { wave: 1, attempt: 1, outcome: 'fail-tests' } },
    { feature: 'demo', type: 'wave-attempt', data: { wave: 1, attempt: 2, outcome: 'fail-tests' } },
    { feature: 'demo', type: 'wave-failed', data: { wave: 1, reason: 'budget-exhausted' } },
    { feature: 'demo', type: 'deliver-stopped', data: { class: 'failed', reason: 'budget', decision: 'x' } },
  );
  const { result } = await runStopped({ state, maxFailedAttempts: 2 });
  assert.deepEqual(result, { ok: true, waves: 1 });

  // Without the reset (no deliver-stopped), the same history is already at the cap.
  const unreset = makeValidatingState();
  unreset.appended.push(
    { feature: 'demo', type: 'deliver-started' },
    { feature: 'demo', type: 'wave-attempt', data: { wave: 1, attempt: 1, outcome: 'fail-tests' } },
    { feature: 'demo', type: 'wave-attempt', data: { wave: 1, attempt: 2, outcome: 'fail-tests' } },
  );
  const capped = await runStopped({ state: unreset, maxFailedAttempts: 2, maxAttempts: 5 });
  assert.equal(capped.result.stopped, 'failed-attempt-cap');
});

test('(cap-e) AC#5 null/off (and non-positive / non-integer) → deep-equal to baseline', async () => {
  const run = async (extra) => {
    let n = 0;
    return (await runStopped({ runWave: async () => (n++ < 2 ? { outcome: 'fail-tests', summary: `s${n}` } : { outcome: 'success' }), ...extra })).state.appended;
  };
  const baseline = await run({});
  assert.equal(baseline[baseline.length - 1].type, 'pr-opened');
  for (const off of [null, 0, -1, 1.5, '2']) {
    assert.deepEqual(await run({ maxFailedAttempts: off }), baseline, `maxFailedAttempts=${JSON.stringify(off)}`);
  }
});

test('(cap-f) AC#5 success attempts are not counted', async () => {
  const { result } = await runStopped({
    state: makeValidatingState({ plan: { waves: [{ n: 1 }, { n: 2 }, { n: 3 }] } }),
    maxFailedAttempts: 1,
  });
  assert.deepEqual(result, { ok: true, waves: 3 });
});

// ── resume-with-operator-context: spine resume param (Task 2.1) ──

const RESUME_CONTEXT = '  \n`npm test` was flaky; I fixed `harness/foo.js` by hand.\n\t ';
const RESUME_STOP = { class: 'needs-decision', reason: 'failed-attempt-cap', decision: 'raise the cap or fix', wave: 1 };
const RESUME = { context: RESUME_CONTEXT, recordedBy: 'sean@torchcodelab.com', stop: RESUME_STOP };

/** A runWave that records every attemptCtx it is handed, answering from `outcomes` (default success). */
function capturingRunWave(outcomes = []) {
  const calls = [];
  const runWave = async (wave, ctx) => {
    calls.push({ wave: wave.n, ctx });
    return { outcome: outcomes[calls.length - 1] || 'success', summary: `s${calls.length}` };
  };
  return { calls, runWave };
}

test('(resume-a) AC#1 resume set → run-resumed directly after deliver-started, context byte-for-byte', async () => {
  const { state, result } = await runStopped({ resume: RESUME });
  assert.deepEqual(result, { ok: true, waves: 1 });
  const types = state.appended.map((e) => e.type);
  const i = types.indexOf('deliver-started');
  assert.equal(types[i + 1], 'run-resumed');
  const ev = state.appended[i + 1];
  assert.equal(ev.actor, 'harness');
  assert.equal(ev.recordedBy, RESUME.recordedBy);
  assert.equal(typeof ev.ts, 'string');
  assert.deepEqual(ev.data, {
    context: RESUME_CONTEXT,
    recordedBy: RESUME.recordedBy,
    stop: { class: 'needs-decision', reason: 'failed-attempt-cap', wave: 1 },
  });
  assert.equal(ev.data.context, RESUME_CONTEXT);
});

test('(resume-b) AC#1 a stop with no wave records no wave key on run-resumed', async () => {
  const stop = { class: 'failed', reason: 'resume-verify', decision: 'x' };
  const { state } = await runStopped({ resume: { ...RESUME, stop } });
  const ev = state.appended.find((e) => e.type === 'run-resumed');
  assert.deepEqual(ev.data.stop, { class: 'failed', reason: 'resume-verify' });
  assert.equal('wave' in ev.data.stop, false);
});

test('(resume-c) AC#3 only the first runWave call carries operatorContext (not the retry, not the next wave)', async () => {
  const { calls, runWave } = capturingRunWave(['fail-tests', 'success', 'success']);
  const { result } = await runStopped({ state: makeValidatingState({ plan: twoWaves }), runWave, resume: RESUME });
  assert.deepEqual(result, { ok: true, waves: 2 });
  assert.deepEqual(calls.map((c) => [c.wave, c.ctx.attempt]), [[1, 1], [1, 2], [2, 1]]);
  assert.deepEqual(calls[0].ctx.operatorContext, { context: RESUME_CONTEXT, stop: RESUME_STOP });
  assert.equal('operatorContext' in calls[1].ctx, false, 'retry omits the key');
  assert.equal('operatorContext' in calls[2].ctx, false, 'next wave omits the key');
});

test('(resume-d) AC#3 completed waves skipped → operatorContext on the first non-completed wave', async () => {
  const state = makeValidatingState({ plan: twoWaves });
  state.appended.push(
    { feature: 'demo', type: 'deliver-started' },
    { feature: 'demo', type: 'wave-complete', data: { wave: 1 } },
    { feature: 'demo', type: 'deliver-stopped', data: { class: 'failed', reason: 'budget', decision: 'x' } },
  );
  const { calls, runWave } = capturingRunWave();
  const { result } = await runStopped({ state, runWave, resume: RESUME });
  assert.deepEqual(result, { ok: true, waves: 2 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].wave, 2);
  assert.deepEqual(calls[0].ctx.operatorContext, { context: RESUME_CONTEXT, stop: RESUME_STOP });
});

test('(resume-e) AC#5 unapproved gate with resume set → gate stop, no run-resumed', async () => {
  const { calls, runWave } = capturingRunWave();
  const { state, result } = await runStopped({ state: makeValidatingState({ gateResult: blockedGate }), runWave, resume: RESUME });
  assert.equal(result.stopped, 'gate');
  assert.equal(calls.length, 0);
  assert.equal(state.appended.some((e) => e.type === 'run-resumed'), false);
  assert.deepEqual(state.appended, []);
});

test('(resume-f) AC#6 resuming a failed-attempt-cap stop does not re-trip the cap immediately', async () => {
  const state = makeValidatingState();
  state.appended.push(
    { feature: 'demo', type: 'deliver-started' },
    { feature: 'demo', type: 'wave-attempt', data: { wave: 1, attempt: 1, outcome: 'fail-tests' } },
    { feature: 'demo', type: 'wave-attempt', data: { wave: 1, attempt: 2, outcome: 'fail-tests' } },
    { feature: 'demo', type: 'deliver-stopped', data: { class: 'needs-decision', reason: 'failed-attempt-cap', decision: 'x', wave: 1 } },
  );
  const { calls, runWave } = capturingRunWave();
  const { result } = await runStopped({ state, runWave, maxFailedAttempts: 2, maxAttempts: 5, resume: RESUME });
  assert.deepEqual(result, { ok: true, waves: 1 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].ctx.operatorContext, { context: RESUME_CONTEXT, stop: RESUME_STOP });
});

test('(resume-g) AC#7 resume null/absent → event sequence and attemptCtx deep-equal the run without the param', async () => {
  const run = async (extra) => {
    const { calls, runWave } = capturingRunWave(['fail-tests', 'success', 'success']);
    const { state } = await runStopped({ state: makeValidatingState({ plan: twoWaves }), runWave, ...extra });
    return { events: state.appended, ctxs: calls.map((c) => c.ctx) };
  };
  const baseline = await run({});
  assert.deepEqual(await run({ resume: null }), baseline);
  assert.deepEqual(await run({ resume: undefined }), baseline);
  for (const ctx of baseline.ctxs) assert.equal('operatorContext' in ctx, false);
});

// ── adversarial-gate-evals: spine push guard (Task 1.2) ──

const TIP_A = 'a'.repeat(40);
const TIP_B = 'b'.repeat(40);

/** An sh fake answering default-tip.sh reads from `tips` in order (each
 * `{ status, stdout }`); every other script passes. Records every script name. */
function tipSh(tips) {
  const calls = [];
  let reads = 0;
  const sh = (script) => {
    calls.push(script);
    if (script !== 'scripts/default-tip.sh') return { status: 0 };
    const tip = tips[reads] ?? tips[tips.length - 1];
    reads += 1;
    return tip;
  };
  return { calls, sh };
}

const tipOk = (sha) => ({ status: 0, stdout: `${sha}\n` });

test('(push-a) AC#3 tip moved during the wave → attempt demoted to fail-protocol, run stops abort', async () => {
  const { sh } = tipSh([tipOk(TIP_A), tipOk(TIP_B)]);
  const { state, result } = await runStopped({ sh, pushGuard: true });
  assert.equal(result.ok, false);
  const attempts = state.appended.filter((e) => e.type === 'wave-attempt');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].data.outcome, 'fail-protocol');
  const failed = state.appended.find((e) => e.type === 'wave-failed');
  assert.equal(failed.data.action, 'abort');
  assertOneTrailingStop(state, { outcome: 'fail-protocol', action: 'abort' });
  assert.equal(state.appended.some((e) => e.type === 'wave-complete'), false);
});

test('(push-b) AC#3 tip moved on a FAILING attempt → still fail-protocol (regardless of outcome)', async () => {
  const { sh } = tipSh([tipOk(TIP_A), tipOk(TIP_B)]);
  const runWave = async () => ({ outcome: 'fail-tests' });
  const { state } = await runStopped({ sh, runWave, pushGuard: true });
  const attempt = state.appended.find((e) => e.type === 'wave-attempt');
  assert.equal(attempt.data.outcome, 'fail-protocol');
  assertOneTrailingStop(state, { outcome: 'fail-protocol' });
});

test('(push-c) AC#3 push-guard overrides a scope demotion', async () => {
  const { sh: tips } = tipSh([tipOk(TIP_A), tipOk(TIP_B)]);
  const sh = (script, feature) => (script.endsWith('check-scope.sh') ? { status: 1 } : tips(script, feature));
  const { state } = await runStopped({ sh, pushGuard: true });
  const attempt = state.appended.find((e) => e.type === 'wave-attempt');
  assert.equal(attempt.data.outcome, 'fail-protocol');
});

test('(push-d) AC#3 tip unchanged (trailing whitespace ignored) → no extra event, normal flow', async () => {
  const { calls, sh } = tipSh([tipOk(TIP_A), { status: 0, stdout: `  ${TIP_A}  ` }]);
  const { state, result } = await runStopped({ sh, pushGuard: true });
  assert.deepEqual(result, { ok: true, waves: 1 });
  const { state: baseline } = await runStopped();
  assert.deepEqual(state.appended, baseline.appended);
  assert.deepEqual(calls.slice(0, 2), ['scripts/default-tip.sh', 'scripts/default-tip.sh']);
});

for (const [label, tips, status] of [
  ['before', [{ status: 3, stdout: '' }, tipOk(TIP_B)], 3],
  ['after', [tipOk(TIP_A), { status: 2, stdout: '' }], 2],
]) {
  test(`(push-e-${label}) AC#4 ${label} read fails → push-check-unavailable with status, no demotion`, async () => {
    const { sh } = tipSh(tips);
    const { state, result } = await runStopped({ sh, pushGuard: true });
    assert.deepEqual(result, { ok: true, waves: 1 });
    const unavailable = state.appended.filter((e) => e.type === 'push-check-unavailable');
    assert.equal(unavailable.length, 1);
    assert.equal(unavailable[0].actor, 'harness');
    assert.equal(typeof unavailable[0].ts, 'string');
    assert.deepEqual(unavailable[0].data, { wave: 1, attempt: 1, status });
    assert.equal(state.appended.find((e) => e.type === 'wave-attempt').data.outcome, 'success');
    assert.equal(phaseOf(state.appended), phaseOf(state.appended.filter((e) => e.type !== 'push-check-unavailable')));
  });
}

test('(push-f) AC#4 pushGuard false/absent → default-tip.sh never invoked, sequence identical', async () => {
  const run = async (extra) => {
    const { calls, sh } = tipSh([tipOk(TIP_A), tipOk(TIP_B)]);
    const runWave = capturingRunWave(['fail-tests', 'success', 'success']).runWave;
    const { state } = await runStopped({ state: makeValidatingState({ plan: twoWaves }), runWave, sh, ...extra });
    return { events: state.appended, calls };
  };
  const baseline = await run({});
  assert.equal(baseline.calls.includes('scripts/default-tip.sh'), false);
  const off = await run({ pushGuard: false });
  assert.deepEqual(off, baseline);
});

// ── run-scoped-approval-freeze: an approval cannot change within a run (#158) ──

const DURING_RUN = /an approved event was recorded during this run/;
const AGENT_APPROVAL = { feature: 'demo', type: 'approved', actor: 'architect', ts: 't' };

/** A runWave that, during wave `atWave`, records an `approved` event straight
 * into the log (as an agent running `cli.js approve` would — bypassing the spine). */
function approvingRunWave(state, atWave) {
  const calls = [];
  const runWave = async (wave) => {
    calls.push(wave.n);
    if (wave.n === atWave) state.appended.push({ ...AGENT_APPROVAL });
    return { outcome: 'success' };
  };
  return { calls, runWave };
}

test('(freeze-a) AC#1 approval recorded during wave 1 → approval-changed before wave 2, runWave not called again', async () => {
  const state = makeValidatingState({ plan: twoWaves });
  const { calls, runWave } = approvingRunWave(state, 1);
  const { result } = await runStopped({ state, runWave });
  assert.equal(result.stopped, 'approval-changed');
  assert.equal(result.ok, false);
  assert.equal(result.wave, 2);
  assert.match(result.reason, DURING_RUN);
  assert.deepEqual(calls, [1]);
  assert.ok(!wave2Started(state), 'wave 2 never started');
  assert.ok(state.appended.some((e) => e.type === 'approved'), 'the agent approval stays as evidence');
  assertOneTrailingStop(state, { class: 'needs-decision', reason: 'approval-changed', wave: 2 });
});

test('(freeze-b) AC#2 approval recorded during the last wave → approval-changed, no post-check, no pr-opened', async () => {
  const state = makeValidatingState();
  const { runWave } = approvingRunWave(state, 1);
  const shCalls = [];
  let portCalls = 0;
  const { result } = await runStopped({
    state,
    runWave,
    sh: (script) => { shCalls.push(script); return { status: 0 }; },
    approvalIntact: () => { portCalls += 1; return { ok: true }; },
  });
  assert.equal(result.stopped, 'approval-changed');
  assert.match(result.reason, DURING_RUN);
  assert.equal(portCalls, 1, 'the post-loop check does not call the approvalIntact port');
  // The per-wave scope gate also calls check-scope.sh, so compare against a
  // baseline: the stopped run makes exactly the baseline's calls minus POST_CHECKS.
  const baselineCalls = [];
  await runStopped({ sh: (script) => { baselineCalls.push(script); return { status: 0 }; } });
  assert.deepEqual(baselineCalls.slice(-2), ['scripts/check-scope.sh', 'scripts/open-pr.sh']);
  assert.deepEqual(shCalls, baselineCalls.slice(0, -2), 'no post-check ran');
  assert.ok(!state.appended.some((e) => e.type === 'pr-opened'));
  assertOneTrailingStop(state, { class: 'needs-decision', reason: 'approval-changed', wave: 1 });
});

test('(freeze-c) AC#3 approval before deliver-started (re-approval between runs) → no stop', async () => {
  const state = makeValidatingState({ plan: twoWaves });
  state.appended.push({ ...AGENT_APPROVAL }, { ...AGENT_APPROVAL });
  const { result } = await runStopped({ state });
  assert.deepEqual(result, { ok: true, waves: 2 });
});

test('(freeze-d) AC#4 no mid-run approval → event sequence identical to baseline', async () => {
  const baseline = await runStopped({ state: makeValidatingState({ plan: twoWaves }) });
  const again = await runStopped({ state: makeValidatingState({ plan: twoWaves }), runWave: approvingRunWave(null, 99).runWave });
  assert.deepEqual(baseline.result, { ok: true, waves: 2 });
  assert.deepEqual(again.state.appended, baseline.state.appended);
  assert.equal(baseline.state.appended[baseline.state.appended.length - 1].type, 'pr-opened');
});

test('(freeze-e) approvedDuringRun: non-array / empty / no deliver-started → []', () => {
  for (const bad of [undefined, null, 'x', 42, {}, []]) assert.deepEqual(approvedDuringRun(bad), [], String(bad));
  assert.deepEqual(approvedDuringRun([{ type: 'approved' }]), [], 'no deliver-started → none are in-run');
  assert.deepEqual(approvedDuringRun([null, { type: 'deliver-started' }, undefined, 7]), []);
});

test('(freeze-f) approvedDuringRun: a resumed run counts only approvals after the LATEST deliver-started', () => {
  const late = { type: 'approved', ts: 'late' };
  const history = [
    { type: 'approved', ts: 'first' },
    { type: 'deliver-started' },
    { type: 'approved', ts: 'mid' },
    { type: 'deliver-stopped' },
    { type: 'deliver-started' },
    { type: 'wave-started' },
    late,
  ];
  assert.deepEqual(approvedDuringRun(history), [late]);
  assert.deepEqual(approvedDuringRun(history.slice(0, 6)), []);
});

// ── #161: the spine's free-text stop reason reaches deliver-stopped as `detail` ──

const APPROVED_DURING_RUN_TEXT =
  'an approved event was recorded during this run (re-approval must happen between runs, not within one)';

test('(detail-a) AC#6 approvalIntact {ok:false, reason} → deliver-stopped data.detail carries that reason', async () => {
  const { state, result } = await runStopped({
    state: makeValidatingState({ plan: twoWaves }),
    approvalIntact: intactOnlyOnFirstCall(() => ({ ok: false, reason: 'x' })),
  });
  assert.equal(result.stopped, 'approval-changed');
  const stop = assertOneTrailingStop(state, { class: 'needs-decision', reason: 'approval-changed', wave: 2 });
  assert.equal(typeof stop.data.detail, 'string');
  assert.match(stop.data.detail, /x/);
  assert.equal(stop.data.detail, result.reason, 'detail is the result reason, verbatim');
});

test('(detail-b) AC#6 approval recorded during a run → detail equals the approved-during-run reason', async () => {
  // Between-wave path (stop before wave 2) and post-loop path (single wave).
  const between = makeValidatingState({ plan: twoWaves });
  await runStopped({ state: between, runWave: approvingRunWave(between, 1).runWave });
  const lastWave = makeValidatingState();
  await runStopped({ state: lastWave, runWave: approvingRunWave(lastWave, 1).runWave });
  for (const state of [between, lastWave]) {
    const stop = assertOneTrailingStop(state, { class: 'needs-decision', reason: 'approval-changed' });
    assert.equal(stop.data.detail, APPROVED_DURING_RUN_TEXT);
  }
});

test('(detail-c) AC#7 stops without a free-text reason append no `detail` key', async () => {
  let n = 0;
  const capped = await runStopped({
    maxFailedAttempts: 2,
    runWave: async () => ({ outcome: 'fail-tests', summary: `s${n++}` }),
  });
  const capStop = assertOneTrailingStop(capped.state, { reason: 'failed-attempt-cap' });
  assert.ok(!Object.hasOwn(capStop.data, 'detail'), 'failed-attempt-cap carries no detail');
  const budgetState = makeValidatingState();
  budgetState.appended.push({ feature: 'demo', type: 'wave-attempt', data: { wave: 0, outcome: 'success', usage: { total: 5 } } });
  const budget = await runStopped({ state: budgetState, tokenBudget: 1 });
  const budgetStop = assertOneTrailingStop(budget.state, { reason: 'token-budget' });
  assert.ok(!Object.hasOwn(budgetStop.data, 'detail'), 'token-budget carries no detail');
});

// ── capability-classes (#85): waveCapabilities → wave-started.capabilities ──

test('(capcls-a) AC#7 a constrained wave records its effective classes on every wave-started, including the retry', async () => {
  let i = 0;
  const { state, result } = await runOneWave({
    runWave: async () => (i++ === 0 ? { outcome: 'fail-tests', summary: 'first' } : { outcome: 'success' }),
    waveCapabilities: { 1: ['fs_read', 'net'] },
  });
  assert.deepEqual(result, { ok: true, waves: 1 });
  const started = state.appended.filter((e) => e.type === 'wave-started');
  assert.deepEqual(started.map((e) => e.data), [
    { wave: 1, attempt: 1, capabilities: ['fs_read', 'net'] },
    { wave: 1, attempt: 2, capabilities: ['fs_read', 'net'] },
  ]);
});

test('(capcls-b) AC#7 an unconstrained wave (absent from waveCapabilities) records no capabilities key', async () => {
  const { state } = await runOneWave({
    plan: twoWaves,
    runWave: async () => ({ outcome: 'success' }),
    waveCapabilities: { 2: ['fs_read'] },
    waveModels: { 2: 'claude-haiku-4-5' },
  });
  const [w1, w2] = state.appended.filter((e) => e.type === 'wave-started');
  assert.ok(!('capabilities' in w1.data), 'key absent, not undefined');
  assert.deepEqual(w2.data, { wave: 2, attempt: 1, model: 'claude-haiku-4-5', capabilities: ['fs_read'] });
});

test('(capcls-c) AC#7 waveCapabilities {} vs omitted → byte-identical event sequences', async () => {
  const runWith = async (extra) =>
    (await runOneWave({ plan: twoWaves, runWave: async () => ({ outcome: 'success' }), ...extra })).state.appended;
  const omitted = await runWith({});
  const empty = await runWith({ waveCapabilities: {} });
  assert.equal(JSON.stringify(empty), JSON.stringify(omitted));
  assert.ok(omitted.filter((e) => e.type === 'wave-started').every((e) => !('capabilities' in e.data)));
});

// ── acp-surface AC#4: permission decisions on wave-attempt ──────────────────

const PERMS = [{ kind: 'edit', decision: 'allow' }, { kind: null, decision: 'cancelled' }];
const attemptsOf = (state) => state.appended.filter((e) => e.type === 'wave-attempt');

test('(perm-a) AC#4 result.permissions is recorded on the wave-attempt data', async () => {
  const { state } = await runOneWave({ runWave: async () => ({ outcome: 'success', permissions: PERMS }) });
  const [attempt] = attemptsOf(state);
  assert.deepEqual(attempt.data.permissions, PERMS);
  assert.deepEqual(Object.keys(attempt.data), ['wave', 'attempt', 'outcome', 'usage', 'permissions']);
});

test('(perm-b) AC#4 absent or empty permissions -> byte-identical event sequence, no key', async () => {
  const runWith = async (extra) =>
    (await runOneWave({ plan: twoWaves, runWave: async () => ({ outcome: 'success', ...extra }) })).state.appended;
  const absent = await runWith({});
  for (const extra of [{ permissions: [] }, { permissions: undefined }, { permissions: 'edit' }]) {
    const appended = await runWith(extra);
    assert.equal(JSON.stringify(appended), JSON.stringify(absent), JSON.stringify(extra));
  }
  assert.ok(absent.filter((e) => e.type === 'wave-attempt').every((e) => !('permissions' in e.data)));
});

test('(perm-c) AC#4 a veto-sourced attempt keeps its provenance shape plus permissions', async () => {
  const spy = makeVetoSpy({ point: 'post-wave', outcome: 'fail-scope' });
  const { state } = await runOneWave({
    runWave: async () => ({ outcome: 'success', permissions: PERMS }),
    runHooks: spy.runHooks,
  });
  const [attempt] = attemptsOf(state);
  assert.equal(attempt.data.outcome, 'fail-scope');
  assert.equal(attempt.data.source, 'hook');
  assert.equal(attempt.data.point, 'post-wave');
  assert.equal(attempt.data.hook, 'hooks/post-wave/01.sh');
  assert.deepEqual(attempt.data.permissions, PERMS);
});
