import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverSpine } from '../spine.js';
import { loadMatrix } from '../matrix.js';
import { classifyStop } from '../stops.js';

const MATRIX = loadMatrix();

const PREPARED_DATA = Object.freeze({
  base: 'main',
  merged: true,
  fastForwarded: false,
  committed: true,
  pushed: true,
});

const RESUME = Object.freeze({
  context: 'resolved the conflict by hand',
  recordedBy: 'dev',
  stop: { class: 'needs-decision', reason: 'merge-conflict' },
});

/** In-memory fake StateStore, in the style of spine.test.js. `seed` pre-loads
 * prior-run events (history() reads the same array appends go to). */
function makeFakeState({ plan, seed = [] }) {
  const appended = [...seed];
  return {
    appended,
    async gate() {
      return { passed: true, reason: 'ok', satisfiedBy: { actor: 'architect' } };
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
  };
}

function fixedClock() {
  let i = 0;
  return () => `t${i++}`;
}

/** Run the spine over a two-wave plan; `extra` overrides/extends the options. */
async function run(extra = {}, seed = []) {
  const state = makeFakeState({ plan: { waves: [{ n: 1 }, { n: 2 }] }, seed });
  const waveCalls = [];
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: async (wave) => {
      waveCalls.push(wave.n);
      return { outcome: 'success' };
    },
    sh: () => ({ status: 0 }),
    now: fixedClock(),
    ...extra,
  });
  return { result, state, waveCalls, types: state.appended.map((e) => e.type) };
}

const lastOf = (state) => state.appended[state.appended.length - 1];

test('absent prepare port → event sequence identical to a baseline run', async () => {
  const baseline = await run();
  const withNull = await run({ prepare: null });
  assert.deepEqual(withNull.state.appended, baseline.state.appended);
  assert.deepEqual(withNull.result, baseline.result);
  assert.ok(!baseline.types.includes('run-prepared'));
});

test('success → run-prepared (with data) after deliver-started, before wave-started', async () => {
  let calls = 0;
  const prepare = async () => {
    calls += 1;
    return { ok: true, data: { ...PREPARED_DATA } };
  };
  const { result, state, types } = await run({ prepare });
  assert.deepEqual(result, { ok: true, waves: 2 });
  assert.equal(calls, 1);
  assert.deepEqual(types.slice(0, 3), ['deliver-started', 'run-prepared', 'wave-started']);
  const prepared = state.appended.find((e) => e.type === 'run-prepared');
  assert.deepEqual(prepared.data, PREPARED_DATA);
  assert.equal(prepared.actor, 'harness');
  assert.equal(prepared.feature, 'demo');
});

test('merge-conflict → deliver-stopped needs-decision with rendered decision; no waves', async () => {
  const prepare = async () => ({
    ok: false,
    stopped: 'merge-conflict',
    detail: 'harness/spine.js',
    base: 'main',
    branch: 'rad/demo',
  });
  const { result, state, types, waveCalls } = await run({ prepare });
  assert.equal(result.stopped, 'merge-conflict');
  assert.equal(result.ok, false);
  assert.deepEqual(types, ['deliver-started', 'deliver-stopped']);
  assert.deepEqual(waveCalls, []);
  const stop = lastOf(state).data;
  assert.equal(stop.class, 'needs-decision');
  assert.equal(stop.reason, 'merge-conflict');
  assert.equal(stop.detail, 'harness/spine.js');
  assert.equal(
    stop.decision,
    'merging origin/main into rad/demo conflicts (harness/spine.js); resolve the conflict on the branch, commit, and re-run with --resume',
  );
});

test('merge-conflict without base/branch/detail → placeholders fall back to unknown', () => {
  const { decision } = classifyStop({ stopped: 'merge-conflict' });
  assert.equal(
    decision,
    'merging origin/unknown into unknown conflicts (unknown); resolve the conflict on the branch, commit, and re-run with --resume',
  );
  assert.equal(classifyStop({ stopped: 'prepare-failed' }).decision, 'prepare failed: unknown');
});

test('prepare-failed result → deliver-stopped class failed; no waves', async () => {
  const prepare = async () => ({ ok: false, stopped: 'prepare-failed', detail: 'push rejected' });
  const { result, state, types, waveCalls } = await run({ prepare });
  assert.equal(result.stopped, 'prepare-failed');
  assert.deepEqual(types, ['deliver-started', 'deliver-stopped']);
  assert.deepEqual(waveCalls, []);
  const stop = lastOf(state).data;
  assert.equal(stop.class, 'failed');
  assert.equal(stop.decision, 'prepare failed: push rejected');
});

test('throwing prepare port → prepare-failed carrying the error message', async () => {
  const prepare = async () => {
    throw new Error('git fetch exited 128');
  };
  const { result, state, types, waveCalls } = await run({ prepare });
  assert.equal(result.stopped, 'prepare-failed');
  assert.equal(result.detail, 'git fetch exited 128');
  assert.deepEqual(types, ['deliver-started', 'deliver-stopped']);
  assert.deepEqual(waveCalls, []);
  const stop = lastOf(state).data;
  assert.equal(stop.class, 'failed');
  assert.equal(stop.decision, 'prepare failed: git fetch exited 128');
  assert.equal(stop.detail, 'git fetch exited 128');
});

test('unknown stopped from the port → classifyStop throws (fail-closed), nothing stopped', async () => {
  const prepare = async () => ({ ok: false, stopped: 'mystery', detail: 'x' });
  await assert.rejects(run({ prepare }), /classifyStop: unknown stopped "mystery"/);
});

test('resume → prepare runs after run-resumed; completed waves are still skipped', async () => {
  const seed = [
    { feature: 'demo', type: 'deliver-started', actor: 'harness', ts: 's0' },
    { feature: 'demo', type: 'wave-started', actor: 'harness', ts: 's1', data: { wave: 1, attempt: 1 } },
    { feature: 'demo', type: 'wave-attempt', actor: 'harness', ts: 's2', data: { wave: 1, attempt: 1, outcome: 'success' } },
    { feature: 'demo', type: 'wave-complete', actor: 'harness', ts: 's3', data: { wave: 1 } },
    {
      feature: 'demo',
      type: 'deliver-stopped',
      actor: 'harness',
      ts: 's4',
      data: { class: 'needs-decision', reason: 'merge-conflict', decision: 'd' },
    },
  ];
  const prepare = async () => ({ ok: true, data: { ...PREPARED_DATA } });
  const { result, types, waveCalls } = await run({ prepare, resume: RESUME }, seed);
  assert.deepEqual(result, { ok: true, waves: 2 });
  assert.deepEqual(waveCalls, [2]);
  const thisRun = types.slice(seed.length);
  assert.deepEqual(thisRun.slice(0, 4), ['deliver-started', 'run-resumed', 'run-prepared', 'wave-started']);
});
