/**
 * deliver-prepare.js — the real prepare port behind `rad deliver`'s Prepare
 * phase: bring the work branch up to date and mark the plan in-progress before
 * any wave runs.
 *
 * In order: refuse unless HEAD is on the work branch with nothing staged; fetch
 * origin; fast-forward to origin's work branch when it is ahead (never rebase,
 * never force); merge origin's base branch when HEAD lacks it, stashing tracked
 * partial work around the merge (a conflicted merge is aborted, leaving HEAD
 * and the tree as they were); set the plan
 * header `Status: in-progress`; then commit/push/label via publishPlanChange.
 * Each step checks before it acts, so a rerun is idempotent.
 *
 * Fails closed: any unexpected git result is a `prepare-failed` stop carrying
 * the git stderr. Every git call is an args array through the injected `sh`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { requirePublishReady, publishPlanChange } from './branch-publish.js';
import { setPlanStatus, planIssueNumber } from './plan-commit.js';

const ORIGIN = 'origin';
const IN_PROGRESS = 'in-progress';
const PUBLISH_VERB = 'rad deliver';
const STOP_MERGE_CONFLICT = 'merge-conflict';
const STOP_PREPARE_FAILED = 'prepare-failed';
const OK_EXIT = 0;
const NOT_ANCESTOR_EXIT = 1;
const REF_ABSENT_EXIT = 1;
const LS_REMOTE_NO_MATCH_EXIT = 2;
const DIFF_HAS_CHANGES_EXIT = 1;
const CONFLICT_PATH_SEPARATOR = ', ';
const NO_OUTPUT = 'no output';
const STASH_MESSAGE_PREFIX = 'rad deliver: partial work before merging ';
const KEPT_STASH = 'stash@{0}';

/** A typed stop; `stopped` is the PrepareResult stop kind. */
class PrepareStop extends Error {
  constructor(stopped, detail) {
    super(detail);
    this.stopped = stopped;
  }
}

/** The trimmed stderr (else stdout) of a failed call, for error context. */
function detailOf(res) {
  return String(res.stderr || res.stdout || NO_OUTPUT).trim();
}

function git(sh, root, args) {
  return sh('git', args, { cwd: root });
}

/** A prepare-failed stop describing a git call's unexpected exit. */
function gitFailure(args, res, prefix = '') {
  return new PrepareStop(STOP_PREPARE_FAILED, `${prefix}git ${args.join(' ')} exited ${res.status}: ${detailOf(res)}`);
}

/** Run git; on non-zero exit stop with prepare-failed. Returns trimmed stdout. */
function gitOrStop(sh, root, args) {
  const res = git(sh, root, args);
  if (res.status !== OK_EXIT) throw gitFailure(args, res);
  return String(res.stdout ?? '').trim();
}

/**
 * Fetch the base branch, then the work branch when origin has it (a work
 * branch not yet pushed is not an error). Returns whether origin has it.
 */
function fetchOrigin(sh, root, baseBranch, workBranch) {
  const unreachable = 'cannot reach origin: ';
  const fetchBase = ['fetch', '-q', ORIGIN, baseBranch];
  const base = git(sh, root, fetchBase);
  if (base.status !== OK_EXIT) throw gitFailure(fetchBase, base, unreachable);
  const lsArgs = ['ls-remote', '--exit-code', '--heads', ORIGIN, `refs/heads/${workBranch}`];
  const ls = git(sh, root, lsArgs);
  if (ls.status === LS_REMOTE_NO_MATCH_EXIT) return false;
  if (ls.status !== OK_EXIT) throw gitFailure(lsArgs, ls, unreachable);
  const fetchWork = ['fetch', '-q', ORIGIN, workBranch];
  const work = git(sh, root, fetchWork);
  if (work.status !== OK_EXIT) throw gitFailure(fetchWork, work, unreachable);
  return true;
}

/** Whether `ref` is already contained in HEAD (exit 1 = not an ancestor). */
function isAncestorOfHead(sh, root, ref) {
  const args = ['merge-base', '--is-ancestor', ref, 'HEAD'];
  const res = git(sh, root, args);
  if (res.status === OK_EXIT) return true;
  if (res.status === NOT_ANCESTOR_EXIT) return false;
  throw gitFailure(args, res);
}

/** Fast-forward to origin's work branch when it is ahead; returns whether it did. */
function fastForwardWork(sh, root, workBranch, onOrigin) {
  if (!onOrigin) return false;
  const ref = `${ORIGIN}/${workBranch}`;
  if (isAncestorOfHead(sh, root, ref)) return false;
  const res = git(sh, root, ['merge', '-q', '--ff-only', ref]);
  if (res.status !== OK_EXIT) {
    throw new PrepareStop(STOP_PREPARE_FAILED, `diverged from ${ref}: ${detailOf(res)}`);
  }
  return true;
}

/** Abort the in-progress merge; an abort that fails is itself a stop. */
function abortMerge(sh, root, context) {
  const args = ['merge', '--abort'];
  const res = git(sh, root, args);
  if (res.status !== OK_EXIT) throw gitFailure(args, res, `${context}; `);
}

function mergeInProgress(sh, root) {
  const args = ['rev-parse', '-q', '--verify', 'MERGE_HEAD'];
  const res = git(sh, root, args);
  if (res.status === OK_EXIT) return true;
  if (res.status === REF_ABSENT_EXIT) return false;
  throw gitFailure(args, res);
}

/** Whether the worktree has tracked uncommitted changes (`git diff --quiet` exit 1). */
function hasTrackedChanges(sh, root) {
  const args = ['diff', '--quiet'];
  const res = git(sh, root, args);
  if (res.status === OK_EXIT) return false;
  if (res.status === DIFF_HAS_CHANGES_EXIT) return true;
  throw gitFailure(args, res);
}

function conflictedPaths(sh, root) {
  return gitOrStop(sh, root, ['diff', '--name-only', '--diff-filter=U'])
    .split('\n').filter((p) => p !== '');
}

/**
 * Pop the partial-work stash. A conflicting pop is reset to HEAD (the work is
 * still in the stash, which git keeps on a conflict) and stops merge-conflict.
 */
function restoreStash(sh, root, ref) {
  const kept = `partial work kept in git stash (${KEPT_STASH})`;
  const args = ['stash', 'pop', '-q'];
  const res = git(sh, root, args);
  if (res.status === OK_EXIT) return;
  const conflicted = conflictedPaths(sh, root);
  if (conflicted.length === 0) throw gitFailure(args, res, `${kept}; `);
  const resetArgs = ['reset', '-q', '--hard', 'HEAD'];
  const reset = git(sh, root, resetArgs);
  if (reset.status !== OK_EXIT) throw gitFailure(resetArgs, reset, `${kept}; `);
  const paths = conflicted.join(CONFLICT_PATH_SEPARATOR);
  throw new PrepareStop(STOP_MERGE_CONFLICT,
    `partial work conflicts with ${ref} in ${paths}; it is kept in git stash (${KEPT_STASH})`);
}

/**
 * Abort a failed merge, restore any stash, and return the stop to throw.
 * Conflicted paths are read BEFORE the abort (the abort clears them).
 */
function failedMerge(sh, root, { ref, args, res, stashed }) {
  const conflicted = conflictedPaths(sh, root);
  if (conflicted.length > 0) {
    const paths = conflicted.join(CONFLICT_PATH_SEPARATOR);
    abortMerge(sh, root, `merge conflict in ${paths}`);
    if (stashed) restoreStash(sh, root, ref);
    return new PrepareStop(STOP_MERGE_CONFLICT, paths);
  }
  if (mergeInProgress(sh, root)) abortMerge(sh, root, `merge of ${ref} failed`);
  if (stashed) restoreStash(sh, root, ref);
  return gitFailure(args, res);
}

/**
 * Merge origin's base branch when HEAD lacks it. Tracked partial work is
 * stashed around the merge (no -u: untracked files stay put) and popped after.
 * Returns { merged, stashed }.
 */
function mergeBase(sh, root, baseBranch) {
  const ref = `${ORIGIN}/${baseBranch}`;
  if (isAncestorOfHead(sh, root, ref)) return { merged: false, stashed: false };
  const stashed = hasTrackedChanges(sh, root);
  if (stashed) gitOrStop(sh, root, ['stash', 'push', '-q', '-m', `${STASH_MESSAGE_PREFIX}${ref}`]);
  const args = ['merge', '-q', '--no-edit', ref];
  const res = git(sh, root, args);
  if (res.status !== OK_EXIT) throw failedMerge(sh, root, { ref, args, res, stashed });
  if (stashed) restoreStash(sh, root, ref);
  return { merged: true, stashed };
}

/** Set the plan header Status to in-progress (only when it differs); returns the text. */
function markInProgress(root, planPath) {
  const file = join(root, planPath);
  try {
    const text = readFileSync(file, 'utf8');
    const next = setPlanStatus(text, IN_PROGRESS);
    if (next !== text) writeFileSync(file, next);
    return next;
  } catch (err) {
    throw new PrepareStop(STOP_PREPARE_FAILED, `cannot set Status: ${IN_PROGRESS} in ${planPath}: ${err.message}`);
  }
}

/** The begin-execution commit message; the Issue line is omitted when null. */
function beginMessage(feature, planPath, issue) {
  const body = [`Plan: ${planPath}`];
  if (issue !== null) body.push(`Issue: ${issue}`);
  return `deliver(${feature}): begin execution\n\n${body.join('\n')}`;
}

function publish(sh, root, { feature, planPath, workBranch }, text) {
  const issue = planIssueNumber(text);
  const result = publishPlanChange(sh, root, {
    verb: PUBLISH_VERB,
    branch: workBranch,
    paths: [planPath],
    message: beginMessage(feature, planPath, issue),
    issue,
    labelStatus: IN_PROGRESS,
  });
  if (result.code !== OK_EXIT) throw new PrepareStop(STOP_PREPARE_FAILED, result.message);
  return result;
}

function runPrepare(opts) {
  const { sh, root, workBranch, baseBranch, planPath } = opts;
  const refusal = requirePublishReady(sh, root, workBranch);
  if (refusal !== null) throw new PrepareStop(STOP_PREPARE_FAILED, refusal);
  const onOrigin = fetchOrigin(sh, root, baseBranch, workBranch);
  const fastForwarded = fastForwardWork(sh, root, workBranch, onOrigin);
  const { merged, stashed } = mergeBase(sh, root, baseBranch);
  const text = markInProgress(root, planPath);
  const { committed, pushed } = publish(sh, root, opts, text);
  const data = { base: baseBranch, merged, fastForwarded, committed, pushed };
  return stashed ? { ...data, stashed: true } : data;
}

/** Programmer errors (not runtime failures) surface at construction. */
function requirePortOptions(opts) {
  if (typeof opts.sh !== 'function') throw new TypeError('makePreparePort: sh must be a function');
  for (const key of ['root', 'feature', 'planPath', 'workBranch', 'baseBranch']) {
    if (typeof opts[key] !== 'string' || opts[key].trim() === '') throw new TypeError(`makePreparePort: ${key} is required`);
  }
}

/**
 * Build the prepare port.
 *
 * @param {{ sh: Function, root: string, feature: string, planPath: string,
 *           workBranch: string, baseBranch: string }} opts
 *   - sh: `(cmd, args, { cwd }) => { status, stdout, stderr }`
 *   - planPath: the plan doc, relative to `root`
 * @returns {() => Promise<
 *   { ok: true, data: { base: string, merged: boolean, fastForwarded: boolean, committed: boolean, pushed: boolean } }
 * | { ok: false, stopped: 'merge-conflict'|'prepare-failed', detail: string, base: string, branch: string }>}
 */
export function makePreparePort(opts) {
  requirePortOptions(opts);
  return async () => {
    try {
      return { ok: true, data: runPrepare(opts) };
    } catch (err) {
      if (!(err instanceof PrepareStop)) throw err;
      return { ok: false, stopped: err.stopped, detail: err.message, base: opts.baseBranch, branch: opts.workBranch };
    }
  };
}
