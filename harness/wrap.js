/**
 * wrap.js — `rad wrap <feature>`.
 *
 * Publishes the session notes a model already wrote into a plan: commits ONLY
 * the plan file plus the feature's exact-name execution logs on its work
 * branch, then pushes. The model writes the content; this verb only performs
 * the state change. It never writes the plan's content or its `Status:`
 * (`rad deliver` owns status), and it requests no label.
 *
 * Exit codes: 0 = committed (if needed) and pushed, or nothing to publish;
 * 2 = refused, nothing changed; 1 = a publish step failed — a rerun is safe
 * and resumes (no rollback). Every refusal runs before any git write.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { defaultSh, isSafeFeature } from './adapters/git-state-store.js';
import { publishPlanChange, requirePublishReady } from './branch-publish.js';
import { executionLogPaths } from './deliver-finish.js';
import { planHeaderValue, planIssueNumber } from './plan-commit.js';

const VERB = 'rad wrap';
export const WRAP_USAGE = 'rad wrap <feature>';
const REFUSED_EXIT = 2;
const FAILED_EXIT = 1;
const OK_EXIT = 0;
/** isSafeFeature admits this reserved project log; it is never a plan slug. */
const RESERVED_SLUG = '_architecture';
const HELP_FLAGS = ['--help', '-h'];

/** A deliberate stop carrying its exit code; anything else is a bug and propagates. */
class WrapStop extends Error {
  constructor(code, message, { usage = false } = {}) {
    super(message);
    this.code = code;
    this.usage = usage;
  }
}
const refuse = (message) => new WrapStop(REFUSED_EXIT, message);
const usageError = (message) => new WrapStop(REFUSED_EXIT, message, { usage: true });

/**
 * Parse argv into the feature. A bad argument throws a usage stop (exit 2).
 *
 * @param {string[]} argv
 * @returns {{ feature: string }}
 */
export function parseWrapArgs(argv) {
  const option = argv.find((a) => a.startsWith('-'));
  if (option !== undefined) throw usageError(`unknown option '${option}'`);
  if (argv.length !== 1) throw usageError('expected exactly one <feature>');
  const [feature] = argv;
  if (!isSafeFeature(feature) || feature === RESERVED_SLUG) {
    throw usageError(`invalid feature '${feature}' (expected /^[a-z0-9][a-z0-9-]*$/)`);
  }
  return { feature };
}

/** Every refusal, in order, before anything is written. */
function loadRequest(argv, sh, root) {
  const { feature } = parseWrapArgs(argv);
  const planRel = `.agents/plans/${feature}.md`;
  const planAbs = join(root, planRel);
  if (!existsSync(planAbs)) throw refuse(`plan file not found: ${planRel}`);
  const text = readFileSync(planAbs, 'utf8');
  const branch = planHeaderValue(text, 'Branch');
  if (branch === null || branch.trim() === '') throw refuse(`${planRel} has no Branch: header; cannot find its work branch`);
  const notReady = requirePublishReady(sh, root, branch.trim());
  if (notReady !== null) throw refuse(notReady);
  return { feature, planRel, text, branch: branch.trim() };
}

/** Commit the plan and its execution logs (if changed) and push; never labels. */
function publishNotes(sh, root, req) {
  const message = `wrap(${req.feature}): session notes\n\nPlan: ${req.planRel}`;
  return publishPlanChange(sh, root, {
    verb: VERB,
    branch: req.branch,
    paths: [req.planRel, ...executionLogPaths(root, req.feature)],
    message,
    issue: planIssueNumber(req.text),
  });
}

/**
 * `rad wrap <feature>`
 *
 * @param {string[]} argv
 * @param {{ repoRoot: string, sh?: typeof defaultSh }} ctx
 * @returns {Promise<number>} exit code
 */
export async function wrapCommand(argv, ctx) {
  if (argv.some((a) => HELP_FLAGS.includes(a))) {
    process.stdout.write(`Usage: ${WRAP_USAGE}\n`);
    return OK_EXIT;
  }
  const sh = ctx.sh ?? defaultSh;
  const root = ctx.repoRoot;
  try {
    const req = loadRequest(argv, sh, root);
    const result = publishNotes(sh, root, req);
    if (result.code !== OK_EXIT) {
      process.stderr.write(`${VERB}: ${result.message}\n`);
      return FAILED_EXIT;
    }
    if (!result.committed && !result.pushed) process.stdout.write(`${VERB}: nothing to publish\n`);
    process.stdout.write(`${VERB}: ok feature=${req.feature} committed=${result.committed} pushed=${result.pushed}\n`);
    return OK_EXIT;
  } catch (err) {
    if (!(err instanceof WrapStop)) throw err;
    process.stderr.write(`${VERB}: ${err.message}\n`);
    if (err.usage) process.stderr.write(`Usage: ${WRAP_USAGE}\n`);
    return err.code;
  }
}
