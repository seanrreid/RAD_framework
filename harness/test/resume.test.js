import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeFrom } from '../events.js';
import { deliverSpine } from '../spine.js';
import { loadMatrix } from '../matrix.js';
import { fingerprint } from '../fingerprint.js';

const MATRIX = loadMatrix();

// ── resumeFrom unit tests — the pure fold ──────────────────────────────────

test('resumeFrom: empty history → empty Set', () => {
  const completed = resumeFrom([]);
  assert.ok(completed instanceof Set);
  assert.equal(completed.size, 0);
});

test('resumeFrom: null history → empty Set (no throw)', () => {
  const completed = resumeFrom(null);
  assert.ok(completed instanceof Set);
  assert.equal(completed.size, 0);
});

test('resumeFrom: undefined history → empty Set (no throw)', () => {
  const completed = resumeFrom(undefined);
  assert.ok(completed instanceof Set);
  assert.equal(completed.size, 0);
});

test('resumeFrom: wave-complete for waves 1 and 2 → Set{1,2}', () => {
  const history = [
    { type: 'deliver-started' },
    { type: 'wave-attempt', data: { wave: 1, outcome: 'success' } },
    { type: 'wave-complete', data: { wave: 1 } },
    { type: 'wave-attempt', data: { wave: 2, outcome: 'success' } },
    { type: 'wave-complete', data: { wave: 2 } },
  ];
  const completed = resumeFrom(history);
  assert.deepEqual([...completed].sort(), [1, 2]);
});

test('resumeFrom: a wave with only wave-attempt (no wave-complete) is NOT included', () => {
  // Wave 1 advanced; wave 2 crashed mid-run (attempt logged, never completed).
  const history = [
    { type: 'wave-attempt', data: { wave: 1, outcome: 'success' } },
    { type: 'wave-complete', data: { wave: 1 } },
    { type: 'wave-attempt', data: { wave: 2, outcome: 'success' } },
  ];
  const completed = resumeFrom(history);
  assert.ok(completed.has(1));
  assert.ok(!completed.has(2), 'wave 2 only attempted — must NOT be marked complete');
  assert.equal(completed.size, 1);
});

test('resumeFrom: mixed/partial history — only wave-complete events count', () => {
  // A noisy log: research/plan/approval markers, failed waves, retries. Only the
  // waves that actually carry a wave-complete should be returned.
  const history = [
    { type: 'research-created' },
    { type: 'plan-created' },
    { type: 'approved' },
    { type: 'deliver-started' },
    { type: 'wave-attempt', data: { wave: 1, outcome: 'fail-tests' } },
    { type: 'wave-attempt', data: { wave: 1, outcome: 'success' } },
    { type: 'wave-complete', data: { wave: 1 } },
    { type: 'wave-failed', data: { wave: 2, reason: 'budget-exhausted' } },
  ];
  const completed = resumeFrom(history);
  assert.deepEqual([...completed], [1]);
  assert.ok(!completed.has(2), 'a wave-failed wave is not complete');
});

test('resumeFrom: malformed / non-numeric wave-complete events contribute nothing', () => {
  // Defensive: events with no data, no wave, or a non-numeric wave id must not
  // crash the fold AND must not add a bogus entry — only numeric wave ids count
  // (a string '3' would never match the numeric wave.n and would mis-skip).
  const history = [
    { type: 'wave-complete' }, // no data
    { type: 'wave-complete', data: {} }, // data but no wave
    { type: 'wave-complete', data: { wave: '3' } }, // string id — ignored
    { type: 'wave-complete', data: { wave: 3 } }, // the only valid one
  ];
  const completed = resumeFrom(history);
  assert.ok(completed.has(3));
  assert.equal(completed.size, 1, 'malformed/non-numeric events contribute nothing');
});

// ── Resume idempotency at the spine level ──────────────────────────────────
//
// "Crash after wave 2 → resume at 3, no duplicate commits/events." Seed a fake
// StateStore history with wave-complete for waves 1–2 of a multi-wave plan, run
// deliverSpine, and assert runWave is invoked only for waves >= 3 and no
// duplicate wave-complete events are appended for waves 1–2.

/**
 * Fake StateStore whose history is seeded with prior events. `append` records
 * into the same array so the fold sees both prior and freshly-appended events
 * (matching the real store's append-only semantics).
 */
function makeSeededState({ gateResult, plan, seed = [] }) {
  const events = [...seed];
  return {
    events,
    seedCount: seed.length,
    async gate() {
      return gateResult;
    },
    append(event) {
      events.push(event);
    },
    plan() {
      return plan;
    },
    history() {
      return events;
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

function fixedClock() {
  let i = 0;
  return () => `t${i++}`;
}

test('resume idempotency: crash after wave 2 → only waves >= 3 run, no duplicate completes for 1–2', async () => {
  const plan = { waves: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }] };
  const seed = [
    { feature: 'demo', type: 'deliver-started', ts: 's0' },
    { feature: 'demo', type: 'wave-attempt', ts: 's1', data: { wave: 1, outcome: 'success' } },
    { feature: 'demo', type: 'wave-complete', ts: 's2', data: { wave: 1 } },
    { feature: 'demo', type: 'wave-attempt', ts: 's3', data: { wave: 2, outcome: 'success' } },
    { feature: 'demo', type: 'wave-complete', ts: 's4', data: { wave: 2 } },
  ];
  const state = makeSeededState({ gateResult: passingGate, plan, seed });

  const runWaveArgs = [];
  const runWave = async (wave) => {
    runWaveArgs.push(wave.n);
    return { outcome: 'success' };
  };

  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave,
    sh: () => ({ status: 0 }), // check-tests-present + post-checks all exit 0
    now: fixedClock(),
  });

  assert.deepEqual(result, { ok: true, waves: 4 });

  // (a) runWave invoked ONLY for the un-completed waves (3 and 4), in order.
  assert.deepEqual(runWaveArgs, [3, 4]);

  // (b) No duplicate wave-complete events for waves 1–2. The only completes for
  // 1 and 2 are the seeded ones — nothing newly appended re-completes them.
  const completesFor = (n) =>
    state.events.filter((e) => e.type === 'wave-complete' && e.data && e.data.wave === n);
  assert.equal(completesFor(1).length, 1, 'wave 1 completed exactly once');
  assert.equal(completesFor(2).length, 1, 'wave 2 completed exactly once');
  // And the survivors are the original seeded events (same timestamps).
  assert.equal(completesFor(1)[0].ts, 's2');
  assert.equal(completesFor(2)[0].ts, 's4');

  // Newly completed waves 3 and 4 each get exactly one wave-complete.
  assert.equal(completesFor(3).length, 1);
  assert.equal(completesFor(4).length, 1);

  // No wave-attempt was re-appended for the skipped waves: the only post-seed
  // attempts belong to waves 3 and 4.
  const newEvents = state.events.slice(state.seedCount);
  const newAttemptWaves = newEvents
    .filter((e) => e.type === 'wave-attempt')
    .map((e) => e.data.wave);
  assert.deepEqual(newAttemptWaves, [3, 4]);
  assert.ok(!newAttemptWaves.includes(1));
  assert.ok(!newAttemptWaves.includes(2));
});

test('resume idempotency: re-running an already fully-complete plan appends no new wave events', async () => {
  // Every wave already carries a wave-complete → nothing to re-run. The spine
  // should skip all waves (runWave never called) and append no duplicate
  // wave-attempt/wave-complete events.
  const plan = { waves: [{ n: 1 }, { n: 2 }] };
  const seed = [
    { feature: 'demo', type: 'deliver-started', ts: 's0' },
    { feature: 'demo', type: 'wave-complete', ts: 's1', data: { wave: 1 } },
    { feature: 'demo', type: 'wave-complete', ts: 's2', data: { wave: 2 } },
  ];
  const state = makeSeededState({ gateResult: passingGate, plan, seed });

  let runWaveCalls = 0;
  const runWave = async () => {
    runWaveCalls += 1;
    return { outcome: 'success' };
  };

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

  assert.deepEqual(result, { ok: true, waves: 2 });
  assert.equal(runWaveCalls, 0, 'all waves already complete — runWave never called');
  // Every wave hits the skip `continue` before the resume-verify block, so the
  // cumulative check-tests-present gate must never run when all waves are complete.
  assert.ok(
    !shCalls.includes('scripts/check-tests-present.sh'),
    'check-tests-present must not run when all waves are already complete',
  );

  // No new wave-attempt or wave-complete events appended (resume-verify and the
  // end deliver-started/pr-opened bookkeeping aside).
  const newEvents = state.events.slice(state.seedCount);
  assert.ok(!newEvents.some((e) => e.type === 'wave-attempt'));
  assert.ok(!newEvents.some((e) => e.type === 'wave-complete'));

  // Still exactly one wave-complete per wave (the seeded ones).
  const completesFor = (n) =>
    state.events.filter((e) => e.type === 'wave-complete' && e.data && e.data.wave === n);
  assert.equal(completesFor(1).length, 1);
  assert.equal(completesFor(2).length, 1);
});

// ── #119 durability: orphan convergence and resume seeding (Task 2.2) ───────

const MAX_ATTEMPTS = 3; // mirrors spine.js MAX_ATTEMPTS (the default ceiling)

/** One deliverSpine run over `state` (whose history persists across runs). */
function deliver(state, runWave) {
  return deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave,
    sh: () => ({ status: 0 }),
    now: fixedClock(),
  });
}

const oneWave = { waves: [{ n: 1 }] };
const ofType = (state, type) => state.events.filter((e) => e.type === type);

/** A runWave that fails differently every call (never trips the doom-loop). */
function distinctFailures(calls) {
  return async (wave, ctx) => {
    calls.push(ctx.attempt);
    return { outcome: 'fail-tests', summary: `distinct failure ${calls.length}` };
  };
}

test('durability (a): runWave dies after wave-started → the rerun converges exactly one orphan and surfaces', async () => {
  const state = makeSeededState({ gateResult: passingGate, plan: oneWave });
  await assert.rejects(
    deliver(state, async () => {
      throw new Error('process killed mid-agent');
    }),
    /process killed mid-agent/,
  );
  assert.equal(ofType(state, 'wave-started').length, 1);
  assert.equal(ofType(state, 'wave-attempt').length, 0);

  let runWaveCalls = 0;
  const result = await deliver(state, async () => {
    runWaveCalls += 1;
    return { outcome: 'success' };
  });

  assert.deepEqual(result, { stopped: 'matrix', ok: false, wave: 1, action: 'surface', outcome: 'fail-timeout' });
  assert.equal(runWaveCalls, 0, 'no new attempt runs before the orphan is surfaced');
  const attempts = ofType(state, 'wave-attempt');
  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0].data, { wave: 1, attempt: 1, outcome: 'fail-timeout', reason: 'orphaned' });
  const failed = ofType(state, 'wave-failed');
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0].data, { wave: 1, action: 'surface', reason: 'orphaned' });
});

test('durability (a2): the orphan surface terminal fires on-error once, before its wave-failed', async () => {
  const state = makeSeededState({ gateResult: passingGate, plan: oneWave });
  await assert.rejects(deliver(state, async () => {
    throw new Error('crash');
  }));

  const hookCalls = [];
  const runHooks = (point, ctx) => {
    hookCalls.push({ point, ctx, eventsBefore: state.events.length });
    return { ran: [], veto: null, failures: [] };
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

  assert.equal(result.stopped, 'matrix');
  const onError = hookCalls.filter((c) => c.point === 'on-error');
  assert.equal(onError.length, 1, 'on-error fires exactly once for the orphaned wave');
  assert.deepEqual(onError[0].ctx, { feature: 'demo', wave: 1, outcome: 'fail-timeout' });
  const failedIdx = state.events.findIndex((e) => e.type === 'wave-failed');
  assert.ok(onError[0].eventsBefore <= failedIdx, 'on-error fires before wave-failed is appended');
});

test('durability (b): a third run appends no second synthetic event and re-runs the wave with a fresh budget', async () => {
  const state = makeSeededState({ gateResult: passingGate, plan: oneWave });
  await assert.rejects(deliver(state, async () => {
    throw new Error('crash');
  }));
  await deliver(state, async () => ({ outcome: 'success' })); // converges the orphan

  const calls = [];
  const result = await deliver(state, distinctFailures(calls));

  const synthetic = ofType(state, 'wave-attempt').filter((e) => e.data.reason === 'orphaned');
  assert.equal(synthetic.length, 1, 'idempotent: the orphan is converged exactly once');
  // The last terminal wave-failed resets the count: the full budget runs again.
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(result.stopped, 'budget');
});

test('durability (c): 2 recorded attempts with no terminal → only MAX_ATTEMPTS-2 more attempts', async () => {
  const seed = [
    { feature: 'demo', type: 'deliver-started', ts: 's0' },
    { feature: 'demo', type: 'wave-started', ts: 's1', data: { wave: 1, attempt: 1 } },
    { feature: 'demo', type: 'wave-attempt', ts: 's2', data: { wave: 1, attempt: 1, outcome: 'fail-tests', fingerprint: 'a'.repeat(64) } },
    { feature: 'demo', type: 'wave-started', ts: 's3', data: { wave: 1, attempt: 2 } },
    { feature: 'demo', type: 'wave-attempt', ts: 's4', data: { wave: 1, attempt: 2, outcome: 'fail-tests', fingerprint: 'b'.repeat(64) } },
  ];
  const state = makeSeededState({ gateResult: passingGate, plan: oneWave, seed });

  const calls = [];
  const result = await deliver(state, distinctFailures(calls));

  assert.equal(calls.length, MAX_ATTEMPTS - 2);
  assert.deepEqual(calls, [3], 'the attempt counter continues from the log');
  assert.equal(result.stopped, 'budget');
  const newStarted = state.events.slice(state.seedCount).filter((e) => e.type === 'wave-started');
  assert.deepEqual(newStarted.map((e) => e.data), [{ wave: 1, attempt: 3 }]);
});

test('durability (d): an identical recorded fingerprint + the same failure after restart → doom-loop on the first post-restart attempt', async () => {
  const failure = { outcome: 'fail-tests', summary: 'the same failure' };
  const seed = [
    { feature: 'demo', type: 'wave-started', ts: 's0', data: { wave: 1, attempt: 1 } },
    { feature: 'demo', type: 'wave-attempt', ts: 's1', data: { wave: 1, attempt: 1, outcome: 'fail-tests', fingerprint: fingerprint(failure) } },
  ];
  const state = makeSeededState({ gateResult: passingGate, plan: oneWave, seed });

  let runWaveCalls = 0;
  const result = await deliver(state, async () => {
    runWaveCalls += 1;
    return { ...failure };
  });

  assert.equal(result.stopped, 'doom-loop');
  assert.equal(runWaveCalls, 1, 'the breaker trips on the first attempt after restart');
});

test('durability (e): a legacy log (no fingerprint, no attempt keys) never doom-loops on resume', async () => {
  const failure = { outcome: 'fail-tests', summary: 'the same failure' };
  const seed = [
    { feature: 'demo', type: 'deliver-started', ts: 's0' },
    { feature: 'demo', type: 'wave-attempt', ts: 's1', data: { wave: 1, outcome: 'fail-tests' } },
  ];
  const state = makeSeededState({ gateResult: passingGate, plan: oneWave, seed });

  const outcomes = [{ ...failure }, { outcome: 'success' }];
  let i = 0;
  const result = await deliver(state, async () => outcomes[i++]);

  // The first post-restart attempt repeats the failure yet does not trip the
  // breaker (lastPrint seeded null); the next attempt advances.
  assert.deepEqual(result, { ok: true, waves: 1 });
  assert.equal(i, 2);
  assert.ok(!ofType(state, 'wave-failed').length, 'no doom-loop, no orphan surfaced');
});
