/**
 * label.js — `rad label <issue> <status>`.
 *
 * Mirrors a RAD status onto a GitHub issue by calling scripts/rad-label.sh.
 * It adds no gh logic of its own and runs no role check, matching the script,
 * which plan-open, approve and deliver already call without one.
 *
 * Exit codes: 0 = the script succeeded (it no-ops with exit 0 when gh is
 * unavailable); 1 = the script failed, its output passed through; 2 = refused
 * before any script call (bad arguments). Every call is an args array through
 * the injected `sh`.
 */
import { join } from 'node:path';
import process from 'node:process';

import { defaultSh } from './adapters/git-state-store.js';

const VERB = 'rad label';
export const LABEL_USAGE = 'rad label <issue> <status>';
/** The statuses scripts/rad-label.sh accepts; keep in step with its ALL_STATUSES. */
export const LABEL_STATUSES = [
  'draft', 'ready', 'pending-review', 'needs-revision', 'rejected', 'approved', 'in-progress', 'review', 'done',
];
const OK_EXIT = 0;
const FAILED_EXIT = 1;
const REFUSED_EXIT = 2;
const LABEL_SCRIPT = 'scripts/rad-label.sh';
const HELP_FLAGS = new Set(['--help', '-h']);
/** A positive integer, optionally written `#N`; group 1 is the number. */
const ISSUE_ARG_PATTERN = /^#?([1-9]\d*)$/;

/** A deliberate refusal carrying its message; anything else is a bug and propagates. */
class LabelRefusal extends Error {}
const refuse = (message) => new LabelRefusal(`${message}\nusage: ${LABEL_USAGE}`);

/**
 * Parse argv into the issue number and status. Returns `{ help: true }` for --help/-h.
 *
 * @param {string[]} argv
 * @returns {{ issue: string, status: string } | { help: true }}
 */
export function parseLabelArgs(argv) {
  if (argv.some((a) => HELP_FLAGS.has(a))) return { help: true };
  if (argv.length !== 2) throw refuse(`expected <issue> and <status>, got ${argv.length} argument(s)`);
  const [issueArg, status] = argv;
  const m = ISSUE_ARG_PATTERN.exec(issueArg);
  if (!m) throw refuse(`invalid issue '${issueArg}' (expected a positive integer or #N)`);
  if (!LABEL_STATUSES.includes(status)) {
    throw refuse(`unknown status '${status}' (expected one of: ${LABEL_STATUSES.join(', ')})`);
  }
  return { issue: m[1], status };
}

/**
 * `rad label <issue> <status>`
 *
 * @param {string[]} argv
 * @param {{ repoRoot: string, sh?: typeof defaultSh, env?: Record<string, string|undefined> }} ctx
 * @returns {Promise<number>} exit code
 */
export async function labelCommand(argv, ctx) {
  const sh = ctx.sh ?? defaultSh;
  let parsed;
  try {
    parsed = parseLabelArgs(argv);
  } catch (err) {
    if (!(err instanceof LabelRefusal)) throw err;
    process.stderr.write(`${VERB}: ${err.message}\n`);
    return REFUSED_EXIT;
  }
  if (parsed.help) {
    process.stdout.write(`usage: ${LABEL_USAGE}\n`);
    return OK_EXIT;
  }
  const res = sh(join(ctx.repoRoot, LABEL_SCRIPT), [parsed.issue, parsed.status], {
    cwd: ctx.repoRoot, env: ctx.env ?? process.env,
  });
  if (res.stdout) process.stdout.write(String(res.stdout));
  if (res.stderr) process.stderr.write(String(res.stderr));
  return res.status === 0 ? OK_EXIT : FAILED_EXIT;
}
