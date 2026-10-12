import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageDurations, humanTouches, tokensPerDeliveredFeature } from '../cycle-metrics.js';

const ev = (type, ts, data) => ({ feature: 'f', type, ts, ...(data ? { data } : {}) });
const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-01T00:01:00.000Z';
const T2 = '2026-10-01T00:03:00.000Z';
const T3 = '2026-10-01T00:10:00.000Z';
const NULL_DURATIONS = { approvedToStartMs: null, runMs: null, totalMs: null };
const attempt = (usage) => ev('wave-attempt', T1, usage ? { usage } : {});

test('stageDurations: full history yields all three spans', () => {
  const h = [ev('approved', T0), ev('deliver-started', T1), ev('pr-opened', T3)];
  assert.deepEqual(stageDurations(h), { approvedToStartMs: 60000, runMs: 540000, totalMs: 600000 });
});

test('stageDurations: no approved event nulls the approval-based spans', () => {
  const h = [ev('deliver-started', T1), ev('pr-opened', T3)];
  assert.deepEqual(stageDurations(h), { approvedToStartMs: null, runMs: 540000, totalMs: null });
});

test('stageDurations: approved but never delivered', () => {
  assert.deepEqual(stageDurations([ev('approved', T0)]), NULL_DURATIONS);
});

test('stageDurations: resumed run uses first deliver-started and last pr-opened', () => {
  const h = [ev('approved', T0), ev('deliver-started', T1), ev('deliver-started', T2), ev('pr-opened', T3)];
  assert.equal(stageDurations(h).runMs, 540000);
});

test('stageDurations: several re-approvals use the first approved', () => {
  const h = [ev('approved', T0), ev('approved', T2), ev('deliver-started', T2), ev('pr-opened', T3)];
  assert.equal(stageDurations(h).totalMs, 600000);
});

test('stageDurations: invalid timestamp yields null, never NaN', () => {
  const h = [ev('approved', 'not-a-date'), ev('deliver-started', T1), ev('pr-opened', T3)];
  assert.deepEqual(stageDurations(h), { approvedToStartMs: null, runMs: 540000, totalMs: null });
});

test('stageDurations: missing timestamp yields null', () => {
  const h = [ev('approved', undefined), ev('deliver-started', T1), ev('pr-opened', T3)];
  assert.equal(stageDurations(h).approvedToStartMs, null);
});

test('stageDurations: backwards timestamps yield null, never negative', () => {
  const h = [ev('approved', T3), ev('deliver-started', T1), ev('pr-opened', T0)];
  assert.deepEqual(stageDurations(h), NULL_DURATIONS);
});

test('stageDurations: empty history', () => {
  assert.deepEqual(stageDurations([]), NULL_DURATIONS);
});

test('stageDurations: non-array and malformed input', () => {
  for (const bad of [null, undefined, 'x', 7, {}]) assert.deepEqual(stageDurations(bad), NULL_DURATIONS);
  assert.deepEqual(stageDurations([null, 3, 'x', {}]), NULL_DURATIONS);
});

test('humanTouches: empty history is all zeros', () => {
  assert.deepEqual(humanTouches([]), { approvals: 0, reApprovals: 0, needsDecisionStops: 0, resumes: 0, total: 0 });
});

test('humanTouches: no approved event gives reApprovals 0, not -1', () => {
  assert.equal(humanTouches([ev('deliver-started', T1)]).reApprovals, 0);
});

test('humanTouches: several re-approvals count approvals once in total', () => {
  const t = humanTouches([ev('approved', T0), ev('approved', T1), ev('approved', T2)]);
  assert.equal(t.approvals, 3);
  assert.equal(t.reApprovals, 2);
  assert.equal(t.total, 3);
});

test('humanTouches: needs-decision stops count, failed stops do not', () => {
  const t = humanTouches([
    ev('deliver-stopped', T1, { class: 'needs-decision' }),
    ev('deliver-stopped', T2, { class: 'failed' }),
  ]);
  assert.equal(t.needsDecisionStops, 1);
  assert.equal(t.total, 1);
});

test('humanTouches: resumed run counts resumes', () => {
  const t = humanTouches([ev('approved', T0), ev('run-resumed', T1), ev('run-resumed', T2)]);
  assert.equal(t.resumes, 2);
  assert.equal(t.total, 3);
});

test('humanTouches: stop events missing data are tolerated', () => {
  assert.equal(humanTouches([ev('deliver-stopped', T1)]).needsDecisionStops, 0);
});

test('humanTouches: non-array and malformed input', () => {
  const zero = { approvals: 0, reApprovals: 0, needsDecisionStops: 0, resumes: 0, total: 0 };
  for (const bad of [null, undefined, 'x', 7, {}]) assert.deepEqual(humanTouches(bad), zero);
  assert.deepEqual(humanTouches([null, 3, {}]), zero);
});

test('tokensPerDeliveredFeature: mixed delivered and undelivered features', () => {
  const r = tokensPerDeliveredFeature({
    a: [attempt({ input: 10, output: 5, total: 15 }), ev('pr-opened', T3)],
    b: [attempt({ input: 30, output: 15, total: 45 }), ev('pr-opened', T3)],
    c: [attempt({ input: 999, output: 1, total: 1000 })],
  });
  assert.deepEqual(r, { perFeature: { a: 15, b: 45 }, mean: 30 });
});

test('tokensPerDeliveredFeature: delivered feature with no usage is null and excluded from mean', () => {
  const r = tokensPerDeliveredFeature({
    a: [attempt({ total: 20 }), ev('pr-opened', T3)],
    b: [attempt(), ev('pr-opened', T3)],
  });
  assert.deepEqual(r, { perFeature: { a: 20, b: null }, mean: 20 });
});

test('tokensPerDeliveredFeature: all delivered features without usage give null mean', () => {
  assert.deepEqual(tokensPerDeliveredFeature({ a: [ev('pr-opened', T3)] }), { perFeature: { a: null }, mean: null });
});

test('tokensPerDeliveredFeature: empty and non-object input', () => {
  const empty = { perFeature: {}, mean: null };
  for (const bad of [{}, null, undefined, [], 'x', 7]) assert.deepEqual(tokensPerDeliveredFeature(bad), empty);
});

test('tokensPerDeliveredFeature: non-array and malformed histories are skipped', () => {
  const r = tokensPerDeliveredFeature({ a: null, b: 'x', c: [null, {}] });
  assert.deepEqual(r, { perFeature: {}, mean: null });
});
