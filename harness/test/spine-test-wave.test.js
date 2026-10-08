import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverSpine, buildTestWave } from '../spine.js';
import { loadMatrix } from '../matrix.js';

const MATRIX = loadMatrix();
const PRESENCE = 'scripts/check-tests-present.sh';

const WAVES = Object.freeze([{ n: 1 }, { n: 2 }]);

/** Wave 1 promises a.test.js; b.test.js and c.test.js are listed in Tests to
 * Write but promised by NO wave — the end-of-run test wave's job. */
const TESTS_BY_WAVE = Object.freeze({ 1: ['a.test.js'], 2: [] });
const ALL_TESTS = Object.freeze(['a.test.js', 'b.test.js', 'c.test.js']);

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

/**
 * Run the spine. `writes(wave, attempt)` returns the files that attempt writes
 * (default: plan wave 1 writes a.test.js, the test wave writes its tasks'
 * files). The presence stub fails only when its array arg lists an unwritten
 * file (`presenceAlwaysPasses` forces a pass). `testWave` is built over `paths`
 * against the same written set unless `testWave` is passed explicitly.
 */
async function run({
  paths = ALL_TESTS,
  testWave,
  withTestWave = true,
  testsByWave = TESTS_BY_WAVE,
  writes = defaultWrites,
  prewritten = [],
  seed = [],
  maxAttempts = 1,
  presenceAlwaysPasses = false,
} = {}) {
  const state = makeFakeState({ plan: { waves: WAVES }, seed });
  const written = new Set(prewritten);
  const shCalls = [];
  const waveObjects = [];
  const missingCalls = [];
  const sh = (script, arg) => {
    shCalls.push({ script, arg });
    if (script !== PRESENCE || !Array.isArray(arg) || presenceAlwaysPasses) return { status: 0 };
    return { status: arg.every((p) => written.has(p)) ? 0 : 1, stdout: '' };
  };
  const port = testWave ?? {
    paths,
    missing: (ps) => {
      missingCalls.push([...ps]);
      return ps.filter((p) => !written.has(p));
    },
  };
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: async (wave, { attempt }) => {
      waveObjects.push(wave);
      for (const p of writes(wave, attempt)) written.add(p);
      return { outcome: 'success' };
    },
    sh,
    now: fixedClock(),
    maxAttempts,
    ...(testsByWave === undefined ? {} : { testsByWave }),
    ...(withTestWave ? { testWave: port } : {}),
  });
  const presence = shCalls.filter((c) => c.script === PRESENCE).map((c) => c.arg);
  return { result, state, waveObjects, presence, missingCalls };
}

function defaultWrites(wave) {
  if (wave.kind === 'tests') return wave.tasks.flatMap((t) => t.files);
  return wave.n === 1 ? ['a.test.js'] : [];
}

const ofType = (state, type) => state.appended.filter((e) => e.type === type);
const attemptsOf = (state) => ofType(state, 'wave-attempt').map((e) => [e.data.wave, e.data.outcome]);
const stopped = (state) => ofType(state, 'deliver-stopped');

const EXPECTED_TASKS = [
  {
    title: 'Write b.test.js',
    files: ['b.test.js'],
    what: "Write the test file b.test.js listed in the plan's Tests to Write.",
    validate: 'b.test.js exists',
  },
  {
    title: 'Write c.test.js',
    files: ['c.test.js'],
    what: "Write the test file c.test.js listed in the plan's Tests to Write.",
    validate: 'c.test.js exists',
  },
];

test('no testWave → unchanged: no test wave, no kind key, plan count result', async () => {
  const absent = await run({ withTestWave: false });
  assert.deepEqual(absent.result, { ok: true, waves: 2 });
  assert.deepEqual(absent.waveObjects.map((w) => w.n), [1, 2]);
  assert.ok(ofType(absent.state, 'wave-started').every((e) => !('kind' in e.data)));
  assert.equal(stopped(absent.state).length, 0);
});

test('nothing missing → no test wave and no extra events (identical to no testWave)', async () => {
  const prewritten = ['b.test.js', 'c.test.js'];
  const withPort = await run({ prewritten });
  const without = await run({ prewritten, withTestWave: false });
  assert.deepEqual(withPort.result, { ok: true, waves: 2 });
  assert.deepEqual(withPort.waveObjects.map((w) => w.n), [1, 2]);
  assert.deepEqual(withPort.state.appended, without.state.appended);
  assert.deepEqual(withPort.presence, without.presence);
  // Called once to decide on the test wave, once by the final guard.
  assert.deepEqual(withPort.missingCalls, [ALL_TESTS, ALL_TESTS]);
});

test('missing → synthetic wave N+1 runs with one task per missing path, kind on wave-started', async () => {
  const { result, state, waveObjects, presence } = await run();
  assert.deepEqual(result, { ok: true, waves: 2 }); // plan count, not 3
  assert.deepEqual(waveObjects.map((w) => w.n), [1, 2, 3]);
  assert.deepEqual(waveObjects[2], { n: 3, type: 'sequential', kind: 'tests', tasks: EXPECTED_TASKS });
  const started = ofType(state, 'wave-started').map((e) => e.data);
  assert.deepEqual(started, [
    { wave: 1, attempt: 1 },
    { wave: 2, attempt: 1 },
    { wave: 3, attempt: 1, kind: 'tests' },
  ]);
  assert.deepEqual(attemptsOf(state), [[1, 'success'], [2, 'success'], [3, 'success']]);
  assert.deepEqual(ofType(state, 'wave-complete').map((e) => e.data.wave), [1, 2, 3]);
  // The test wave's gate: the plan's full promised union PLUS the synthetic paths.
  assert.deepEqual(presence.at(-1), ['a.test.js', 'b.test.js', 'c.test.js']);
  assert.equal(stopped(state).length, 0);
  assert.equal(ofType(state, 'pr-opened').length, 1);
});

test('wave N+1 is numbered from the HIGHEST plan wave n', () => {
  const wave = buildTestWave([{ n: 4 }, { n: 2 }], ['x.test.js']);
  assert.equal(wave.n, 5);
  assert.equal(buildTestWave([], ['x.test.js']).n, 1);
});

test('testsByWave null → the test wave gate uses the scoped form with the synthetic paths alone', async () => {
  const { result, presence } = await run({ testsByWave: null });
  assert.equal(result.ok, true);
  // Plan waves keep today's feature-string call; the test wave passes an array.
  assert.deepEqual(presence, ['demo', 'demo', ['b.test.js', 'c.test.js']]);
});

test('test wave gate failing → fail-tests and a matrix retry, then advances', async () => {
  // Attempt 1 of the test wave writes nothing; attempt 2 writes the files.
  const writes = (wave, attempt) =>
    wave.kind === 'tests' ? (attempt === 1 ? [] : wave.tasks.flatMap((t) => t.files)) : defaultWrites(wave);
  const { result, state, waveObjects } = await run({ writes, maxAttempts: 2 });
  assert.deepEqual(result, { ok: true, waves: 2 });
  assert.deepEqual(waveObjects.map((w) => w.n), [1, 2, 3, 3]);
  assert.deepEqual(attemptsOf(state), [
    [1, 'success'],
    [2, 'success'],
    [3, 'fail-tests'],
    [3, 'success'],
  ]);
});

test('still missing after a completed test wave → tests-missing stop listing the paths', async () => {
  // The test wave writes nothing; a presence script that passes lets it complete.
  const writes = (wave) => (wave.kind === 'tests' ? [] : defaultWrites(wave));
  const { result, state } = await run({ writes, presenceAlwaysPasses: true });
  assert.deepEqual(result, {
    stopped: 'tests-missing',
    ok: false,
    detail: 'b.test.js, c.test.js',
    reason: 'b.test.js, c.test.js',
  });
  assert.deepEqual(ofType(state, 'wave-complete').map((e) => e.data.wave), [1, 2, 3]);
  const stops = stopped(state);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].data.class, 'failed');
  assert.equal(stops[0].data.reason, 'tests-missing');
  assert.equal(stops[0].data.detail, 'b.test.js, c.test.js');
  assert.equal(
    stops[0].data.decision,
    'test files still missing after the test wave: b.test.js, c.test.js; write them on the branch and re-run rad deliver',
  );
  assert.equal(ofType(state, 'pr-opened').length, 0);
});

test('resume with N+1 already complete → not re-run, and the final guard still runs', async () => {
  const seed = [1, 2, 3].map((n) => ({ type: 'wave-complete', data: { wave: n } }));
  const missing = await run({ seed, prewritten: ['a.test.js', 'b.test.js'] });
  assert.equal(missing.waveObjects.length, 0); // nothing re-runs
  assert.equal(missing.result.stopped, 'tests-missing');
  assert.equal(missing.result.reason, 'c.test.js');
  assert.equal(stopped(missing.state).length, 1);

  const present = await run({ seed, prewritten: ALL_TESTS });
  assert.equal(present.waveObjects.length, 0);
  assert.deepEqual(present.result, { ok: true, waves: 2 });
  assert.deepEqual(present.missingCalls, [ALL_TESTS, ALL_TESTS]);
});

test('resume with plan waves complete but N+1 not → runs the test wave once', async () => {
  const seed = [1, 2].map((n) => ({ type: 'wave-complete', data: { wave: n } }));
  const { result, waveObjects } = await run({ seed, prewritten: ['a.test.js'] });
  assert.deepEqual(result, { ok: true, waves: 2 });
  assert.deepEqual(waveObjects.map((w) => w.n), [3]);
});

test('a missing() port that throws or returns a non-array stops fail-closed', async () => {
  const throwing = await run({
    testWave: { paths: ALL_TESTS, missing: () => { throw new Error('boom'); } },
  });
  assert.equal(throwing.result.stopped, 'tests-missing');
  assert.equal(throwing.result.reason, 'testWave.missing threw: boom');
  assert.equal(throwing.waveObjects.length, 2); // plan waves only

  const bogus = await run({ testWave: { paths: ALL_TESTS, missing: () => 'b.test.js' } });
  assert.equal(bogus.result.stopped, 'tests-missing');
  assert.equal(bogus.result.reason, 'testWave.missing returned a non-array');
});
