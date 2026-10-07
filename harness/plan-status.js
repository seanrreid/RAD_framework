/**
 * plan-status.js — `rad plan-status <feature> <rejected|needs-revision> [--trailer "Key: Value"]...`.
 *
 * Records an architect's non-approval review of a plan: sets the plan header
 * `Status:`, commits ONLY the plan file on its work branch with a message
 * derived from the plan, pushes, then labels the issue with the status. Any
 * coding tool can call it; no step is left to a model.
 *
 * Exit codes: 0 = committed (if needed) and pushed; 2 = refused, nothing
 * changed; 1 = a publish step failed — a rerun is safe and resumes (no rollback).
 * Every refusal runs before the header write. Every git call is an args array via `sh`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { createGitStateStore, defaultSh, isSafeFeature } from './adapters/git-state-store.js';
import { evaluateGate } from './gates.js';
import { publishPlanChange, requirePublishReady } from './branch-publish.js';
import { planIssueNumber, planWorkBranch, reviewCommitMessage, setPlanStatus, validateTrailer } from './plan-commit.js';

const VERB = 'rad plan-status';
export const PLAN_STATUS_USAGE = 'rad plan-status <feature> <rejected|needs-revision> [--trailer "Key: Value"]...';
const REFUSED_EXIT = 2;
const FAILED_EXIT = 1;
const OK_EXIT = 0;
const ROLE_SCRIPT = 'scripts/check-role.sh';
const ARCHITECT_ROLE = 'architect';
const APPROVED_GATE = 'approved';
/** The review outcomes this verb records. */
const REVIEW_STATUSES = ['rejected', 'needs-revision'];
/** Header statuses past review: a review verdict can no longer replace them. */
const LOCKED_STATUSES = ['approved', 'in-progress', 'complete'];
/** isSafeFeature admits this reserved project log; it is never a plan slug. */
const RESERVED_SLUG = '_architecture';
const SECTION_HEADING_PATTERN = /^## /;
const HELP_FLAGS = ['--help', '-h'];

/** A deliberate stop carrying its exit code; anything else is a bug and propagates. */
class PlanStatusStop extends Error {
  constructor(code, message, { usage = false } = {}) {
    super(message);
    this.code = code;
    this.usage = usage;
  }
}
const refuse = (message) => new PlanStatusStop(REFUSED_EXIT, message);
const usageError = (message) => new PlanStatusStop(REFUSED_EXIT, message, { usage: true });

/**
 * Parse argv into the feature, the requested status and validated trailers.
 * A bad argument throws a usage stop (exit 2).
 *
 * @param {string[]} argv
 * @returns {{ feature: string, status: string, trailers: string[] }}
 */
export function parsePlanStatusArgs(argv) {
  const positionals = [];
  const trailers = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--trailer') {
      if (i + 1 >= argv.length) throw usageError('--trailer requires a "Key: Value" argument');
      const err = validateTrailer(argv[i + 1]);
      if (err !== null) throw usageError(`invalid --trailer: ${err}`);
      trailers.push(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('-')) {
      throw usageError(`unknown option '${arg}'`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 2) throw usageError('expected <feature> and <status>');
  const [feature, status] = positionals;
  if (!isSafeFeature(feature) || feature === RESERVED_SLUG) {
    throw usageError(`invalid feature '${feature}' (expected /^[a-z0-9][a-z0-9-]*$/)`);
  }
  if (!REVIEW_STATUSES.includes(status)) {
    throw usageError(`status must be one of ${REVIEW_STATUSES.join(', ')}, got '${status}'`);
  }
  return { feature, status, trailers };
}

/** The trimmed `<key>:` value from the header block (before the first `## `), or ''. */
function headerField(text, key) {
  const prefix = `${key}:`;
  for (const line of text.split('\n')) {
    if (SECTION_HEADING_PATTERN.test(line)) break;
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return '';
}

/** Refuse unless the running git user holds the architect role. */
function requireArchitect(sh, root) {
  const res = sh(join(root, ROLE_SCRIPT), [ARCHITECT_ROLE, root], { cwd: root });
  if (res.status !== 0) {
    const detail = String(res.stdout || res.stderr || '').trim();
    throw refuse(`permission denied — recording a plan review requires the architect role${detail ? `: ${detail}` : ''}`);
  }
}

/** Refuse when the plan is past review: a locked header Status, or a passing approved gate. */
function requireNotApproved(sh, root, feature, current) {
  if (LOCKED_STATUSES.includes(current)) {
    throw refuse(`plan Status is '${current}'; a review verdict cannot replace it`);
  }
  const history = createGitStateStore({ repoRoot: root, sh }).history(feature);
  const gate = evaluateGate(APPROVED_GATE, history);
  if (gate.passed) throw refuse(`the approved gate passes for '${feature}' (the event log records an approval)`);
}

/** The running git user.email; empty refuses (the commit names its reviewer). */
function reviewerEmail(sh, root) {
  const res = sh('git', ['config', 'user.email'], { cwd: root });
  const email = String(res.stdout ?? '').trim();
  if (res.status !== 0 || email === '') throw refuse('cannot determine git user.email — set your git identity first');
  return email;
}

/** Every refusal, in order, before anything is written. */
function loadRequest(argv, sh, root) {
  const { feature, status, trailers } = parsePlanStatusArgs(argv);
  const planRel = `.agents/plans/${feature}.md`;
  const planAbs = join(root, planRel);
  if (!existsSync(planAbs)) throw refuse(`plan file not found: ${planRel}`);
  requireArchitect(sh, root);
  const text = readFileSync(planAbs, 'utf8');
  const current = headerField(text, 'Status');
  requireNotApproved(sh, root, feature, current);
  const branch = planWorkBranch(headerField(text, 'Branch'), feature);
  const notReady = requirePublishReady(sh, root, branch);
  if (notReady !== null) throw refuse(notReady);
  const reviewedBy = reviewerEmail(sh, root);
  return { feature, status, trailers, planRel, planAbs, text, current, branch, reviewedBy };
}

/** Write the header Status (only when it differs), then commit, push and label. */
function recordReview(sh, root, req) {
  const text = req.current === req.status ? req.text : setPlanStatus(req.text, req.status);
  if (text !== req.text) writeFileSync(req.planAbs, text, 'utf8');
  const issue = planIssueNumber(text);
  const message = reviewCommitMessage(text, { feature: req.feature, status: req.status, reviewedBy: req.reviewedBy }, req.trailers);
  const result = publishPlanChange(sh, root, {
    verb: VERB, branch: req.branch, paths: [req.planRel], message, issue, labelStatus: req.status,
  });
  return { ...result, issue };
}

/**
 * `rad plan-status <feature> <rejected|needs-revision> [--trailer "Key: Value"]...`
 *
 * @param {string[]} argv
 * @param {{ repoRoot: string, sh?: typeof defaultSh }} ctx
 * @returns {Promise<number>} exit code
 */
export async function planStatusCommand(argv, ctx) {
  if (argv.some((a) => HELP_FLAGS.includes(a))) {
    process.stdout.write(`Usage: ${PLAN_STATUS_USAGE}\n`);
    return OK_EXIT;
  }
  const sh = ctx.sh ?? defaultSh;
  const root = ctx.repoRoot;
  try {
    const req = loadRequest(argv, sh, root);
    const result = recordReview(sh, root, req);
    if (result.code !== OK_EXIT) {
      process.stderr.write(`${VERB}: ${result.message}\n`);
      return FAILED_EXIT;
    }
    process.stdout.write(
      `${VERB}: ok feature=${req.feature} status=${req.status} committed=${result.committed} pushed=${result.pushed} issue=${result.issue ?? 'none'}\n`,
    );
    return OK_EXIT;
  } catch (err) {
    if (!(err instanceof PlanStatusStop)) throw err;
    process.stderr.write(`${VERB}: ${err.message}\n`);
    if (err.usage) process.stderr.write(`Usage: ${PLAN_STATUS_USAGE}\n`);
    return err.code;
  }
}
