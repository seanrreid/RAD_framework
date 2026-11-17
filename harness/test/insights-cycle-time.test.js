import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCycleTime, formatCycleTime } from '../insights-cycle-time.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..', 'insights-cycle-time.js');
const FIXTURES = join(HERE, 'fixtures', 'insights');
const GOLDEN = readFileSync(join(HERE, 'fixtures', 'insights-parity', 'golden.txt'), 'utf8');
const FIXTURE_NAMES = ['enriched', 'legacy', 'mixed', 'provider', 'tiered'];
const NULL_DURATIONS = { approvedToStartMs: null, runMs: null, totalMs: null };
const ZERO_TOUCHES = { approvals: 0, reApprovals: 0, needsDecisionStops: 0, resumes: 0, total: 0 };
const EMPTY_RESULT = { noEventLogs: true, perFeature: {}, tokens: { perFeature: {}, mean: null } };

const makeTmp = () => mkdtempSync(join(tmpdir(), 'insights-cycle-time-'));
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
  const m = GOLDEN.split(`=== 4h:${name} ===\n`)[1];
  return m.split(/^=== .* ===\n/m)[0];
}

const logOf = (...events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const ev = (type, ts, data) => ({ type, ts, ...(data ? { data } : {}) });
const attemptWith = (usage) => ev('wave-attempt', '2026-01-01T00:00:00Z', { wave: 1, outcome: 'success', usage });

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

test('key order: noEventLogs, perFeature, tokens; each feature is durations then touches', () => {
  withTmp(stateDirWith(['enriched']), (dir) => {
    const out = buildCycleTime(dir);
    assert.deepStrictEqual(Object.keys(out), ['noEventLogs', 'perFeature', 'tokens']);
    assert.deepStrictEqual(Object.keys(out.perFeature.enriched), ['durations', 'touches']);
  });
});

test('edge: missing state dir -> empty result, exit 0', () => {
  withTmp(makeTmp(), (dir) => {
    const absent = join(dir, 'absent');
    assert.deepStrictEqual(buildCycleTime(absent), EMPTY_RESULT);
    assert.deepStrictEqual(JSON.parse(run(absent)), EMPTY_RESULT);
  });
});

test('edge: empty events.jsonl -> the feature is listed with null durations and zero touches', () => {
  withTmp(stateDirWithLogs({ f: '' }), (dir) => {
    const out = buildCycleTime(dir);
    assert.equal(out.noEventLogs, false);
    assert.deepStrictEqual(out.perFeature.f, { durations: NULL_DURATIONS, touches: ZERO_TOUCHES });
    assert.deepStrictEqual(out.tokens, { perFeature: {}, mean: null });
  });
});

test('edge: events missing ts, type or data are tolerated; durations stay null', () => {
  const log = logOf({ type: 'approved' }, { ts: '2026-01-01T00:00:00Z' }, { type: 'wave-attempt', ts: 'x' });
  withTmp(stateDirWithLogs({ f: log }), (dir) => {
    const f = buildCycleTime(dir).perFeature.f;
    assert.deepStrictEqual(f.durations, NULL_DURATIONS);
    assert.equal(f.touches.approvals, 1);
  });
});

test('edge: zero counts are real zeros in touches, never null', () => {
  withTmp(stateDirWithLogs({ f: logOf(ev('pr-opened', '2026-01-01T00:00:00Z')) }), (dir) => {
    assert.deepStrictEqual(buildCycleTime(dir).perFeature.f.touches, ZERO_TOUCHES);
  });
});

test('edge: non-array/non-object data and usage fields are ignored, not thrown on', () => {
  const log = logOf(
    ev('deliver-stopped', '2026-01-01T00:00:00Z', 'nope'),
    ev('deliver-stopped', '2026-01-01T00:00:00Z', [1]),
    ev('pr-opened', '2026-01-01T00:00:00Z'),
    attemptWith([1, 2]),
    attemptWith('lots'),
  );
  withTmp(stateDirWithLogs({ f: log }), (dir) => {
    const out = buildCycleTime(dir);
    assert.equal(out.perFeature.f.touches.needsDecisionStops, 0);
    assert.deepStrictEqual(out.tokens, { perFeature: { f: null }, mean: null });
  });
});

test('edge: an unfinished feature has null durations, never 0', () => {
  const log = logOf(ev('approved', '2026-01-01T00:00:00Z'), ev('deliver-started', '2026-01-01T01:00:00Z'));
  withTmp(stateDirWithLogs({ f: log }), (dir) => {
    const d = buildCycleTime(dir).perFeature.f.durations;
    assert.equal(d.approvedToStartMs, 3600000);
    assert.equal(d.runMs, null);
    assert.equal(d.totalMs, null);
  });
});

test('edge: a delivered feature with no usage is null and excluded from the mean', () => {
  const delivered = (usage) => logOf(ev('pr-opened', '2026-01-01T00:00:00Z'), ...(usage ? [attemptWith(usage)] : []));
  const logs = { bare: delivered(null), used: delivered({ input: 4, output: 6 }), pending: logOf(attemptWith({ total: 99 })) };
  withTmp(stateDirWithLogs(logs), (dir) => {
    assert.deepStrictEqual(buildCycleTime(dir).tokens, { perFeature: { bare: null, used: 10 }, mean: 10 });
  });
});

test('edge: a valid-JSON null line fails closed with a non-zero exit naming file and line', () => {
  withTmp(stateDirWithLogs({ bad: `${JSON.stringify(ev('approved', 't'))}\nnull\n` }), (dir) => {
    const r = runRaw(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /events\.jsonl:2/);
  });
});

test('edge: a malformed log line fails closed with a non-zero exit', () => {
  withTmp(stateDirWithLogs({ bad: '{not json\n' }), (dir) => assert.notEqual(runRaw(dir).status, 0));
});

test('format: the section is the result as 2-space-indented JSON', () => {
  assert.equal(formatCycleTime(EMPTY_RESULT), JSON.stringify(EMPTY_RESULT, null, 2));
});
