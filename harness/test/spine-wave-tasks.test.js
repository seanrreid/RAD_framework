import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverSpine } from '../spine.js';
import { loadMatrix } from '../matrix.js';

const MATRIX = loadMatrix();

const WAVES = Object.freeze([
  { n: 1, heading: 'Wave 1 — The parser' },
  { n: 2, heading: 'Wave 2 — The spine' },
]);

const TASKS_1 = Object.freeze([
  { title: 'Parse blocks', files: 'harness/plan-tasks.js', what: 'Parse.', validate: 'AC#1' },
]);
const TASKS_2 = Object.freeze([
  { title: 'Spine option', files: 'harness/spine.js', what: 'Attach.', validate: 'AC#3' },
  { title: 'Spine tests', files: 'harness/test/x.test.js', what: 'Test.', validate: 'AC#5' },
]);

/** In-memory fake StateStore (copied from spine-test-scope.test.js). */
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

/** Run the spine over `waves`, recording every wave object runWave receives.
 * `waveTasks === undefined` omits the option entirely. */
async function run({ waves = WAVES, waveTasks } = {}) {
  const state = makeFakeState({ plan: { waves } });
  const received = [];
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: async (wave) => {
      received.push(wave);
      return { outcome: 'success' };
    },
    sh: () => ({ status: 0 }),
    now: fixedClock(),
    maxAttempts: 1,
    ...(waveTasks === undefined ? {} : { waveTasks }),
  });
  return { result, state, received };
}

test('an entry in waveTasks is attached (type + tasks) and n/heading are preserved', async () => {
  const waveTasks = {
    1: { type: 'sequential', tasks: TASKS_1 },
    2: { type: 'parallel', tasks: TASKS_2 },
  };
  const { result, received } = await run({ waveTasks });
  assert.equal(result.ok, true);
  assert.deepEqual(received, [
    { n: 1, heading: 'Wave 1 — The parser', type: 'sequential', tasks: TASKS_1 },
    { n: 2, heading: 'Wave 2 — The spine', type: 'parallel', tasks: TASKS_2 },
  ]);
  assert.equal(WAVES[0].tasks, undefined, 'the plan wave itself is not mutated');
});

test('a wave that already has tasks is passed unchanged even when waveTasks has an entry', async () => {
  const own = { n: 1, heading: 'Wave 1', type: 'sequential', kind: 'tests', tasks: TASKS_1 };
  const waveTasks = { 1: { type: 'parallel', tasks: TASKS_2 } };
  const { received } = await run({ waves: [own], waveTasks });
  assert.equal(received.length, 1);
  assert.equal(received[0], own);
});

test('no waveTasks option → runWave receives exactly the plan wave object', async () => {
  const { result, received } = await run();
  assert.equal(result.ok, true);
  assert.equal(received.length, 2);
  assert.equal(received[0], WAVES[0]);
  assert.equal(received[1], WAVES[1]);
});

test('a wave with no entry in waveTasks is passed unchanged', async () => {
  const waveTasks = { 2: { type: 'parallel', tasks: TASKS_2 } };
  const { received } = await run({ waveTasks });
  assert.equal(received[0], WAVES[0]);
  assert.deepEqual(received[1], { ...WAVES[1], type: 'parallel', tasks: TASKS_2 });
});

test('empty waveTasks → every wave passed unchanged; events carry no task data', async () => {
  const { received, state } = await run({ waveTasks: {} });
  assert.equal(received[0], WAVES[0]);
  assert.equal(received[1], WAVES[1]);
  const started = state.appended.filter((e) => e.type === 'wave-started');
  assert.ok(started.every((e) => !('tasks' in e.data) && !('type' in e.data)));
});
