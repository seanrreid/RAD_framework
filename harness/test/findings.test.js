import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VERDICTS,
  CALIBRATION_MIN_LABELED,
  findingVerdict,
  reviewerCalibration,
} from '../findings.js';

const { CONFIRMED, FALSE_ALARM, UNLABELED } = VERDICTS;

const finding = (fields) => ({ type: 'finding', reviewer: 'quality-reviewer', ...fields });
const many = (n, fields) => Array.from({ length: n }, () => finding(fields));

test('VERDICTS is frozen with the documented values', () => {
  assert.deepEqual({ ...VERDICTS }, { CONFIRMED: 'confirmed', FALSE_ALARM: 'false-alarm', UNLABELED: 'unlabeled' });
  assert.ok(Object.isFrozen(VERDICTS));
  assert.equal(CALIBRATION_MIN_LABELED, 5);
});

test('explicit verdict beats contradicting text and category', () => {
  assert.equal(findingVerdict(finding({ verdict: 'confirmed', category: 'false-alarm', issue: 'false alarm' })), CONFIRMED);
  assert.equal(findingVerdict(finding({ verdict: 'false-alarm', issue: 'Verified real; FIXED' })), FALSE_ALARM);
});

test('unknown explicit verdict falls through to the keyword fallback', () => {
  assert.equal(findingVerdict(finding({ verdict: 'maybe', issue: 'FIXED' })), CONFIRMED);
});

test('category false-alarm → false-alarm', () => {
  assert.equal(findingVerdict(finding({ category: 'false-alarm', issue: 'no markers here' })), FALSE_ALARM);
});

test('"adversarially verified FALSE" → false-alarm', () => {
  assert.equal(findingVerdict(finding({ category: 'x', issue: 'adversarially verified FALSE — works.' })), FALSE_ALARM);
});

test('"false alarm" / "false-alarm" in issue → false-alarm', () => {
  assert.equal(findingVerdict(finding({ issue: 'this was a False Alarm' })), FALSE_ALARM);
  assert.equal(findingVerdict(finding({ issue: 'false-alarm per re-check' })), FALSE_ALARM);
});

test('"Verified real; FIXED" → confirmed', () => {
  assert.equal(findingVerdict(finding({ issue: 'Crashes on bash 3.2. Verified real; FIXED (list).' })), CONFIRMED);
  assert.equal(findingVerdict(finding({ issue: 'verified REAL, deferred' })), CONFIRMED);
});

test('lowercase "fixed" alone → unlabeled (FIXED is case-sensitive)', () => {
  assert.equal(findingVerdict(finding({ issue: 'should be fixed eventually' })), UNLABELED);
});

test('both false-alarm and confirmed markers → false-alarm', () => {
  assert.equal(findingVerdict(finding({ issue: 'verified false; FIXED the comment anyway' })), FALSE_ALARM);
});

test('non-object / missing-issue records → unlabeled, never throw', () => {
  for (const bad of [null, undefined, 42, 'FIXED', [], ['FIXED']]) {
    assert.equal(findingVerdict(bad), UNLABELED);
  }
  assert.equal(findingVerdict(finding({ issue: 7 })), UNLABELED);
  assert.equal(findingVerdict({}), UNLABELED);
});

test('precision/falseAlarmRate null below minLabeled, computed at/above', () => {
  const below = reviewerCalibration([...many(3, { issue: 'FIXED' }), ...many(1, { category: 'false-alarm' })]);
  assert.deepEqual(below.reviewers['quality-reviewer'], {
    confirmed: 3, falseAlarm: 1, unlabeled: 0, labeled: 4, precision: null, falseAlarmRate: null,
  });
  const at = reviewerCalibration([...many(4, { issue: 'FIXED' }), ...many(1, { category: 'false-alarm' })]);
  assert.deepEqual(at.reviewers['quality-reviewer'], {
    confirmed: 4, falseAlarm: 1, unlabeled: 0, labeled: 5, precision: 0.8, falseAlarmRate: 0.2,
  });
});

test('zero labeled findings → rates null, not 0', () => {
  const r = reviewerCalibration(many(10, { issue: 'no label' }), 1);
  assert.deepEqual(r.reviewers['quality-reviewer'], {
    confirmed: 0, falseAlarm: 0, unlabeled: 10, labeled: 0, precision: null, falseAlarmRate: null,
  });
});

test('custom minLabeled honored; non-positive-integer falls back to the default', () => {
  const recs = many(2, { issue: 'FIXED' });
  assert.equal(reviewerCalibration(recs, 2).reviewers['quality-reviewer'].precision, 1);
  for (const bad of [0, -1, 2.5, '3', null, NaN]) {
    const r = reviewerCalibration(recs, bad);
    assert.equal(r.minLabeled, CALIBRATION_MIN_LABELED);
    assert.equal(r.reviewers['quality-reviewer'].precision, null);
  }
});

test('cycle records and junk entries are ignored', () => {
  const r = reviewerCalibration([
    { type: 'cycle', reviewer: 'quality-reviewer', issue: 'FIXED' },
    null, 'FIXED', 3,
    finding({ issue: 'FIXED' }),
  ]);
  assert.deepEqual(Object.keys(r.reviewers), ['quality-reviewer']);
  assert.equal(r.reviewers['quality-reviewer'].confirmed, 1);
});

test('missing/non-string reviewer → (unknown) bucket', () => {
  const r = reviewerCalibration([
    { type: 'finding', issue: 'FIXED' },
    { type: 'finding', reviewer: 5, issue: 'FIXED' },
    { type: 'finding', reviewer: '', category: 'false-alarm' },
  ]);
  assert.deepEqual(Object.keys(r.reviewers), ['(unknown)']);
  assert.equal(r.reviewers['(unknown)'].confirmed, 2);
  assert.equal(r.reviewers['(unknown)'].falseAlarm, 1);
});

test('reviewer named "__proto__" is an ordinary bucket', () => {
  const r = reviewerCalibration([finding({ reviewer: '__proto__', issue: 'FIXED' })]);
  assert.ok(Object.hasOwn(r.reviewers, '__proto__'));
  assert.equal(r.reviewers['__proto__'].confirmed, 1);
});

test('non-array → zeroed shape', () => {
  for (const bad of [undefined, null, {}, 'x', 42]) {
    assert.deepEqual(reviewerCalibration(bad), { reviewers: {}, minLabeled: CALIBRATION_MIN_LABELED });
  }
  assert.deepEqual(reviewerCalibration([]), { reviewers: {}, minLabeled: CALIBRATION_MIN_LABELED });
});

// Verbatim lines from .agents/findings.jsonl (issue text untrimmed): every
// label-carrying record, two unlabeled findings (4, 5), and a cycle record (6).
const REAL_LINES = [
  // line 1
  "{\"type\":\"finding\",\"cycle_id\":\"lane-b-v2-2026-05-29\",\"feature\":\"lane-b-v2\",\"date\":\"2026-05-29\",\"reviewer\":\"quality-reviewer\",\"priority\":\"HIGH\",\"category\":\"portability\",\"file\":\"scripts/check-scope.sh\",\"line\":28,\"issue\":\"declare -A (bash 4+) crashes on macOS bash 3.2; called by rad-deliver/rad-review. Verified real; FIXED (newline-delimited scope list). Pre-existing on main.\",\"wcag\":null}",
  // line 2
  "{\"type\":\"finding\",\"cycle_id\":\"lane-b-v2-2026-05-29\",\"feature\":\"lane-b-v2\",\"date\":\"2026-05-29\",\"reviewer\":\"quality-reviewer\",\"priority\":\"LOW\",\"category\":\"robustness\",\"file\":\"scripts/lint-plan.sh\",\"line\":53,\"issue\":\"RAD_BRANCH_PREFIX embedded in =~ regex unescaped. FIXED with literal prefix test.\",\"wcag\":null}",
  // line 3
  "{\"type\":\"finding\",\"cycle_id\":\"lane-b-v2-2026-05-29\",\"feature\":\"lane-b-v2\",\"date\":\"2026-05-29\",\"reviewer\":\"quality-reviewer\",\"priority\":\"LOW\",\"category\":\"false-alarm\",\"file\":\"scripts/checkout-plan.sh\",\"line\":34,\"issue\":\"Claimed sed-escape breaks branch validation; adversarially verified FALSE — works for default and normal prefixes. No change.\",\"wcag\":null}",
  // line 4
  "{\"type\":\"finding\",\"cycle_id\":\"lane-b-v2-2026-05-29\",\"feature\":\"lane-b-v2\",\"date\":\"2026-05-29\",\"reviewer\":\"quality-reviewer\",\"priority\":\"LOW\",\"category\":\"pre-existing\",\"file\":\"scripts/open-pr.sh\",\"line\":63,\"issue\":\"GitLab label list leading-comma + unquoted label word-splitting. Pre-existing in untouched open_gitlab(); out of scope for this PR.\",\"wcag\":null}",
  // line 5
  "{\"type\":\"finding\",\"cycle_id\":\"lane-b-v2-2026-05-29\",\"feature\":\"lane-b-v2\",\"date\":\"2026-05-29\",\"reviewer\":\"quality-reviewer\",\"priority\":\"LOW\",\"category\":\"pre-existing\",\"file\":\"scripts/rad-status.sh\",\"line\":131,\"issue\":\"collect_logs find|xargs ls -t word-splits/space-bug. Pre-existing in untouched function; out of scope.\",\"wcag\":null}",
  // line 6
  "{\"type\":\"cycle\",\"cycle_id\":\"lane-b-v2-2026-05-29\",\"feature\":\"lane-b-v2\",\"date\":\"2026-05-29\",\"outcome\":\"READY_FOR_ARCHITECT_REVIEW\",\"high\":1,\"medium\":0,\"low\":4}",
  // line 7
  "{\"type\":\"finding\",\"cycle_id\":\"fix-open-pr-labels-2026-05-29\",\"feature\":\"fix-open-pr-labels\",\"date\":\"2026-05-29\",\"reviewer\":\"quality-reviewer\",\"priority\":\"LOW\",\"category\":\"testing\",\"file\":\"scripts/test-open-pr.sh\",\"line\":53,\"issue\":\"No GitHub zero-label test case (the previously-buggy empty-array branch). FIXED: added case 5.\",\"wcag\":null}",
  // line 8
  "{\"type\":\"finding\",\"cycle_id\":\"fix-open-pr-labels-2026-05-29\",\"feature\":\"fix-open-pr-labels\",\"date\":\"2026-05-29\",\"reviewer\":\"quality-reviewer\",\"priority\":\"LOW\",\"category\":\"testing\",\"file\":\"scripts/test-open-pr.sh\",\"line\":70,\"issue\":\"Negative assertions could false-green if a stub never wrote its argv file. FIXED: require_called guard.\",\"wcag\":null}",
  // line 10
  "{\"type\":\"finding\",\"cycle_id\":\"script-hardening-2026-05-29\",\"feature\":\"script-hardening\",\"date\":\"2026-05-29\",\"reviewer\":\"quality-reviewer\",\"priority\":\"MEDIUM\",\"category\":\"error-handling\",\"file\":\"scripts/rad-status.sh\",\"line\":146,\"issue\":\"tasks_done/failed could be empty (unreadable file) → empty numeric operand. FIXED with ${var:-0}; verified [[ \\\"\\\" -gt 0 ]] does not actually crash. Reviewer's suggested || echo 0 rejected (regresses #3).\",\"wcag\":null}",
  // line 11
  "{\"type\":\"finding\",\"cycle_id\":\"script-hardening-2026-05-29\",\"feature\":\"script-hardening\",\"date\":\"2026-05-29\",\"reviewer\":\"quality-reviewer\",\"priority\":\"MEDIUM\",\"category\":\"testing\",\"file\":\"scripts/test-script-hardening.sh\",\"line\":30,\"issue\":\"t3 fixture lacked .agents/plans/. FIXED (added + comment); plans path covered elsewhere.\",\"wcag\":null}",
  // line 12
  "{\"type\":\"finding\",\"cycle_id\":\"script-hardening-2026-05-29\",\"feature\":\"script-hardening\",\"date\":\"2026-05-29\",\"reviewer\":\"quality-reviewer\",\"priority\":\"LOW\",\"category\":\"testing\",\"file\":\"scripts/test-script-hardening.sh\",\"line\":109,\"issue\":\"t4 didn't exercise the #4 placeholder-strip branch. FIXED: fixture now includes the placeholder line + asserts it is filtered.\",\"wcag\":null}",
  // line 13
  "{\"type\":\"finding\",\"cycle_id\":\"script-hardening-2026-05-29\",\"feature\":\"script-hardening\",\"date\":\"2026-05-29\",\"reviewer\":\"quality-reviewer\",\"priority\":\"LOW\",\"category\":\"code-clarity\",\"file\":\"install.sh\",\"line\":229,\"issue\":\"ensure_deliver_label fallback message ambiguous. FIXED: clearer wording referencing step 2.\",\"wcag\":null}",
  // line 39
  "{\"type\":\"finding\",\"cycle_id\":\"resume-and-verify-postmerge-2026-06-10\",\"feature\":\"resume-and-verify\",\"date\":\"2026-06-10\",\"reviewer\":\"quality-reviewer\",\"priority\":\"MEDIUM\",\"category\":\"correctness\",\"file\":\"harness/spine.js\",\"line\":119,\"issue\":\"Per-wave gate demotion fingerprinted the model's variable result text, so a gate that fails identically while the model rewords its output never trips the doom-loop and burns the whole attempt budget. FIXED: fingerprint stable gate-derived fields.\",\"wcag\":null}",
  // line 40
  "{\"type\":\"finding\",\"cycle_id\":\"resume-and-verify-postmerge-2026-06-10\",\"feature\":\"resume-and-verify\",\"date\":\"2026-06-10\",\"reviewer\":\"quality-reviewer\",\"priority\":\"MEDIUM\",\"category\":\"testing\",\"file\":\"harness/test/resume.test.js\",\"line\":72,\"issue\":\"Malformed wave-complete test did not assert completed.size, so removing the data guard would not be caught. FIXED: asserts size===1 against no-data/no-wave/string-id events.\",\"wcag\":null}",
  // line 41
  "{\"type\":\"finding\",\"cycle_id\":\"resume-and-verify-postmerge-2026-06-10\",\"feature\":\"resume-and-verify\",\"date\":\"2026-06-10\",\"reviewer\":\"quality-reviewer\",\"priority\":\"MEDIUM\",\"category\":\"testing\",\"file\":\"harness/test/resume.test.js\",\"line\":186,\"issue\":\"Already-complete resume test used an untracked sh mock; resume-verify running when it shouldn't would not be caught. FIXED: tracking sh asserts check-tests.sh never runs when all waves complete.\",\"wcag\":null}",
  // line 42
  "{\"type\":\"finding\",\"cycle_id\":\"resume-and-verify-postmerge-2026-06-10\",\"feature\":\"resume-and-verify\",\"date\":\"2026-06-10\",\"reviewer\":\"quality-reviewer\",\"priority\":\"LOW\",\"category\":\"null-safety\",\"file\":\"harness/events.js\",\"line\":156,\"issue\":\"resumeFrom did not type-check data.wave; a string id would be added and never match the numeric wave.n (silent mis-skip). FIXED: typeof === 'number' guard.\",\"wcag\":null}",
];

test('real findings.jsonl labeled lines → hand-counted calibration', () => {
  const records = REAL_LINES.map((line) => JSON.parse(line));
  // Hand count: line 3 is the sole false-alarm (category + "verified FALSE");
  // lines 1,2,7,8,10-13,39-42 carry uppercase FIXED → 12 confirmed; 4,5 unlabeled.
  assert.deepEqual(reviewerCalibration(records), {
    reviewers: {
      'quality-reviewer': {
        confirmed: 12, falseAlarm: 1, unlabeled: 2, labeled: 13,
        precision: 12 / 13, falseAlarmRate: 1 / 13,
      },
    },
    minLabeled: CALIBRATION_MIN_LABELED,
  });
});
