import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPromptSurfaces, formatPromptSurfaces, PROMPT_SURFACE_MAP, PROMPT_SIGNAL_THRESHOLD,
} from '../insights-prompt-surfaces.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..', 'insights-prompt-surfaces.js');
const FIXTURES = join(HERE, 'fixtures', 'insights');
const ROUTED = join(HERE, 'fixtures', 'insights-parity', 'prompt-surfaces');
const GOLDEN = readFileSync(join(HERE, 'fixtures', 'insights-parity', 'golden.txt'), 'utf8');
const FIXTURE_NAMES = ['enriched', 'legacy', 'mixed', 'provider', 'tiered'];
const ZERO_SECTION = { threshold: 3, noWaveData: true, noEnrichedData: true, proposals: [], unmapped: [] };

const makeTmp = () => mkdtempSync(join(tmpdir(), 'insights-surfaces-'));
const withTmp = (dir, fn) => { try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

/** Run the module; returns stdout (asserts a clean exit). */
function run(stateDir) {
  const r = spawnSync(process.execPath, [MODULE], { env: { ...process.env, RAD_STATE_DIR: stateDir }, encoding: 'utf8' });
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

/** A state dir with one feature whose events.jsonl holds the given raw text. */
function stateDirWithLog(feature, text) {
  const dir = makeTmp();
  mkdirSync(join(dir, feature));
  writeFileSync(join(dir, feature, 'events.jsonl'), text);
  return dir;
}

function goldenSection(name) {
  return GOLDEN.split(`=== 4g:${name} ===\n`)[1].split(/^=== .* ===\n/m)[0];
}

const attempt = (outcome, extra = {}) => ({ type: 'wave-attempt', data: { wave: 1, outcome, ...extra } });
const times = (n, event) => Array.from({ length: n }, () => event);
const jsonl = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

for (const name of FIXTURE_NAMES) {
  test(`parity: ${name} fixture matches the golden from the old inline snippet`, () => {
    withTmp(stateDirWith([name]), (dir) => assert.equal(run(dir), goldenSection(name)));
  });
}

test('parity: all fixtures together and an empty state dir match the golden', () => {
  withTmp(stateDirWith(FIXTURE_NAMES), (dir) => assert.equal(run(dir), goldenSection('all')));
  withTmp(makeTmp(), (dir) => assert.equal(run(dir), goldenSection('empty')));
});

test('parity: the routed fixture (proposals + unmapped signals) matches the golden', () => {
  assert.equal(run(ROUTED), goldenSection('routed'));
});

test('edge: missing state dir -> zero section, exit 0', () => {
  assert.deepStrictEqual(JSON.parse(run(join(tmpdir(), 'insights-surfaces-no-state'))), ZERO_SECTION);
});

test('edge: empty events.jsonl contributes nothing', () => {
  withTmp(stateDirWithLog('f', ''), (dir) => assert.deepStrictEqual(JSON.parse(run(dir)), ZERO_SECTION));
});

test('edge: an event missing its feature field is attributed to the state-dir name', () => {
  withTmp(stateDirWithLog('stamped', jsonl(times(3, attempt('fail-protocol')))), (dir) => {
    const out = JSON.parse(run(dir));
    assert.equal(out.proposals.length, 1);
    assert.equal(out.proposals[0].signal, 'outcome:fail-protocol');
    assert.deepStrictEqual(out.proposals[0].features, { stamped: 3 });
  });
});

test('edge: an attempt missing its outcome is never a failure signal', () => {
  const log = jsonl(times(4, { type: 'wave-attempt', data: { wave: 1 } }));
  withTmp(stateDirWithLog('f', log), (dir) => {
    const out = JSON.parse(run(dir));
    assert.deepStrictEqual(out.proposals, []);
    assert.deepStrictEqual(out.unmapped, []);
  });
});

test('edge: zero counts -> threshold echoed, both degradation flags set, no signals', () => {
  assert.deepStrictEqual(buildPromptSurfaces({}), ZERO_SECTION);
  assert.deepStrictEqual(buildPromptSurfaces({ f: [] }), ZERO_SECTION);
});

test('edge: non-array tasks field is not enriched data and yields no blocked signal', () => {
  const history = times(4, attempt('success', { tasks: 'not-an-array' }));
  const out = buildPromptSurfaces({ f: history });
  assert.equal(out.noWaveData, false);
  assert.equal(out.noEnrichedData, true);
  assert.deepStrictEqual(out.proposals, []);
  assert.deepStrictEqual(out.unmapped, []);
});

test('edge: a non-array history is ignored by the folds', () => {
  assert.deepStrictEqual(buildPromptSurfaces({ f: 'nope', g: null }), ZERO_SECTION);
});

test('edge: signals below the threshold render in neither list', () => {
  const history = times(PROMPT_SIGNAL_THRESHOLD - 1, attempt('fail-protocol'));
  const out = buildPromptSurfaces({ f: history });
  assert.deepStrictEqual([out.proposals, out.unmapped], [[], []]);
});

test('unmapped: a reason with no PROMPT_SURFACE_MAP row is listed explicitly, never proposed', () => {
  assert.equal(PROMPT_SURFACE_MAP['outcome:fail-tests'], undefined);
  const history = times(PROMPT_SIGNAL_THRESHOLD, { ...attempt('fail-tests'), feature: 'x' });
  const out = buildPromptSurfaces({ f: history });
  assert.deepStrictEqual(out.proposals, []);
  assert.deepStrictEqual(out.unmapped, [{ signal: 'outcome:fail-tests', count: 3, features: { x: 3 } }]);
});

test('mapped: every PROMPT_SURFACE_MAP row carries a target, section and note key', () => {
  for (const row of Object.values(PROMPT_SURFACE_MAP)) {
    assert.deepStrictEqual(Object.keys(row).sort(), ['note', 'section', 'target']);
  }
});

test('edge: a malformed log line fails closed with a non-zero exit', () => {
  withTmp(stateDirWithLog('bad', '{not json\n'), (dir) => {
    const r = spawnSync(process.execPath, [MODULE], { env: { ...process.env, RAD_STATE_DIR: dir }, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
  });
});

test('formatPromptSurfaces is 2-space JSON without a trailing newline', () => {
  assert.equal(formatPromptSurfaces({ a: 1 }), '{\n  "a": 1\n}');
});
