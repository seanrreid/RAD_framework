/**
 * Cycle-time and human-touch metrics — pure, read-side folds over event
 * histories. No I/O, no writes, no gating: nothing here may be read to block,
 * warn or gate a command. The /rad-insights skill loads the histories and
 * formats the output; this module only returns data.
 *
 * What counts as a human touch (a policy decision):
 *   - an `approved` event (counted once as `approvals`; every approval after
 *     the first is also reported as `reApprovals`, but `total` counts
 *     approvals once, never re-approvals on top);
 *   - a `deliver-stopped` event whose `data.class` is `needs-decision`
 *     (a person had to answer);
 *   - a `run-resumed` event (a person restarted the run).
 * What does NOT count: `failed` stops, retries, wave outcomes, and plan
 * edits — plan edits are not events, so only re-approvals approximate them.
 */
import { totalUsage } from './events.js';

const EVENT = Object.freeze({
  APPROVED: 'approved',
  DELIVER_STARTED: 'deliver-started',
  PR_OPENED: 'pr-opened',
  DELIVER_STOPPED: 'deliver-stopped',
  RUN_RESUMED: 'run-resumed',
});
const NEEDS_DECISION = 'needs-decision';

const eventsOf = (history) =>
  (Array.isArray(history) ? history : []).filter((e) => e && typeof e === 'object');

const ofType = (history, type) => eventsOf(history).filter((e) => e.type === type);

const msOf = (event) => {
  if (!event || (typeof event.ts !== 'string' && typeof event.ts !== 'number')) return null;
  const ms = Date.parse(event.ts);
  return Number.isFinite(ms) ? ms : null;
};

const spanMs = (from, to) => {
  const start = msOf(from);
  const end = msOf(to);
  if (start === null || end === null || end < start) return null;
  return end - start;
};

/**
 * @param {Object[]} history - one feature's events
 * @returns {{ approvedToStartMs: ?number, runMs: ?number, totalMs: ?number }}
 *   each `null` when an endpoint is missing, invalid, or the span runs backwards
 */
export function stageDurations(history) {
  const approved = ofType(history, EVENT.APPROVED)[0];
  const started = ofType(history, EVENT.DELIVER_STARTED)[0];
  const opened = ofType(history, EVENT.PR_OPENED).at(-1);
  return {
    approvedToStartMs: spanMs(approved, started),
    runMs: spanMs(started, opened),
    totalMs: spanMs(approved, opened),
  };
}

/**
 * @param {Object[]} history - one feature's events
 * @returns {{ approvals: number, reApprovals: number, needsDecisionStops: number,
 *   resumes: number, total: number }}
 */
export function humanTouches(history) {
  const approvals = ofType(history, EVENT.APPROVED).length;
  const needsDecisionStops = ofType(history, EVENT.DELIVER_STOPPED)
    .filter((e) => e.data && e.data.class === NEEDS_DECISION).length;
  const resumes = ofType(history, EVENT.RUN_RESUMED).length;
  return {
    approvals,
    reApprovals: Math.max(approvals - 1, 0),
    needsDecisionStops,
    resumes,
    total: approvals + needsDecisionStops + resumes,
  };
}

/**
 * Tokens per delivered feature: only features whose history has a `pr-opened`
 * event count. A delivered feature with no recorded usage is `null` and is
 * excluded from the mean.
 *
 * @param {Object<string, Object[]>} histories - feature → events
 * @returns {{ perFeature: Object<string, ?number>, mean: ?number }}
 */
export function tokensPerDeliveredFeature(histories) {
  const perFeature = {};
  if (!histories || typeof histories !== 'object' || Array.isArray(histories)) {
    return { perFeature, mean: null };
  }
  for (const [feature, history] of Object.entries(histories)) {
    if (ofType(history, EVENT.PR_OPENED).length === 0) continue;
    const { total } = totalUsage(history);
    perFeature[feature] = total > 0 ? total : null;
  }
  const counted = Object.values(perFeature).filter((t) => t !== null);
  const mean = counted.length === 0 ? null : counted.reduce((a, b) => a + b, 0) / counted.length;
  return { perFeature, mean };
}
