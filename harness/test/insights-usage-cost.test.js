import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTokenCost } from '../insights-usage-cost.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..', 'insights-usage-cost.js');
const FIXTURES = join(HERE, 'fixtures', 'insights');
const GOLDEN = readFileSync(join(HERE, 'fixtures', 'insights-parity', 'golden.txt'), 'utf8');
const FIXTURE_NAMES = ['enriched', 'legacy', 'mixed', 'provider', 'tiered'];
const WAVES_PREFIX = '# waves ';

const makeTmp = () => mkdtempSync(join(tmpdir(), 'insights-usage-'));
const withTmp = (dir, fn) => { try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

function runRaw(stateDir) {
  const env = { ...process.env, RAD_STATE_DIR: stateDir };
  return spawnSync(process.execPath, [MODULE], { env, encoding: 'utf8' });
}

function run(stateDir) {
  const r = runRaw(stateDir);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
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
  const m = GOLDEN.split(`=== 4b:${name} ===\n`)[1];
  return m.split(/^=== .* ===\n/m)[0];
}

/** Parse the old jq output: `feature<TAB>total` lines, then `# waves <f>` blocks of `wave<TAB>sum`. */
function parseGolden(text) {
  const totals = {};
  const waves = {};
  let current = null;
  for (const line of text.split('\n').filter(Boolean)) {
    if (line.startsWith(WAVES_PREFIX)) { current = line.slice(WAVES_PREFIX.length); waves[current] = []; continue; }
    const [key, value] = line.split('\t');
    if (current === null) totals[key] = Number(value);
    else waves[current].push({ wave: key, total: Number(value) });
  }
  return { totals, waves };
}

function assertMatchesGolden(out, name) {
  const { totals, waves } = parseGolden(goldenSection(name));
  assert.deepStrictEqual(Object.keys(out.perFeature), Object.keys(totals));
  for (const [feature, cost] of Object.entries(out.perFeature)) {
    assert.equal(cost.total, totals[feature], `${feature} total`);
    assert.deepStrictEqual(cost.perWave, waves[feature], `${feature} per-wave`);
  }
}

const logOf = (...events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const attempt = (data, extra = {}) => ({ type: 'wave-attempt', feature: 'f', data, ...extra });

for (const name of FIXTURE_NAMES) {
  test(`parity: ${name} fixture numerically equals the old jq output`, () => {
    withTmp(stateDirWith([name]), (dir) => assertMatchesGolden(run(dir), name));
  });
}

test('parity: all fixtures together numerically equal the old jq output', () => {
  withTmp(stateDirWith(FIXTURE_NAMES), (dir) => assertMatchesGolden(run(dir), 'all'));
});

test('parity: an empty state dir equals the old (empty) jq output', () => {
  withTmp(makeTmp(), (dir) => {
    const out = run(dir);
    assertMatchesGolden(out, 'empty');
    assert.equal(out.noData, true);
  });
});

test('edge: missing state dir -> noData, no features, exit 0', () => {
  assert.deepStrictEqual(run(join(tmpdir(), 'insights-usage-no-state')), { noData: true, perFeature: {} });
});

test('edge: empty events.jsonl lists the feature with zero cost and unknown usage', () => {
  withTmp(stateDirWithLog('f', ''), (dir) => {
    const out = run(dir);
    assert.equal(out.noData, false);
    assert.deepStrictEqual(out.perFeature.f, {
      total: 0, inferredTotal: 0, attempts: 0, usageRecorded: 0, usageUnknown: true, perWave: [],
    });
  });
});

test('edge: missing or null usage counts as 0 and marks usage unknown', () => {
  const log = logOf(attempt({ wave: 1 }), attempt({ wave: 1, usage: null }), attempt({ wave: 2 }));
  withTmp(stateDirWithLog('f', log), (dir) => {
    const f = buildTokenCost(dir).perFeature.f;
    assert.equal(f.total, 0);
    assert.equal(f.usageUnknown, true);
    assert.deepStrictEqual(f.perWave, [{ wave: '1', total: 0 }, { wave: '2', total: 0 }]);
  });
});

test('edge: zero totals are recorded usage, not unknown', () => {
  const log = logOf(attempt({ wave: 1, usage: { input: 0, output: 0, total: 0 } }));
  withTmp(stateDirWithLog('f', log), (dir) => {
    const f = buildTokenCost(dir).perFeature.f;
    assert.equal(f.total, 0);
    assert.equal(f.usageRecorded, 1);
    assert.equal(f.usageUnknown, false);
  });
});

test('edge: non-array/non-object fields do not break the fold (tasks, usage, data)', () => {
  const log = logOf(
    attempt({ wave: 1, tasks: 'nope', usage: { total: 10 } }),
    attempt({ wave: 1, usage: 'bad' }),
    attempt({ wave: 2, usage: { total: 'x' } }),
    { type: 'wave-attempt', feature: 'f', data: 'oops' },
  );
  withTmp(stateDirWithLog('f', log), (dir) => {
    const f = buildTokenCost(dir).perFeature.f;
    assert.equal(f.total, 10);
    assert.deepStrictEqual(f.perWave, [{ wave: '?', total: 0 }, { wave: '1', total: 10 }, { wave: '2', total: 0 }]);
  });
});

test('edge: wave number falls back to the top-level wave, then to "?"', () => {
  const log = logOf(
    { type: 'wave-attempt', feature: 'f', wave: 3, data: { usage: { total: 5 } } },
    attempt({ usage: { total: 7 } }),
  );
  withTmp(stateDirWithLog('f', log), (dir) => {
    assert.deepStrictEqual(buildTokenCost(dir).perFeature.f.perWave, [
      { wave: '?', total: 7 }, { wave: '3', total: 5 },
    ]);
  });
});

test('edge: total missing but input/output present -> total 0, inferredTotal infers it', () => {
  const log = logOf(attempt({ wave: 1, usage: { input: 80, output: 20 } }));
  withTmp(stateDirWithLog('f', log), (dir) => {
    const f = buildTokenCost(dir).perFeature.f;
    assert.equal(f.total, 0);
    assert.equal(f.inferredTotal, 100);
  });
});

test('edge: a valid-JSON null line fails closed, naming the file and line (exit non-zero)', () => {
  const log = logOf(attempt({ wave: 1, usage: { total: 1 } })) + 'null\n';
  withTmp(stateDirWithLog('f', log), (dir) => {
    const r = runRaw(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /events\.jsonl:2/);
  });
});

test('edge: malformed JSON exits non-zero', () => {
  withTmp(stateDirWithLog('f', '{not json\n'), (dir) => assert.notEqual(runRaw(dir).status, 0));
});
