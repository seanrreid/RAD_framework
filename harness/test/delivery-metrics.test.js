import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REWORK_WINDOW_DAYS, resolveWindowDays, verificationLoad, reworkRate, trend,
} from '../delivery-metrics.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const at = (days) => iso(T0 + days * DAY);
const NOW = T0 + 30 * DAY;
const OPTS = { windowDays: 14, now: NOW };

const ev = (type, ts) => ({ type, ts });
const file = (path, added = 1, deleted = 0) => ({ path, added, deleted });
const merge = (over = {}) => ({
  feature: 'f', sha: 'm1', pr: 7, mergedAt: at(0), files: [file('a.js'), file('b.js')], scopedFiles: [], ...over,
});
const commit = (sha, days, touches, over = {}) => ({
  sha, committedAt: at(days), isDeliver: false, touches, ...over,
});
const touch = (path, status = 'M', oldPath) => ({ path, status, ...(oldPath ? { oldPath } : {}) });
const only = (rows) => { assert.equal(rows.length, 1); return rows[0]; };

// ── verificationLoad ────────────────────────────────────────────────────────

test('verificationLoad: merged feature with pr-opened yields files, lines and span', () => {
  const histories = { f: [ev('pr-opened', at(-1))] };
  assert.deepEqual(verificationLoad([merge({ files: [file('a.js', 3, 2), file('b.js', 4, 1)] })], histories), [
    { feature: 'f', pr: 7, merged: true, files: 2, linesChanged: 10, openedToMergeMs: DAY },
  ]);
});

test('verificationLoad: span runs from the LAST pr-opened event', () => {
  const histories = { f: [ev('pr-opened', at(-3)), ev('pr-opened', at(-1))] };
  assert.equal(only(verificationLoad([merge()], histories)).openedToMergeMs, DAY);
});

test('verificationLoad: a missing pr-opened event gives a null span', () => {
  const row = only(verificationLoad([merge()], { f: [ev('approved', at(-2))] }));
  assert.equal(row.openedToMergeMs, null);
  assert.equal(row.merged, true);
});

test('verificationLoad: a backwards span is null', () => {
  assert.equal(only(verificationLoad([merge()], { f: [ev('pr-opened', at(1))] })).openedToMergeMs, null);
});

test('verificationLoad: feature with no merged PR is listed merged:false', () => {
  const rows = verificationLoad([], { g: [ev('pr-opened', at(0))], h: [ev('approved', at(0))] });
  assert.deepEqual(rows, [
    { feature: 'g', pr: null, merged: false, files: null, linesChanged: null, openedToMergeMs: null },
  ]);
});

test('verificationLoad: binary numstat (-) counts as 0 lines', () => {
  const files = [{ path: 'img.png', added: null, deleted: null }, { path: 'x.bin', added: '-', deleted: '-' }, file('a.js', 2, 1)];
  const row = only(verificationLoad([merge({ files })], {}));
  assert.equal(row.files, 3);
  assert.equal(row.linesChanged, 3);
});

test('verificationLoad: a PR with zero changed files reports 0 files and 0 lines', () => {
  const row = only(verificationLoad([merge({ files: [] })], {}));
  assert.equal(row.files, 0);
  assert.equal(row.linesChanged, 0);
});

test('verificationLoad: empty input gives an empty array', () => {
  assert.deepEqual(verificationLoad([], {}), []);
  assert.deepEqual(verificationLoad(undefined, undefined), []);
});

// ── reworkRate ──────────────────────────────────────────────────────────────

test('reworkRate: a direct fix inside the window is rework', () => {
  const row = only(reworkRate([merge()], [commit('c1', 1, [touch('a.js')])], OPTS));
  assert.equal(row.files, 2);
  assert.equal(row.reworkedFiles, 1);
  assert.equal(row.rate, 0.5);
  assert.equal(row.reworkCommits, 1);
  assert.equal(row.windowComplete, true);
});

test('reworkRate: a PR with zero changed files has rate:null', () => {
  const row = only(reworkRate([merge({ files: [] })], [commit('c1', 1, [touch('a.js')])], OPTS));
  assert.deepEqual(row, {
    feature: 'f', files: 0, reworkedFiles: 0, rate: null, reworkCommits: 0, weightedRework: null, windowComplete: true,
  });
});

test('reworkRate: a window running past now is windowComplete:false', () => {
  const row = only(reworkRate([merge()], [], { windowDays: 14, now: T0 + 5 * DAY }));
  assert.equal(row.windowComplete, false);
  assert.equal(row.rate, 0);
});

test('reworkRate: a commit exactly at the window edge counts; one just past does not', () => {
  const edge = reworkRate([merge()], [commit('c1', 14, [touch('a.js')])], OPTS);
  assert.equal(only(edge).reworkedFiles, 1);
  const past = { sha: 'c2', committedAt: iso(T0 + 14 * DAY + 1), isDeliver: false, touches: [touch('a.js')] };
  assert.equal(only(reworkRate([merge()], [past], OPTS)).reworkedFiles, 0);
});

test('reworkRate: the merge commit itself and earlier commits are not rework', () => {
  const commits = [commit('m1', 0, [touch('a.js')]), commit('c0', -1, [touch('a.js')])];
  assert.equal(only(reworkRate([merge()], commits, OPTS)).reworkedFiles, 0);
});

test('reworkRate: a rename chain is followed back to the original file', () => {
  const commits = [
    commit('c1', 1, [touch('a2.js', 'R100', 'a.js')]),
    commit('c2', 2, [touch('a3.js', 'R090', 'a2.js')]),
    commit('c3', 3, [touch('a3.js')]),
  ];
  const row = only(reworkRate([merge()], commits, OPTS));
  assert.equal(row.reworkedFiles, 1);
  assert.equal(row.reworkCommits, 3);
});

test('reworkRate: a new file at the old path after a rename is not followed', () => {
  const commits = [commit('c1', 1, [touch('a2.js', 'R100', 'a.js')]), commit('c2', 2, [touch('a.js', 'A')])];
  const row = only(reworkRate([merge({ files: [file('a.js')] })], commits, OPTS));
  assert.equal(row.reworkCommits, 1);
});

test('reworkRate: a delete counts as a touch', () => {
  const row = only(reworkRate([merge()], [commit('c1', 2, [touch('b.js', 'D')])], OPTS));
  assert.equal(row.reworkedFiles, 1);
  assert.equal(row.reworkCommits, 1);
});

test('reworkRate: a later deliver merge is excluded only for its own scoped files', () => {
  const later = merge({ feature: 'g', sha: 'm2', mergedAt: at(3), files: [file('a.js'), file('b.js')], scopedFiles: ['a.js'] });
  const commits = [commit('m2', 3, [touch('a.js'), touch('b.js')], { isDeliver: true, feature: 'g' })];
  const row = reworkRate([merge(), later], commits, OPTS)[0];
  assert.equal(row.reworkedFiles, 1);
  assert.equal(row.reworkCommits, 1);
});

test('reworkRate: a planned rename is not rework, but a later edit of the renamed file is', () => {
  const later = merge({ feature: 'g', sha: 'm2', mergedAt: at(2), files: [file('a2.js')], scopedFiles: ['a.js', 'a2.js'] });
  const commits = [
    commit('m2', 2, [touch('a2.js', 'R100', 'a.js')], { isDeliver: true, feature: 'g' }),
    commit('c1', 4, [touch('a2.js')]),
  ];
  const row = reworkRate([merge({ files: [file('a.js')] }), later], commits, OPTS)[0];
  assert.equal(row.reworkedFiles, 1);
  assert.equal(row.reworkCommits, 1);
});

test('reworkRate: .agents/ paths are excluded from the file set', () => {
  const files = [file('a.js'), file('.agents/plans/f.md'), file('.agents/state/f/events.jsonl')];
  const row = only(reworkRate([merge({ files })], [commit('c1', 1, [touch('.agents/plans/f.md')])], OPTS));
  assert.equal(row.files, 1);
  assert.equal(row.reworkedFiles, 0);
  assert.equal(row.rate, 0);
});

test('reworkRate: weighting favours a day-0 touch over a near-edge touch', () => {
  const day0 = { sha: 'c1', committedAt: iso(T0 + 1), isDeliver: false, touches: [touch('a.js')] };
  const near = commit('c2', 13, [touch('a.js')]);
  const early = only(reworkRate([merge({ files: [file('a.js')] })], [day0], OPTS)).weightedRework;
  const late = only(reworkRate([merge({ files: [file('a.js')] })], [near], OPTS)).weightedRework;
  assert.ok(Math.abs(early - 1) < 1e-6, `day-0 weight ≈ 1, got ${early}`);
  assert.ok(Math.abs(late - 1 / 14) < 1e-9, `day-13 weight = 1/14, got ${late}`);
  const both = only(reworkRate([merge()], [day0, near], OPTS));
  assert.ok(Math.abs(both.weightedRework - (early + late) / 2) < 1e-9);
});

test('reworkRate: an unparseable mergedAt yields null rates and an incomplete window', () => {
  const row = only(reworkRate([merge({ mergedAt: 'not-a-date' })], [commit('c1', 1, [touch('a.js')])], OPTS));
  assert.equal(row.rate, null);
  assert.equal(row.windowComplete, false);
});

test('reworkRate: empty input gives an empty array', () => {
  assert.deepEqual(reworkRate([], [], OPTS), []);
  assert.deepEqual(reworkRate(undefined, undefined, OPTS), []);
});

// ── trend ───────────────────────────────────────────────────────────────────

test('trend: 0 and 1 values are flat with their sample size', () => {
  assert.deepEqual(trend([]), { arrow: '→', n: 0 });
  assert.deepEqual(trend([0.4]), { arrow: '→', n: 1 });
  assert.deepEqual(trend(undefined), { arrow: '→', n: 0 });
});

test('trend: 2+ values compare the older half with the newer half', () => {
  assert.deepEqual(trend([0.1, 0.5]), { arrow: '↑', n: 2 });
  assert.deepEqual(trend([0.5, 0.1]), { arrow: '↓', n: 2 });
  assert.deepEqual(trend([0.2, 0.2]), { arrow: '→', n: 2 });
  assert.deepEqual(trend([1, 1, 9, 2, 2]), { arrow: '↑', n: 5 });
});

test('trend: no tolerance — any difference moves the arrow', () => {
  assert.deepEqual(trend([0.5, 0.5000001]), { arrow: '↑', n: 2 });
});

test('trend: nulls are dropped before splitting', () => {
  assert.deepEqual(trend([null, 0.1, null, 0.5]), { arrow: '↑', n: 2 });
  assert.deepEqual(trend([null, 0.3, null]), { arrow: '→', n: 1 });
});

// ── resolveWindowDays ───────────────────────────────────────────────────────

test('resolveWindowDays: unset, 0, negative and NaN fall back to the default', () => {
  assert.equal(DEFAULT_REWORK_WINDOW_DAYS, 14);
  assert.equal(resolveWindowDays({}), 14);
  assert.equal(resolveWindowDays(undefined), 14);
  assert.equal(resolveWindowDays({ RAD_REWORK_WINDOW_DAYS: '0' }), 14);
  assert.equal(resolveWindowDays({ RAD_REWORK_WINDOW_DAYS: '-3' }), 14);
  assert.equal(resolveWindowDays({ RAD_REWORK_WINDOW_DAYS: 'abc' }), 14);
});

test('resolveWindowDays: a positive integer is used', () => {
  assert.equal(resolveWindowDays({ RAD_REWORK_WINDOW_DAYS: '7' }), 7);
});
