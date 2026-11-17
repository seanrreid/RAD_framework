import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReworkLoad, formatReworkLoad } from '../insights-rework-load.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..', 'insights-rework-load.js');
const GOLDEN = readFileSync(join(HERE, 'fixtures', 'insights-parity', 'golden.txt'), 'utf8');

const FROZEN_NOW = Date.parse('2026-11-17T12:00:00Z');
const BASE = 'main';

const planFor = (title, paths) => `# Plan: ${title}

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
${paths.map((p) => `| ${p} | 1-10 | edit |`).join('\n')}
`;
const squashBody = (slug) => `* plan: x\n\n* approve: ${slug}\n\nPlan: .agents/plans/${slug}.md\n\n* deliver(${slug}): begin execution`;

function git(cwd, args, date) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
  if (date) { env.GIT_AUTHOR_DATE = date; env.GIT_COMMITTER_DATE = date; }
  const res = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
}

function write(root, rel, content) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function commit(root, date, message, files) {
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  git(root, ['add', '-A'], date);
  git(root, ['commit', '-q', '--allow-empty', '-m', message], date);
}

function deliver(root, date, slug, pr, files, scope = Object.keys(files)) {
  const all = { [`.agents/plans/${slug}.md`]: planFor(slug, scope), ...files };
  commit(root, date, `Deliver: ${slug} (#${pr})\n\n${squashBody(slug)}`, all);
}

const prOpened = (ts) => JSON.stringify({ type: 'pr-opened', ts }) + '\n';

/** A deterministic repo on `main`; `empty` leaves it with no commits. */
function buildRepo(root, scenario) {
  git(root, ['init', '-q', '-b', BASE]);
  if (scenario === 'empty') return;
  commit(root, '2026-09-01T10:00:00Z', 'seed', { 'shared.js': 'one\n', 'a.js': 'a\n', 'b.js': 'b\n' });
  deliver(root, '2026-09-10T10:00:00Z', 'alpha', 10, { 'a.js': 'a\nx\ny\n', 'shared.js': 'one\ntwo\n' });
  commit(root, '2026-09-12T10:00:00Z', 'fix: a', { 'a.js': 'a\nfixed\n' });
  deliver(root, '2026-10-20T10:00:00Z', 'beta', 11, { 'b.js': 'b\nz\n', 'c.js': 'c\n' });
  commit(root, '2026-10-25T10:00:00Z', 'fix: b', { 'b.js': 'b\nz\nfixed\n' });
  deliver(root, '2026-11-10T10:00:00Z', 'gamma', 12, { 'g.js': 'g\n' });
  commit(root, '2026-11-12T10:00:00Z', 'fix: g', { 'g.js': 'g\nfixed\n' });
  deliver(root, '2026-11-13T10:00:00Z', 'delta', 13, {}, []);
  const logs = {
    alpha: prOpened('2026-09-09T10:00:00Z'),
    beta: prOpened('2026-10-19T10:00:00Z'),
    gamma: prOpened('2026-11-09T22:00:00Z'),
    epsilon: prOpened('2026-11-14T10:00:00Z'),
    zeta: '',
  };
  for (const [feature, text] of Object.entries(logs)) write(root, `.agents/state/${feature}/events.jsonl`, text);
}

const STATE = (root) => join(root, '.agents', 'state');
const makeRoot = (scenario) => {
  const root = mkdtempSync(join(tmpdir(), 'insights-rework-load-'));
  buildRepo(root, scenario);
  return root;
};
const withRoot = (scenario, fn) => {
  const root = makeRoot(scenario);
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const build = (root, extra = {}) => buildReworkLoad({
  stateDir: STATE(root), root, defaultBranch: BASE, env: {}, now: FROZEN_NOW, ...extra,
});
const runModule = (root, env = {}) => spawnSync(process.execPath, [MODULE], {
  cwd: root, encoding: 'utf8', env: { ...process.env, RAD_STATE_DIR: STATE(root), DEFAULT_BRANCH: BASE, ...env },
});
const goldenSection = (name) => GOLDEN.split(`=== 4i:${name} ===\n`)[1].split(/^=== .* ===\n/m)[0];
const putLog = (root, feature, text) => write(root, `.agents/state/${feature}/events.jsonl`, text);

for (const scenario of ['populated', 'empty']) {
  test(`4i:${scenario}: output is byte-identical to the golden from the old snippet`, () => {
    withRoot(scenario, (root) => {
      assert.equal(`${formatReworkLoad(build(root))}\n`, goldenSection(scenario));
    });
  });
}

test('buildReworkLoad: result and trends keys are in contract order', () => {
  withRoot('populated', (root) => {
    const result = build(root);
    assert.deepEqual(Object.keys(result), ['noMerges', 'windowDays', 'unresolved', 'load', 'rework', 'trends']);
    assert.deepEqual(Object.keys(result.trends), ['reworkRate', 'prSize', 'reviewLatency']);
  });
});

test('direct run: stdout equals the formatted result (frozen clock not needed for an empty repo)', () => {
  withRoot('empty', (root) => {
    const r = runModule(root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, goldenSection('empty'));
  });
});

test('missing state dir: loads from git only and exits 0', () => {
  withRoot('populated', (root) => {
    rmSync(STATE(root), { recursive: true, force: true });
    const r = runModule(root);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.noMerges, false);
    assert.ok(out.load.every((row) => row.merged && row.openedToMergeMs === null));
  });
});

test('empty events.jsonl contributes nothing and an unmerged feature without pr-opened has no row', () => {
  withRoot('populated', (root) => {
    assert.equal(build(root).load.some((r) => r.feature === 'zeta'), false);
  });
});

test('an unmerged feature with a pr-opened event yields a merged:false row with null spans', () => {
  withRoot('populated', (root) => {
    const row = build(root).load.find((r) => r.feature === 'epsilon');
    assert.deepEqual(row, { feature: 'epsilon', pr: null, merged: false, files: null, linesChanged: null, openedToMergeMs: null });
  });
});

test('a merge with no product files has a null rate and weightedRework, never NaN or 0', () => {
  withRoot('populated', (root) => {
    const row = build(root).rework.find((r) => r.feature === 'delta');
    assert.equal(row.files, 0);
    assert.equal(row.rate, null);
    assert.equal(row.weightedRework, null);
  });
});

test('a pr-opened event missing its ts gives a null openedToMergeMs', () => {
  withRoot('populated', (root) => {
    putLog(root, 'alpha', `${JSON.stringify({ type: 'pr-opened' })}\n`);
    assert.equal(build(root).load.find((r) => r.feature === 'alpha').openedToMergeMs, null);
  });
});

test('a non-string ts and a non-array data field are tolerated, not counted', () => {
  withRoot('populated', (root) => {
    putLog(root, 'alpha', `${JSON.stringify({ type: 'pr-opened', ts: { not: 'a string' }, data: [1] })}\n`);
    assert.equal(build(root).load.find((r) => r.feature === 'alpha').openedToMergeMs, null);
  });
});

test('RAD_REWORK_WINDOW_DAYS is honored through resolveWindowDays', () => {
  withRoot('populated', (root) => {
    const env = { RAD_REWORK_WINDOW_DAYS: '30' };
    const result = build(root, { env });
    assert.equal(result.windowDays, 30);
    // beta merged 28 days before `now`: complete at 14 days, still open at 30.
    assert.equal(build(root).rework.find((r) => r.feature === 'beta').windowComplete, true);
    assert.equal(result.rework.find((r) => r.feature === 'beta').windowComplete, false);
    const bad = build(root, { env: { RAD_REWORK_WINDOW_DAYS: '-3' } });
    assert.equal(bad.windowDays, 14);
  });
});

test('a valid-JSON null line exits non-zero naming file:line', () => {
  withRoot('populated', (root) => {
    putLog(root, 'alpha', `${JSON.stringify({ type: 'pr-opened', ts: '2026-09-09T10:00:00Z' })}\nnull\n`);
    const r = runModule(root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /alpha[\\/]events\.jsonl:2: event is not a JSON object/);
  });
});

test('a malformed line exits non-zero', () => {
  withRoot('populated', (root) => {
    putLog(root, 'alpha', '{not json\n');
    const r = runModule(root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /JSON/);
  });
});

test('a missing DEFAULT_BRANCH exits non-zero with a message naming it', () => {
  withRoot('populated', (root) => {
    for (const value of [undefined, '']) {
      const env = { ...process.env, RAD_STATE_DIR: STATE(root) };
      delete env.DEFAULT_BRANCH;
      if (value !== undefined) env.DEFAULT_BRANCH = value;
      const r = spawnSync(process.execPath, [MODULE], { cwd: root, encoding: 'utf8', env });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /DEFAULT_BRANCH/);
    }
  });
});

test('a default branch that is not found exits non-zero with the reader message on stderr', () => {
  withRoot('populated', (root) => {
    const r = runModule(root, { DEFAULT_BRANCH: 'nope' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /default branch 'nope' not found/);
  });
});
