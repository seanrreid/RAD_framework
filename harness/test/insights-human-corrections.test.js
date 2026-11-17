import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHumanCorrections, formatHumanCorrections } from '../insights-human-corrections.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const MODULE = join(HERE, '..', 'insights-human-corrections.js');
const FIXTURES = join(HERE, 'fixtures', 'insights');
const GOLDEN = readFileSync(join(HERE, 'fixtures', 'insights-parity', 'golden.txt'), 'utf8');
const FIXTURE_NAMES = ['enriched', 'legacy', 'mixed', 'provider', 'tiered'];
const EMPTY_LINE = 'No human corrections recorded.';
const NO_FINDINGS = 'no-findings.jsonl';

const makeTmp = () => mkdtempSync(join(tmpdir(), 'insights-human-corrections-'));
const withTmp = (dir, fn) => { try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

// Runs from the repo root: post-deliver fixes read `git log` there. SINCE is always set so
// the caller's environment cannot leak in.
function runRaw(stateDir, { findings, since = '' } = {}) {
  const findingsFile = findings ?? join(stateDir, NO_FINDINGS);
  const env = { ...process.env, RAD_STATE_DIR: stateDir, RAD_FINDINGS_FILE: findingsFile, SINCE: since };
  return spawnSync(process.execPath, [MODULE], { env, cwd: REPO_ROOT, encoding: 'utf8' });
}

function run(stateDir, opts) {
  const r = runRaw(stateDir, opts);
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
  const m = GOLDEN.split(`=== 4j:${name} ===\n`)[1];
  return m.split(/^=== .* ===\n/m)[0];
}

const logOf = (...events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const ev = (type, ts, data) => ({ type, ts, ...(data ? { data } : {}) });
const reapprovedLog = (day) => logOf(ev('approved', '2026-01-01T00:00:00Z'), ev('approved', `${day}T12:00:00Z`));
const confirmed = (feature, date) => ({ type: 'finding', feature, date, verdict: 'confirmed', category: 'null-safety' });

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

test('edge: missing state dir -> the empty-state line, exit 0', () => {
  withTmp(makeTmp(), (dir) => assert.equal(run(join(dir, 'absent'), { findings: join(dir, 'f.jsonl') }), `${EMPTY_LINE}\n`));
});

test('edge: empty events.jsonl -> the empty-state line', () => {
  withTmp(stateDirWithLogs({ f: '' }), (dir) => assert.equal(run(dir), `${EMPTY_LINE}\n`));
});

test('edge: events missing type, ts or data are tolerated and count nothing', () => {
  const log = logOf({ type: 'approved' }, { ts: '2026-01-01T00:00:00Z' }, { type: 'run-resumed', ts: 'x' });
  withTmp(stateDirWithLogs({ f: log }), (dir) => {
    assert.equal(formatHumanCorrections(buildHumanCorrections({
      stateDir: dir, findingsFile: join(dir, NO_FINDINGS), root: REPO_ROOT,
    })).split('\n')[0], EMPTY_LINE);
  });
});

test('edge: zero counts render the empty-state line, never a zero total', () => {
  withTmp(stateDirWithLogs({ f: logOf(ev('approved', '2026-01-01T00:00:00Z')) }), (dir) => {
    assert.equal(run(dir).split('\n')[0], EMPTY_LINE);
  });
});

test('edge: non-array/non-object data and a non-object findings record are ignored', () => {
  const log = logOf(ev('run-resumed', '2026-01-01T00:00:00Z', 'nope'), ev('run-resumed', '2026-01-01T00:00:00Z', [1]));
  withTmp(stateDirWithLogs({ f: log }), (dir) => {
    const findings = join(dir, 'findings.jsonl');
    writeFileSync(findings, '[1]\n"text"\n');
    assert.equal(run(dir, { findings }).split('\n')[0], EMPTY_LINE);
  });
});

test('edge: a valid-JSON null line fails closed with a non-zero exit naming file and line', () => {
  withTmp(stateDirWithLogs({ bad: `${JSON.stringify(ev('approved', 't'))}\nnull\n` }), (dir) => {
    const r = runRaw(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /events\.jsonl: line 2/);
  });
});

test('edge: a malformed log line fails closed with a non-zero exit', () => {
  withTmp(stateDirWithLogs({ bad: '{not json\n' }), (dir) => {
    const r = runRaw(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /events\.jsonl: line 1: malformed JSON/);
  });
});

test('findings: a malformed line is skipped, stderr names file:line, exit 0, valid rows still count', () => {
  withTmp(makeTmp(), (dir) => {
    mkdirSync(join(dir, 'feat'));
    writeFileSync(join(dir, 'feat', 'events.jsonl'), logOf(ev('approved', '2026-01-01T00:00:00Z')));
    const findings = join(dir, 'findings.jsonl');
    writeFileSync(findings, `${JSON.stringify(confirmed('feat', '2026-02-03'))}\n{broken\n`);
    const r = runRaw(dir, { findings });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`skipping malformed JSON at ${findings.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:2`));
    assert.match(r.stdout, /- review-fix: 1/);
  });
});

test('findings: a confirmed review finding becomes a review-fix row', () => {
  withTmp(stateDirWithLogs({ feat: logOf(ev('approved', '2026-01-01T00:00:00Z')) }), (dir) => {
    const findings = join(dir, 'findings.jsonl');
    writeFileSync(findings, `${JSON.stringify(confirmed('feat', '2026-02-03'))}\n`);
    const out = run(dir, { findings });
    assert.match(out, /Total corrections: 1/);
    assert.match(out, /2026-02-03 review-fix — null-safety/);
  });
});

test('SINCE: a row exactly on the boundary is kept, an earlier one is dropped', () => {
  withTmp(stateDirWithLogs({ f: reapprovedLog('2026-03-02') }), (dir) => {
    assert.match(run(dir, { since: '2026-03-02' }), /Total corrections: 1/);
    assert.equal(run(dir, { since: '2026-03-03' }), `${EMPTY_LINE}\n`);
  });
});

test('SINCE: a bad value exits non-zero', () => {
  withTmp(makeTmp(), (dir) => {
    const r = runRaw(dir, { since: 'last-week' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--since must be YYYY-MM-DD/);
  });
});

test('format: the section is the fold text printed as-is', () => {
  assert.equal(formatHumanCorrections({ rows: [], counts: {}, topFeatures: [], shown: {}, unavailable: [] }), EMPTY_LINE);
});
