import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBlockedReasons, formatBlockedReasons } from '../insights-blocked-reasons.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..', 'insights-blocked-reasons.js');
const FIXTURES = join(HERE, 'fixtures', 'insights');
const GOLDEN = readFileSync(join(HERE, 'fixtures', 'insights-parity', 'golden.txt'), 'utf8');
const FIXTURE_NAMES = ['enriched', 'legacy', 'mixed', 'provider', 'tiered'];
const ZERO_COUNTS = { enrichedAttempts: 0, blocked_code: 0, blocked_spec: 0, blocked_intent: 0 };

const makeTmp = () => mkdtempSync(join(tmpdir(), 'insights-reasons-'));
const withTmp = (dir, fn) => { try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

function runRaw(stateDir) {
  const env = { ...process.env, RAD_STATE_DIR: stateDir };
  return spawnSync(process.execPath, [MODULE], { env, encoding: 'utf8' });
}

/** Run the module; returns stdout (asserts a clean exit). */
function run(stateDir) {
  const r = runRaw(stateDir);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function stateDirWith(names) {
  const dir = makeTmp();
  for (const n of names) {
    mkdirSync(join(dir, n));
    copyFileSync(join(FIXTURES, n, 'events.jsonl'), join(dir, n, 'events.jsonl'));
  }
  return dir;
}

function stateDirWithLog(feature, text) {
  const dir = makeTmp();
  mkdirSync(join(dir, feature));
  writeFileSync(join(dir, feature, 'events.jsonl'), text);
  return dir;
}

function goldenSection(name) {
  const m = GOLDEN.split(`=== 4d:${name} ===\n`)[1];
  return m.split(/^=== .* ===\n/m)[0];
}

const logOf = (...events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const attempt = (tasks) => ({ type: 'wave-attempt', feature: 'f', data: { wave: 1, outcome: 'fail-tests', tasks } });

for (const name of FIXTURE_NAMES) {
  test(`parity: ${name} fixture matches the golden from the old inline snippet`, () => {
    withTmp(stateDirWith([name]), (dir) => assert.equal(run(dir), goldenSection(name)));
  });
}

test('parity: all fixtures together match the golden', () => {
  withTmp(stateDirWith(FIXTURE_NAMES), (dir) => assert.equal(run(dir), goldenSection('all')));
});

test('parity: an empty state dir matches the golden', () => {
  withTmp(makeTmp(), (dir) => assert.equal(run(dir), goldenSection('empty')));
});

test('edge: missing state dir -> noEnrichedData with zero counts, exit 0', () => {
  withTmp(makeTmp(), (dir) => {
    const out = JSON.parse(run(join(dir, 'absent')));
    assert.deepStrictEqual(out, { noEnrichedData: true, aggregate: ZERO_COUNTS, perFeature: {} });
  });
});

test('edge: empty events.jsonl lists the feature with zero counts and noEnrichedData', () => {
  withTmp(stateDirWithLog('f', ''), (dir) => {
    assert.deepStrictEqual(JSON.parse(run(dir)), {
      noEnrichedData: true, aggregate: ZERO_COUNTS, perFeature: { f: ZERO_COUNTS },
    });
  });
});

test('edge: noEnrichedData stays true when no attempt carries tasks (legacy only)', () => {
  const legacy = { type: 'wave-attempt', feature: 'f', data: { wave: 1, outcome: 'success' } };
  withTmp(stateDirWithLog('f', logOf(legacy)), (dir) => {
    const out = buildBlockedReasons(dir);
    assert.equal(out.noEnrichedData, true);
    assert.equal(out.aggregate.enrichedAttempts, 0);
  });
});

test('edge: an event missing data/tasks fields is skipped, not counted', () => {
  const log = logOf({ type: 'wave-attempt', feature: 'f' }, { type: 'wave-attempt', data: {} });
  withTmp(stateDirWithLog('f', log), (dir) => {
    assert.deepStrictEqual(buildBlockedReasons(dir).aggregate, ZERO_COUNTS);
  });
});

test('edge: zero blocked tasks in an enriched attempt -> enriched counted, buckets zero', () => {
  const log = logOf(attempt([{ title: 'T', status: 'complete' }]));
  withTmp(stateDirWithLog('f', log), (dir) => {
    const out = buildBlockedReasons(dir);
    assert.equal(out.noEnrichedData, false);
    assert.deepStrictEqual(out.aggregate, { ...ZERO_COUNTS, enrichedAttempts: 1 });
  });
});

test('edge: non-array tasks field is ignored, as are non-object entries', () => {
  const log = logOf(attempt('nope'), attempt({ status: 'blocked_code' }), attempt([null, 7, 'x']));
  withTmp(stateDirWithLog('f', log), (dir) => {
    assert.deepStrictEqual(buildBlockedReasons(dir).aggregate, { ...ZERO_COUNTS, enrichedAttempts: 1 });
  });
});

test('edge: blocked statuses are summed across features', () => {
  const a = logOf(attempt([{ title: 'A', status: 'blocked_code' }]));
  const b = logOf(attempt([{ title: 'B', status: 'blocked_spec' }, { title: 'C', status: 'blocked_code' }]));
  const dir = stateDirWithLog('a', a);
  mkdirSync(join(dir, 'b'));
  writeFileSync(join(dir, 'b', 'events.jsonl'), b);
  withTmp(dir, () => {
    const out = buildBlockedReasons(dir);
    assert.deepStrictEqual(out.aggregate, { enrichedAttempts: 2, blocked_code: 2, blocked_spec: 1, blocked_intent: 0 });
    assert.deepStrictEqual(Object.keys(out.perFeature), ['a', 'b']);
  });
});

test('edge: a valid-JSON null line fails closed with a non-zero exit naming file and line', () => {
  withTmp(stateDirWithLog('bad', 'null\n'), (dir) => {
    const r = runRaw(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /events\.jsonl:1/);
  });
});

test('edge: a malformed log line fails closed with a non-zero exit', () => {
  withTmp(stateDirWithLog('bad', '{not json\n'), (dir) => assert.notEqual(runRaw(dir).status, 0));
});

test('formatBlockedReasons is 2-space JSON without a trailing newline', () => {
  assert.equal(formatBlockedReasons({ a: 1 }), '{\n  "a": 1\n}');
});
