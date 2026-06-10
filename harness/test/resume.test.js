import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeFrom } from '../events.js';
import { deliverSpine } from '../spine.js';
import { loadMatrix } from '../matrix.js';

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

test('resumeFrom: a wave-complete missing data is tolerated (no throw)', () => {
  // Defensive: an event with no data must not crash the fold. It contributes an
  // undefined wave entry rather than throwing.
  const history = [
    { type: 'wave-complete' }, // no data
    { type: 'wave-complete', data: { wave: 3 } },
  ];
  const completed = resumeFrom(history);
  assert.ok(completed.has(3));
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
    sh: () => ({ status: 0 }), // check-tests + post-checks all green
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

  assert.deepEqual(result, { ok: true, waves: 2 });
  assert.equal(runWaveCalls, 0, 'all waves already complete — runWave never called');

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
