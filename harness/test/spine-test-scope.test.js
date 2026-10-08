import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverSpine, promisedUpTo } from '../spine.js';
import { loadMatrix } from '../matrix.js';

const MATRIX = loadMatrix();
const PRESENCE = 'scripts/check-tests-present.sh';

const WAVES = Object.freeze([{ n: 1 }, { n: 2 }, { n: 3 }]);

/** Wave 1 promises a.test.js, wave 2 promises b.test.js (+ a repeat of a),
 * wave 3 promises nothing. */
const TESTS_BY_WAVE = Object.freeze({
  1: ['a.test.js'],
  2: ['b.test.js', 'a.test.js'],
  3: [],
});

/** In-memory fake StateStore, in the style of spine-prepare.test.js. `seed`
 * pre-loads prior-run events (history() reads the same array appends go to). */
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

/** Run the spine where each wave "writes" the files in `writes[n]` (default:
 * what it promised); `prewritten` are files a prior (resumed) run wrote. The presence stub fails only when its arg lists a file
 * not yet written; every sh call is recorded as { script, arg }. */
async function run({ testsByWave, writes = testsByWave || {}, seed = [], prewritten = [], waves = WAVES } = {}) {
  const state = makeFakeState({ plan: { waves }, seed });
  const written = new Set(prewritten);
  const shCalls = [];
  const waveCalls = [];
  const sh = (script, arg) => {
    shCalls.push({ script, arg });
    if (script !== PRESENCE || !Array.isArray(arg)) return { status: 0 };
    return { status: arg.every((p) => written.has(p)) ? 0 : 1, stdout: '' };
  };
  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: async (wave) => {
      waveCalls.push(wave.n);
      for (const p of writes[wave.n] || []) written.add(p);
      return { outcome: 'success' };
    },
    sh,
    now: fixedClock(),
    maxAttempts: 1,
    ...(testsByWave === undefined ? {} : { testsByWave }),
  });
  const presence = shCalls.filter((c) => c.script === PRESENCE).map((c) => c.arg);
  return { result, state, waveCalls, presence };
}

const attempts = (state) => state.appended.filter((e) => e.type === 'wave-attempt');

test('promisedUpTo: de-duplicated union in wave order, then listed order', () => {
  assert.deepEqual(promisedUpTo(TESTS_BY_WAVE, WAVES, 0), []);
  assert.deepEqual(promisedUpTo(TESTS_BY_WAVE, WAVES, 1), ['a.test.js']);
  assert.deepEqual(promisedUpTo(TESTS_BY_WAVE, WAVES, 2), ['a.test.js', 'b.test.js']);
  assert.deepEqual(promisedUpTo(TESTS_BY_WAVE, WAVES, 3), ['a.test.js', 'b.test.js']);
});

test('promisedUpTo: missing wave key and non-array value promise nothing', () => {
  assert.deepEqual(promisedUpTo({ 2: 'x.test.js' }, WAVES, 3), []);
  assert.deepEqual(promisedUpTo({}, WAVES, 3), []);
});

test('regression: a test file promised by wave 2 does not fail wave 1', async () => {
  const { result, state, waveCalls } = await run({ testsByWave: TESTS_BY_WAVE });
  assert.equal(result.ok, true);
  assert.deepEqual(waveCalls, [1, 2, 3]);
  assert.ok(attempts(state).every((e) => e.data.outcome === 'success'));
});

test('a wave that promised a file and did not write it → fail-tests at that wave', async () => {
  const writes = { 1: ['a.test.js'], 2: [], 3: [] };
  const { result, state, waveCalls } = await run({ testsByWave: TESTS_BY_WAVE, writes });
  assert.notEqual(result.ok, true);
  assert.deepEqual(waveCalls, [1, 2]); // wave 3 never runs
  const outcomes = attempts(state).map((e) => [e.data.wave, e.data.outcome]);
  assert.deepEqual(outcomes, [
    [1, 'success'],
    [2, 'fail-tests'],
  ]);
});

test('the checked union grows across waves (args per call)', async () => {
  const testsByWave = { 1: ['a.test.js'], 2: ['b.test.js'], 3: ['c.test.js', 'a.test.js'] };
  const { presence } = await run({ testsByWave });
  assert.deepEqual(presence, [
    ['a.test.js'],
    ['a.test.js', 'b.test.js'],
    ['a.test.js', 'b.test.js', 'c.test.js'],
  ]);
});

test('empty union skips the gate (no check-tests-present call) and the wave advances', async () => {
  const testsByWave = { 1: [], 2: ['b.test.js'], 3: [] };
  const { result, presence, waveCalls } = await run({ testsByWave });
  assert.equal(result.ok, true);
  assert.deepEqual(waveCalls, [1, 2, 3]);
  // Wave 1 promised nothing so far → skipped; waves 2 and 3 check b.
  assert.deepEqual(presence, [['b.test.js'], ['b.test.js']]);
});

test('empty union still runs the wave Verify command', async () => {
  const state = makeFakeState({ plan: { waves: [{ n: 1 }] } });
  const scripts = [];
  await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave: async () => ({ outcome: 'success' }),
    sh: (script) => {
      scripts.push(script);
      return { status: 0 };
    },
    now: fixedClock(),
    waveVerify: { 1: 'npm test' },
    testsByWave: { 1: [] },
  });
  assert.ok(!scripts.includes(PRESENCE));
  assert.ok(scripts.includes('scripts/check-verify.sh'));
});

test('resume-verify checks only the completed waves\' promised files', async () => {
  const seed = [{ feature: 'demo', type: 'wave-complete', data: { wave: 1 } }];
  const testsByWave = { 1: ['a.test.js'], 2: ['b.test.js'], 3: [] };
  const { presence, waveCalls } = await run({ testsByWave, seed, prewritten: ['a.test.js'] });
  // First call is the resume-verify for completed wave 1 only.
  assert.deepEqual(presence[0], ['a.test.js']);
  assert.deepEqual(waveCalls, [2, 3]);
});

test('resume-verify fails closed when a completed wave\'s file is absent', async () => {
  const seed = [{ feature: 'demo', type: 'wave-complete', data: { wave: 1 } }];
  const { result, waveCalls } = await run({
    testsByWave: { 1: ['a.test.js'], 2: [], 3: [] },
    writes: {},
    seed,
  });
  assert.deepEqual(result, { stopped: 'resume-verify', ok: false });
  assert.deepEqual(waveCalls, []);
});

test('resume-verify with an empty completed-wave union is skipped', async () => {
  const seed = [{ feature: 'demo', type: 'wave-complete', data: { wave: 1 } }];
  const testsByWave = { 1: [], 2: ['b.test.js'], 3: [] };
  const { result, presence, waveCalls } = await run({ testsByWave, seed });
  assert.equal(result.ok, true);
  assert.deepEqual(waveCalls, [2, 3]);
  assert.deepEqual(presence, [['b.test.js'], ['b.test.js']]); // no resume call
});

test('absent testsByWave keeps sh(script, feature) for gate and resume-verify', async () => {
  const seed = [{ feature: 'demo', type: 'wave-complete', data: { wave: 1 } }];
  const { presence } = await run({ seed });
  assert.deepEqual(presence, ['demo', 'demo', 'demo']); // resume + waves 2, 3
});

test('explicit null testsByWave is identical to absent', async () => {
  const absent = await run();
  const withNull = await run({ testsByWave: null });
  assert.deepEqual(withNull.state.appended, absent.state.appended);
  assert.deepEqual(withNull.presence, ['demo', 'demo', 'demo']);
});
