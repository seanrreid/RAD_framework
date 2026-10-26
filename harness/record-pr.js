/**
 * record-pr.js — `rad record-pr <feature> --pr <n>`.
 *
 * Records the `pr-opened` event for a delivery finished by hand: the PR was
 * opened outside `rad deliver`, so the event log never saw it. It looks the PR
 * up with `gh`, appends one `pr-opened` event (data `{ pr, handFinished: true }`),
 * marks the plan `Status: complete` with `Completed-At:`, and publishes ONLY the
 * plan file and `events.jsonl` on the work branch.
 *
 * Exit codes: 0 = recorded and published; 2 = refused, nothing written;
 * 1 = a publish step failed — a rerun is safe and resumes without appending a
 * second `pr-opened`. Every refusal runs before the first write. Every external
 * call is an args array through the injected `sh`; a `gh` failure is reported
 * with its reason, never treated as success.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { createGitStateStore, defaultSh, isSafeFeature } from './adapters/git-state-store.js';
import { evaluateGate } from './gates.js';
import { publishPlanChange, requirePublishReady } from './branch-publish.js';
import { planHeaderValue, planIssueNumber, planWorkBranch, setPlanStatus, upsertPlanHeader } from './plan-commit.js';

const VERB = 'rad record-pr';
export const RECORD_PR_USAGE = 'rad record-pr <feature> --pr <n>';
const OK_EXIT = 0;
const FAILED_EXIT = 1;
const REFUSED_EXIT = 2;
const APPROVED_GATE = 'approved';
const COMPLETE = 'complete';
const COMPLETED_AT = 'Completed-At';
const REVIEW_LABEL = 'review';
const PR_OPEN_STATE = 'OPEN';
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const RESERVED_SLUG = '_architecture';
const HELP_FLAGS = ['--help', '-h'];
const EVENT_ACTOR = 'harness';

/** A deliberate stop carrying its exit code; anything else is a bug and propagates. */
class RecordPrStop extends Error {
  constructor(code, message, { usage = false } = {}) {
    super(message);
    this.code = code;
    this.usage = usage;
  }
}
const refuse = (message) => new RecordPrStop(REFUSED_EXIT, message);
const usageError = (message) => new RecordPrStop(REFUSED_EXIT, message, { usage: true });

/**
 * Parse argv into the feature and the PR number. A bad argument throws a usage stop (exit 2).
 *
 * @param {string[]} argv
 * @returns {{ feature: string, pr: number }}
 */
export function parseRecordPrArgs(argv) {
  const positionals = [];
  let prArg = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pr') {
      if (i + 1 >= argv.length) throw usageError('--pr requires a PR number');
      prArg = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('-')) {
      throw usageError(`unknown option '${arg}'`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 1) throw usageError('expected exactly one <feature>');
  const [feature] = positionals;
  if (!isSafeFeature(feature) || feature === RESERVED_SLUG) {
    throw usageError(`invalid feature '${feature}' (expected /^[a-z0-9][a-z0-9-]*$/)`);
  }
  if (prArg === null) throw usageError('--pr <n> is required');
  if (!POSITIVE_INTEGER.test(prArg)) throw usageError(`--pr must be a positive integer, got '${prArg}'`);
  return { feature, pr: Number(prArg) };
}

/** The recorded hand-finished `pr-opened` for this PR after the last deliver-started, else null. */
function findRecordedPr(history, pr) {
  const events = Array.isArray(history) ? history : [];
  const start = events.map((e) => e?.type).lastIndexOf('deliver-started');
  const after = events.slice(start + 1).filter((e) => e?.type === 'pr-opened');
  if (after.length === 0) return null;
  const mine = after.find((e) => e.data?.handFinished === true && e.data?.pr === pr);
  if (!mine) throw refuse('the history already records a pr-opened after the last deliver-started; nothing to record');
  return mine;
}

/** `gh pr view` through `sh`: the PR must be OPEN with the work branch as its head. */
function requireOpenPr(sh, root, pr, workBranch) {
  const res = sh('gh', ['pr', 'view', String(pr), '--json', 'state,headRefName'], { cwd: root });
  if (res.status !== 0) {
    const detail = String(res.stderr || res.stdout || '').trim();
    throw refuse(`cannot look up PR #${pr} (gh exited ${res.status})${detail ? `: ${detail}` : ''}`);
  }
  let info;
  try {
    info = JSON.parse(String(res.stdout ?? ''));
  } catch (err) {
    throw refuse(`cannot parse the gh output for PR #${pr}: ${err.message}`);
  }
  if (info?.state !== PR_OPEN_STATE) throw refuse(`PR #${pr} is ${info?.state ?? 'in an unknown state'}, not ${PR_OPEN_STATE}`);
  if (info.headRefName !== workBranch) {
    throw refuse(`PR #${pr} head is '${info.headRefName}', not the work branch '${workBranch}'`);
  }
}

/** Every refusal, in order, before anything is written. */
function loadRequest(argv, sh, root) {
  const { feature, pr } = parseRecordPrArgs(argv);
  const planRel = `.agents/plans/${feature}.md`;
  if (!existsSync(join(root, planRel))) throw refuse(`plan file not found: ${planRel}`);
  const text = readFileSync(join(root, planRel), 'utf8');
  const state = createGitStateStore({ repoRoot: root, sh });
  const history = state.history(feature);
  if (!evaluateGate(APPROVED_GATE, history).passed) throw refuse(`'${feature}' is not approved; nothing to record`);
  const recorded = findRecordedPr(history, pr);
  const branch = planWorkBranch(planHeaderValue(text, 'Branch') ?? '', feature);
  const notReady = requirePublishReady(sh, root, branch);
  if (notReady !== null) throw refuse(notReady);
  if (recorded === null) requireOpenPr(sh, root, pr, branch);
  return { feature, pr, planRel, text, state, branch, resume: recorded !== null };
}

/** Status: complete plus Completed-At (first completion time kept); returns the new text. */
function markComplete(root, req) {
  let next = setPlanStatus(req.text, COMPLETE);
  if (planHeaderValue(next, COMPLETED_AT) === null) {
    next = upsertPlanHeader(next, COMPLETED_AT, new Date().toISOString(), { after: 'Status' });
  }
  if (next !== req.text) writeFileSync(join(root, req.planRel), next, 'utf8');
  return next;
}

/** Append the event (unless a rerun finds it), mark the plan, then publish plan + events log only. */
function recordAndPublish(sh, root, req) {
  if (!req.resume) {
    req.state.append({ feature: req.feature, type: 'pr-opened', actor: EVENT_ACTOR, data: { pr: req.pr, handFinished: true } });
  }
  const text = markComplete(root, req);
  const issue = planIssueNumber(text);
  const result = publishPlanChange(sh, root, {
    verb: VERB,
    branch: req.branch,
    paths: [req.planRel, `.agents/state/${req.feature}/events.jsonl`],
    message: `deliver(${req.feature}): record hand-finished PR #${req.pr}\n\nPlan: ${req.planRel}${issue === null ? '' : `\nIssue: ${issue}`}`,
    issue,
    labelStatus: REVIEW_LABEL,
  });
  return { ...result, issue };
}

/**
 * `rad record-pr <feature> --pr <n>`
 *
 * @param {string[]} argv
 * @param {{ repoRoot: string, sh?: typeof defaultSh }} ctx
 * @returns {Promise<number>} exit code
 */
export async function recordPrCommand(argv, ctx) {
  if (argv.some((a) => HELP_FLAGS.includes(a))) {
    process.stdout.write(`Usage: ${RECORD_PR_USAGE}\n`);
    return OK_EXIT;
  }
  const sh = ctx.sh ?? defaultSh;
  const root = ctx.repoRoot;
  try {
    const req = loadRequest(argv, sh, root);
    const result = recordAndPublish(sh, root, req);
    if (result.code !== OK_EXIT) {
      process.stderr.write(`${VERB}: ${result.message}\n`);
      return FAILED_EXIT;
    }
    process.stdout.write(
      `${VERB}: ok feature=${req.feature} pr=${req.pr} committed=${result.committed} pushed=${result.pushed} issue=${result.issue ?? 'none'}\n`,
    );
    return OK_EXIT;
  } catch (err) {
    if (!(err instanceof RecordPrStop)) throw err;
    process.stderr.write(`${VERB}: ${err.message}\n`);
    if (err.usage) process.stderr.write(`Usage: ${RECORD_PR_USAGE}\n`);
    return err.code;
  }
}
