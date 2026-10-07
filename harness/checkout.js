/**
 * checkout.js — `rad checkout <feature | .agents/plans/<feature>.md>`.
 *
 * Checks out a plan's work branch at its remote tip by calling
 * scripts/checkout-plan.sh. It adds no git logic of its own. The plan doc is
 * not on the default branch before checkout, so the branch comes from the
 * RAD_BRANCH_PREFIX convention (conventionWorkBranch), never from a local
 * plan header.
 *
 * Exit codes: 0 = on the branch at its remote tip with the plan present;
 * 2 = refused before any git call (bad arguments); 1 = the checkout script
 * failed (invalid name, missing branch, divergence) or the plan file is absent
 * at the branch tip. Every call is an args array through the injected `sh`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { defaultSh, isSafeFeature } from './adapters/git-state-store.js';
import { conventionWorkBranch } from './plan-commit.js';

const VERB = 'rad checkout';
export const CHECKOUT_USAGE = 'rad checkout <feature | .agents/plans/<feature>.md>';
const OK_EXIT = 0;
const FAILED_EXIT = 1;
const REFUSED_EXIT = 2;
const CHECKOUT_SCRIPT = 'scripts/checkout-plan.sh';
const PLANS_DIR = '.agents/plans';
const HELP_FLAGS = new Set(['--help', '-h']);
/** Accepted shapes: `<f>`, `<f>.md`, `.agents/plans/<f>.md`; group 1 is the feature. */
const FEATURE_ARG_PATTERN = /^(?:\.agents\/plans\/([^/]+)\.md|([^/]+?)(?:\.md)?)$/;
/** isSafeFeature admits this reserved project log; it is never a plan slug. */
const RESERVED_SLUG = '_architecture';

/** A deliberate stop carrying its exit code; anything else is a bug and propagates. */
class CheckoutStop extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const refuse = (message) => new CheckoutStop(REFUSED_EXIT, `${message}\nusage: ${CHECKOUT_USAGE}`);
const failure = (message) => new CheckoutStop(FAILED_EXIT, message);

/**
 * Parse argv into the feature slug. Returns `{ help: true }` for --help/-h.
 *
 * @param {string[]} argv
 * @returns {{ feature: string } | { help: true }}
 */
export function parseCheckoutArgs(argv) {
  if (argv.some((a) => HELP_FLAGS.has(a))) return { help: true };
  const option = argv.find((a) => a.startsWith('-'));
  if (option !== undefined) throw refuse(`unknown option '${option}'`);
  if (argv.length !== 1) throw refuse(`expected exactly one <feature>, got ${argv.length}`);
  const m = FEATURE_ARG_PATTERN.exec(argv[0]);
  if (!m) throw refuse(`expected <feature>, <feature>.md or ${PLANS_DIR}/<feature>.md, got '${argv[0]}'`);
  const feature = m[1] ?? m[2];
  if (!isSafeFeature(feature) || feature === RESERVED_SLUG) {
    throw refuse(`invalid feature '${feature}' (expected /^[a-z0-9][a-z0-9-]*$/)`);
  }
  return { feature };
}

/** Run checkout-plan.sh; a non-zero exit fails with the script's own stderr. */
function runCheckoutScript(sh, root, branch, env) {
  const res = sh(join(root, CHECKOUT_SCRIPT), [branch], { cwd: root, env });
  if (res.status !== 0) {
    const detail = String(res.stderr || res.stdout || 'no output').trim();
    throw failure(`${CHECKOUT_SCRIPT} ${branch} exited ${res.status}:\n${detail}`);
  }
}

/** The checked-out HEAD sha; a failing rev-parse fails the command. */
function readHead(sh, root) {
  const res = sh('git', ['rev-parse', 'HEAD'], { cwd: root });
  if (res.status !== 0) throw failure(`git rev-parse HEAD exited ${res.status}: ${String(res.stderr).trim()}`);
  return String(res.stdout ?? '').trim();
}

/** Check out the branch and confirm the plan is at its tip; returns the ok-line fields. */
function checkoutPlan(sh, root, feature, env) {
  const branch = conventionWorkBranch(feature, env);
  runCheckoutScript(sh, root, branch, env);
  const planRel = `${PLANS_DIR}/${feature}.md`;
  if (!existsSync(join(root, planRel))) {
    throw failure(`checked out ${branch} but ${planRel} is missing at its tip; is this a RAD plan branch?`);
  }
  return { branch, planRel, head: readHead(sh, root) };
}

/**
 * `rad checkout <feature | .agents/plans/<feature>.md>`
 *
 * @param {string[]} argv
 * @param {{ repoRoot: string, sh?: typeof defaultSh, env?: Record<string, string|undefined> }} ctx
 * @returns {Promise<number>} exit code
 */
export async function checkoutCommand(argv, ctx) {
  const sh = ctx.sh ?? defaultSh;
  const env = ctx.env ?? process.env;
  try {
    const parsed = parseCheckoutArgs(argv);
    if (parsed.help) {
      process.stdout.write(`usage: ${CHECKOUT_USAGE}\n`);
      return OK_EXIT;
    }
    const { branch, planRel, head } = checkoutPlan(sh, ctx.repoRoot, parsed.feature, env);
    process.stdout.write(`${VERB}: ok feature=${parsed.feature} branch=${branch} head=${head} plan=${planRel}\n`);
    return OK_EXIT;
  } catch (err) {
    if (!(err instanceof CheckoutStop)) throw err;
    process.stderr.write(`${VERB}: ${err.message}\n`);
    return err.code;
  }
}
