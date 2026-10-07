/**
 * deliver-finish.js — the real finish port behind `rad deliver`'s Finish
 * phase: mark the plan complete before the deliver PR opens, and record the
 * pr-opened event after it.
 *
 * beforePr, in order: refuse unless HEAD is on the work branch with nothing
 * staged; set the plan header `Status: complete` and add `Completed-At:` right
 * after it (an existing Completed-At is kept, so a rerun keeps the first
 * completion time); then commit plan + events log, push, and label `review`
 * via publishPlanChange. afterPr: same refusal check, then commit/push/label
 * the events log alone.
 *
 * The push is required, not gated by RAD_SYNC: the deliver PR is opened from
 * origin's work branch, so an unpushed finish commit would be missing from it.
 * Safe to repeat: each step checks before it acts, so a rerun with nothing new
 * commits nothing, pushes nothing, and only re-applies the label.
 *
 * afterPr runs after the spine has recorded pr-opened, so its failure is never
 * an event in the spine — it comes back as `{ ok: false, detail }` for the
 * caller to report. Every git call is an args array through the injected `sh`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { requirePublishReady, publishPlanChange } from './branch-publish.js';
import { setPlanStatus, planIssueNumber, planHeaderValue, upsertPlanHeader } from './plan-commit.js';

const COMPLETE = 'complete';
const COMPLETED_AT = 'Completed-At';
const REVIEW_LABEL = 'review';
const PUBLISH_VERB = 'rad deliver';
const OK_EXIT = 0;
const REQUIRED_STRINGS = ['root', 'feature', 'planPath', 'workBranch'];

/** A runtime failure; its message is the result's `detail`. */
class FinishStop extends Error {}

function eventsPath(feature) {
  return `.agents/state/${feature}/events.jsonl`;
}

/** The commit message: subject, blank line, Plan line, Issue line (omitted when null). */
function finishMessage(feature, subject, planPath, issue) {
  const body = [`Plan: ${planPath}`];
  if (issue !== null) body.push(`Issue: ${issue}`);
  return `deliver(${feature}): ${subject}\n\n${body.join('\n')}`;
}

function readPlan(root, planPath) {
  try {
    return readFileSync(join(root, planPath), 'utf8');
  } catch (err) {
    throw new FinishStop(`cannot read ${planPath}: ${err.message}`);
  }
}

/** Status: complete plus Completed-At (first completion time kept); writes only on change. */
function markComplete(root, planPath) {
  const text = readPlan(root, planPath);
  try {
    let next = setPlanStatus(text, COMPLETE);
    if (planHeaderValue(next, COMPLETED_AT) === null) {
      next = upsertPlanHeader(next, COMPLETED_AT, new Date().toISOString(), { after: 'Status' });
    }
    if (next !== text) writeFileSync(join(root, planPath), next);
    return next;
  } catch (err) {
    throw new FinishStop(`cannot mark ${planPath} ${COMPLETE}: ${err.message}`);
  }
}

/**
 * publishPlanChange runs `git add -- <paths>`, which fails on a path that is
 * neither on disk nor tracked. A plan finishing before any event was written
 * has no events log yet, so only paths present on disk are published.
 */
function presentPaths(root, paths) {
  return paths.filter((p) => existsSync(join(root, p)));
}

function publish(opts, paths, subject, text) {
  const { sh, root, feature, planPath, workBranch } = opts;
  const issue = planIssueNumber(text);
  const result = publishPlanChange(sh, root, {
    verb: PUBLISH_VERB,
    branch: workBranch,
    paths,
    message: finishMessage(feature, subject, planPath, issue),
    issue,
    labelStatus: REVIEW_LABEL,
  });
  if (result.code !== OK_EXIT) throw new FinishStop(result.message);
  return { committed: result.committed, pushed: result.pushed };
}

function requireReady(opts) {
  const refusal = requirePublishReady(opts.sh, opts.root, opts.workBranch);
  if (refusal !== null) throw new FinishStop(refusal);
}

function runBeforePr(opts) {
  requireReady(opts);
  const text = markComplete(opts.root, opts.planPath);
  const paths = presentPaths(opts.root, [opts.planPath, eventsPath(opts.feature)]);
  return publish(opts, paths, 'mark plan complete', text);
}

function runAfterPr(opts) {
  requireReady(opts);
  const events = eventsPath(opts.feature);
  // pr-opened was just recorded, so a missing log is an anomaly: fail closed.
  if (!existsSync(join(opts.root, events))) throw new FinishStop(`${events} is missing; pr-opened cannot be published`);
  return publish(opts, [events], 'record pr-opened', readPlan(opts.root, opts.planPath));
}

/** Wrap a step: FinishStop becomes `{ ok: false, detail }`; anything else rethrows. */
function asPortStep(run, opts) {
  return async () => {
    try {
      return { ok: true, data: run(opts) };
    } catch (err) {
      if (!(err instanceof FinishStop)) throw err;
      return { ok: false, detail: err.message };
    }
  };
}

/** Programmer errors (not runtime failures) surface at construction. */
function requirePortOptions(opts) {
  if (opts === null || typeof opts !== 'object') throw new TypeError('makeFinishPort: options object is required');
  if (typeof opts.sh !== 'function') throw new TypeError('makeFinishPort: sh must be a function');
  for (const key of REQUIRED_STRINGS) {
    if (typeof opts[key] !== 'string' || opts[key].trim() === '') throw new TypeError(`makeFinishPort: ${key} is required`);
  }
}

/**
 * Build the finish port.
 *
 * @param {{ sh: Function, root: string, feature: string, planPath: string, workBranch: string }} opts
 *   - sh: `(cmd, args, { cwd }) => { status, stdout, stderr }`
 *   - planPath: the plan doc, relative to `root`
 * @returns {{ beforePr: () => Promise<FinishResult>, afterPr: () => Promise<FinishResult> }}
 *   where FinishResult is `{ ok: true, data: { committed: boolean, pushed: boolean } } | { ok: false, detail: string }`
 */
export function makeFinishPort(opts) {
  requirePortOptions(opts);
  return { beforePr: asPortStep(runBeforePr, opts), afterPr: asPortStep(runAfterPr, opts) };
}
