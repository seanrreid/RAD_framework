import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReliability, formatReliability, spendPerWave } from '../insights-reliability.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..', 'insights-reliability.js');
const FIXTURES = join(HERE, 'fixtures', 'insights');
const GOLDEN = readFileSync(join(HERE, 'fixtures', 'insights-parity', 'golden.txt'), 'utf8');
const FIXTURE_NAMES = ['enriched', 'legacy', 'mixed', 'provider', 'tiered'];

const makeTmp = () => mkdtempSync(join(tmpdir(), 'insights-rel-'));
const attempt = (data) => ({ type: 'wave-attempt', feature: 'f', data });

/** Run the module against a state dir; returns stdout (asserts a clean exit). */
function run(stateDir) {
  const r = spawnSync(process.execPath, [MODULE], { env: { ...process.env, RAD_STATE_DIR: stateDir }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** A state dir holding the named fixtures as feature dirs (same layout the golden used). */
function stateDirWith(names) {
  const dir = makeTmp();
  for (const n of names) {
    mkdirSync(join(dir, n));
    copyFileSync(join(FIXTURES, n, 'events.jsonl'), join(dir, n, 'events.jsonl'));
  }
  return dir;
}

function goldenSection(name) {
  const m = GOLDEN.split(`=== ${name} ===\n`)[1];
  return m.split(/^=== .* ===\n/m)[0];
}

for (const name of FIXTURE_NAMES) {
  test(`parity: ${name} fixture matches the golden from the old inline snippet`, () => {
    const dir = stateDirWith([name]);
    try { assert.equal(run(dir), goldenSection(name)); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('parity: all fixtures together match the golden', () => {
  const dir = stateDirWith(FIXTURE_NAMES);
  try { assert.equal(run(dir), goldenSection('all')); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parity: an empty state dir matches the golden', () => {
  const dir = makeTmp();
  try { assert.equal(run(dir), goldenSection('empty')); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('edge: missing state dir -> noWaveData with no features, exit 0', () => {
  const out = JSON.parse(run(join(tmpdir(), 'insights-rel-does-not-exist')));
  assert.equal(out.noWaveData, true);
  assert.deepEqual(out.perFeature, {});
  assert.equal(out.aggregate.outcomes.total, 0);
});

test('edge: empty events.jsonl -> feature listed with zero counts', () => {
  const dir = makeTmp();
  try {
    mkdirSync(join(dir, 'blank'));
    writeFileSync(join(dir, 'blank', 'events.jsonl'), '');
    const out = JSON.parse(run(dir));
    assert.equal(out.noWaveData, true);
    assert.deepEqual(Object.keys(out.perFeature), ['blank']);
    assert.deepEqual(out.perFeature.blank.spendPerWave, {});
    assert.equal(out.perFeature.blank.retries.total, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('edge: missing field — attempt with no data is skipped, no wave buckets as "?", no usage is 0', () => {
  assert.deepEqual(spendPerWave([{ type: 'wave-attempt' }]), {});
  assert.deepEqual(spendPerWave([attempt({})]), { '?': 0 });
  assert.deepEqual(spendPerWave([attempt({ wave: 2 })]), { 2: 0 });
  assert.deepEqual(spendPerWave([null, { type: 'other', data: { wave: 1 } }]), {});
});

test('edge: missing field — an attempt without feature or wave still counts in retries.total', () => {
  const r = buildReliability([{ feature: 'f', history: [attempt({})] }]);
  assert.equal(r.aggregate.retries.total, 1);
  assert.equal(r.noWaveData, false);
});

test('edge: zero counts — zero usage contributes 0 and total-vs-input+output preference holds', () => {
  assert.deepEqual(spendPerWave([attempt({ wave: 1, usage: { total: 0, input: 5, output: 5 } })]), { 1: 0 });
  assert.deepEqual(spendPerWave([attempt({ wave: 1, usage: { input: 3, output: 4 } })]), { 1: 7 });
  const r = buildReliability([]);
  assert.equal(r.noWaveData, true);
  assert.equal(r.aggregate.usage.total, 0);
});

test('edge: non-array/non-object field — array or string usage and string wave are tolerated', () => {
  assert.deepEqual(spendPerWave([attempt({ wave: 1, usage: [1, 2] })]), { 1: 0 });
  assert.deepEqual(spendPerWave([attempt({ wave: 1, usage: 'lots' })]), { 1: 0 });
  assert.deepEqual(spendPerWave([attempt({ wave: '1', usage: { total: 9 } })]), { '?': 9 });
});

test('edge: non-array history entries (non-object events) do not throw', () => {
  assert.deepEqual(spendPerWave([null, 3, 'x', []]), {});
  assert.equal(buildReliability([{ feature: 'f', history: [null, 3] }]).noWaveData, true);
});

test('edge: malformed JSON in a log fails closed with a non-zero exit', () => {
  const dir = makeTmp();
  try {
    mkdirSync(join(dir, 'bad'));
    writeFileSync(join(dir, 'bad', 'events.jsonl'), '{not json}\n');
    const r = spawnSync(process.execPath, [MODULE], { env: { ...process.env, RAD_STATE_DIR: dir }, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /JSON/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('formatReliability is pretty JSON of the build result', () => {
  const r = buildReliability([]);
  assert.equal(formatReliability(r), JSON.stringify(r, null, 2));
});
