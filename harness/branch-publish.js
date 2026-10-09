/**
 * branch-publish.js — the resumable commit/push/label step behind `rad approve`,
 * `rad plan-status` and `rad wrap` (which requests no label).
 *
 * Publishes a fixed set of paths on the plan's work branch: commits ONLY those
 * paths (explicit pathspec, so unrelated files never ride along), pushes when
 * origin lacks the branch or lags HEAD, then labels the issue — the label runs
 * only after a successful push. Each step checks before it acts, so a rerun
 * after any failure resumes where the last run stopped (no rollback).
 *
 * Never writes to stderr: failures come back as `{ code, message }` for the
 * caller to print. Every git call is an args array via `sh`.
 */
import { join } from 'node:path';
import process from 'node:process';

const OK_EXIT = 0;
const FAILED_EXIT = 1;
const LABEL_SCRIPT = 'scripts/rad-label.sh';
const DIFF_CACHED_CLEAN_EXIT = 0;
const DIFF_CACHED_DIRTY_EXIT = 1;
const LS_REMOTE_NO_MATCH_EXIT = 2;
const NO_OUTPUT = 'no output';

/** A failed step; its message already carries the resume hint. */
class PublishStop extends Error {}

/** The trimmed stderr (else stdout) of a failed call, for error context. */
function detailOf(res) {
  return String(res.stderr || res.stdout || NO_OUTPUT).trim();
}

/** Run git; on non-zero exit throw a PublishStop built by `makeMessage(detail)`. */
function gitOrStop(sh, root, args, makeMessage) {
  const res = sh('git', args, { cwd: root });
  if (res.status !== 0) {
    throw new PublishStop(makeMessage(`git ${args.join(' ')} exited ${res.status}: ${detailOf(res)}`));
  }
  return String(res.stdout ?? '').trim();
}

/**
 * Refuse unless HEAD is on `branch` and nothing is staged. A git call that
 * cannot answer is itself a refusal (fail closed).
 *
 * @param {Function} sh - `(cmd, args, { cwd }) => { status, stdout, stderr }`
 * @param {string} repoRoot
 * @param {string} branch
 * @returns {string|null} the refusal message, or null when ready
 */
export function requirePublishReady(sh, repoRoot, branch) {
  const head = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
  if (head.status !== 0) {
    return `cannot read the current branch (git rev-parse exited ${head.status}): ${detailOf(head)}`;
  }
  const current = String(head.stdout ?? '').trim();
  if (current !== branch) return `HEAD is on '${current}', not the work branch '${branch}'; check it out first`;
  const staged = sh('git', ['diff', '--cached', '--quiet'], { cwd: repoRoot });
  if (staged.status === DIFF_CACHED_DIRTY_EXIT) {
    return 'staged changes are present; commit or unstage them first so they cannot ride along';
  }
  if (staged.status !== DIFF_CACHED_CLEAN_EXIT) {
    return `cannot check the index (git diff --cached exited ${staged.status}): ${detailOf(staged)}`;
  }
  return null;
}

/** Commit `paths` only when they have changes; returns whether it committed. */
function commitPaths(sh, root, req, fail) {
  const changed = gitOrStop(sh, root, ['status', '--porcelain', '--', ...req.paths], fail);
  if (changed === '') return false;
  gitOrStop(sh, root, ['add', '--', ...req.paths], fail);
  gitOrStop(sh, root, ['commit', '-q', '-m', req.message, '--', ...req.paths], fail);
  return true;
}

/** origin's sha for refs/heads/<branch>, or null when origin lacks it. */
function remoteSha(sh, root, branch, fail) {
  const args = ['ls-remote', '--exit-code', '--heads', 'origin', branch];
  const res = sh('git', args, { cwd: root });
  if (res.status === LS_REMOTE_NO_MATCH_EXIT) return null;
  if (res.status !== 0) throw new PublishStop(fail(`git ${args.join(' ')} exited ${res.status}: ${detailOf(res)}`));
  // --heads matches by suffix, so pick the exact ref (team/rad/x must not count for rad/x).
  const ref = `refs/heads/${branch}`;
  const line = String(res.stdout ?? '').split('\n').map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name === ref);
  return line === undefined ? null : line[0];
}

/** Push when origin lacks the branch or its tip differs from HEAD; returns whether it pushed. */
function pushIfNeeded(sh, root, req, fail) {
  const remote = remoteSha(sh, root, req.branch, fail);
  const local = gitOrStop(sh, root, ['rev-parse', 'HEAD'], fail);
  if (remote === local) return false;
  gitOrStop(sh, root, ['push', '-q', '-u', 'origin', req.branch], (d) => fail(`push failed: ${d}`));
  return true;
}

/** Label the issue with `labelStatus`, or say why not. */
function labelIssue(sh, root, req, fail) {
  if (!hasLabelStatus(req)) {
    process.stdout.write('label skipped: no label requested\n');
    return;
  }
  if (req.issue === null || req.issue === undefined) {
    process.stdout.write('label skipped: no issue\n');
    return;
  }
  const res = sh(join(root, LABEL_SCRIPT), [String(req.issue), req.labelStatus], { cwd: root });
  if (res.status !== 0) {
    throw new PublishStop(fail(`${LABEL_SCRIPT} ${req.issue} ${req.labelStatus} exited ${res.status}: ${detailOf(res)}`));
  }
}

/** An absent or null `labelStatus` means no label was requested (e.g. `rad wrap`). */
function hasLabelStatus(req) {
  return req.labelStatus !== undefined && req.labelStatus !== null;
}

const isBlank = (value) => typeof value !== 'string' || value.trim() === '';

/** Programmer errors (not runtime failures): an empty pathspec would commit everything. */
function requireRequest(req) {
  if (!Array.isArray(req.paths) || req.paths.length === 0) throw new TypeError('publishPlanChange: paths must be a non-empty array');
  for (const key of ['verb', 'branch', 'message']) {
    if (isBlank(req[key])) throw new TypeError(`publishPlanChange: ${key} is required`);
  }
  if (hasLabelStatus(req) && isBlank(req.labelStatus)) {
    throw new TypeError('publishPlanChange: labelStatus must be a non-empty string when given');
  }
}

/**
 * Commit `paths` (if changed), push the branch (if origin lags), then label
 * (skipped when `labelStatus` is absent or null).
 *
 * @param {Function} sh - `(cmd, args, { cwd }) => { status, stdout, stderr }`
 * @param {string} repoRoot
 * @param {{ verb: string, branch: string, paths: string[], message: string,
 *           issue: number|null, labelStatus?: string|null }} req
 * @returns {{ code: number, committed: boolean, pushed: boolean, message: string }}
 */
export function publishPlanChange(sh, repoRoot, req) {
  requireRequest(req);
  const fail = (detail) => `${detail}; a rerun of ${req.verb} is safe and resumes`;
  let committed = false;
  let pushed = false;
  try {
    committed = commitPaths(sh, repoRoot, req, fail);
    pushed = pushIfNeeded(sh, repoRoot, req, fail);
    labelIssue(sh, repoRoot, req, fail);
  } catch (err) {
    if (!(err instanceof PublishStop)) throw err;
    return { code: FAILED_EXIT, committed, pushed, message: err.message };
  }
  return { code: OK_EXIT, committed, pushed, message: `published ${req.branch} (committed=${committed} pushed=${pushed})` };
}
