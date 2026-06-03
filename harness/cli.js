#!/usr/bin/env node
/**
 * rad — RAD harness CLI.
 *
 * A thin, deterministic composition layer over the harness ports. It owns the
 * pure git/state mechanics that the `/rad-*` prose commands used to inline; the
 * prose retains the human-in-the-loop steps (review summary, confirmation) and
 * shells out here for the recording.
 *
 * This CLI never calls a model, never opens a PR, and never pushes a branch.
 *
 * Subcommands:
 *   approve <feature> [--on-behalf-of <name>] [--evidence <text>]
 *
 * Argv parsing is hand-rolled (no runtime dep beyond js-yaml, which this file
 * does not need). Control flow is deterministic and side-effect-free except for
 * the dispatched subcommand.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import process from 'node:process';

import { createGitStateStore, defaultSh } from './adapters/git-state-store.js';

const SUBCOMMANDS = {
  approve: {
    summary: 'Record an architect approval (event + plan-doc Status) on the work branch.',
    usage: 'rad approve <feature> [--on-behalf-of <name>] [--evidence <text>]',
    // run is wired below, after the command is defined, to keep the table near
    // the top of the file while letting the implementation read top-down.
    run: (argv, ctx) => approveCommand(argv, ctx),
  },
};

/** The harness package root (where cli.js lives). */
const HERE = dirname(fileURLToPath(import.meta.url));
/** The repo root is the parent of the harness/ directory. */
const REPO_ROOT = join(HERE, '..');

/** Build the usage/help text listing every available subcommand. */
function usageText() {
  const lines = [];
  lines.push('rad — RAD harness CLI');
  lines.push('');
  lines.push('Usage: rad <command> [options]');
  lines.push('');
  lines.push('Commands:');
  for (const [name, spec] of Object.entries(SUBCOMMANDS)) {
    lines.push(`  ${name.padEnd(10)} ${spec.summary}`);
  }
  lines.push('');
  lines.push('Run a command with its own arguments, e.g.:');
  for (const spec of Object.values(SUBCOMMANDS)) {
    lines.push(`  ${spec.usage}`);
  }
  return lines.join('\n');
}

/**
 * Entry point. Returns the process exit code (does not call process.exit so it
 * stays testable). Only the dispatched subcommand performs side effects.
 *
 * @param {string[]} argv - arguments after `node cli.js`
 * @param {{ repoRoot?: string }} [opts]
 * @returns {Promise<number>}
 */
export async function main(argv, opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const [first, ...rest] = argv;

  // --help or bare invocation: print usage to stdout, exit 0.
  if (first === undefined || first === '--help' || first === '-h') {
    process.stdout.write(usageText() + '\n');
    return 0;
  }

  const spec = SUBCOMMANDS[first];
  if (!spec) {
    process.stderr.write(`rad: unknown command '${first}'\n\n`);
    process.stderr.write(usageText() + '\n');
    return 1;
  }

  return spec.run(rest, { repoRoot });
}

/**
 * Hand-rolled argv parser for `approve`. Returns the positional feature and the
 * `--on-behalf-of` / `--evidence` option values (undefined when absent). Throws
 * on a flag that is missing its value or on extra positionals so malformed
 * invocations fail loudly rather than silently mis-parse.
 *
 * @param {string[]} argv
 * @returns {{ feature?: string, onBehalfOf?: string, evidence?: string }}
 */
function parseApproveArgs(argv) {
  let feature;
  let onBehalfOf;
  let evidence;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--on-behalf-of') {
      onBehalfOf = argv[i + 1];
      if (onBehalfOf === undefined) throw new Error('--on-behalf-of requires a value');
      i += 1;
    } else if (arg === '--evidence') {
      evidence = argv[i + 1];
      if (evidence === undefined) throw new Error('--evidence requires a value');
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option '${arg}'`);
    } else if (feature === undefined) {
      feature = arg;
    } else {
      throw new Error(`unexpected argument '${arg}'`);
    }
  }

  return { feature, onBehalfOf, evidence };
}

/** True when a string is present and not whitespace-only. */
function isNonEmpty(s) {
  return typeof s === 'string' && s.trim() !== '';
}

/**
 * Bootstrap dual-write part (b): write the plan-doc Status header fields so the
 * existing `/rad-deliver` gate (check-plan-approved.sh, which reads the doc
 * Status) passes. Updates `Status`, `Approved-By`, `Approved-At` in place, and
 * in proxy mode also `Recorded-By` and `Approval-Evidence` (inserted after the
 * existing header block if not already present). Preserves all other content.
 *
 * @param {string} planFile - absolute path to the plan doc
 * @param {{ approvedBy: string, approvedAt: string, recordedBy?: string, evidence?: string, proxy: boolean }} fields
 */
function writePlanStatus(planFile, fields) {
  const text = readFileSync(planFile, 'utf8');
  const lines = text.split('\n');

  const approvedByValue = fields.proxy
    ? `${fields.approvedBy} (out-of-band)`
    : fields.approvedBy;

  // Track the end of the header block so freshly-inserted fields stay grouped
  // with the existing headers. Seeded to the `Status:` line; advanced as we add.
  let anchor = lines.findIndex((l) => /^Status:\s*.*$/.test(l));

  // Set a header field in place if it exists, else insert it just after the
  // current anchor (keeping the header block contiguous). Returns nothing; keeps
  // `anchor` pointing at the last header line touched.
  const upsert = (key, value) => {
    const re = new RegExp(`^${key}:\\s*.*$`);
    const idx = lines.findIndex((l) => re.test(l));
    if (idx !== -1) {
      lines[idx] = `${key}: ${value}`;
      if (idx > anchor) anchor = idx;
      return;
    }
    // Missing: insert after the anchor (or prepend if there is no header at all).
    const at = anchor === -1 ? 0 : anchor + 1;
    lines.splice(at, 0, `${key}: ${value}`);
    anchor = at;
  };

  upsert('Status', 'approved');
  upsert('Approved-By', approvedByValue);
  upsert('Approved-At', fields.approvedAt);

  if (fields.proxy) {
    upsert('Recorded-By', fields.recordedBy);
    upsert('Approval-Evidence', fields.evidence);
  }

  writeFileSync(planFile, lines.join('\n'), 'utf8');
}

/**
 * `approve <feature> [--on-behalf-of <name>] [--evidence <text>]`.
 *
 * Enforces architect authority with parity to the prose rules and, on success,
 * performs the bootstrap DUAL-WRITE: (a) appends the `approved` event via
 * recordApproval(...) AND (b) writes the plan-doc Status header. Pure git/state
 * work — no model call, no PR, no push.
 *
 * Authority:
 *   - Direct mode (no --on-behalf-of): the running git user MUST be a configured
 *     architect (check-role.sh architect). approvedBy/recordedBy = running user.
 *   - Proxy mode (--on-behalf-of <name> + required --evidence <text>): <name>
 *     MUST validate as a configured architect (check-role.sh architect CLAUDE.md
 *     <name>); the running user need NOT be an architect. approvedBy = <name>,
 *     recordedBy = running user.
 *
 * Attribution: the event-log `actor` is the ROLE TOKEN `architect` — that is what
 * gates.yaml's `requiredRole`/`actor-has-role` rule matches (and what the
 * git-state-store unit tests assert). The HUMAN identity (the architect whose
 * judgment it is) is preserved on the event as `recordedBy` and in the plan-doc
 * `Approved-By` header. The role trust boundary itself lives in check-role.sh,
 * which we consult above before recording.
 *
 * @param {string[]} argv - args after `approve`
 * @param {{ repoRoot: string, sh?: typeof defaultSh }} ctx
 * @returns {Promise<number>}
 */
export async function approveCommand(argv, ctx) {
  const { repoRoot } = ctx;
  const sh = ctx.sh ?? defaultSh;

  let parsed;
  try {
    parsed = parseApproveArgs(argv);
  } catch (err) {
    process.stderr.write(`rad approve: ${err.message}\n`);
    process.stderr.write('Usage: rad approve <feature> [--on-behalf-of <name>] [--evidence <text>]\n');
    return 1;
  }

  const { feature, onBehalfOf, evidence } = parsed;

  if (!isNonEmpty(feature)) {
    process.stderr.write('rad approve: a feature name is required\n');
    process.stderr.write('Usage: rad approve <feature> [--on-behalf-of <name>] [--evidence <text>]\n');
    return 1;
  }

  const claudeMd = join(repoRoot, 'CLAUDE.md');
  const roleScript = join(repoRoot, 'scripts', 'check-role.sh');

  // Resolve the running git user (the recorder).
  const userResult = sh('git', ['config', 'user.email'], { cwd: repoRoot });
  const runningUser = (userResult.stdout || '').trim();
  if (!isNonEmpty(runningUser)) {
    process.stderr.write('rad approve: cannot determine git user.email — set your git identity first\n');
    return 1;
  }

  // approvedBy = the HUMAN architect whose judgment this is (plan-doc Approved-By
  // + the event's recordedBy audit field). The event-log `actor` is always the
  // role token `architect` (see below). recordedBy = whoever physically ran it.
  let approvedBy;
  let recordedBy;
  let proxy = false;

  if (isNonEmpty(onBehalfOf)) {
    // Proxy mode: --evidence is mandatory; the named approver must be an architect.
    proxy = true;
    if (!isNonEmpty(evidence)) {
      process.stderr.write('rad approve: --on-behalf-of requires --evidence (cite where the architect approved)\n');
      return 1;
    }
    const roleCheck = sh(roleScript, ['architect', claudeMd, onBehalfOf], { cwd: repoRoot });
    if (roleCheck.status !== 0) {
      process.stderr.write(`rad approve: '${onBehalfOf}' is not a configured architect in CLAUDE.md — cannot record their approval\n`);
      if (isNonEmpty(roleCheck.stderr)) process.stderr.write(roleCheck.stderr);
      return 1;
    }
    approvedBy = onBehalfOf;
    recordedBy = runningUser;
  } else {
    // Direct mode: the running user must be a configured architect.
    if (isNonEmpty(evidence)) {
      process.stderr.write('rad approve: --evidence is only valid with --on-behalf-of\n');
      return 1;
    }
    const roleCheck = sh(roleScript, ['architect', claudeMd], { cwd: repoRoot });
    if (roleCheck.status !== 0) {
      process.stderr.write('rad approve: permission denied — direct approval requires the architect role\n');
      if (isNonEmpty(roleCheck.stdout)) process.stderr.write(roleCheck.stdout);
      return 1;
    }
    approvedBy = runningUser;
    recordedBy = runningUser;
  }

  // The event-log actor is the human identity (approvedBy); recordApproval freezes
  // the verified role token into the event's `role` field at write-time.
  const actor = approvedBy;

  const planFile = join(repoRoot, '.agents', 'plans', `${feature}.md`);
  if (!existsSync(planFile)) {
    process.stderr.write(`rad approve: no plan doc at .agents/plans/${feature}.md\n`);
    return 1;
  }

  const ts = new Date().toISOString();
  const store = createGitStateStore({ repoRoot, sh, claudeMd });

  // Dual-write (a): append the `approved` event. recordApproval validates the
  // transition before writing — an illegal move (e.g. already approved) throws.
  try {
    store.recordApproval({
      feature,
      actor,
      recordedBy,
      ts,
      evidence: proxy ? evidence : undefined,
    });
  } catch (err) {
    process.stderr.write(`rad approve: cannot record approval — ${err.message}\n`);
    return 1;
  }

  // Dual-write (b): write the plan-doc Status header fields (Approved-By carries
  // the HUMAN architect identity, not the role token).
  writePlanStatus(planFile, {
    approvedBy,
    approvedAt: ts,
    recordedBy,
    evidence,
    proxy,
  });

  // Structured success line (machine-greppable single line).
  if (proxy) {
    process.stdout.write(
      `rad approve: ok feature=${feature} status=approved approved-by=${approvedBy} recorded-by=${recordedBy} approved-at=${ts} proxy=true\n`,
    );
  } else {
    process.stdout.write(
      `rad approve: ok feature=${feature} status=approved approved-by=${approvedBy} approved-at=${ts} proxy=false\n`,
    );
  }
  return 0;
}

// Run only when invoked as a script (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`rad: ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
