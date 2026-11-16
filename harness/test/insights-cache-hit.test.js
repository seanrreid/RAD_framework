import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCacheHit, formatCacheHit, NO_CACHE_LINE } from '../insights-cache-hit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..', 'insights-cache-hit.js');
const FIXTURES = join(HERE, 'fixtures', 'insights');
const GOLDEN = readFileSync(join(HERE, 'fixtures', 'insights-parity', 'golden.txt'), 'utf8');
const FIXTURE_NAMES = ['enriched', 'legacy', 'mixed', 'provider', 'tiered'];
const EMPTY_RESULT = {
  noCacheData: true, withoutCache: 0, overallRatioPct: null,
  totals: { cacheRead: 0, input: 0 }, attempts: [], droppedToZero: [],
};

const makeTmp = () => mkdtempSync(join(tmpdir(), 'insights-cache-hit-'));
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
  const m = GOLDEN.split(`=== 4f2:${name} ===\n`)[1];
  return m.split(/^=== .* ===\n/m)[0];
}

const logOf = (...events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const attempt = (feature, wave, usage) => ({
  type: 'wave-attempt', feature, data: { wave, outcome: 'success', ...(usage ? { usage } : {}) },
});
const cached = (cacheRead, input) => ({ cacheRead, input });

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

test('edge: missing state dir -> degradation line then empty result, exit 0', () => {
  withTmp(makeTmp(), (dir) => {
    const out = run(join(dir, 'absent'));
    assert.equal(out.split('\n')[0], NO_CACHE_LINE);
    assert.deepStrictEqual(JSON.parse(out.slice(NO_CACHE_LINE.length + 1)), EMPTY_RESULT);
  });
});

test('edge: empty events.jsonl -> empty result', () => {
  withTmp(stateDirWithLogs({ f: '' }), (dir) => assert.deepStrictEqual(buildCacheHit(dir), EMPTY_RESULT));
});

test('edge: attempts missing feature, data or wave are not placed', () => {
  const log = logOf(
    { type: 'wave-attempt', data: { wave: 1, usage: cached(5, 5) } },
    { type: 'wave-attempt', feature: 'f' },
    { type: 'wave-attempt', feature: 'f', data: { usage: cached(5, 5) } },
  );
  withTmp(stateDirWithLogs({ f: log }), (dir) => assert.deepStrictEqual(buildCacheHit(dir), EMPTY_RESULT));
});

test('edge: attempt without usage.cacheRead counts as withoutCache, not a ratio', () => {
  withTmp(stateDirWithLogs({ f: logOf(attempt('f', 1, null)) }), (dir) => {
    const out = buildCacheHit(dir);
    assert.equal(out.withoutCache, 1);
    assert.equal(out.noCacheData, true);
    assert.deepStrictEqual(out.attempts, []);
  });
});

test('edge: zero cacheRead and zero input -> ratioPct null and overallRatioPct null, not 0 or NaN', () => {
  withTmp(stateDirWithLogs({ f: logOf(attempt('f', 1, cached(0, 0))) }), (dir) => {
    const out = buildCacheHit(dir);
    assert.equal(out.noCacheData, false);
    assert.equal(out.attempts[0].ratioPct, null);
    assert.equal(out.overallRatioPct, null);
    assert.deepStrictEqual(out.droppedToZero, []);
  });
});

test('edge: non-array/non-object data and usage fields are ignored, not thrown on', () => {
  const log = logOf(
    { type: 'wave-attempt', feature: 'f', data: [] },
    { type: 'wave-attempt', feature: 'f', data: 'nope' },
    { type: 'wave-attempt', feature: 'f', data: { wave: 1, usage: [1, 2] } },
    { type: 'wave-attempt', feature: 'f', data: { wave: [1], usage: cached(5, 5) } },
  );
  withTmp(stateDirWithLogs({ f: log }), (dir) => {
    const out = buildCacheHit(dir);
    assert.equal(out.noCacheData, true);
    assert.deepStrictEqual(out.attempts, []);
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

test('droppedToZero: a zero ratio after a positive first attempt is flagged with earlierPeakPct last', () => {
  const log = logOf(attempt('f', 1, cached(3, 1)), attempt('f', 1, cached(0, 4)));
  withTmp(stateDirWithLogs({ f: log }), (dir) => {
    const out = buildCacheHit(dir);
    assert.equal(out.droppedToZero.length, 1);
    assert.equal(out.droppedToZero[0].earlierPeakPct, 75);
    assert.equal(Object.keys(out.droppedToZero[0]).at(-1), 'earlierPeakPct');
    assert.equal(out.attempts[1].ratioPct, 0);
    assert.equal(Object.keys(out.attempts[1]).at(-1), 'ratioPct');
  });
});

test('droppedToZero: a zero first attempt is not a drop', () => {
  withTmp(stateDirWithLogs({ f: logOf(attempt('f', 1, cached(0, 4))) }), (dir) => {
    assert.deepStrictEqual(buildCacheHit(dir).droppedToZero, []);
  });
});

test('overallRatioPct is a rounded integer over summed input + cacheRead', () => {
  withTmp(stateDirWithLogs({ f: logOf(attempt('f', 1, cached(1, 7))) }), (dir) => {
    assert.equal(buildCacheHit(dir).overallRatioPct, 13);
  });
});

test('format: the no-cache line is printed only when no attempt carries usage.cacheRead', () => {
  assert.equal(formatCacheHit(EMPTY_RESULT), `${NO_CACHE_LINE}\n${JSON.stringify(EMPTY_RESULT, null, 2)}`);
  withTmp(stateDirWithLogs({ f: logOf(attempt('f', 1, cached(1, 1))) }), (dir) => {
    const text = formatCacheHit(buildCacheHit(dir));
    assert.ok(text.startsWith('{'));
    assert.ok(!text.includes(NO_CACHE_LINE));
  });
});
