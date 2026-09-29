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
