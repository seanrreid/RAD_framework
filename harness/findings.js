/**
 * Reviewer calibration — how often each reviewer's findings turn out real.
 *
 * Read-side only over `.agents/findings.jsonl` records. Pure and total: never
 * throws on malformed input; a non-array or junk record degrades to a zeroed
 * shape / the 'unlabeled' verdict rather than failing the caller's report.
 */

export const VERDICTS = Object.freeze({
  CONFIRMED: 'confirmed',
  FALSE_ALARM: 'false-alarm',
  UNLABELED: 'unlabeled',
});

// Below this many labeled findings a rate is noise: precision/falseAlarmRate
// stay null (never 0) so a report cannot present an unearned score.
export const CALIBRATION_MIN_LABELED = 5;

const FINDING_TYPE = 'finding';
const UNKNOWN_REVIEWER = '(unknown)';
const FALSE_ALARM_CATEGORY = 'false-alarm';

// Documented keyword fallback for records predating the explicit `verdict`
// field. An explicit verdict always wins over these. False-alarm markers are
// checked before confirmed markers, so a record carrying both is false-alarm.
// FIXED is deliberately case-SENSITIVE: lowercase "fixed" in prose is not a label.
const FALSE_ALARM_PATTERN = /\bverified false\b|\bfalse[- ]alarm\b/i;
const VERIFIED_REAL_PATTERN = /\bverified real\b/i;
const FIXED_PATTERN = /\bFIXED\b/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function findingVerdict(record) {
  if (!isObject(record)) return VERDICTS.UNLABELED;
  if (record.verdict === VERDICTS.CONFIRMED || record.verdict === VERDICTS.FALSE_ALARM) {
    return record.verdict;
  }
  const issue = typeof record.issue === 'string' ? record.issue : '';
  if (record.category === FALSE_ALARM_CATEGORY || FALSE_ALARM_PATTERN.test(issue)) {
    return VERDICTS.FALSE_ALARM;
  }
  if (VERIFIED_REAL_PATTERN.test(issue) || FIXED_PATTERN.test(issue)) {
    return VERDICTS.CONFIRMED;
  }
  return VERDICTS.UNLABELED;
}

function normalizeMinLabeled(minLabeled) {
  return Number.isInteger(minLabeled) && minLabeled > 0 ? minLabeled : CALIBRATION_MIN_LABELED;
}

function emptyTally() {
  return { confirmed: 0, falseAlarm: 0, unlabeled: 0 };
}

function tallyByReviewer(records) {
  const tallies = new Map(); // Map, not {}: a reviewer named "__proto__" must not hit the prototype
  for (const record of records) {
    if (!isObject(record) || record.type !== FINDING_TYPE) continue;
    const name = typeof record.reviewer === 'string' && record.reviewer ? record.reviewer : UNKNOWN_REVIEWER;
    if (!tallies.has(name)) tallies.set(name, emptyTally());
    const tally = tallies.get(name);
    const verdict = findingVerdict(record);
    if (verdict === VERDICTS.CONFIRMED) tally.confirmed += 1;
    else if (verdict === VERDICTS.FALSE_ALARM) tally.falseAlarm += 1;
    else tally.unlabeled += 1;
  }
  return tallies;
}

function withRates(tally, minLabeled) {
  const labeled = tally.confirmed + tally.falseAlarm;
  const enough = labeled >= minLabeled;
  return {
    ...tally,
    labeled,
    precision: enough ? tally.confirmed / labeled : null,
    falseAlarmRate: enough ? tally.falseAlarm / labeled : null,
  };
}

export function reviewerCalibration(records, minLabeled = CALIBRATION_MIN_LABELED) {
  const min = normalizeMinLabeled(minLabeled);
  if (!Array.isArray(records)) return { reviewers: {}, minLabeled: min };
  const entries = [...tallyByReviewer(records)].map(([name, tally]) => [name, withRates(tally, min)]);
  return { reviewers: Object.fromEntries(entries), minLabeled: min };
}

// Priority buckets findingsByFile tallies; anything else counts toward total only.
const PRIORITY_KEYS = Object.freeze({ HIGH: 'high', MEDIUM: 'medium', LOW: 'low' });

function emptyFileTally() {
  return { total: 0, high: 0, medium: 0, low: 0, categories: new Set() };
}

/**
 * Per-file review-history tally for the given paths: only `type:'finding'`
 * records whose `file` is one of `paths` count. Paths with no findings are
 * omitted; categories are de-duplicated and sorted. Non-array input → {};
 * never throws.
 *
 * @param {Object[]} records - parsed findings.jsonl records
 * @param {string[]} paths - the paths of interest
 * @returns {Object<string, { total: number, high: number, medium: number, low: number, categories: string[] }>}
 */
export function findingsByFile(records, paths) {
  if (!Array.isArray(records) || !Array.isArray(paths)) return {};
  const wanted = new Set(paths.filter((p) => typeof p === 'string'));
  const tallies = new Map(); // Map, not {}: a path named "__proto__" must not hit the prototype
  for (const record of records) {
    if (!isObject(record) || record.type !== FINDING_TYPE || !wanted.has(record.file)) continue;
    if (!tallies.has(record.file)) tallies.set(record.file, emptyFileTally());
    const tally = tallies.get(record.file);
    tally.total += 1;
    const key = typeof record.priority === 'string' ? PRIORITY_KEYS[record.priority.toUpperCase()] : undefined;
    if (key) tally[key] += 1;
    if (typeof record.category === 'string' && record.category) tally.categories.add(record.category);
  }
  const entries = [...tallies].map(([file, t]) => [file, { ...t, categories: [...t.categories].sort() }]);
  return Object.fromEntries(entries);
}
