import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModelSpend, formatModelSpend } from '../insights-model-spend.js';
import { TIERING_MIN_FEATURES } from '../insights-wave-tiering.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..', 'insights-model-spend.js');
const FIXTURES = join(HERE, 'fixtures', 'insights');
const GOLDEN = readFileSync(join(HERE, 'fixtures', 'insights-parity', 'golden.txt'), 'utf8');
const FIXTURE_NAMES = ['enriched', 'legacy', 'mixed', 'provider', 'tiered'];
const EMPTY_RESULT = { groups: {}, features: 0, advisories: [], minFeatures: TIERING_MIN_FEATURES };

const makeTmp = () => mkdtempSync(join(tmpdir(), 'insights-model-spend-'));
const withTmp = (dir, fn) => { try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

function runRaw(stateDir) {
  const env = { ...process.env, RAD_STATE_DIR: stateDir };
  return spawnSync(process.execPath, [MODULE], { env, encoding: 'utf8' });
}

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

function stateDirWithLogs(logs) {
  const dir = makeTmp();
  for (const [feature, text] of Object.entries(logs)) {
    mkdirSync(join(dir, feature));
    writeFileSync(join(dir, feature, 'events.jsonl'), text);
  }
  return dir;
}

function goldenSection(name) {
  const m = GOLDEN.split(`=== 4f3:${name} ===\n`)[1];
  return m.split(/^=== .* ===\n/m)[0];
}

const logOf = (...events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const started = (feature, wave, model) => ({
  type: 'wave-started', feature, data: { wave, ...(model ? { model } : {}) },
});
const attempt = (feature, wave, outcome, n, usage) => ({
  type: 'wave-attempt', feature, data: { wave, outcome, attempt: n, ...(usage ? { usage } : {}) },
});
const used = (input, output) => ({ input, output });

// One single-wave feature per name; each wave passes first try on `model` (default when omitted).
function featureLogs(names, model, outcome = 'success') {
  return Object.fromEntries(names.map((f) => [f, logOf(started(f, 1, model), attempt(f, 1, outcome, 1, used(5, 5)))]));
}

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

test('edge: missing state dir -> empty groups, exit 0', () => {
  withTmp(makeTmp(), (dir) => {
    assert.deepStrictEqual(JSON.parse(run(join(dir, 'absent'))), EMPTY_RESULT);
  });
});

test('edge: empty events.jsonl -> empty result', () => {
  withTmp(stateDirWithLogs({ f: '' }), (dir) => assert.deepStrictEqual(buildModelSpend(dir), EMPTY_RESULT));
});

test('edge: events missing feature, data or wave are not placed', () => {
  const log = logOf(
    { type: 'wave-attempt', data: { wave: 1, outcome: 'success' } },
    { type: 'wave-attempt', feature: 'f' },
    { type: 'wave-attempt', feature: 'f', data: { outcome: 'success' } },
    { type: 'wave-started', feature: 'f' },
  );
  withTmp(stateDirWithLogs({ f: log }), (dir) => assert.deepStrictEqual(buildModelSpend(dir), EMPTY_RESULT));
});

test('edge: a wave with zero attempts adds no group, so no percentage is NaN', () => {
  withTmp(stateDirWithLogs({ f: logOf(started('f', 1, 'm')) }), (dir) => {
    assert.deepStrictEqual(buildModelSpend(dir), EMPTY_RESULT);
  });
});

test('edge: all-failed wave -> percentages 0 (never NaN)', () => {
  withTmp(stateDirWithLogs({ f: logOf(started('f', 1, 'm'), attempt('f', 1, 'failed', 1, used(1, 1))) }), (dir) => {
    const g = buildModelSpend(dir).groups.m;
    assert.equal(g.firstAttemptSuccessPct, 0);
    assert.equal(g.retriedPct, 0);
    assert.equal(JSON.stringify(g).includes('NaN'), false);
  });
});

test('edge: non-array/non-object data and usage fields are ignored, not thrown on', () => {
  const log = logOf(
    { type: 'wave-attempt', feature: 'f', data: [] },
    { type: 'wave-attempt', feature: 'f', data: 'nope' },
    { type: 'wave-attempt', feature: 'f', data: { wave: [1], outcome: 'success' } },
    { type: 'wave-attempt', feature: 'f', data: { wave: 1, outcome: 'success', usage: [1, 2] } },
  );
  withTmp(stateDirWithLogs({ f: log }), (dir) => {
    const g = buildModelSpend(dir).groups.unrecorded;
    assert.equal(g.waves, 1);
    assert.equal(g.unknownUsage, 1);
    assert.equal(g.meanTokens, null);
  });
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

test('meanTokens is null (not 0) when no wave in the group reported usage', () => {
  const log = logOf(started('f', 1, 'm'), attempt('f', 1, 'success', 1));
  withTmp(stateDirWithLogs({ f: log }), (dir) => {
    const g = buildModelSpend(dir).groups.m;
    assert.equal(g.meanTokens, null);
    assert.equal(g.unknownUsage, 1);
  });
});

test('meanTokens is a rounded mean over known-usage waves only', () => {
  const log = logOf(
    started('f', 1, 'm'), attempt('f', 1, 'success', 1, used(3, 4)),
    started('f', 2, 'm'), attempt('f', 2, 'success', 1),
  );
  withTmp(stateDirWithLogs({ f: log }), (dir) => {
    const g = buildModelSpend(dir).groups.m;
    assert.equal(g.tokens, 7);
    assert.equal(g.meanTokens, 7);
  });
});

test('group key order is {...g, firstAttemptSuccessPct, retriedPct, meanTokens}; result key order is fixed', () => {
  withTmp(stateDirWithLogs(featureLogs(['f'], 'm')), (dir) => {
    const out = buildModelSpend(dir);
    assert.deepStrictEqual(Object.keys(out), ['groups', 'features', 'advisories', 'minFeatures']);
    assert.deepStrictEqual(Object.keys(out.groups.m).slice(-3), ['firstAttemptSuccessPct', 'retriedPct', 'meanTokens']);
  });
});

test('advisory floor: default-group downgrade fires at exactly TIERING_MIN_FEATURES features, not one fewer', () => {
  const names = Array.from({ length: TIERING_MIN_FEATURES }, (_, i) => `f${i}`);
  withTmp(stateDirWithLogs(featureLogs(names)), (dir) => {
    const out = buildModelSpend(dir);
    assert.equal(out.advisories.length, 1);
    assert.equal(out.advisories[0].kind, 'downgrade');
    assert.equal(out.advisories[0].model, 'default');
  });
  withTmp(stateDirWithLogs(featureLogs(names.slice(1))), (dir) => {
    assert.deepStrictEqual(buildModelSpend(dir).advisories, []);
  });
});

test('unrecorded group (no wave-started) never advises, even past the floor', () => {
  const logs = Object.fromEntries(['a', 'b', 'c'].map((f) => [f, logOf(attempt(f, 1, 'success', 1, used(1, 1)))]));
  withTmp(stateDirWithLogs(logs), (dir) => {
    const out = buildModelSpend(dir);
    assert.equal(out.groups.unrecorded.features, 3);
    assert.deepStrictEqual(out.advisories, []);
  });
});

test('default group: wave-started with no model lands in `default`, a declared model in its own group', () => {
  const log = logOf(started('f', 1), attempt('f', 1, 'success', 1), started('f', 2, 'opus'), attempt('f', 2, 'success', 1));
  withTmp(stateDirWithLogs({ f: log }), (dir) => {
    assert.deepStrictEqual(Object.keys(buildModelSpend(dir).groups).sort(), ['default', 'opus']);
  });
});

test('format: pretty-printed JSON with 2-space indent', () => {
  assert.equal(formatModelSpend(EMPTY_RESULT), JSON.stringify(EMPTY_RESULT, null, 2));
});
