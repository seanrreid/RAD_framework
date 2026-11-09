/**
 * Human-corrections report — read-side folds that count the moments a person
 * had to correct the delivery: a re-approval, a resume answer, a confirmed
 * review finding, a commit pushed after the deliver PR opened. Information
 * only: nothing here may be read to block, warn or gate a command, and
 * nothing here writes a file. The only I/O is the `git` read commands made by
 * `readBranchCommits` (harness/branch-commits.js) for `postDeliverFixRows`;
 * every other export is pure.
 *
 * A correction row is `{ date: 'YYYY-MM-DD', feature, category, evidence }`.
 */
import { VERDICTS, findingVerdict } from './findings.js';
import { readBranchCommits } from './branch-commits.js';

export const TOP_FEATURES = 5;
export const MAX_ROWS_PER_FEATURE = 5;

export const CATEGORY = Object.freeze({
  REAPPROVAL: 'reapproval',
  RESUME_ANSWER: 'resume-answer',
  REVIEW_FIX: 'review-fix',
  POST_DELIVER_FIX: 'post-deliver-fix',
});

const EVENT = Object.freeze({ APPROVED: 'approved', RUN_RESUMED: 'run-resumed', PR_OPENED: 'pr-opened' });
const FINDING_TYPE = 'finding';
const UNKNOWN = 'unknown';
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_CHARS = 10;
const MS_PER_SECOND = 1000;
const SHORT_SHA_CHARS = 7;
const RESERVED_LOG_PREFIX = '_'; // project logs such as `_architecture` belong to no feature
const EMPTY_STATE = 'No human corrections recorded.';
const UNAVAILABLE_NO_PR = 'no pr-opened event';
const UNAVAILABLE_NO_REF = 'no branch ref';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** ISO day (UTC) of an event timestamp, or null when absent or unparseable. */
function dayOf(ts) {
  const ms = typeof ts === 'string' || typeof ts === 'number' ? Date.parse(ts) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, DAY_CHARS) : null;
}

/**
 * Parse one events.jsonl text. Blank lines are skipped but still counted.
 * @throws {Error} naming `logName` and the 1-based line of the first bad line
 */
export function parseEventLog(text, logName) {
  const events = [];
  String(text ?? '').split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`${logName}: line ${i + 1}: malformed JSON (${err.message})`);
    }
    if (!isObject(parsed)) throw new Error(`${logName}: line ${i + 1}: event is not a JSON object`);
    events.push(parsed);
  });
  return events;
}

/** One row per approved event after the first. */
export function reapprovalRows(feature, events) {
  return asArray(events).filter((e) => isObject(e) && e.type === EVENT.APPROVED)
    .map((e, i) => ({ event: e, n: i + 1 }))
    .filter(({ n }) => n >= 2)
    .map(({ event, n }) => ({ date: dayOf(event.ts), feature, category: CATEGORY.REAPPROVAL, evidence: `approved event #${n}` }))
    .filter((row) => row.date !== null);
}

/** One row per run-resumed event whose resume text is non-empty after trimming. */
export function resumeAnswerRows(feature, events) {
  return asArray(events).filter((e) => isObject(e) && e.type === EVENT.RUN_RESUMED)
    .filter((e) => isObject(e.data) && typeof e.data.context === 'string' && e.data.context.trim() !== '')
    .map((e) => ({
      date: dayOf(e.ts),
      feature,
      category: CATEGORY.RESUME_ANSWER,
      evidence: isObject(e.data.stop) && e.data.stop.class ? String(e.data.stop.class) : UNKNOWN,
    }))
    .filter((row) => row.date !== null);
}

/** One row per confirmed finding record of `feature`; cycle records never count. */
export function reviewFixRows(feature, records) {
  return asArray(records)
    .filter((r) => isObject(r) && r.type === FINDING_TYPE && r.feature === feature)
    .filter((r) => findingVerdict(r) === VERDICTS.CONFIRMED)
    .filter((r) => typeof r.date === 'string' && DAY_PATTERN.test(r.date))
    .map((r) => ({
      date: r.date,
      feature,
      category: CATEGORY.REVIEW_FIX,
      evidence: typeof r.category === 'string' && r.category ? r.category : UNKNOWN,
    }));
}

const isReservedLog = (name) => typeof name === 'string' && name.startsWith(RESERVED_LOG_PREFIX);

/**
 * Commits on `rad/<feature>` strictly later than the pr-opened event (second
 * precision), minus harness commits; the git reading lives in
 * `readBranchCommits`. A missing ref or missing pr-opened is reported as
 * `unavailable`, never thrown; a reserved project log (`_architecture`) is not
 * a feature and yields nothing.
 *
 * @returns {{ rows: Object[], unavailable: ?string }}
 * @throws {Error} on an unsafe feature name or a git failure on an existing ref
 */
export function postDeliverFixRows(feature, events, { root, sh } = {}) {
  if (isReservedLog(feature)) return { rows: [], unavailable: null };
  const opened = asArray(events).filter((e) => isObject(e) && e.type === EVENT.PR_OPENED).at(-1);
  const result = readBranchCommits({ root, feature, since: opened ? opened.ts : undefined, sh });
  if (!result.available) return { rows: [], unavailable: result.reason };
  const rows = result.commits.map((c) => ({
    date: new Date(c.seconds * MS_PER_SECOND).toISOString().slice(0, DAY_CHARS),
    feature,
    category: CATEGORY.POST_DELIVER_FIX,
    evidence: `${c.sha.slice(0, SHORT_SHA_CHARS)} ${c.subject}`,
  }));
  return { rows, unavailable: null };
}

const compareRows = (a, b) =>
  cmp(a.date, b.date) || cmp(a.feature, b.feature) || cmp(a.category, b.category) || cmp(a.evidence, b.evidence);

function countBy(rows, key) {
  const counts = new Map();
  for (const row of rows) counts.set(row[key], (counts.get(row[key]) ?? 0) + 1);
  return counts;
}

/**
 * @param {Object} input
 * @param {Object<string, Object[]>} input.histories - feature → events
 * @param {Object[]} input.findings - findings.jsonl records
 * @param {Object<string, {rows: Object[], unavailable: ?string}>} [input.postDeliver] - feature → postDeliverFixRows result
 * @param {string} [input.since] - YYYY-MM-DD; rows dated on or after it are kept
 * @returns {{ rows: Object[], counts: Object<string, number>, topFeatures: Object[],
 *   shown: Object<string, Object[]>, unavailable: Object[] }}
 */
export function buildCorrections({ histories = {}, findings = [], postDeliver = {}, since } = {}) {
  if (since !== undefined && !DAY_PATTERN.test(since)) {
    throw new Error(`human-corrections: --since must be YYYY-MM-DD, got ${JSON.stringify(since)}`);
  }
  const features = Object.keys(histories).filter((f) => !isReservedLog(f)).sort();
  const unavailable = [];
  const all = [];
  for (const feature of features) {
    const events = histories[feature];
    all.push(...reapprovalRows(feature, events), ...resumeAnswerRows(feature, events), ...reviewFixRows(feature, findings));
    const post = postDeliver[feature];
    if (post && post.unavailable) unavailable.push({ feature, reason: post.unavailable });
    if (post) all.push(...asArray(post.rows));
  }
  const rows = all.filter((r) => since === undefined || r.date >= since).sort(compareRows);
  const perFeature = countBy(rows, 'feature');
  const topFeatures = [...perFeature].map(([feature, count]) => ({ feature, count }))
    .sort((a, b) => b.count - a.count || cmp(a.feature, b.feature)).slice(0, TOP_FEATURES);
  const shown = {};
  for (const { feature } of topFeatures) {
    shown[feature] = rows.filter((r) => r.feature === feature).slice(0, MAX_ROWS_PER_FEATURE);
  }
  return { rows, counts: Object.fromEntries([...countBy(rows, 'category')].sort()), topFeatures, shown, unavailable };
}

/** Feature-agnostic kind of an unavailable reason, so the report can group them. */
function unavailableKind(reason) {
  if (reason.startsWith(UNAVAILABLE_NO_PR)) return UNAVAILABLE_NO_PR;
  return /branch ref/.test(reason) ? UNAVAILABLE_NO_REF : reason;
}

/** One summary line plus one line per kind, never one line per feature. */
function unavailableLines(unavailable) {
  if (unavailable.length === 0) return [];
  const kinds = countBy(unavailable.map((u) => ({ kind: unavailableKind(u.reason) })), 'kind');
  const lines = [`Unavailable: ${unavailable.length} feature(s) whose post-deliver fixes could not be counted`];
  for (const [kind, n] of [...kinds].sort()) lines.push(`- ${kind}: ${n}`);
  return lines;
}

/** Deterministic text for the report section; a single line when nothing was corrected. */
export function formatCorrections(result) {
  if (!result || result.rows.length === 0) return EMPTY_STATE;
  const lines = [`Total corrections: ${result.rows.length}`, 'By category:'];
  for (const [category, n] of Object.entries(result.counts)) lines.push(`- ${category}: ${n}`);
  lines.push('Top features:');
  for (const { feature, count } of result.topFeatures) {
    lines.push(`- ${feature}: ${count}`);
    for (const r of result.shown[feature]) lines.push(`  - ${r.date} ${r.category} — ${r.evidence}`);
  }
  lines.push(...unavailableLines(result.unavailable));
  return lines.join('\n');
}
