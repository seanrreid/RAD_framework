/**
 * Post-merge rework rate and Gate-2 verification load — pure, read-side folds
 * over delivery history (from delivery-history.js) and event histories. No
 * I/O, no writes, no gating: nothing here may be read to block, warn or gate a
 * command. `now` and `windowDays` are parameters; the caller supplies them.
 *
 * What counts as rework (a policy decision):
 *   - a first-parent commit inside `(mergedAt, mergedAt + windowDays]` that
 *     touches a file the deliver merge changed — followed through renames, and
 *     a delete counts as a touch;
 *   - NOT a later deliver merge touching a file in its own `scopedFiles` (that
 *     is planned work, not rework);
 *   - NOT anything under `.agents/` (process artifacts, not product files).
 * Spans and rates are `null` when an endpoint is missing, invalid, runs
 * backwards, or the denominator is zero — never a guessed 0.
 */

export const DEFAULT_REWORK_WINDOW_DAYS = 14;

const WINDOW_ENV = 'RAD_REWORK_WINDOW_DAYS';
const DAY_MS = 24 * 60 * 60 * 1000;
const PR_OPENED = 'pr-opened';
const PROCESS_ARTIFACT_PREFIX = '.agents/';
const RENAMED = 'R';
const DELETED = 'D';
const COPIED = 'C';
const ARROW = Object.freeze({ UP: '↑', DOWN: '↓', FLAT: '→' });

const list = (value) => (Array.isArray(value) ? value : []).filter((v) => v && typeof v === 'object');

const msOf = (ts) => {
  if (typeof ts !== 'string' && typeof ts !== 'number') return null;
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
};

const spanMs = (from, to) => {
  const start = msOf(from);
  const end = msOf(to);
  if (start === null || end === null || end < start) return null;
  return end - start;
};

/** numstat reports binary files as `-`; those (and anything non-numeric) count as 0 lines. */
const lineCount = (n) => (Number.isFinite(n) ? n : 0);

const isProductPath = (path) => typeof path === 'string' && !path.startsWith(PROCESS_ARTIFACT_PREFIX);

/**
 * @param {Object<string, string|undefined>} env
 * @returns {number} a positive integer day count; unset, 0, negative or NaN → the default
 */
export function resolveWindowDays(env) {
  const parsed = Number.parseInt(env ? env[WINDOW_ENV] : undefined, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REWORK_WINDOW_DAYS;
}

function loadRow(merge, history) {
  const opened = list(history).filter((e) => e.type === PR_OPENED).at(-1);
  const files = list(merge.files);
  return {
    feature: merge.feature,
    pr: merge.pr ?? null,
    merged: true,
    files: files.length,
    linesChanged: files.reduce((sum, f) => sum + lineCount(f.added) + lineCount(f.deleted), 0),
    openedToMergeMs: opened ? spanMs(opened.ts, merge.mergedAt) : null,
  };
}

/**
 * One row per deliver merge, then one `merged:false` row per feature that
 * opened a PR but has no merge record (sorted by feature name).
 *
 * @param {Object[]} merges - readDeliveryHistory().merges
 * @param {Object<string, Object[]>} histories - feature → events
 * @returns {{ feature: string, pr: ?number, merged: boolean, files: ?number,
 *   linesChanged: ?number, openedToMergeMs: ?number }[]}
 */
export function verificationLoad(merges, histories) {
  const byFeature = histories && typeof histories === 'object' && !Array.isArray(histories) ? histories : {};
  const rows = list(merges).map((m) => loadRow(m, byFeature[m.feature]));
  const mergedFeatures = new Set(rows.map((r) => r.feature));
  const unmerged = Object.keys(byFeature)
    .filter((f) => !mergedFeatures.has(f) && list(byFeature[f]).some((e) => e.type === PR_OPENED))
    .sort();
  for (const feature of unmerged) {
    rows.push({ feature, pr: null, merged: false, files: null, linesChanged: null, openedToMergeMs: null });
  }
  return rows;
}

/** Scoped-file sets of every deliver merge, keyed by sha — the exclusion for later planned work. */
const scopedBySha = (merges) =>
  new Map(list(merges).map((m) => [m.sha, new Set(Array.isArray(m.scopedFiles) ? m.scopedFiles : [])]));

/** Commits strictly after `startMs` and at or before `endMs`, oldest first. */
function commitsInWindow(commits, excludeSha, startMs, endMs) {
  return list(commits)
    .map((c) => ({ commit: c, ms: msOf(c.committedAt) }))
    .filter(({ commit, ms }) => commit.sha !== excludeSha && ms !== null && ms > startMs && ms <= endMs)
    .sort((a, b) => a.ms - b.ms);
}

/**
 * Walk one commit's touches against `live` (current path → original path),
 * following renames and deletes. Returns the original paths touched as rework.
 */
function reworkTouches(commit, live, scoped) {
  const touched = [];
  for (const touch of list(commit.touches)) {
    const status = String(touch.status ?? '');
    // A copy leaves its source untouched: only the destination can be rework.
    const from = status.startsWith(COPIED) ? touch.path : touch.oldPath ?? touch.path;
    if (!live.has(from)) continue;
    const original = live.get(from);
    const planned = scoped && (scoped.has(touch.path) || scoped.has(from));
    if (!planned) touched.push(original);
    if (status.startsWith(RENAMED) || status.startsWith(DELETED)) live.delete(from);
    if (status.startsWith(RENAMED)) live.set(touch.path, original);
  }
  return touched;
}

function reworkRow(merge, commits, scopedIndex, windowDays, now) {
  const paths = [...new Set(list(merge.files).map((f) => f.path).filter(isProductPath))];
  const startMs = msOf(merge.mergedAt);
  const row = { feature: merge.feature, files: paths.length, reworkedFiles: 0, rate: null,
    reworkCommits: 0, weightedRework: null, windowComplete: false };
  if (startMs === null) return row;
  const windowMs = windowDays * DAY_MS;
  row.windowComplete = startMs + windowMs <= now;
  const live = new Map(paths.map((p) => [p, p]));
  const reworked = new Set();
  let weight = 0;
  for (const { commit, ms } of commitsInWindow(commits, merge.sha, startMs, startMs + windowMs)) {
    const scoped = commit.isDeliver ? scopedIndex.get(commit.sha) : undefined;
    const touched = reworkTouches(commit, live, scoped);
    if (touched.length > 0) row.reworkCommits += 1;
    for (const original of touched) {
      reworked.add(original);
      weight += 1 - (ms - startMs) / windowMs;
    }
  }
  row.reworkedFiles = reworked.size;
  if (paths.length > 0) {
    row.rate = reworked.size / paths.length;
    row.weightedRework = weight / paths.length;
  }
  return row;
}

/**
 * @param {Object[]} merges - readDeliveryHistory().merges
 * @param {Object[]} commits - readDeliveryHistory().commits (any order)
 * @param {{ windowDays: number, now: number }} opts - `now` in epoch ms
 * @returns {{ feature: string, files: number, reworkedFiles: number, rate: ?number,
 *   reworkCommits: number, weightedRework: ?number, windowComplete: boolean }[]}
 */
export function reworkRate(merges, commits, { windowDays, now }) {
  const scopedIndex = scopedBySha(merges);
  return list(merges).map((m) => reworkRow(m, commits, scopedIndex, windowDays, now));
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Compare the mean of the older half with the mean of the newer half (an odd
 * middle value belongs to neither). No floor, no tolerance: any difference
 * moves the arrow, and `n` is always reported so the reader can judge it.
 *
 * @param {(?number)[]} values - oldest → newest; nulls and non-numbers dropped
 * @returns {{ arrow: '↑'|'↓'|'→', n: number }}
 */
export function trend(values) {
  const xs = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v));
  const n = xs.length;
  if (n < 2) return { arrow: ARROW.FLAT, n };
  const half = Math.floor(n / 2);
  const older = mean(xs.slice(0, half));
  const newer = mean(xs.slice(n - half));
  if (newer > older) return { arrow: ARROW.UP, n };
  if (newer < older) return { arrow: ARROW.DOWN, n };
  return { arrow: ARROW.FLAT, n };
}
