import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProviderSpend, formatProviderSpend } from '../insights-provider-spend.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..', 'insights-provider-spend.js');
const FIXTURES = join(HERE, 'fixtures', 'insights');
const GOLDEN = readFileSync(join(HERE, 'fixtures', 'insights-parity', 'golden.txt'), 'utf8');
const FIXTURE_NAMES = ['enriched', 'legacy', 'mixed', 'provider', 'tiered'];
const EMPTY_RESULT = { groups: {}, features: 0 };

const makeTmp = () => mkdtempSync(join(tmpdir(), 'insights-provider-spend-'));
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
  const m = GOLDEN.split(`=== 4f4:${name} ===\n`)[1];
  return m.split(/^=== .* ===\n/m)[0];
}

const logOf = (...events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const attempt = (feature, outcome, n, extra = {}) => ({
  type: 'wave-attempt', feature, data: { wave: 1, outcome, attempt: n, ...extra },
});
const tagged = (adapter, model) => ({ agent: model ? { adapter, model } : { adapter } });

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
  withTmp(stateDirWithLogs({ f: '' }), (dir) => assert.deepStrictEqual(buildProviderSpend(dir), EMPTY_RESULT));
});

test('edge: events missing feature or data are not counted', () => {
  const log = logOf(
    { type: 'wave-attempt', data: { wave: 1, outcome: 'success' } },
    { type: 'wave-attempt', feature: 'f' },
  );
  withTmp(stateDirWithLogs({ f: log }), (dir) => assert.deepStrictEqual(buildProviderSpend(dir), EMPTY_RESULT));
});

test('edge: an attempt missing wave is still counted (provider groups key on the tag)', () => {
  const log = logOf({ type: 'wave-attempt', feature: 'f', data: { outcome: 'success', ...tagged('sdk', 'm') } });
  withTmp(stateDirWithLogs({ f: log }), (dir) => {
    assert.equal(buildProviderSpend(dir).groups['sdk/m'].attempts, 1);
  });
});

test('edge: zero passes -> passPct 0, never NaN', () => {
  withTmp(stateDirWithLogs({ f: logOf(attempt('f', 'failed', 1, tagged('sdk', 'm'))) }), (dir) => {
    const g = buildProviderSpend(dir).groups['sdk/m'];
    assert.equal(g.passPct, 0);
    assert.equal(JSON.stringify(g).includes('NaN'), false);
  });
});

test('edge: non-array/non-object data, agent and usage fields do not throw', () => {
  const log = logOf(
    { type: 'wave-attempt', feature: 'f', data: [] },
    { type: 'wave-attempt', feature: 'f', data: 'nope' },
    attempt('f', 'success', 1, { agent: 'sdk' }),
    attempt('f', 'success', 1, { agent: [], usage: [1, 2] }),
  );
  withTmp(stateDirWithLogs({ f: log }), (dir) => {
    const g = buildProviderSpend(dir).groups.unknown;
    // data: 'nope' is dropped; data: [] is an object to the fold and lands in `unknown` like the rest.
    assert.equal(g.attempts, 3);
    assert.equal(g.unknownUsage, 3);
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

test('unknown group and untagged attempt: no agent tag lands in `unknown`; tagged without model in `<adapter>/none`', () => {
  const log = logOf(attempt('f', 'success', 1), attempt('f', 'failed', 2, tagged('acp')));
  withTmp(stateDirWithLogs({ f: log }), (dir) => {
    const { groups } = buildProviderSpend(dir);
    assert.deepStrictEqual(Object.keys(groups).sort(), ['acp/none', 'unknown']);
    assert.equal(groups.unknown.passPct, 100);
    assert.equal(groups['acp/none'].retries, 1);
  });
});

test('passPct is rounded with Math.round, out of attempts', () => {
  const log = logOf(
    attempt('f', 'success', 1, tagged('sdk', 'm')),
    attempt('f', 'failed', 1, tagged('sdk', 'm')),
    attempt('f', 'failed', 2, tagged('sdk', 'm')),
  );
  withTmp(stateDirWithLogs({ f: log }), (dir) => assert.equal(buildProviderSpend(dir).groups['sdk/m'].passPct, 33));
});

test('key order: result is groups, features; each group ends with passPct', () => {
  withTmp(stateDirWithLogs({ f: logOf(attempt('f', 'success', 1, tagged('sdk', 'm'))) }), (dir) => {
    const out = buildProviderSpend(dir);
    assert.deepStrictEqual(Object.keys(out), ['groups', 'features']);
    assert.equal(Object.keys(out.groups['sdk/m']).at(-1), 'passPct');
  });
});

test('format: pretty-printed JSON with 2-space indent', () => {
  assert.equal(formatProviderSpend(EMPTY_RESULT), JSON.stringify(EMPTY_RESULT, null, 2));
});
