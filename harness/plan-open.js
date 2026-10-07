/**
 * plan-open.js — `rad plan-open <plan-file> [--trailer "Key: Value"]...`.
 *
 * Cuts the plan's work branch from origin/<default>, commits ONLY the plan file
 * with a message derived from the plan, pushes, then labels the issue. Any
 * coding tool can call it; no step is left to a model.
 *
 * Exit codes: 0 = committed and pushed; 2 = refused, nothing changed; 1 = a step
 * failed after the branch exists — a rerun is safe and resumes (no rollback).
 * Always pushes; never reads RAD_SYNC. Every git call is an args array via `sh`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

import { defaultSh, isSafeFeature } from './adapters/git-state-store.js';
import { conventionWorkBranch, planCommitMessage, planIssueNumber, validateTrailer } from './plan-commit.js';

const VERB = 'rad plan-open';
export const PLAN_OPEN_USAGE = 'rad plan-open <plan-file> [--trailer "Key: Value"]...';
const REFUSED_EXIT = 2;
const FAILED_EXIT = 1;
const OK_EXIT = 0;
const LINT_SCRIPT = 'scripts/lint-plan.sh';
const LABEL_SCRIPT = 'scripts/rad-label.sh';
const DEFAULT_BRANCH_SCRIPT = 'scripts/get-default-branch.sh';
const LABEL_STATUS = 'pending-review';
/** The plan path relative to the repo root; group 1 is the slug. */
const PLAN_PATH_PATTERN = /^\.agents\/plans\/([^/]+)\.md$/;
/** isSafeFeature admits this reserved project log; it is never a plan slug. */
const RESERVED_SLUG = '_architecture';
/** Same grammar as draft-insights-plan.sh validate_branch: no leading '-', no '..'. */
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SHOW_REF_ABSENT_EXIT = 1;
const LS_REMOTE_NO_MATCH_EXIT = 2;
const HEADER_BRANCH_PATTERN = /^Branch:\s*(.*)$/;
const SECTION_HEADING_PATTERN = /^## /;

/** A deliberate stop carrying its exit code; anything else is a bug and propagates. */
class PlanOpenStop extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const refuse = (message) => new PlanOpenStop(REFUSED_EXIT, message);
const failure = (message) => new PlanOpenStop(FAILED_EXIT, `${message}; a rerun of ${VERB} is safe and resumes`);

/** Run git; on non-zero exit throw the stop `makeStop(detail)` builds. */
function gitOrStop(sh, root, args, makeStop) {
  const res = sh('git', args, { cwd: root });
  if (res.status !== 0) {
    const detail = String(res.stderr || res.stdout || 'no output').trim();
    throw makeStop(`git ${args.join(' ')} exited ${res.status}: ${detail}`);
  }
  return String(res.stdout ?? '').trim();
}

/** Parse argv into the plan path and its validated trailers. */
export function parsePlanOpenArgs(argv) {
  const positionals = [];
  const trailers = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--trailer') {
      if (i + 1 >= argv.length) throw refuse('--trailer requires a "Key: Value" argument');
      const err = validateTrailer(argv[i + 1]);
      if (err !== null) throw refuse(`invalid --trailer: ${err}`);
      trailers.push(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('-')) {
      throw refuse(`unknown option '${arg}'`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 1) throw refuse(`expected exactly one <plan-file>; usage: ${PLAN_OPEN_USAGE}`);
  return { planArg: positionals[0], trailers };
}

/** Resolve the plan path; it must be `.agents/plans/<slug>.md` under the repo root. */
function resolvePlanTarget(planArg, repoRoot) {
  const planAbs = resolve(repoRoot, planArg);
  const planRel = relative(repoRoot, planAbs).split('\\').join('/');
  const m = PLAN_PATH_PATTERN.exec(planRel);
  if (!m) throw refuse(`plan must be .agents/plans/<slug>.md under the repo root, got '${planArg}'`);
  const slug = m[1];
  if (!isSafeFeature(slug) || slug === RESERVED_SLUG) {
    throw refuse(`invalid plan slug '${slug}' (expected /^[a-z0-9][a-z0-9-]*$/)`);
  }
  if (!existsSync(planAbs)) throw refuse(`plan file not found: ${planRel}`);
  return { slug, planRel, planAbs };
}

/** The `Branch:` header value from the header block, or '' when absent. */
function headerBranch(text) {
  for (const line of text.split('\n')) {
    if (SECTION_HEADING_PATTERN.test(line)) break;
    const m = HEADER_BRANCH_PATTERN.exec(line);
    if (m) return m[1].trim();
  }
  return '';
}

/** The plan's branch; refused unless it equals the convention branch for the slug. */
function requireConventionBranch(text, slug, env) {
  const expected = conventionWorkBranch(slug, env);
  const branch = headerBranch(text);
  if (branch === '') throw refuse(`plan has no Branch: header (expected 'Branch: ${expected}')`);
  if (branch !== expected) throw refuse(`plan Branch: '${branch}' must equal '${expected}'`);
  if (!BRANCH_NAME_PATTERN.test(branch) || branch.includes('..')) {
    throw refuse(`invalid branch name '${branch}' (allowed: [A-Za-z0-9._/-], no leading '-' or '..')`);
  }
  return branch;
}

/** Every refusal that needs only the argv and the plan text — runs before any git call. */
function loadRequest(argv, ctx) {
  const { planArg, trailers } = parsePlanOpenArgs(argv);
  const target = resolvePlanTarget(planArg, ctx.repoRoot);
  const text = readFileSync(target.planAbs, 'utf8');
  const branch = requireConventionBranch(text, target.slug, ctx.env ?? process.env);
  let message;
  try {
    message = planCommitMessage(text, trailers);
  } catch (err) {
    throw refuse(`cannot derive the commit message: ${err.message}`);
  }
  return { ...target, text, branch, message };
}

/** The default branch from get-default-branch.sh; a failure or empty output refuses. */
function readDefaultBranch(sh, root) {
  const res = sh(join(root, DEFAULT_BRANCH_SCRIPT), [root], { cwd: root });
  const branch = String(res.stdout ?? '').trim();
  if (res.status !== 0 || branch === '') {
    const detail = String(res.stderr || '').trim();
    throw refuse(`cannot resolve default branch (${DEFAULT_BRANCH_SCRIPT} exited ${res.status}) ${detail}`.trim());
  }
  return branch;
}

/** True when refs/heads/<branch> exists; an unexpected show-ref exit refuses. */
function localBranchExists(sh, root, branch) {
  const res = sh('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root });
  if (res.status === 0) return true;
  if (res.status === SHOW_REF_ABSENT_EXIT) return false;
  throw refuse(`git show-ref exited ${res.status}: ${String(res.stderr).trim()}`);
}

/** True when origin has the branch; an unverifiable origin refuses. */
function remoteBranchExists(sh, root, branch) {
  const res = sh('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], { cwd: root });
  if (res.status === 0) return true;
  if (res.status === LS_REMOTE_NO_MATCH_EXIT) return false;
  throw refuse(`cannot verify origin (git ls-remote exited ${res.status}): ${String(res.stderr).trim()}`);
}

/**
 * True when the branch tip is the plan commit: it changes only the plan file
 * and its plan blob is byte-identical to the working copy (same object id).
 */
function tipIsPlanCommit(sh, root, req) {
  const stop = (d) => refuse(d);
  const changed = gitOrStop(sh, root, ['diff-tree', '--no-commit-id', '--name-only', '-r', req.branch], stop);
  if (changed !== req.planRel) return false;
  const tipBlob = gitOrStop(sh, root, ['rev-parse', `${req.branch}:${req.planRel}`], stop);
  const workBlob = gitOrStop(sh, root, ['hash-object', '--', req.planRel], stop);
  return tipBlob === workBlob;
}

/** Existing local branch → 'commit' (nothing beyond origin/<default>) or 'push' (tip is the plan commit). */
function classifyLocalBranch(sh, root, req) {
  const base = `origin/${readDefaultBranch(sh, root)}`;
  const ahead = Number(gitOrStop(sh, root, ['rev-list', '--count', `${base}..${req.branch}`], refuse));
  if (ahead === 0) return 'commit';
  if (ahead === 1 && tipIsPlanCommit(sh, root, req)) return 'push';
  throw refuse(`${req.branch} already has ${ahead} commit(s) beyond ${base} that are not this plan's commit`);
}

/** Refuse unless the plan lints and no tracked file has uncommitted changes. */
function requireCommitReady(sh, root, req) {
  const lint = sh(join(root, LINT_SCRIPT), [req.planRel], { cwd: root });
  if (lint.status !== 0) {
    const output = `${lint.stdout ?? ''}${lint.stderr ?? ''}`.trim();
    throw refuse(`${LINT_SCRIPT} failed for ${req.planRel}:\n${output}`);
  }
  const dirty = gitOrStop(sh, root, ['status', '--porcelain', '--untracked-files=no'], refuse);
  if (dirty !== '') throw refuse(`tracked files have uncommitted changes; commit or stash them first:\n${dirty}`);
}

/** Fresh run: fetch origin/<default> and cut the branch from it. */
function cutBranch(sh, root, req) {
  requireCommitReady(sh, root, req);
  const base = readDefaultBranch(sh, root);
  gitOrStop(sh, root, ['fetch', '-q', 'origin', base], (d) => refuse(`fetch failed: ${d}`));
  gitOrStop(sh, root, ['checkout', '-q', '-b', req.branch, `origin/${base}`], failure);
}

/** Stage only the plan file and commit it on the work branch. */
function commitPlan(sh, root, req) {
  const current = gitOrStop(sh, root, ['rev-parse', '--abbrev-ref', 'HEAD'], failure);
  if (current !== req.branch) gitOrStop(sh, root, ['checkout', '-q', req.branch], failure);
  gitOrStop(sh, root, ['add', '--', req.planRel], failure);
  gitOrStop(sh, root, ['commit', '-q', '-m', req.message], failure);
}

/** Push the work branch; a failure leaves the local commit for a resumable rerun. */
function pushBranch(sh, root, req) {
  gitOrStop(sh, root, ['push', '-q', '-u', 'origin', req.branch],
    (d) => failure(`committed locally on ${req.branch}; push failed: ${d}`));
}

/** After a successful push: label the issue pending-review, or say why not. */
function labelIssue(sh, root, req) {
  const issue = planIssueNumber(req.text);
  if (issue === null) {
    process.stdout.write('label skipped: no issue\n');
    return null;
  }
  const res = sh(join(root, LABEL_SCRIPT), [String(issue), LABEL_STATUS], { cwd: root });
  if (res.status !== 0) {
    const detail = String(res.stderr || res.stdout || '').trim();
    throw failure(`pushed ${req.branch}; ${LABEL_SCRIPT} ${issue} ${LABEL_STATUS} exited ${res.status}: ${detail}`);
  }
  return issue;
}

/** Decide where to start: 'fresh', 'commit', or 'push'. */
function startingStep(sh, root, req) {
  if (localBranchExists(sh, root, req.branch)) return classifyLocalBranch(sh, root, req);
  if (remoteBranchExists(sh, root, req.branch)) {
    throw refuse(`${req.branch} exists on origin but not locally; check it out (scripts/checkout-plan.sh) instead`);
  }
  return 'fresh';
}

/** Run the steps from `step` onward; returns the ok line's fields. */
function openPlan(sh, root, req, step) {
  if (step === 'fresh') cutBranch(sh, root, req);
  if (step === 'commit') requireCommitReady(sh, root, req);
  if (step !== 'push') commitPlan(sh, root, req);
  pushBranch(sh, root, req);
  const issue = labelIssue(sh, root, req);
  const sha = gitOrStop(sh, root, ['rev-parse', req.branch], failure);
  return { sha, issue };
}

/**
 * `rad plan-open <plan-file> [--trailer "Key: Value"]...`
 *
 * @param {string[]} argv
 * @param {{ repoRoot: string, sh?: typeof defaultSh, env?: Record<string, string|undefined> }} ctx
 * @returns {Promise<number>} exit code
 */
export async function planOpenCommand(argv, ctx) {
  const sh = ctx.sh ?? defaultSh;
  const root = ctx.repoRoot;
  try {
    const req = loadRequest(argv, ctx);
    const step = startingStep(sh, root, req);
    const { sha, issue } = openPlan(sh, root, req, step);
    process.stdout.write(
      `${VERB}: ok feature=${req.slug} branch=${req.branch} commit=${sha} issue=${issue ?? 'none'}\n`,
    );
    return OK_EXIT;
  } catch (err) {
    if (!(err instanceof PlanOpenStop)) throw err;
    process.stderr.write(`${VERB}: ${err.message}\n`);
    return err.code;
  }
}
