import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_ROWS_PER_FEATURE,
  TOP_FEATURES,
  buildCorrections,
  formatCorrections,
  parseEventLog,
  postDeliverFixRows,
  reapprovalRows,
  resumeAnswerRows,
  reviewFixRows,
} from '../human-corrections.js';

const approved = (ts) => ({ type: 'approved', ts });
const resumed = (context, ts = '2026-11-02T10:00:00.000Z') => ({
  type: 'run-resumed',
  ts,
  data: { context, stop: { class: 'needs-decision' } },
});
const finding = (over) => ({ type: 'finding', feature: 'f', date: '2026-11-03', category: 'testing', verdict: 'confirmed', ...over });
const deepFreeze = (v) => {
  if (v && typeof v === 'object') Object.values(v).forEach(deepFreeze);
  return Object.freeze(v);
};

test('no events at all yields no rows and the empty-state line', () => {
  assert.deepEqual(reapprovalRows('f', []), []);
  assert.deepEqual(resumeAnswerRows('f', undefined), []);
  const result = buildCorrections({ histories: { f: [] }, findings: [] });
  assert.equal(result.rows.length, 0);
  assert.equal(formatCorrections(result), 'No human corrections recorded.');
});

test('one approved event yields no reapproval row', () => {
  assert.deepEqual(reapprovalRows('f', [approved('2026-11-01T00:00:00Z')]), []);
});

test('two approved events yield one reapproval row with date and evidence', () => {
  const rows = reapprovalRows('f', [approved('2026-11-01T00:00:00Z'), approved('2026-11-04T08:00:00Z')]);
  assert.deepEqual(rows, [{ date: '2026-11-04', feature: 'f', category: 'reapproval', evidence: 'approved event #2' }]);
});

test('three approved events yield two reapproval rows', () => {
  const rows = reapprovalRows('f', [approved('2026-11-01T00:00:00Z'), approved('2026-11-02T00:00:00Z'), approved('2026-11-03T00:00:00Z')]);
  assert.deepEqual(rows.map((r) => r.evidence), ['approved event #2', 'approved event #3']);
});

test('resume with a context answer yields a row carrying the stop class', () => {
  const rows = resumeAnswerRows('f', [resumed('retry wave 2')]);
  assert.deepEqual(rows, [{ date: '2026-11-02', feature: 'f', category: 'resume-answer', evidence: 'needs-decision' }]);
});

test('resume with a missing, blank or whitespace-only context yields no row', () => {
  const events = [{ type: 'run-resumed', ts: '2026-11-02T10:00:00Z' }, resumed(''), resumed('  \n\t '), resumed(42)];
  assert.deepEqual(resumeAnswerRows('f', events), []);
});

test('malformed event line throws naming the log and the 1-based line', () => {
  const text = '{"type":"approved","ts":"2026-11-01T00:00:00Z"}\n\n{not json}\n';
  assert.throws(() => parseEventLog(text, 'a/events.jsonl'), /a\/events\.jsonl: line 3: malformed JSON/);
  assert.throws(() => parseEventLog('[1]', 'b/events.jsonl'), /b\/events\.jsonl: line 1/);
  assert.equal(parseEventLog('{"type":"x"}\n\n', 'c').length, 1);
});

test('finding with no verdict yields no review-fix row', () => {
  assert.deepEqual(reviewFixRows('f', [finding({ verdict: null })]), []);
});

test('false-alarm finding yields no review-fix row', () => {
  assert.deepEqual(reviewFixRows('f', [finding({ verdict: 'false-alarm' })]), []);
});

test('confirmed finding yields a review-fix row with its category and date', () => {
  assert.deepEqual(reviewFixRows('f', [finding({})]), [
    { date: '2026-11-03', feature: 'f', category: 'review-fix', evidence: 'testing' },
  ]);
});

test('cycle records and other features findings are not counted', () => {
  const records = [{ type: 'cycle', feature: 'f', date: '2026-11-03', verdict: 'confirmed' }, finding({ feature: 'other' })];
  assert.deepEqual(reviewFixRows('f', records), []);
});

test('empty or non-array findings yield no rows', () => {
  assert.deepEqual(reviewFixRows('f', []), []);
  assert.deepEqual(reviewFixRows('f', null), []);
});

test('rows are sorted deterministically by date, feature, category, evidence', () => {
  const histories = {
    b: [approved('2026-11-01T00:00:00Z'), approved('2026-11-05T00:00:00Z')],
    a: [approved('2026-11-01T00:00:00Z'), approved('2026-11-05T00:00:00Z'), resumed('x', '2026-11-05T01:00:00Z')],
  };
  const findings = [finding({ feature: 'a', date: '2026-11-01' })];
  const first = buildCorrections({ histories, findings });
  const second = buildCorrections({ histories: { a: histories.a, b: histories.b }, findings });
  assert.deepEqual(first, second);
  assert.deepEqual(first.rows.map((r) => `${r.date} ${r.feature} ${r.category}`), [
    '2026-11-01 a review-fix',
    '2026-11-05 a reapproval',
    '2026-11-05 a resume-answer',
    '2026-11-05 b reapproval',
  ]);
  assert.deepEqual(first.counts, { reapproval: 2, 'resume-answer': 1, 'review-fix': 1 });
});

test('top features tie on count by name and are capped at TOP_FEATURES', () => {
  const histories = {};
  for (let i = 0; i < TOP_FEATURES + 2; i += 1) {
    histories[`feat-${String.fromCharCode(103 - i)}`] = [approved('2026-11-01T00:00:00Z'), approved('2026-11-02T00:00:00Z')];
  }
  histories['feat-z'] = [approved('2026-11-01T00:00:00Z'), approved('2026-11-02T00:00:00Z'), approved('2026-11-03T00:00:00Z')];
  const { topFeatures } = buildCorrections({ histories });
  assert.equal(topFeatures.length, TOP_FEATURES);
  assert.deepEqual(topFeatures[0], { feature: 'feat-z', count: 2 });
  assert.deepEqual(topFeatures.slice(1).map((t) => t.feature), ['feat-a', 'feat-b', 'feat-c', 'feat-d']);
});

test('shown rows per feature are capped at MAX_ROWS_PER_FEATURE', () => {
  const events = Array.from({ length: MAX_ROWS_PER_FEATURE + 3 }, (_, i) => approved(`2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z`));
  const result = buildCorrections({ histories: { f: events } });
  assert.equal(result.rows.length, MAX_ROWS_PER_FEATURE + 2);
  assert.equal(result.shown.f.length, MAX_ROWS_PER_FEATURE);
});

test('--since keeps the boundary day and later, drops the day before', () => {
  const histories = { f: [approved('2026-11-01T00:00:00Z'), approved('2026-11-09T23:59:59Z'), approved('2026-11-10T00:00:00Z'), approved('2026-11-11T00:00:00Z')] };
  const days = (since) => buildCorrections({ histories, since }).rows.map((r) => r.date);
  assert.deepEqual(days('2026-11-10'), ['2026-11-10', '2026-11-11']);
  assert.deepEqual(days('2026-11-11'), ['2026-11-11']);
  assert.deepEqual(days('2026-11-09'), ['2026-11-09', '2026-11-10', '2026-11-11']);
  assert.throws(() => buildCorrections({ histories, since: '11/10/2026' }), /--since must be YYYY-MM-DD/);
});

test('formatCorrections prints counts, top features and unavailable features', () => {
  const histories = { f: [approved('2026-11-01T00:00:00Z'), approved('2026-11-02T00:00:00Z')] };
  const postDeliver = { f: { rows: [], unavailable: 'no pr-opened event' } };
  const text = formatCorrections(buildCorrections({ histories, postDeliver }));
  assert.match(text, /By category:\n- reapproval: 1/);
  assert.match(text, /Top features:\n- f: 1\n {2}- 2026-11-02 reapproval — approved event #2/);
  assert.match(text, /Unavailable: f \(no pr-opened event\)/);
});

test('the folds do not mutate frozen inputs', () => {
  const histories = deepFreeze({ f: [approved('2026-11-01T00:00:00Z'), approved('2026-11-02T00:00:00Z'), resumed('x')] });
  const findings = deepFreeze([finding({})]);
  assert.doesNotThrow(() => formatCorrections(buildCorrections({ histories, findings, since: '2026-11-01' })));
});

// --- post-deliver fixes (AC#4) -------------------------------------------

function git(cwd, args, env = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
}

function commitAt(root, subject, iso) {
  git(root, ['commit', '-q', '--allow-empty', '-m', subject], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
}

function withFeatureRepo(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rad-corrections-'));
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'dev@example.com']);
    git(root, ['config', 'user.name', 'Dev']);
    git(root, ['checkout', '-q', '-b', 'rad/feat']);
    commitAt(root, 'plan: feat', '2026-11-01T10:00:00Z');
    commitAt(root, 'deliver(feat): task', '2026-11-02T10:00:00Z');
    commitAt(root, 'same second fix', '2026-11-03T10:00:00Z');
    commitAt(root, 'fix: later bug', '2026-11-03T10:00:01Z');
    commitAt(root, 'approve: feat', '2026-11-04T10:00:00Z');
    commitAt(root, 'review: notes', '2026-11-04T11:00:00Z');
    commitAt(root, 'deliver(feat): late task', '2026-11-04T12:00:00Z');
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const opened = { type: 'pr-opened', ts: '2026-11-03T10:00:00.900Z' };

test('post-deliver fixes count commits strictly after pr-opened, skipping harness subjects', () => {
  withFeatureRepo((root) => {
    const { rows, unavailable } = postDeliverFixRows('feat', [opened], { root });
    assert.equal(unavailable, null);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].category, 'post-deliver-fix');
    assert.equal(rows[0].date, '2026-11-03');
    assert.match(rows[0].evidence, /^[0-9a-f]+ fix: later bug$/);
  });
});

test('a missing branch ref or missing pr-opened is unavailable, not an error', () => {
  withFeatureRepo((root) => {
    assert.match(postDeliverFixRows('nobranch', [opened], { root }).unavailable, /no rad\/nobranch branch ref/);
    assert.match(postDeliverFixRows('feat', [], { root }).unavailable, /no pr-opened event/);
    assert.throws(() => postDeliverFixRows('../evil', [opened], { root }), /invalid feature slug/);
  });
});
