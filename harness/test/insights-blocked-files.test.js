import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBlockedFiles, formatBlockedFiles, taskFilesFromPlansDir } from '../insights-blocked-files.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..', 'insights-blocked-files.js');
const FIXTURES = join(HERE, 'fixtures', 'insights');
const PLANS = join(HERE, 'fixtures', 'insights-parity', 'plans');
const GOLDEN = readFileSync(join(HERE, 'fixtures', 'insights-parity', 'golden.txt'), 'utf8');
const FIXTURE_NAMES = ['enriched', 'legacy', 'mixed', 'provider', 'tiered'];
const NO_PLANS = join(tmpdir(), 'insights-blocked-no-plans-dir');
const ZERO_DEFICITS = { files: {}, unattributable: 0, unenriched: 0, belowFloor: 0, minFeatures: 2 };
const ZERO_SECTION = {
  mappedTitles: 0, reportedFiles: 0, files: {}, belowFloor: 0, minFeatures: 2, deficits: ZERO_DEFICITS,
};

const makeTmp = () => mkdtempSync(join(tmpdir(), 'insights-blocked-'));

/** Run the module; returns stdout (asserts a clean exit). */
function run(stateDir, plansDir) {
  const env = { ...process.env, RAD_STATE_DIR: stateDir, RAD_PLANS_DIR: plansDir };
  const r = spawnSync(process.execPath, [MODULE], { env, encoding: 'utf8' });
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
  const m = GOLDEN.split(`=== 4e:${name} ===\n`)[1];
  return m.split(/^=== .* ===\n/m)[0];
}

const attempt = (feature, tasks) => ({ type: 'wave-attempt', feature, data: { wave: 1, outcome: 'fail-tests', tasks } });
const blocked = (title) => ({ title, status: 'blocked_code' });
const withTmp = (dir, fn) => { try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

for (const name of FIXTURE_NAMES) {
  test(`parity: ${name} fixture matches the golden from the old inline snippet`, () => {
    withTmp(stateDirWith([name]), (dir) => assert.equal(run(dir, PLANS), goldenSection(name)));
  });
}

test('parity: all fixtures together match the golden, with and without plan docs', () => {
  withTmp(stateDirWith(FIXTURE_NAMES), (dir) => {
    assert.equal(run(dir, PLANS), goldenSection('all'));
    assert.equal(run(dir, NO_PLANS), goldenSection('all-noplans'));
  });
});

test('parity: an empty state dir matches the golden', () => {
  withTmp(makeTmp(), (dir) => assert.equal(run(dir, PLANS), goldenSection('empty')));
});

test('edge: missing state dir -> zero section naming the mapped titles, exit 0', () => {
  const out = JSON.parse(run(join(tmpdir(), 'insights-blocked-no-state'), PLANS));
  assert.deepStrictEqual(out, { ...ZERO_SECTION, mappedTitles: 3 });
});

test('edge: empty events.jsonl contributes nothing', () => {
  withTmp(stateDirWithLog('f', ''), (dir) => {
    assert.deepStrictEqual(JSON.parse(run(dir, PLANS)), { ...ZERO_SECTION, mappedTitles: 3 });
  });
});

test('edge: an event missing its feature is stamped from the dir name', () => {
  const log = JSON.stringify({ type: 'wave-attempt', data: { wave: 1, tasks: [blocked('T')] } }) + '\n';
  withTmp(stateDirWithLog('stamped', log), (dir) => {
    const out = JSON.parse(run(dir, NO_PLANS));
    // Unmapped title: counted as unattributable, so the feature stamp reached the fold.
    assert.equal(out.deficits.unattributable, 1);
    assert.equal(out.reportedFiles, 0);
  });
});

test('edge: a blocked task with no plan file is unattributable, never dropped', () => {
  const history = [attempt('a', [blocked('Orphan task')])];
  const out = buildBlockedFiles(history, {});
  assert.equal(out.mappedTitles, 0);
  assert.equal(out.deficits.unattributable, 1);
  assert.deepStrictEqual(out.files, {});
});

test('edge: zero counts -> floors echoed, every count zero', () => {
  assert.deepStrictEqual(buildBlockedFiles([], {}), ZERO_SECTION);
});

test('edge: non-array tasks field and non-object entries are ignored', () => {
  const history = [
    attempt('a', 'not-an-array'),
    attempt('b', { title: 'T', status: 'blocked_code' }),
    attempt('c', [null, 7, 'x']),
    null,
  ];
  // The two attempts whose `tasks` is not an array are pre-enrichment (unenriched); nothing is attributed.
  assert.deepStrictEqual(buildBlockedFiles(history, { T: ['t.js'] }), {
    ...ZERO_SECTION, mappedTitles: 1, deficits: { ...ZERO_DEFICITS, unenriched: 2 },
  });
});

test('edge: a malformed log line fails closed with a non-zero exit', () => {
  withTmp(stateDirWithLog('bad', '{not json\n'), (dir) => {
    const env = { ...process.env, RAD_STATE_DIR: dir, RAD_PLANS_DIR: NO_PLANS };
    const r = spawnSync(process.execPath, [MODULE], { env, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
  });
});

test('taskFilesFromPlansDir: missing dir -> {}, fixture plan maps titles to paths', () => {
  assert.deepStrictEqual(taskFilesFromPlansDir(NO_PLANS), {});
  assert.deepStrictEqual(taskFilesFromPlansDir(PLANS)['Add blocked-task fold'], ['harness/events.js', 'harness/test/events.test.js']);
});

test('formatBlockedFiles is 2-space JSON without a trailing newline', () => {
  assert.equal(formatBlockedFiles({ a: 1 }), '{\n  "a": 1\n}');
});
