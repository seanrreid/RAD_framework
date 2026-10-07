import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverSpine } from '../spine.js';
import { loadMatrix } from '../matrix.js';
import { classifyStop } from '../stops.js';

const MATRIX = loadMatrix();

const FINISH_FAILED = 'finish-failed';
const OPEN_PR = 'scripts/open-pr.sh';
const CHECK_SCOPE = 'scripts/check-scope.sh';

/** In-memory fake StateStore, copied from spine-prepare.test.js. The fake does
 * not validate transitions, so "no append after pr-opened" is asserted directly. */
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

/** Run the spine over a two-wave plan; every sh call (and, via `withCalls`,
 * every finish step) is recorded in order into `calls`. `withCalls(calls)`
 * returns extra options to override/extend the defaults. */
async function run(withCalls = () => ({})) {
  const state = makeFakeState({ plan: { waves: [{ n: 1 }, { n: 2 }] } });
  const calls = [];
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: async () => ({ outcome: 'success' }),
    sh: (script) => {
      calls.push(script);
      return { status: 0 };
    },
    now: fixedClock(),
    ...withCalls(calls),
  });
  return { result, state, calls, types: state.appended.map((e) => e.type) };
}

/** A finish port whose steps record into `calls` and return the given result
 * (or throw it, when it is an Error). */
function makeFinish(calls, { before = { ok: true, data: {} }, after = { ok: true, data: {} } }) {
  const step = (name, outcome) => async () => {
    calls.push(name);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { beforePr: step('beforePr', before), afterPr: step('afterPr', after) };
}

const runWithFinish = (opts = {}) => run((calls) => ({ finish: makeFinish(calls, opts) }));

/** The post-check tail of the call log: per-wave checks also run through `sh`,
 * so start at the LAST check-scope call (the post-check one). */
const postCheckTail = (calls) => calls.slice(calls.lastIndexOf(CHECK_SCOPE));

const lastOf = (state) => state.appended[state.appended.length - 1];

test('absent finish port → event sequence and script calls identical to a baseline run', async () => {
  const baseline = await run();
  const withNull = await run(() => ({ finish: null }));
  assert.deepEqual(withNull.state.appended, baseline.state.appended);
  assert.deepEqual(withNull.calls, baseline.calls);
  assert.deepEqual(withNull.result, baseline.result);
  assert.deepEqual(baseline.result, { ok: true, waves: 2 });
  assert.equal(lastOf(baseline.state).type, 'pr-opened');
});

test('order: check-scope → beforePr → open-pr → pr-opened → afterPr; success result unchanged', async () => {
  const { result, state, calls } = await runWithFinish();
  assert.deepEqual(postCheckTail(calls), [CHECK_SCOPE, 'beforePr', OPEN_PR, 'afterPr']);
  assert.deepEqual(result, { ok: true, waves: 2 });
  assert.equal(lastOf(state).type, 'pr-opened');
});

for (const [label, before] of [
  ['ok:false', { ok: false, detail: 'push refused' }],
  ['throws', new Error('push refused')],
]) {
  test(`beforePr ${label} → deliver-stopped failed/finish-failed, no open-pr.sh, no pr-opened`, async () => {
    const { result, state, calls, types } = await runWithFinish({ before });
    assert.deepEqual(postCheckTail(calls), [CHECK_SCOPE, 'beforePr']);
    assert.ok(!calls.includes(OPEN_PR));
    assert.ok(!types.includes('pr-opened'));
    assert.deepEqual(result, { stopped: FINISH_FAILED, ok: false, detail: 'push refused', reason: 'push refused' });
    const stop = lastOf(state);
    assert.equal(stop.type, 'deliver-stopped');
    assert.equal(stop.data.class, 'failed');
    assert.equal(stop.data.reason, FINISH_FAILED);
    assert.equal(stop.data.detail, 'push refused');
    assert.equal(stop.data.decision, 'finishing the run failed: push refused; re-run rad deliver to finish');
  });
}

for (const [label, after] of [
  ['ok:false', { ok: false, detail: 'label failed' }],
  ['throws', new Error('label failed')],
]) {
  test(`afterPr ${label} → finish-failed result with afterPr:true, nothing appended after pr-opened`, async () => {
    const { result, state, calls, types } = await runWithFinish({ after });
    assert.deepEqual(postCheckTail(calls), [CHECK_SCOPE, 'beforePr', OPEN_PR, 'afterPr']);
    assert.deepEqual(result, {
      ok: false,
      stopped: FINISH_FAILED,
      detail: 'label failed',
      reason: 'label failed',
      afterPr: true,
    });
    assert.equal(lastOf(state).type, 'pr-opened');
    assert.ok(!types.includes('deliver-stopped'));
  });
}

test('afterPr ok:false without detail → detail undefined, still no append after pr-opened', async () => {
  const { result, state } = await runWithFinish({ after: { ok: false } });
  assert.equal(result.stopped, FINISH_FAILED);
  assert.equal(result.afterPr, true);
  assert.equal(result.detail, undefined);
  assert.equal(lastOf(state).type, 'pr-opened');
});

test('finish-failed decision renders detail, and `unknown` when detail is missing or empty', () => {
  assert.deepEqual(classifyStop({ stopped: FINISH_FAILED, detail: 'boom' }), {
    class: 'failed',
    reason: FINISH_FAILED,
    decision: 'finishing the run failed: boom; re-run rad deliver to finish',
  });
  for (const detail of [undefined, null, '']) {
    assert.equal(
      classifyStop({ stopped: FINISH_FAILED, detail }).decision,
      'finishing the run failed: unknown; re-run rad deliver to finish',
    );
  }
});
