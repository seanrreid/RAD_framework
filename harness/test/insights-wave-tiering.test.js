import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWaveTiering, formatWaveTiering, TIERING_MIN_FEATURES } from '../insights-wave-tiering.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..', 'insights-wave-tiering.js');
const FIXTURES = join(HERE, 'fixtures', 'insights');
const GOLDEN = readFileSync(join(HERE, 'fixtures', 'insights-parity', 'golden.txt'), 'utf8');
const FIXTURE_NAMES = ['enriched', 'legacy', 'mixed', 'provider', 'tiered'];
const EMPTY_RESULT = {
  noWaveData: true, advisory: false, minFeatures: TIERING_MIN_FEATURES, features: 0, positions: [],
};

const makeTmp = () => mkdtempSync(join(tmpdir(), 'insights-tiering-'));
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

/** A state dir with one events.jsonl per `{ feature: text }` entry. */
function stateDirWithLogs(logs) {
  const dir = makeTmp();
  for (const [feature, text] of Object.entries(logs)) {
    mkdirSync(join(dir, feature));
    writeFileSync(join(dir, feature, 'events.jsonl'), text);
  }
  return dir;
}

function goldenSection(name) {
  const m = GOLDEN.split(`=== 4f:${name} ===\n`)[1];
  return m.split(/^=== .* ===\n/m)[0];
}

const logOf = (...events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const attempt = (feature, wave, outcome) => ({ type: 'wave-attempt', feature, data: { wave, outcome } });

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

test('TIERING_MIN_FEATURES is 3', () => {
  assert.equal(TIERING_MIN_FEATURES, 3);
});

test('edge: missing state dir -> noWaveData, advisory off, exit 0', () => {
  withTmp(makeTmp(), (dir) => assert.deepStrictEqual(JSON.parse(run(join(dir, 'absent'))), EMPTY_RESULT));
});

test('edge: empty events.jsonl -> noWaveData, no positions', () => {
  withTmp(stateDirWithLogs({ f: '' }), (dir) => assert.deepStrictEqual(buildWaveTiering(dir), EMPTY_RESULT));
});

test('edge: attempts missing feature, data or wave cannot be placed -> noWaveData', () => {
  const log = logOf(
    { type: 'wave-attempt', data: { wave: 1, outcome: 'success' } },
    { type: 'wave-attempt', feature: 'f' },
    { type: 'wave-attempt', feature: 'f', data: { outcome: 'success' } },
  );
  withTmp(stateDirWithLogs({ f: log }), (dir) => assert.deepStrictEqual(buildWaveTiering(dir), EMPTY_RESULT));
});

test('edge: zero first-attempt successes and zero retries -> 0 percentages, not NaN', () => {
  const log = logOf(attempt('f', 1, 'fail-tests'));
  withTmp(stateDirWithLogs({ f: log }), (dir) => {
    assert.deepStrictEqual(buildWaveTiering(dir).positions, [
      { wave: 1, n: 1, attempts: 1, firstAttemptSuccessPct: 0, retryPct: 0 },
    ]);
  });
});

test('edge: non-array/non-object data fields are ignored, not thrown on', () => {
  const log = logOf(
    { type: 'wave-attempt', feature: 'f', data: [] },
    { type: 'wave-attempt', feature: 'f', data: 'nope' },
    { type: 'wave-attempt', feature: 'f', data: { wave: [1], outcome: 'success' } },
  );
  withTmp(stateDirWithLogs({ f: log }), (dir) => assert.deepStrictEqual(buildWaveTiering(dir), EMPTY_RESULT));
});

test('edge: percentages are rounded integers (1 of 8 = 12.5% -> 13)', () => {
  const events = [];
  for (let i = 0; i < 8; i += 1) events.push(attempt(`f${i}`, 1, i === 0 ? 'success' : 'fail-tests'));
  const logs = Object.fromEntries(events.map((e) => [e.feature, logOf(e)]));
  withTmp(stateDirWithLogs(logs), (dir) => {
    assert.equal(buildWaveTiering(dir).positions[0].firstAttemptSuccessPct, 13);
  });
});

test('edge: advisory flips at exactly TIERING_MIN_FEATURES features', () => {
  const logs = {};
  for (let i = 1; i <= TIERING_MIN_FEATURES; i += 1) {
    logs[`f${i}`] = logOf(attempt(`f${i}`, 1, 'success'));
    withTmp(stateDirWithLogs(logs), (dir) => {
      const out = buildWaveTiering(dir);
      assert.equal(out.features, i);
      assert.equal(out.advisory, i >= TIERING_MIN_FEATURES);
    });
  }
});

test('edge: a valid-JSON null line fails closed with a non-zero exit naming file and line', () => {
  withTmp(stateDirWithLogs({ bad: 'null\n' }), (dir) => {
    const r = runRaw(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /events\.jsonl:1/);
  });
});

test('edge: a malformed log line fails closed with a non-zero exit', () => {
  withTmp(stateDirWithLogs({ bad: '{not json\n' }), (dir) => assert.notEqual(runRaw(dir).status, 0));
});

test('format: formatWaveTiering is two-space pretty-printed JSON', () => {
  assert.equal(formatWaveTiering(EMPTY_RESULT), JSON.stringify(EMPTY_RESULT, null, 2));
});
