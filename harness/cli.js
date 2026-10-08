#!/usr/bin/env node
/**
 * rad — RAD harness CLI.
 *
 * A thin, deterministic composition layer over the harness ports. It owns the
 * pure git/state mechanics that the `/rad-*` prose commands used to inline; the
 * prose retains the human-in-the-loop steps (review summary, confirmation) and
 * shells out here for the recording.
 *
 * This CLI never calls a model and never opens a PR. It pushes a branch only
 * through the `approve`, `plan-open` and `plan-status` publish steps.
 *
 * Subcommands:
 *   approve <feature> [--on-behalf-of <name>] [--evidence <text>] [--no-commit] [--trailer "Key: Value"]...
 *   plan-open <plan-file> [--trailer "Key: Value"]...
 *   plan-status <feature> <rejected|needs-revision> [--trailer "Key: Value"]...
 *   checkout <feature | .agents/plans/<feature>.md>
 *
 * Argv parsing is hand-rolled (no runtime dep beyond js-yaml, which this file
 * does not need). Control flow is deterministic and side-effect-free except for
 * the dispatched subcommand.
 */

import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import {
  readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, realpathSync, statSync, lstatSync, renameSync,
  mkdtempSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { spawnSync, execFileSync } from 'node:child_process';

import { createGitStateStore, defaultSh } from './adapters/git-state-store.js';
import { evaluateGate } from './gates.js';
import { planFingerprint } from './plan-fingerprint.js';
import { makeWorktreeLifecycle } from './adapters/worktree.js';
import { deliverSpine } from './spine.js';
import { createHookRunner } from './hook-runner.js';
import { createCommandAdapter, probeCommand, runCommandPrompt } from './adapters/agent/command.js';
import { createAcpAdapter, probeAcp, checkAcpAgent, ACP_CHECK_NAMES } from './adapters/agent/acp.js';
import { sanitizeErrorMessage } from './adapters/agent/contract.js';
import { loadMatrix } from './matrix.js';
import { classifyStop, STOP_CLASSES } from './stops.js';
import {
  deliverCompleted, latestStop, dormantStop, fileDeficitSignals, forecastForPaths, DEFICITS, phaseOf,
} from './events.js';
import { taskFilesFromPlanText, mergeTaskFiles, taskFilesByWave } from './plan-tasks.js';
import { parseCapabilityLine, resolveWaveCapabilities, sdkAllowedTools, commandRefusal } from './capabilities.js';
import { gatherDigestInputs, buildDigest, renderDigest, readScope } from './digest.js';
import { buildPrBody, testsToWritePaths } from './pr-body.js';
import { buildReviewPrompt, parseFindings } from './review.js';
import {
  CONFIG_PATH, SETTINGS_KEYS, loadConfig, getConfigValue, migrateFromClaudeMd, serializeConfig, validateConfig,
  buildInitConfig, seedSettings, writeConfigAtomic, AGENT_ADAPTERS, AGENT_PRESETS,
} from './config.js';
import {
  MANIFEST_PATH, PENDING_DIR, UNKNOWN_RAD_VERSION, CORE_LAYER, PRESET_LAYER, PRESET_NEEDS_CORE_ERROR,
  readManifest, planInstall, applyInstall, installDrift, planPresetInstall, applyPresetInstall,
} from './install-manifest.js';
import { readPreset } from './preset.js';
import { selectAgent } from './agent-select.js';
import { readSources, renderOutputs, planGenerate, applyGenerate } from './generate.js';
import { mergeDeliverGateHook } from './claude-settings.js';
import {
  approveCommitMessage, conventionWorkBranch, planIssueNumber, planWorkBranch, validateTrailer,
} from './plan-commit.js';
import { publishPlanChange, requirePublishReady } from './branch-publish.js';
import { planOpenCommand, PLAN_OPEN_USAGE } from './plan-open.js';
import { planStatusCommand, PLAN_STATUS_USAGE } from './plan-status.js';
import { checkoutCommand, CHECKOUT_USAGE } from './checkout.js';
import { makePreparePort } from './deliver-prepare.js';
import { makeFinishPort } from './deliver-finish.js';

/** Usage line for `rad approve` (parse errors and the command table). */
const APPROVE_USAGE = 'rad approve <feature> [--on-behalf-of <name>] [--evidence <text>] [--no-commit] [--trailer "Key: Value"]...';
/** Usage line for `rad deliver` (help, parse errors, and the command table). */
const DELIVER_USAGE = 'rad deliver <feature> [--model <model-id>] [--resume --context <text>]';
/** Usage line for `rad stop-status`. */
const STOP_STATUS_USAGE = 'rad stop-status <feature> [--stdin]';
/** Usage line for `rad forecast`. */
const FORECAST_USAGE = 'rad forecast <plan>';
/** Usage line for `rad digest`. */
const DIGEST_USAGE = 'rad digest <feature> [--branch <ref>] [--base <ref>]';
/** Usage line for `rad pr-body`. */
const PR_BODY_USAGE = 'rad pr-body <feature> [--branch <ref>] [--base <ref>]';
/** Usage line for `rad review`. */
const REVIEW_USAGE = 'rad review <reviewer> [--base <ref>]';
/** Usage line for `rad capabilities`. */
const CAPABILITIES_USAGE = 'rad capabilities <feature> [--plan <path>]';
/** Usage line for `rad install-core`. */
const INSTALL_CORE_USAGE = 'rad install-core --source <dir> [--target <dir>]';
/** Usage line for `rad install-preset`. */
const INSTALL_PRESET_USAGE = 'rad install-preset (--source <dir> | --reapply) [--target <dir>]';
/** Usage line for `rad install-hooks`. */
const INSTALL_HOOKS_USAGE = 'rad install-hooks [--target <dir>]';
/** Usage line for `rad install-status`. */
const INSTALL_STATUS_USAGE = 'rad install-status [--target <dir>]';
/** Usage line for `rad acp-check`. */
const ACP_CHECK_USAGE = 'rad acp-check --cmd "<agent>" [--timeout <seconds>]';
/** Usage line for `rad generate`. */
const GENERATE_USAGE = 'rad generate [--check] [--root <dir>]';
/** Usage line for `rad config`. */
const CONFIG_USAGE = 'rad config get <key> | rad config validate | rad config settings'
  + ' | rad config migrate [--from <path>] [--force] | rad config init [--architect <id>] [--platform <p>] [--default-branch <b>]'
  + ' [--agent <claude|codex> | --agent-cmd <cmd> [--agent-adapter <command|acp>] | --agent-adapter sdk] [--force]';

const SUBCOMMANDS = {
  approve: {
    summary: 'Record an architect approval (event + plan-doc Status) on the work branch.',
    usage: APPROVE_USAGE,
    // run is wired below, after the command is defined, to keep the table near
    // the top of the file while letting the implementation read top-down.
    run: (argv, ctx) => approveCommand(argv, ctx),
  },
  deliver: {
    summary: 'Run approved plan wave execution via Claude Agent SDK.',
    usage: DELIVER_USAGE,
    run: (argv, ctx) => deliverCommand(argv, ctx),
  },
  status: {
    summary: 'Show current state of all rad/ features.',
    usage: 'rad status [--phase <phase>]',
    run: (argv, ctx) => statusCommand(argv, ctx),
  },
  gate: {
    summary: 'Evaluate a named gate over a feature event log (read-only).',
    usage: 'rad gate <feature> <name> [--stdin]',
    run: (argv, ctx) => gateCommand(argv, ctx),
  },
  'stop-status': {
    summary: 'Report whether a feature has a dormant needs-decision stop (read-only).',
    usage: STOP_STATUS_USAGE,
    run: (argv, ctx) => stopStatusCommand(argv, ctx),
  },
  forecast: {
    summary: "Advisory plan-time reliability readout for a plan's declared paths (read-only).",
    usage: FORECAST_USAGE,
    run: (argv, ctx) => forecastCommand(argv, ctx),
  },
  digest: {
    summary: "Ranked, read-only review digest for a feature's deliver PR (Gate 2 aid).",
    usage: DIGEST_USAGE,
    run: (argv, ctx) => digestCommand(argv, ctx),
  },
  'pr-body': {
    summary: "Print the deliver PR title and body built from a feature's branch tip (read-only).",
    usage: PR_BODY_USAGE,
    run: (argv, ctx) => prBodyCommand(argv, ctx),
  },
  review: {
    summary: 'Run one reviewer agent through the review lane (RAD_REVIEW_AGENT_CMD, else RAD_AGENT_CMD).',
    usage: REVIEW_USAGE,
    run: (argv, ctx) => reviewCommand(argv, ctx),
  },
  config: {
    summary: 'Create, read, validate, or migrate the RAD config file (.rad/config.yml).',
    usage: CONFIG_USAGE,
    run: (argv, ctx) => configCommand(argv, ctx),
  },
  capabilities: {
    summary: "Show each wave's effective capability classes for a plan (read-only).",
    usage: CAPABILITIES_USAGE,
    run: (argv, ctx) => capabilitiesCommand(argv, ctx),
  },
  'install-core': {
    summary: 'Install or upgrade RAD core files into a target, never overwriting local edits.',
    usage: INSTALL_CORE_USAGE,
    run: (argv, ctx) => installCoreCommand(argv, ctx),
  },
  'install-preset': {
    summary: 'Install or upgrade a preset over an installed core and seed its settings, never overwriting local edits.',
    usage: INSTALL_PRESET_USAGE,
    run: (argv, ctx) => installPresetCommand(argv, ctx),
  },
  'install-hooks': {
    summary: "Register the deliver-gate hook in a target's .claude/settings.json, never overwriting existing settings.",
    usage: INSTALL_HOOKS_USAGE,
    run: (argv, ctx) => installHooksCommand(argv, ctx),
  },
  'install-status': {
    summary: 'Report core files that drifted from .rad/installed.json (read-only).',
    usage: INSTALL_STATUS_USAGE,
    run: (argv, ctx) => installStatusCommand(argv, ctx),
  },
  'acp-check': {
    summary: 'Run the ACP v1 conformance check against an agent command (writes nothing).',
    usage: ACP_CHECK_USAGE,
    run: (argv, ctx) => acpCheckCommand(argv, ctx),
  },
  generate: {
    summary: 'Generate Claude and Codex files from .rad/ sources; --check reports drift and orphans (writes nothing).',
    usage: GENERATE_USAGE,
    run: (argv, ctx) => generateCommand(argv, ctx),
  },
  'owner-claim': {
    summary: 'Claim the single-writer lock on a feature (records who holds it).',
    usage: 'rad owner-claim <feature>',
    run: (argv, ctx) => ownerClaimCommand(argv, ctx),
  },
  'owner-release': {
    summary: 'Release the single-writer lock on a feature (clears the holder).',
    usage: 'rad owner-release <feature>',
    run: (argv, ctx) => ownerReleaseCommand(argv, ctx),
  },
  'plan-open': {
    summary: "Cut a plan's work branch, commit the plan with a derived message, push, and label its issue.",
    usage: PLAN_OPEN_USAGE,
    run: (argv, ctx) => planOpenCommand(argv, ctx),
  },
  'plan-status': {
    summary: "Record a plan review (rejected or needs-revision): set its Status, commit the plan, push, and label its issue.",
    usage: PLAN_STATUS_USAGE,
    run: (argv, ctx) => planStatusCommand(argv, ctx),
  },
  checkout: {
    summary: "Check out a plan's work branch at its remote tip.",
    usage: CHECKOUT_USAGE,
    run: (argv, ctx) => checkoutCommand(argv, ctx),
  },
  'plan-fingerprint': {
    summary: 'Print the SHA-256 fingerprint of a plan doc body (read-only).',
    usage: 'rad plan-fingerprint <planFile>',
    run: (argv, ctx) => planFingerprintCommand(argv, ctx),
  },
  'architecture-approve': {
    summary: 'Record a frozen architecture-approved audit event for a slug.',
    usage: 'rad architecture-approve <slug> [--on-behalf-of <name>] [--evidence <text>]',
    run: (argv, ctx) => architectureApproveCommand(argv, ctx),
  },
};

/**
 * The ONLY RAD_AGENT_PREFLIGHT value that skips the command-path startup probe.
 * Unset, empty, or any other value runs it (fail-closed: a typo never disables).
 */
const PREFLIGHT_OFF = 'off';
/** Accepted RAD_AGENT values; the unknown-value message lists them in this order. */
const AGENT_KINDS = ['command', 'sdk', 'acp'];

/**
 * Env var overriding the preflight probe deadline, in whole seconds. Unset or
 * empty keeps the adapter default; anything but digits (no sign, no unit, no
 * whitespace, no zero) is a hard usage error — mirrors RAD_VERIFY_TIMEOUT_SECONDS
 * in scripts/check-verify.sh: a typo must never silently restore the default.
 */
const PREFLIGHT_TIMEOUT_ENV = 'RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS';
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
/** Exit code for a malformed deliver configuration value. */
const USAGE_EXIT_CODE = 2;
/** Exit code for a deliver stop a human can lift (#77 `needs-decision`). */
const NEEDS_DECISION_EXIT_CODE = 3;
/** Exit code for a deliver stop showing the work is wrong (#77 `failed`). */
const FAILED_EXIT_CODE = 1;
/** The one RAD_WORKTREE value that opts OUT of worktree isolation (the default is ON). */
const WORKTREE_OFF_VALUE = '0';

/**
 * Hard ceiling on `rad deliver --resume --context <text>`. An over-long context
 * is refused (exit 2), never truncated — the operator's words reach the agent
 * and the run-resumed audit event verbatim or not at all.
 */
const RESUME_CONTEXT_MAX_CHARS = 8000;

/**
 * Env var arming the spine's cumulative failed-attempt cap (#77). Unset or
 * empty = off; anything but a positive integer is a hard usage error (exit 2,
 * before any event) — a typo must never silently disable the cap.
 */
const MAX_FAILED_ATTEMPTS_ENV = 'RAD_MAX_FAILED_ATTEMPTS';

/**
 * Env var overriding the wave-lifecycle hooks dir. Unset/empty = the convention
 * dir `<root>/scripts/hooks`. A value that could be read as a flag or that
 * carries a line break is a hard usage error (exit 2, before any event).
 */
const HOOKS_DIR_ENV = 'RAD_HOOKS_DIR';
const DEFAULT_HOOKS_SUBDIR = join('scripts', 'hooks');
const MALFORMED_HOOKS_DIR = /^-|[\r\n]/;
/** How a config-supplied hooks dir is named in operator-facing errors. */
const HOOKS_DIR_SETTING_SOURCE = `settings.hooks_dir in ${CONFIG_PATH}`;
/** Exit status reported for a hook that could not be spawned or died on a signal. */
const HOOK_SPAWN_FAILURE_EXIT = 127;

/** Prints the project default branch (always exit 0 by contract). */
const DEFAULT_BRANCH_SCRIPT = 'scripts/get-default-branch.sh';
/** Remote whose default-branch tip the spine's push guard reads. */
const PUSH_GUARD_REMOTE = 'origin';
/** Label every deliver PR carries (CLAUDE.md → PR Labels). */
const DELIVER_PR_LABEL = 'rad:deliver';

/**
 * Argument contract for every script the deliver spine runs through its `sh`
 * port, keyed by the EXACT script string the spine passes. Each builder takes
 * the per-run script context (and the spine's second `sh` argument) and returns
 * argv. A script absent from this table is refused (fail-closed), never run
 * with a guessed argv.
 */
const SCRIPT_ARGS = Object.freeze({
  'scripts/check-scope.sh': (c) => [c.planPath, c.branch, ...c.baseArgs()],
  // An array arg is the spine's wave-scoped promised set → `--only <paths>`;
  // a string arg (the feature, unscoped spine) → the whole plan, as before.
  'scripts/check-tests-present.sh': (c, only) => [c.planPath, ...(Array.isArray(only) ? ['--only', ...only] : [])],
  'scripts/check-verify.sh': (_c, command) => [command],
  'scripts/open-pr.sh': (c) => {
    const { title, body } = c.prBody();
    return ['--title', title, '--body', body, '--head', c.branch, '--no-draft', '--label', DELIVER_PR_LABEL];
  },
  'scripts/default-tip.sh': (c) => [PUSH_GUARD_REMOTE, ...c.baseArgs()],
});

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
 * Hand-rolled argv parser for `approve`. Returns the positional feature, the
 * `--on-behalf-of` / `--evidence` option values (undefined when absent), the
 * `--no-commit` flag, and every `--trailer` value in order (validated by the
 * caller). Throws on a flag that is missing its value or on extra positionals
 * so malformed invocations fail loudly rather than silently mis-parse.
 *
 * @param {string[]} argv
 * @returns {{ feature?: string, onBehalfOf?: string, evidence?: string, noCommit: boolean, trailers: string[] }}
 */
function parseApproveArgs(argv) {
  let feature;
  let onBehalfOf;
  let evidence;
  let noCommit = false;
  const trailers = [];

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
    } else if (arg === '--no-commit') {
      noCommit = true;
    } else if (arg === '--trailer') {
      if (argv[i + 1] === undefined) throw new Error('--trailer requires a "Key: Value" argument');
      trailers.push(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option '${arg}'`);
    } else if (feature === undefined) {
      feature = arg;
    } else {
      throw new Error(`unexpected argument '${arg}'`);
    }
  }

  return { feature, onBehalfOf, evidence, noCommit, trailers };
}

/** True when a string is present and not whitespace-only. */
function isNonEmpty(s) {
  return typeof s === 'string' && s.trim() !== '';
}

/**
 * Best-effort branch publish for portable process memory.
 *
 * GATED on RAD_SYNC (the same env-knob convention as RAD_WORKTREE / RAD_TOKEN_BUDGET):
 * unset/empty short-circuits at the TOP — NO push, NO behavior change (AC#5
 * byte-for-byte). When set, shells out to scripts/git-sync.sh push <workBranch>,
 * which is itself offline-fail-safe (exits 0 even on push failure). We additionally
 * guard here so a non-zero status or a spawn failure from the helper NEVER fails the
 * calling verb — the local commit has already landed; the remote catches up later.
 * Plain git only; credentials are inherited by the helper, never prompted or stored.
 *
 * @param {string} repoRoot
 * @param {string} workBranch - the rad/<feature> work branch to publish
 * @param {typeof defaultSh} sh - injectable shell-out helper
 */
function bestEffortSyncPush(repoRoot, workBranch, sh) {
  if (!isNonEmpty(process.env.RAD_SYNC)) return; // OFF: byte-for-byte today.
  const script = join(repoRoot, 'scripts', 'git-sync.sh');
  if (!existsSync(script)) return; // helper absent — nothing to do, never fail.
  try {
    sh(script, ['push', workBranch], { cwd: repoRoot });
  } catch {
    // Best-effort: a spawn failure must never block the verb. The helper already
    // exits 0 on a failed push; this guards the spawn boundary itself.
  }
}

/**
 * Hand-rolled argv parser for `deliver`. Returns the positional feature, the
 * optional `--model <id>` value, the `--resume` flag, and the `--context <text>`
 * value (undefined when absent). Throws on a flag that is missing its value or
 * on extra positionals so malformed invocations fail loudly. A `--context` with
 * no value carries `exitCode: USAGE_EXIT_CODE` (the resume surface exits 2);
 * the pre-existing parse errors keep their exit 1.
 *
 * @param {string[]} argv
 * `modelExplicit` is true only when `--model` was given, so an adapter that
 * cannot honour a model (acp) warns only when one was actually requested.
 *
 * @returns {{ feature?: string, model: string, modelExplicit: boolean, resume: boolean, context?: string }}
 */
function parseDeliverArgs(argv) {
  let feature;
  let model = 'claude-opus-4-8';
  let modelExplicit = false;
  let resume = false;
  let context;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--model') {
      const val = argv[i + 1];
      if (val === undefined) throw new Error('--model requires a value');
      model = val;
      modelExplicit = true;
      i += 1;
    } else if (arg === '--resume') {
      resume = true;
    } else if (arg === '--context') {
      const val = argv[i + 1];
      if (val === undefined) {
        throw Object.assign(new Error('--context requires a value'), { exitCode: USAGE_EXIT_CODE });
      }
      context = val;
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option '${arg}'`);
    } else if (feature === undefined) {
      feature = arg;
    } else {
      throw new Error(`unexpected argument '${arg}'`);
    }
  }

  return { feature, model, modelExplicit, resume, context };
}

/**
 * Extract the body lines of a `### <name>` markdown sub-section (until the next
 * `##` or `###` heading). Used to pull Do Not Touch / Key Files / Reminders from
 * the plan's Execution Notes section.
 *
 * @param {string} text
 * @param {string} name - sub-section heading (without the leading '### ')
 * @returns {string[]}
 */
function subSectionLines(text, name) {
  const lines = text.split('\n');
  const out = [];
  let inSection = false;
  for (const line of lines) {
    if (new RegExp(`^###\\s+${name}\\s*$`).test(line.trim())) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (/^#{2,}/.test(line)) break;
      out.push(line);
    }
  }
  return out;
}

/**
 * Parse optional per-wave model overrides from the plan doc.
 *
 * Convention: an optional `Model:` line inside a `### Wave N` block selects the
 * model for that wave only (e.g. "Model: claude-haiku-4-5"). Waves without the
 * line are absent from the returned map, so the deliver default applies. The map
 * is keyed by wave NUMBER (the integer N from the heading) → model id string.
 *
 * This lives in cli.js by design: the per-wave model travels via planCtx, NOT by
 * editing the plan parser in git-state-store.js.
 *
 * @param {string} text - full plan doc text
 * @returns {Record<number, string>}
 */
function parseWaveModels(text) {
  const waveModels = {};
  let currentWave;
  for (const line of text.split('\n')) {
    const heading = /^###\s+Wave\s+(\d+)\b/.exec(line.trim());
    if (heading) {
      currentWave = Number(heading[1]);
      continue;
    }
    // A new `##`/`###` heading that is NOT a Wave heading ends the current block.
    // Deeper headings (`####` task subheadings) stay INSIDE the wave so a Model:
    // line still applies across the wave's tasks.
    if (/^#{2,3}\s/.test(line.trim())) {
      currentWave = undefined;
      continue;
    }
    if (currentWave !== undefined) {
      const m = /^Model:\s*(.+)$/.exec(line.trim());
      if (m && m[1].trim() !== '') waveModels[currentWave] = m[1].trim();
    }
  }
  return waveModels;
}

/**
 * Parse optional per-wave verification commands from the plan doc.
 *
 * Convention: an optional `Verify:` line inside a `### Wave N` block declares the
 * shell command the HARNESS runs after that wave (e.g. "Verify: npm test"). Waves
 * without the line are absent from the returned map, so nothing is executed and
 * the wave's gating is byte-for-byte what it was before this existed. The map is
 * keyed by wave NUMBER (the integer N from the heading) → command string.
 *
 * Structurally mirrors parseWaveModels — same wave-block scoping, same rule that
 * deeper `####` task subheadings stay INSIDE the wave. It lives in cli.js by
 * design: the per-wave command travels via planCtx, NOT by editing the plan
 * parser in git-state-store.js.
 *
 * The command is arbitrary shell from a HUMAN-APPROVED plan doc; the trust
 * boundary is the approval gate, unchanged. Execution is deliberately NOT done
 * here — scripts/check-verify.sh owns it, under an allow-listed env.
 *
 * @param {string} text - full plan doc text
 * @returns {Record<number, string>}
 */
function parseWaveVerify(text) {
  const waveVerify = {};
  let currentWave;
  for (const line of text.split('\n')) {
    const heading = /^###\s+Wave\s+(\d+)\b/.exec(line.trim());
    if (heading) {
      currentWave = Number(heading[1]);
      continue;
    }
    // A new `##`/`###` heading that is NOT a Wave heading ends the current block.
    // Deeper headings (`####` task subheadings) stay INSIDE the wave so a Verify:
    // line still applies across the wave's tasks.
    if (/^#{2,3}\s/.test(line.trim())) {
      currentWave = undefined;
      continue;
    }
    if (currentWave !== undefined) {
      const m = /^Verify:\s*(.+)$/.exec(line.trim());
      if (m && m[1].trim() !== '') waveVerify[currentWave] = m[1].trim();
    }
  }
  return waveVerify;
}

/** A `### Wave N` heading; N is the wave number. */
const WAVE_HEADING_PATTERN = /^###\s+Wave\s+(\d+)\b/;
/** A `Capabilities:` line. The value may be empty so an empty declaration is reported, never ignored. */
const CAPABILITIES_LINE_PATTERN = /^Capabilities:(.*)$/;
/** Scope of a Capabilities: line before the first `##` heading: the plan default. */
const PLAN_HEADER_SCOPE = 'header';

/** Record one `Capabilities:` line into `out` under `scope` (PLAN_HEADER_SCOPE or a wave number). */
function recordCapabilityLine(out, scope, value) {
  const where = scope === PLAN_HEADER_SCOPE ? 'plan header' : `wave ${scope}`;
  const parsed = parseCapabilityLine(value);
  if (!parsed.ok) {
    out.capabilityErrors.push(`${where}: ${parsed.error}`);
    return;
  }
  const declared = scope === PLAN_HEADER_SCOPE
    ? out.planCapabilities !== undefined
    : Object.hasOwn(out.waveCapabilities, scope);
  if (declared) {
    out.capabilityErrors.push(`${where}: Capabilities: is declared more than once`);
  } else if (scope === PLAN_HEADER_SCOPE) {
    out.planCapabilities = parsed.classes;
  } else {
    out.waveCapabilities[scope] = parsed.classes;
  }
}

/**
 * Parse `Capabilities:` declarations (#85) from the plan doc.
 *
 * A line in the plan header (before the first `##`/`###` heading) is the plan
 * default; a line inside a `### Wave N` block is that wave's request and
 * REPLACES the default. Wave-block scoping mirrors parseWaveModels: a non-Wave
 * `##`/`###` heading ends the block, `####` task subheadings stay inside it.
 * Lines anywhere else are ignored. Malformed or duplicate lines are collected
 * in `capabilityErrors` (each naming "plan header" or "wave N") so deliver can
 * refuse before any event; they are never silently dropped.
 *
 * @param {string} text - full plan doc text
 * @returns {{ planCapabilities: string[]|undefined, waveCapabilities: Record<number, string[]>,
 *   capabilityErrors: string[], waveNumbers: number[] }}
 */
function parseCapabilities(text) {
  const out = { planCapabilities: undefined, waveCapabilities: {}, capabilityErrors: [], waveNumbers: [] };
  let scope = PLAN_HEADER_SCOPE;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const heading = WAVE_HEADING_PATTERN.exec(line);
    if (heading) {
      scope = Number(heading[1]);
      if (!out.waveNumbers.includes(scope)) out.waveNumbers.push(scope);
      continue;
    }
    if (/^#{2,3}\s/.test(line)) {
      scope = undefined;
      continue;
    }
    const m = CAPABILITIES_LINE_PATTERN.exec(line);
    if (m && scope !== undefined) recordCapabilityLine(out, scope, m[1]);
  }
  return out;
}

/**
 * Per-wave promised test files: for each wave, its task File: paths that are
 * also resolved `## Tests to Write` paths (exact string match). Unresolvable
 * Tests-to-Write items match nothing; a wave promising none is omitted, so a
 * plan with no promises yields {} and the spine skips the presence gate.
 *
 * @param {string} text - full plan doc text
 * @returns {Record<number, string[]>}
 */
function parseTestsByWave(text) {
  const promised = new Set(testsToWritePaths(text).filter((t) => 'path' in t).map((t) => t.path));
  const testsByWave = {};
  for (const [wave, paths] of taskFilesByWave(text)) {
    const tests = paths.filter((p) => promised.has(p));
    if (tests.length > 0) testsByWave[wave] = tests;
  }
  return testsByWave;
}

/**
 * Parse a plan doc text to extract the planCtx fields needed by runWave.
 *
 * @param {string} text - full plan doc text
 * @returns {{ branch: string, acceptanceCriteria: string[], waveModels: Record<number, string>, waveVerify: Record<number, string>,
 *   planCapabilities: string[]|undefined, waveCapabilities: Record<number, string[]>, capabilityErrors: string[],
 *   waveNumbers: number[], testsByWave: Record<number, string[]>,
 *   executionNotes: { doNotTouch: string[], keyFiles: string[], reminders: string[] } }}
 */
export function parsePlanCtx(text) {
  // Branch: extract from `Branch: rad/feature` header line
  let branch = '';
  for (const line of text.split('\n')) {
    const m = /^Branch:\s*(.+)$/.exec(line.trim());
    if (m) { branch = m[1].trim(); break; }
  }

  // Acceptance Criteria: numbered list lines in `## Acceptance Criteria`
  const acLines = [];
  let inAc = false;
  for (const line of text.split('\n')) {
    if (/^##\s+Acceptance Criteria/.test(line)) { inAc = true; continue; }
    if (inAc) {
      if (/^##/.test(line)) break;
      const trimmed = line.trim();
      if (/^[0-9]+\./.test(trimmed)) acLines.push(trimmed);
    }
  }

  // Execution Notes sub-sections
  const doNotTouch = subSectionLines(text, 'Do Not Touch')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2));

  const keyFiles = subSectionLines(text, 'Key Files')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2));

  const reminders = subSectionLines(text, 'Reminders')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2));

  return {
    branch,
    acceptanceCriteria: acLines,
    waveModels: parseWaveModels(text),
    waveVerify: parseWaveVerify(text),
    testsByWave: parseTestsByWave(text),
    ...parseCapabilities(text),
    executionNotes: { doNotTouch, keyFiles, reminders },
  };
}

/**
 * Parse RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS. Unset/empty → `timeoutMs`
 * undefined (probeCommand's default applies); malformed → `{ ok: false }`.
 *
 * @returns {{ ok: true, timeoutMs?: number } | { ok: false, raw: string }}
 */
function preflightTimeoutFromEnv() {
  const raw = process.env[PREFLIGHT_TIMEOUT_ENV];
  if (raw === undefined || raw === '') return { ok: true };
  if (!POSITIVE_INTEGER_PATTERN.test(raw)) return { ok: false, raw };
  return { ok: true, timeoutMs: Number(raw) * 1000 };
}

/**
 * Per RAD_AGENT_CMD-backed adapter: its startup probe and the operator-facing
 * failure prefix. The acp prefix names the handshake, since an acp probe can
 * fail on a protocol mismatch, not only on missing credentials.
 */
const PREFLIGHT_PROBES = {
  command: {
    probe: probeCommand,
    failure: 'RAD_AGENT_CMD failed to start under the adapter env ' +
      '(it must authenticate without inherited env vars)',
  },
  acp: { probe: probeAcp, failure: 'RAD_AGENT_CMD failed the ACP handshake' },
};

/**
 * Run the selected adapter's startup probe unless RAD_AGENT_PREFLIGHT is
 * exactly PREFLIGHT_OFF. On failure, writes the operator-facing reason to
 * stderr. A malformed RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS fails before the
 * probe spawns.
 *
 * @param {string} cmd - the configured RAD_AGENT_CMD
 * @param {string} repoRoot
 * @param {'command'|'acp'} [kind] - which adapter's probe to run
 * @returns {Promise<number|null>} null when the probe passed or was skipped,
 *   else the deliver exit code (1 probe failed, 2 malformed timeout)
 */
async function preflightExitCode(cmd, repoRoot, kind = 'command') {
  if (process.env.RAD_AGENT_PREFLIGHT === PREFLIGHT_OFF) return null;
  const timeout = preflightTimeoutFromEnv();
  if (!timeout.ok) {
    process.stderr.write(
      `rad deliver: ${PREFLIGHT_TIMEOUT_ENV} must be a positive integer (got '${timeout.raw}')\n`,
    );
    return USAGE_EXIT_CODE;
  }
  const { probe, failure } = PREFLIGHT_PROBES[kind];
  const result = await probe({ cmd, repoRoot, timeoutMs: timeout.timeoutMs });
  if (result.ok) return null;
  process.stderr.write(`rad deliver: ${failure}: ${result.error}\n`);
  return 1;
}

/** The gate every deliver run must pass before any wave executes. */
const APPROVED_GATE = 'approved';

/**
 * Evaluate the approved gate over the work-branch TIP's event log, read through
 * the sh port (`git show <branch>:<log>`) so it works while the branch is
 * checked out nowhere. Same pure fold as `rad gate --stdin` (evaluateGate over
 * parseEventsJsonl). A missing log (git show fails) fails CLOSED.
 *
 * @returns {{ passed: boolean, reason: string }}
 */
function branchTipApprovedGate({ feature, branch, repoRoot, sh }) {
  const read = readBranchTipHistory({ feature, branch, repoRoot, sh });
  if (!read.ok) return { passed: false, reason: read.reason };
  return evaluateGate(APPROVED_GATE, read.history);
}

/**
 * Read the work-branch TIP's event log through the sh port
 * (`git show <branch>:<log>`). The single branch-tip read shared by the approved
 * gate and the --resume eligibility check, so both fold the identical history.
 *
 * @returns {{ ok: true, history: Object[] } | { ok: false, reason: string }}
 */
function readBranchTipHistory({ feature, branch, repoRoot, sh, parse = parseEventsJsonl }) {
  const logPath = `.agents/state/${feature}/events.jsonl`;
  const res = sh('git', ['show', `${branch}:${logPath}`], { cwd: repoRoot });
  if (res.status !== 0) {
    const detail = sanitizeErrorMessage(String(res.stderr ?? '').trim());
    return { ok: false, reason: `no event log at ${branch}:${logPath}` + (detail ? ` (${detail})` : '') };
  }
  return { ok: true, history: parse(String(res.stdout ?? '')) };
}

/**
 * Read + parse the plan doc under `root` into planCtx. Writes the operator
 * message and returns null when the doc is absent.
 */
function loadPlanCtx(root, feature) {
  const planFile = join(root, '.agents', 'plans', `${feature}.md`);
  if (!existsSync(planFile)) {
    process.stderr.write(`rad deliver: no plan doc at .agents/plans/${feature}.md\n`);
    return null;
  }
  const planCtx = parsePlanCtx(readFileSync(planFile, 'utf8'));
  planCtx.feature = feature;
  planCtx.executionLog = `.agents/logs/${feature}-${new Date().toISOString().slice(0, 10)}.md`;
  return planCtx;
}

/**
 * Validate the selected agent's credentials, WITHOUT constructing anything.
 * An injected ctx.runWave (tests) skips the check. `selection` is selectAgent's
 * result: the kind and command come from it (environment OR config, never mixed).
 *
 * @param {{ runWave?: Function }} ctx
 * @param {{ kind?: string, cmd?: string, source?: 'env'|'config' }} selection
 * @returns {{ injected: Function } | { kind: 'sdk', apiKey: string }
 *   | { kind: 'command'|'acp', cmd: string } | { code: number }}
 */
export function resolveAgent(ctx, selection) {
  if (ctx.runWave) return { injected: ctx.runWave };
  if (selection.kind === 'sdk') {
    // SDK path: requires ANTHROPIC_API_KEY (checked before any SDK construction
    // or model call). Credentials are the SDK's concern, not the command path's.
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!isNonEmpty(apiKey)) {
      process.stderr.write('rad deliver: ANTHROPIC_API_KEY is required\n');
      return { code: 1 };
    }
    return { kind: 'sdk', apiKey };
  }
  // Command (default) and acp paths: no ANTHROPIC_API_KEY required, since
  // credentials are the configured agent's concern. A command is mandatory:
  // RAD_AGENT_CMD from the environment, or agent.command from the config.
  const kind = selection.kind === 'acp' ? 'acp' : 'command';
  const { cmd } = selection;
  if (!isNonEmpty(cmd)) {
    const missing = selection.source === 'config'
      ? `agent.command is required when agent.adapter is ${kind} in ${CONFIG_PATH}`
      : `RAD_AGENT_CMD is required when RAD_AGENT=${kind}`;
    process.stderr.write(`rad deliver: ${missing}\n`);
    return { code: 1 };
  }
  return { kind, cmd };
}

/**
 * The project deny list from .rad/config.yml under `root`. deliver has never
 * required the config, so a MISSING file means no deny list; an INVALID one is
 * a refusal (fail closed: a deny list that cannot be read is not an empty one).
 *
 * @returns {Promise<{ ok: true, deny: string[] } | { ok: false, error: string }>}
 */
async function loadCapabilityDeny(root) {
  const loaded = await loadConfig(root);
  if (loaded.ok) return { ok: true, deny: loaded.doc.capabilities?.deny ?? [] };
  if (loaded.missing) return { ok: true, deny: [] };
  return { ok: false, error: `${CONFIG_PATH} is invalid, so capabilities.deny cannot be read: ${loaded.errors.join('; ')}` };
}

/**
 * Resolve every wave of a parsed plan against the project deny list under
 * `root`. Shared by `rad deliver` and `rad capabilities` so both report the
 * SAME text for a malformed Capabilities: line, an unreadable deny list, or a
 * denied explicit request. Adapter-agnostic: adapter checks stay with deliver.
 *
 * @param {{ planCtx: object, root: string, planLabel: string }} opts - planLabel names the plan in messages
 * @returns {Promise<{ ok: true, byWave: object } | { ok: false, error: string, configInvalid?: true }>}
 */
async function resolvePlanCapabilities({ planCtx, root, planLabel }) {
  if (planCtx.capabilityErrors.length > 0) {
    return { ok: false, error: `malformed Capabilities: line in ${planLabel}: ${planCtx.capabilityErrors.join('; ')}` };
  }
  const deny = await loadCapabilityDeny(root);
  if (!deny.ok) return { ok: false, error: deny.error, configInvalid: true };
  return resolveWaveCapabilities({
    waves: planCtx.waveNumbers,
    planCapabilities: planCtx.planCapabilities,
    waveCapabilities: planCtx.waveCapabilities,
    deny: deny.deny,
  });
}

/**
 * Refusal for a constrained wave the sdk adapter cannot grant (e.g. mcp), or null.
 * @param {Record<number, string[]>} waveEffective
 */
function sdkCapabilityRefusal(waveEffective) {
  for (const [wave, effective] of Object.entries(waveEffective)) {
    const mapped = sdkAllowedTools(effective);
    if (!mapped.ok) return `Wave ${wave} cannot run on the sdk adapter (effective: [${effective.join(', ')}]): ${mapped.error}`;
  }
  return null;
}

/**
 * Resolve every wave's effective capabilities (#85) and check the selected
 * adapter can honour them. On success sets planCtx.waveEffective (wave number
 * -> effective classes, constrained waves only) and returns null; otherwise
 * returns the refusal reason. An injected runWave skips only the adapter check.
 *
 * @returns {Promise<string|null>}
 */
async function capabilityRefusal({ planCtx, root, agent }) {
  const resolved = await resolvePlanCapabilities({
    planCtx, root, planLabel: `.agents/plans/${planCtx.feature}.md`,
  });
  if (!resolved.ok) return resolved.error;
  const waveEffective = {};
  for (const [wave, entry] of Object.entries(resolved.byWave)) {
    if (entry.constrained) waveEffective[wave] = entry.effective;
  }
  if (agent.kind === 'command') {
    const refusal = commandRefusal(resolved.byWave);
    if (refusal) return refusal;
  }
  if (agent.kind === 'acp') {
    // ACP permission answers are defence in depth, not enforcement: an agent
    // may act without asking, so a constrained wave is refused like command.
    const refusal = commandRefusal(resolved.byWave, 'acp');
    if (refusal) return refusal;
  }
  if (agent.kind === 'sdk') {
    const refusal = sdkCapabilityRefusal(waveEffective);
    if (refusal) return refusal;
  }
  planCtx.waveEffective = waveEffective;
  return null;
}

/**
 * Capability check for deliver setup: writes the refusal and returns the usage
 * exit code (before any event is appended), or null to continue.
 *
 * @returns {Promise<{ code: number } | null>}
 */
async function checkCapabilities(opts) {
  const refusal = await capabilityRefusal(opts);
  if (refusal === null) return null;
  process.stderr.write(`rad deliver: ${refusal}\n`);
  return { code: USAGE_EXIT_CODE };
}

/**
 * Construct a RAD_AGENT_CMD-backed adapter (command or acp). acp ignores
 * `model` and warns once per run itself (ACP v1 has no stable model selector).
 * createAcpAdapter rejects a `{prompt}` placeholder at construction; that is
 * an operator config error, reported as exit 1 before any event is appended.
 *
 * @returns {{ adapter: Function } | { code: number }}
 */
function buildCmdAdapter(agent, { model, root }) {
  if (agent.kind !== 'acp') {
    return { adapter: createCommandAdapter({ cmd: agent.cmd, repoRoot: root, model }) };
  }
  try {
    return { adapter: createAcpAdapter({ cmd: agent.cmd, repoRoot: root, model }) };
  } catch (err) {
    process.stderr.write(`rad deliver: ${err.message}\n`);
    return { code: 1 };
  }
}

/**
 * Construct the runWave for a resolved agent, rooted at `root` (the main
 * checkout, or the worktree in isolation mode). Runs the command-path preflight.
 *
 * @returns {Promise<{ runWave: Function } | { code: number }>}
 */
async function buildRunWave(agent, { model, root, planCtx }) {
  if (agent.injected) return { runWave: agent.injected };
  let adapter;
  if (agent.kind === 'sdk') {
    // Lazy-load the SDK adapter: only the sdk branch imports it, so cli.js (and
    // the gate/approve/command paths) load with the SDK absent.
    const { createRunWave } = await import('./adapters/agent/sdk.js');
    adapter = createRunWave({ apiKey: agent.apiKey, model, repoRoot: root });
  } else {
    const built = buildCmdAdapter(agent, { model, root });
    if (built.code !== undefined) return built;
    adapter = built.adapter;
    // Startup preflight: prove the agent CLI can authenticate (and, for acp,
    // complete the handshake) under the allow-listed adapter env BEFORE any
    // event append, so it fails fast instead of as a Wave-1 failure.
    const preflightCode = await preflightExitCode(agent.cmd, root, agent.kind);
    if (preflightCode !== null) return { code: preflightCode };
  }
  // Bind planCtx so deliverSpine's runWave(wave, attemptCtx) call works. The
  // spine's SECOND argument ({ attempt, priorFailure }) is folded into the
  // per-call plan context, which is how it reaches buildWavePrompt without
  // changing the adapter's (wave, planCtx) signature. Additive: on a first
  // attempt priorFailure is null and the rendered prompt is today's, verbatim.
  return { runWave: (wave, attemptCtx) => adapter(wave, { ...planCtx, ...attemptCtx }) };
}

/**
 * Main-checkout setup (RAD_WORKTREE='0'): plan read → gate → agent — the
 * pre-isolation order, byte-for-byte. Everything is rooted at repoRoot.
 */
async function setupMainRun({ ctx, feature, model, selection, repoRoot, sh }) {
  const planCtx = loadPlanCtx(repoRoot, feature);
  if (!planCtx) return { code: 1 };
  const state = createGitStateStore({ repoRoot, sh });
  // Gate check: approved status must be established before any wave execution.
  const g = await state.gate(feature, APPROVED_GATE);
  if (!g.passed) {
    process.stderr.write(`rad deliver: gate not passed for '${feature}' — ${g.reason}\n`);
    return { code: 1 };
  }
  const agent = resolveAgent(ctx, selection);
  if (agent.code !== undefined) return agent;
  const refused = await checkCapabilities({ planCtx, root: repoRoot, agent });
  if (refused) return refused;
  const built = await buildRunWave(agent, { model, root: repoRoot, planCtx });
  if (built.code !== undefined) return built;
  return { root: repoRoot, planCtx, state, runWave: built.runWave, worktree: null };
}

/**
 * Worktree isolation is the DEFAULT: ON unless RAD_WORKTREE is exactly '0'
 * (unset, empty, or any other value → ON). The one read of the knob, shared by
 * the setup switch and readResumeHistory so the gate and resume read one source.
 */
export function worktreeEnabled(env = process.env) {
  return env.RAD_WORKTREE !== WORKTREE_OFF_VALUE;
}

/** Run a git command in `repoRoot` (main checkout or worktree); a non-zero exit throws (fail-closed). */
function mainGit(sh, repoRoot, args) {
  const res = sh('git', args, { cwd: repoRoot });
  if (res.status !== 0) {
    const detail = String(res.stderr || res.stdout || 'no output').trim();
    throw new Error(`git ${args.join(' ')} exited ${res.status}: ${detail}`);
  }
  return String(res.stdout ?? '');
}

/** Paths of every worktree (per `git worktree list --porcelain`) that has `branch` checked out. */
function worktreesOnBranch(porcelain, branch) {
  const ref = `branch refs/heads/${branch}`;
  return porcelain.split(/\n\s*\n/)
    .map((block) => block.split('\n').map((l) => l.trim()))
    .filter((lines) => lines.includes(ref))
    .map((lines) => (lines.find((l) => l.startsWith('worktree ')) ?? '').slice('worktree '.length));
}

/**
 * The main checkout holds the work branch. Clean → switch it to the default
 * branch so `git worktree add` can use the branch. Dirty → refuse (exit 2) with
 * the exact commands; nothing is stashed, discarded, or switched.
 *
 * @returns {{ code: number } | null}
 */
function releaseMainCheckout({ workBranch, repoRoot, sh }) {
  const defaultBranch = readDefaultBranch({ sh, repoRoot, root: repoRoot });
  if (defaultBranch === '' || defaultBranch === workBranch) {
    process.stderr.write(
      `rad deliver: the main checkout is on ${workBranch} and no other default branch resolves — ` +
      'check out another branch in the main checkout, then re-run rad deliver\n',
    );
    return { code: USAGE_EXIT_CODE };
  }
  const dirty = mainGit(sh, repoRoot, ['status', '--porcelain', '--untracked-files=no']).trim();
  if (dirty !== '') {
    process.stderr.write(
      `rad deliver: the main checkout is on ${workBranch} with uncommitted changes, so the worktree ` +
      `cannot use it. Commit or stash your changes (git commit / git stash), then run:\n` +
      `  git checkout ${defaultBranch}\n` +
      'and re-run rad deliver. Nothing was changed.\n',
    );
    return { code: USAGE_EXIT_CODE };
  }
  mainGit(sh, repoRoot, ['checkout', defaultBranch]);
  process.stderr.write(
    `rad deliver: switched the main checkout from ${workBranch} to ${defaultBranch} ` +
    `so the worktree can use ${workBranch}\n`,
  );
  return null;
}

/**
 * Make the work branch available to `git worktree add` before create: resolve
 * the main checkout holding it (releaseMainCheckout), or refuse (exit 2) when
 * another worktree holds it. Never falls back to the main checkout.
 *
 * @returns {{ code: number } | null}
 */
function ensureBranchFree({ workBranch, repoRoot, sh }) {
  const head = mainGit(sh, repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (head === workBranch) return releaseMainCheckout({ workBranch, repoRoot, sh });
  const holders = worktreesOnBranch(mainGit(sh, repoRoot, ['worktree', 'list', '--porcelain']), workBranch);
  if (holders.length > 0) {
    process.stderr.write(
      `rad deliver: ${workBranch} is already checked out in another worktree (${holders.join(', ')}) — ` +
      'see `git worktree list`; remove that worktree or check out another branch there, then re-run\n',
    );
    return { code: USAGE_EXIT_CODE };
  }
  return null;
}

/**
 * Gate on the work-branch tip, then create the worktree on that branch. Under
 * Lane B the plan and its approval events exist ONLY on the work branch, so the
 * gate reads the branch tip (never the main checkout) and fails BEFORE any
 * worktree is created. `git worktree add` cannot check out a branch held
 * elsewhere, so ensureBranchFree resolves that first; a create failure is
 * exit 1 and never falls back to the main checkout.
 *
 * @returns {{ root: string, worktree: object, workBranch: string } | { code: number }}
 */
function prepareWorktreeRoot({ feature, repoRoot, sh }) {
  const workBranch = conventionWorkBranch(feature);
  const g = branchTipApprovedGate({ feature, branch: workBranch, repoRoot, sh });
  if (!g.passed) {
    process.stderr.write(`rad deliver: gate not passed for '${feature}' — ${g.reason}\n`);
    return { code: 1 };
  }
  // The lifecycle adapter shells out via the same sh port, pinned to repoRoot so
  // `git worktree` and the script path resolve against the main checkout.
  const worktree = makeWorktreeLifecycle({
    sh: (file, args) => sh(file, args, { cwd: repoRoot }),
    now: () => new Date().toISOString(),
  });
  try {
    const blocked = ensureBranchFree({ workBranch, repoRoot, sh });
    if (blocked) return blocked;
    return { root: worktree.create(feature, workBranch), worktree, workBranch };
  } catch (err) {
    const safe = sanitizeErrorMessage(err?.message ?? String(err));
    process.stderr.write(`rad deliver: worktree create failed — ${safe}\n`);
    return { code: 1 };
  }
}

/** Tell the operator where a preserved worktree is and the command that removes it. */
function writePreservedPointer(feature, root) {
  process.stderr.write(
    `rad deliver: worktree preserved at ${root}\n` +
    `rad deliver: to remove it (from the main checkout): scripts/worktree-lifecycle.sh remove ${feature} ${root}\n`,
  );
}

/** Preserve a worktree after a setup failure; a preserve error is reported, not hidden. */
function preserveAfterSetupFailure(worktree, feature, root) {
  try {
    worktree.preserve(feature);
    writePreservedPointer(feature, root);
  } catch (err) {
    const safe = sanitizeErrorMessage(err?.message ?? String(err));
    process.stderr.write(`rad deliver: worktree preserve failed — ${safe}\n`);
  }
}

/** `git diff --cached --quiet` exit status meaning "staged changes exist". */
const GIT_DIFF_HAS_CHANGES = 1;

/**
 * Commit the run-state the spine wrote inside the worktree so it persists on
 * the work branch and the NON-forced lifecycle remove sees a clean tree.
 * Commits only when something is staged. Any git failure throws.
 */
function commitRunEvents({ sh, root, feature }) {
  mainGit(sh, root, ['add', '--', `.agents/state/${feature}/`]);
  const staged = sh('git', ['diff', '--cached', '--quiet'], { cwd: root });
  if (staged.status === 0) return;
  if (staged.status !== GIT_DIFF_HAS_CHANGES) {
    const detail = String(staged.stderr || staged.stdout || 'no output').trim();
    throw new Error(`git diff --cached --quiet exited ${staged.status}: ${detail}`);
  }
  mainGit(sh, root, ['commit', '-m', `deliver(${feature}): record deliver run events`]);
}

/**
 * Tear down on evidenced success (after committing the run events), else
 * preserve. A commit failure preserves the worktree — never a forced remove.
 * @returns {number|null} an exit code to return, or null to continue
 */
function finishWorktree({ worktree, completed, sh, root, feature }) {
  if (!completed) {
    worktree.preserve(feature);
    writePreservedPointer(feature, root);
    return null;
  }
  try {
    commitRunEvents({ sh, root, feature });
  } catch (err) {
    const safe = sanitizeErrorMessage(err?.message ?? String(err));
    process.stderr.write(`rad deliver: could not commit run events in the worktree — ${safe}\n`);
    preserveAfterSetupFailure(worktree, feature, root);
    return 1;
  }
  worktree.complete(feature);
  return null;
}

/**
 * Worktree setup (the default; RAD_WORKTREE not '0'): agent credentials → branch-tip gate →
 * worktree create → plan read, state store, and agent ALL rooted at the
 * worktree, so events are read and written on the work branch and the main
 * checkout is never modified. A failure after create preserves the worktree.
 */
async function setupWorktreeRun({ ctx, feature, model, selection, repoRoot, sh }) {
  const agent = resolveAgent(ctx, selection);
  if (agent.code !== undefined) return agent;
  const prepared = prepareWorktreeRoot({ feature, repoRoot, sh });
  if (prepared.code !== undefined) return prepared;
  const { root, worktree, workBranch } = prepared;
  const planCtx = loadPlanCtx(root, feature);
  // A capability refusal after create preserves the worktree, like a preflight failure.
  const refused = planCtx ? await checkCapabilities({ planCtx, root, agent }) : { code: 1 };
  const built = refused ?? await buildRunWave(agent, { model, root, planCtx });
  if (built.code !== undefined) {
    preserveAfterSetupFailure(worktree, feature, root);
    return built;
  }
  const state = createGitStateStore({ repoRoot: root, sh });
  return { root, planCtx, state, runWave: built.runWave, worktree, workBranch };
}

/**
 * The flag half of the --resume eligibility table (needs no history). Returns
 * the refusal reason, or null when the flags are consistent.
 */
function resumeFlagRefusal({ resume, context }) {
  if (context !== undefined && !resume) return '--context requires --resume';
  if (resume && context === undefined) return '--resume requires --context "<text>"';
  if (!resume) return null;
  if (context.trim() === '') return '--context must not be empty';
  if (context.length > RESUME_CONTEXT_MAX_CHARS) {
    return `--context exceeds ${RESUME_CONTEXT_MAX_CHARS} characters (${context.length})`;
  }
  return null;
}

/**
 * Read the history --resume eligibility folds over — the SAME source the
 * approved gate reads: the branch-tip log in worktree mode (worktreeEnabled(),
 * read before any worktree exists), else the feature's log via the state store.
 *
 * @returns {{ ok: true, history: Object[] } | { ok: false, reason: string }}
 */
function readResumeHistory({ feature, repoRoot, sh }) {
  if (worktreeEnabled()) {
    return readBranchTipHistory({ feature, branch: conventionWorkBranch(feature), repoRoot, sh });
  }
  try {
    const state = createGitStateStore({ repoRoot, sh });
    return { ok: true, history: state.history(feature) };
  } catch (err) {
    return { ok: false, reason: sanitizeErrorMessage(err?.message ?? String(err)) };
  }
}

/** The running git user.email via the sh port (as approveCommand reads it); '' when unset or on error. */
function gitUserEmail(repoRoot, sh) {
  const res = sh('git', ['config', 'user.email'], { cwd: repoRoot });
  if (res.status !== 0) return '';
  return String(res.stdout ?? '').trim();
}

/**
 * The --resume eligibility table, in order. Runs before any event append and
 * before worktree creation. Returns `{ resume }` (null without --resume) or
 * `{ refusal }` — the reason deliverCommand reports with exit 2.
 *
 * @returns {{ resume: ({ context: string, recordedBy: string, stop: Object }|null) } | { refusal: string }}
 */
function resolveResume({ resume, context, feature, repoRoot, sh }) {
  const flagRefusal = resumeFlagRefusal({ resume, context });
  if (flagRefusal) return { refusal: flagRefusal };
  if (!resume) return { resume: null };
  const read = readResumeHistory({ feature, repoRoot, sh });
  if (!read.ok) return { refusal: `cannot read the event log to resume: ${read.reason}` };
  const stop = latestStop(read.history);
  if (stop == null) return { refusal: `nothing to resume: ${feature} has no deliver-stopped event` };
  if (stop.class === STOP_CLASSES.FAILED) {
    return { refusal: `cannot resume a failed stop (${stop.reason}): ${stop.decision}` };
  }
  const recordedBy = gitUserEmail(repoRoot, sh);
  if (!isNonEmpty(recordedBy)) return { refusal: 'cannot resolve git user.email for run-resumed.recordedBy' };
  return { resume: { context, recordedBy, stop } };
}

/**
 * Parse RAD_MAX_FAILED_ATTEMPTS. Unset/empty → `cap: null` (the cap is off);
 * a positive integer → that cap; anything else → `{ ok: false }` (exit 2).
 *
 * @returns {{ ok: true, cap: number|null } | { ok: false, raw: string }}
 */
function maxFailedAttemptsFromEnv() {
  const raw = process.env[MAX_FAILED_ATTEMPTS_ENV];
  if (raw === undefined || raw === '') return { ok: true, cap: null };
  if (!POSITIVE_INTEGER_PATTERN.test(raw)) return { ok: false, raw };
  return { ok: true, cap: Number(raw) };
}

/** The LATEST `approved` event in `history`, or null when there is none. */
function latestApprovedEvent(history) {
  const approvals = (Array.isArray(history) ? history : []).filter((e) => e && e.type === 'approved');
  return approvals.length > 0 ? approvals[approvals.length - 1] : null;
}

/**
 * Build the spine's `approvalIntact` port (#77): re-read the plan doc on EVERY
 * call and compare its body fingerprint to the LATEST approved event's
 * `data.fingerprint`. A legacy approval carrying no fingerprint passes (matches
 * check-plan-approved.sh — an edit cannot be proven). Fail-closed otherwise: an
 * unreadable plan or a missing approved event is not intact.
 *
 * @returns {() => { ok: true } | { ok: false, reason: string }}
 */
function makeApprovalIntact({ root, state, feature }) {
  const planFile = join(root, '.agents', 'plans', `${feature}.md`);
  return () => {
    let text;
    try {
      text = readFileSync(planFile, 'utf8');
    } catch (err) {
      return { ok: false, reason: `plan doc unreadable: ${sanitizeErrorMessage(err?.message ?? String(err))}` };
    }
    const approved = latestApprovedEvent(state.history(feature));
    if (!approved) return { ok: false, reason: 'no approved event in the log' };
    const stored = approved.data?.fingerprint;
    if (typeof stored !== 'string' || stored === '') return { ok: true };
    const current = planFingerprint(text).hash;
    if (current === stored) return { ok: true };
    return { ok: false, reason: `plan fingerprint ${current} differs from approved ${stored}` };
  };
}

/**
 * Fail-closed completion check: a spine `ok` exits 0 only when the event log
 * itself evidences it (deliverCompleted). Must run BEFORE worktree teardown,
 * which removes the tree the log lives in.
 *
 * @returns {{ completed: boolean, detail: string }}
 */
function completionEvidence(result, state, feature) {
  if (!result.ok) return { completed: false, detail: '' };
  try {
    const completed = deliverCompleted(state.history(feature), result.waves);
    return { completed, detail: completed ? '' : 'event log lacks wave-complete/pr-opened' };
  } catch (err) {
    return { completed: false, detail: `event log unreadable: ${sanitizeErrorMessage(err?.message ?? String(err))}` };
  }
}

/**
 * Classify a stopped terminal. An unclassifiable shape (classifyStop throws) is
 * reported as `failed` with the reason in the decision — never exit 0 or 3.
 */
function classifyTerminal(result) {
  try {
    return classifyStop(result);
  } catch (err) {
    return { class: STOP_CLASSES.FAILED, reason: 'unclassified', decision: `unclassified stop: ${err.message}` };
  }
}

/** ` detail="…"` for a stop carrying a free-text reason (#161), embedded
 * double quotes escaped; '' when the stop has none. */
function stopDetailField(result) {
  if (typeof result.reason !== 'string' || result.reason === '') return '';
  return ` detail="${result.reason.replace(/"/g, '\\"')}"`;
}

/** Write the machine-greppable failure line and return the stop's exit code. */
function reportStop({ result, feature, worktree, root }) {
  const stop = classifyTerminal(result);
  process.stderr.write(
    `rad deliver: failed feature=${feature} stopped=${result.stopped}` +
    (result.wave !== undefined ? ` wave=${result.wave}` : '') +
    (result.action ? ` action=${result.action}` : '') +
    (result.check ? ` check=${result.check}` : '') +
    (result.spent !== undefined ? ` spent=${result.spent}` : '') +
    (result.budget !== undefined ? ` budget=${result.budget}` : '') +
    (worktree ? ` worktree=${root}` : '') +
    ` class=${stop.class} decision="${stop.decision}"` +
    stopDetailField(result) +
    '\n',
  );
  return stop.class === STOP_CLASSES.NEEDS_DECISION ? NEEDS_DECISION_EXIT_CODE : FAILED_EXIT_CODE;
}

/**
 * Resolve the wave-lifecycle hooks dir, rooted at `root`. Precedence: a
 * non-empty `RAD_HOOKS_DIR` in `env`; else `settings.hooks_dir` (from
 * .rad/config.yml); else `<root>/scripts/hooks`. A malformed value from either
 * source is reported with the source that supplied it — never skipped.
 *
 * @returns {{ ok: true, dir: string } | { ok: false, raw: unknown, source: string }}
 */
export function resolveHooksDir(env, root, settings = {}) {
  const fromEnv = env[HOOKS_DIR_ENV];
  if (isNonEmpty(fromEnv)) return hooksDirFrom(fromEnv, HOOKS_DIR_ENV, root);
  const fromConfig = settings?.hooks_dir;
  if (fromConfig !== undefined) return hooksDirFrom(fromConfig, HOOKS_DIR_SETTING_SOURCE, root);
  return { ok: true, dir: join(root, DEFAULT_HOOKS_SUBDIR) };
}

/** Validate one hooks-dir value from `source` and resolve it against `root`. */
function hooksDirFrom(raw, source, root) {
  if (!isNonEmpty(raw) || MALFORMED_HOOKS_DIR.test(raw)) return { ok: false, raw, source };
  return { ok: true, dir: resolve(root, raw) };
}

/**
 * The .rad/config.yml deliver runs with, loaded once from `repoRoot` before any
 * setup. A missing file is `doc: null` (deliver has never required the config);
 * an invalid one is an error, never treated as absent.
 *
 * @returns {Promise<{ ok: true, doc: Object|null } | { ok: false, errors: string[] }>}
 */
async function loadDeliverConfig(repoRoot) {
  const loaded = await loadConfig(repoRoot);
  if (loaded.missing) return { ok: true, doc: null };
  if (!loaded.ok) return { ok: false, errors: loaded.errors };
  return { ok: true, doc: loaded.doc };
}

/** Write deliver's invalid-config refusal (one line per error); returns exit 2. */
function refuseInvalidDeliverConfig(errors) {
  process.stderr.write(`rad deliver: ${CONFIG_PATH} is invalid:\n`);
  for (const e of errors) process.stderr.write(`  - ${e}\n`);
  return USAGE_EXIT_CODE;
}

/**
 * Select the wave agent (environment all-or-nothing, else the config's
 * `agent:` block — see agent-select.js) BEFORE any setup, so a refusal leaves
 * no worktree and no event. An invalid config selects as if absent, so an
 * environment setup behaves as today (the later settings check still refuses
 * it); with no environment agent, that invalid config is the reported reason.
 * An injected ctx.runWave (tests) skips the selection checks, as it always
 * skipped the unknown-kind check.
 *
 * @returns {{ selection: Object } | { code: number }}
 */
function selectDeliverAgent(ctx, configLoad) {
  const selection = selectAgent(process.env, configLoad.ok ? configLoad.doc : null);
  if (ctx.runWave) return { selection };
  if (selection.error !== undefined) {
    if (!configLoad.ok) return { code: refuseInvalidDeliverConfig(configLoad.errors) };
    process.stderr.write(`rad deliver: ${selection.error}\n`);
    return { code: USAGE_EXIT_CODE };
  }
  if (!AGENT_KINDS.includes(selection.kind)) {
    process.stderr.write(`rad deliver: unknown RAD_AGENT '${selection.kind}' (expected ${AGENT_KINDS.join(' | ')})\n`);
    return { code: 1 };
  }
  return { selection };
}

/**
 * The work branch for a run: the isolated branch in worktree mode, else the
 * plan's `Branch:` header, else the RAD_BRANCH_PREFIX (default rad/) convention.
 */
function resolveWorkBranch(setup, planCtx, feature) {
  return setup.workBranch ?? planWorkBranch(planCtx.branch, feature);
}

/**
 * Read the default branch via get-default-branch.sh. A non-zero exit breaks the
 * script's always-0 contract and is thrown (fail-closed); empty output yields ''
 * so callers omit the optional base argument.
 */
function readDefaultBranch({ sh, repoRoot, root, verb = 'rad deliver' }) {
  const res = sh(join(repoRoot, DEFAULT_BRANCH_SCRIPT), [root], { cwd: root });
  if (res.status !== 0) {
    throw new Error(`${verb}: cannot resolve default branch (${DEFAULT_BRANCH_SCRIPT} exited ${res.status})`);
  }
  return String(res.stdout ?? '').trim();
}

/**
 * The deliverSpine prepare port: an injected ctx.prepare (tests) as-is, else
 * the real port rooted at the run root. Resolving the default branch or a
 * missing port option fails closed BEFORE the spine: the reason is written and
 * `{ code: 1 }` returned.
 *
 * @returns {{ prepare: Function } | { code: number }}
 */
function buildPreparePort({ ctx, sh, repoRoot, root, feature, workBranch }) {
  if (ctx.prepare) return { prepare: ctx.prepare };
  try {
    const baseBranch = readDefaultBranch({ sh, repoRoot, root });
    const planPath = join(PLANS_DIR, `${feature}.md`);
    return { prepare: makePreparePort({ sh, root, feature, planPath, workBranch, baseBranch }) };
  } catch (err) {
    process.stderr.write(`${err instanceof TypeError ? 'rad deliver: ' : ''}${err.message}\n`);
    return { code: FAILED_EXIT_CODE };
  }
}

/** The plan doc path relative to a run root (main checkout or worktree). */
function planRelPath(feature) {
  return join(PLANS_DIR, `${feature}.md`);
}

/**
 * The deliverSpine finish port: an injected ctx.finish (tests) as-is, else the
 * real port rooted at the run root. A construction error fails closed BEFORE
 * the spine, like a prepare-port build error.
 *
 * @returns {{ finish: Object } | { code: number }}
 */
function buildFinishPort({ ctx, sh, root, feature, workBranch }) {
  if (ctx.finish) return { finish: ctx.finish };
  try {
    return { finish: makeFinishPort({ sh, root, feature, planPath: planRelPath(feature), workBranch }) };
  } catch (err) {
    process.stderr.write(`${err instanceof TypeError ? 'rad deliver: ' : ''}${err.message}\n`);
    return { code: FAILED_EXIT_CODE };
  }
}

/** Phase the event log folds to once pr-opened is recorded. */
const DELIVERED_PHASE = 'delivered';
/** Labels the deliver PR's issue (`<issue> <status>`). */
const RAD_LABEL_SCRIPT = 'scripts/rad-label.sh';
/** Issue label a delivered feature carries while its PR is in review. */
const REVIEW_LABEL = 'review';

/**
 * Main-mode delivered rerun: re-run the finish port's afterPr rooted at the
 * main checkout (it commits/pushes the events log and labels `review` itself).
 * An injected ctx.finish stands in for the real port.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
async function rerunMainAfterPr({ ctx, sh, repoRoot, feature }) {
  let finish = ctx.finish;
  if (!finish) {
    const planFile = join(repoRoot, planRelPath(feature));
    if (!existsSync(planFile)) return { ok: false, reason: `no plan doc at ${planRelPath(feature)}` };
    const workBranch = planWorkBranch(parsePlanCtx(readFileSync(planFile, 'utf8')).branch, feature);
    finish = makeFinishPort({ sh, root: repoRoot, feature, planPath: planRelPath(feature), workBranch });
  }
  const res = await finish.afterPr();
  return res.ok ? { ok: true } : { ok: false, reason: `finishing the delivered run failed: ${res.detail}` };
}

/**
 * Worktree-mode delivered rerun: the run's commits are already on the work
 * branch, so nothing is committed — push it (never forced), then label the
 * plan's issue `review` (the plan read at the branch tip). No issue → no label.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function republishDeliveredBranch({ sh, repoRoot, feature }) {
  const branch = conventionWorkBranch(feature);
  mainGit(sh, repoRoot, ['push', 'origin', branch]);
  const issue = planIssueNumber(mainGit(sh, repoRoot, ['show', `${branch}:${planRelPath(feature)}`]));
  if (issue === null) {
    process.stdout.write('label skipped: no issue\n');
    return { ok: true };
  }
  const res = sh(join(repoRoot, RAD_LABEL_SCRIPT), [String(issue), REVIEW_LABEL], { cwd: repoRoot });
  if (res.status === 0) return { ok: true };
  const detail = String(res.stderr || res.stdout || 'no output').trim();
  return { ok: false, reason: `${RAD_LABEL_SCRIPT} ${issue} ${REVIEW_LABEL} exited ${res.status}: ${detail}` };
}

/**
 * Delivered short-circuit: when the log already folds to `delivered`, skip
 * setup/gate/prepare/waves and only finish publishing. An unreadable log is not
 * a delivered one — it returns null and the gate (or --resume check) reports it.
 *
 * @returns {Promise<number|null>} the exit code, or null when not delivered
 */
async function deliveredShortCircuit({ ctx, sh, repoRoot, feature }) {
  const read = readResumeHistory({ feature, repoRoot, sh });
  if (!read.ok || phaseOf(read.history) !== DELIVERED_PHASE) return null;
  let outcome;
  try {
    outcome = worktreeEnabled()
      ? republishDeliveredBranch({ sh, repoRoot, feature })
      : await rerunMainAfterPr({ ctx, sh, repoRoot, feature });
  } catch (err) {
    outcome = { ok: false, reason: sanitizeErrorMessage(err?.message ?? String(err)) };
  }
  if (!outcome.ok) {
    process.stderr.write(`rad deliver: ${outcome.reason}\n`);
    return FAILED_EXIT_CODE;
  }
  process.stdout.write(`rad deliver: already delivered feature=${feature}\n`);
  return 0;
}

/**
 * Per-run context the SCRIPT_ARGS builders read. The base branch is resolved
 * lazily, once per run, only when a script needs it; the wave count is read
 * from the same plan the spine walks.
 */
function makeScriptCtx({ sh, repoRoot, root, feature, branch, state }) {
  let base;
  const resolveBase = () => {
    if (base === undefined) base = readDefaultBranch({ sh, repoRoot, root });
    return base;
  };
  return {
    feature,
    branch,
    planPath: join(root, '.agents', 'plans', `${feature}.md`),
    baseArgs: () => (resolveBase() === '' ? [] : [base]),
    waveCount: () => (state.plan(feature)?.waves ?? []).length,
    prBody: () => deliverPrBody({ sh, root, feature, state, resolveBase }),
  };
}

/**
 * The deliver PR's title + body, gathered at open-pr time from the run root:
 * the plan doc, the feature history, commits and test presence at HEAD. The
 * spine only reaches open-pr after check-scope.sh exits 0, so scope is passed.
 * A failing source renders as unavailable; buildPrBody's own throws surface.
 */
function deliverPrBody({ sh, root, feature, state, resolveBase }) {
  const planPath = planRelPath(feature);
  const plan = prBodySource(() => readFileSync(join(root, planPath), 'utf8'));
  return buildPrBody({
    feature,
    planPath,
    planText: typeof plan === 'string' ? plan : '',
    history: deliverPrHistory(state, feature),
    ...gatherPrBodyRefInputs({ sh, cwd: root, ref: 'HEAD', resolveBase, plan }),
    scope: { passed: true },
  });
}

/** The feature history for the PR body; an unreadable one is reported on stderr and rendered empty. */
function deliverPrHistory(state, feature) {
  const history = prBodySource(() => state.history(feature));
  if (Array.isArray(history)) return history;
  const reason = history?.unavailable ?? 'history is not an array';
  process.stderr.write(`rad deliver: PR body has no wave history (${reason})\n`);
  return [];
}

/**
 * Build the deliverSpine `sh` port: each script string the spine passes is
 * mapped through SCRIPT_ARGS to its real argv and run with cwd = root.
 * An unknown script throws — it is never run with a guessed argv.
 */
export function makeSpineScriptPort({ sh, repoRoot, root, scriptCtx }) {
  return (script, arg) => {
    const build = Object.hasOwn(SCRIPT_ARGS, script) ? SCRIPT_ARGS[script] : null;
    if (!build) throw new Error(`rad deliver: no argument contract for ${script}`);
    return sh(join(repoRoot, script), build(scriptCtx, arg), { cwd: root });
  };
}

/** The script strings SCRIPT_ARGS covers (for contract tests). */
export const SCRIPT_ARG_KEYS = Object.freeze(Object.keys(SCRIPT_ARGS));

/**
 * Real hook spawner honoring hook-runner's `sh(hook, argv, { cwd, env })`
 * contract (defaultSh does not forward env). Spawn errors and signal deaths
 * are reported as a non-zero status so the runner fails closed/open per point.
 */
function spawnHook(file, args, opts) {
  const res = spawnSync(file, args, {
    cwd: opts.cwd, env: opts.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error) {
    return { status: HOOK_SPAWN_FAILURE_EXIT, stdout: '', stderr: `${res.error.code ?? 'spawn-error'}: ${res.error.message}` };
  }
  const signalNote = res.signal ? `killed by ${res.signal}` : '';
  return { status: res.status ?? HOOK_SPAWN_FAILURE_EXIT, stdout: res.stdout ?? '', stderr: res.stderr || signalNote };
}

/**
 * Wire the hook runner for a run: hooks run with cwd = root and inherit the
 * process env plus the runner's RAD_HOOK_* values.
 */
function makeRunHooks({ hookShell, root, hooksDir, now }) {
  const hookSh = (file, args, opts = {}) =>
    hookShell(file, args, { cwd: root, env: { ...process.env, ...opts.env } });
  return createHookRunner({ sh: hookSh, now, hooksDir }).runHooks;
}

/**
 * `deliver <feature> [--model <model-id>]`.
 *
 * Reads the approved plan, constructs an SDK-backed runWave, and drives
 * deliverSpine to completion. Returns an integer exit code — never calls
 * process.exit() directly.
 *
 * @param {string[]} argv - args after `deliver`
 * @param {{ repoRoot: string, sh?: typeof defaultSh, runWave?: Function }} ctx
 * @returns {Promise<number>}
 */
export async function deliverCommand(argv, ctx) {
  const { repoRoot } = ctx;
  const sh = ctx.sh ?? defaultSh;

  // Subcommand-level help: print usage and exit 0.
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`Usage: ${DELIVER_USAGE}\n`);
    process.stdout.write('\nRun approved plan wave execution via Claude Agent SDK.\n');
    return 0;
  }

  let parsed;
  try {
    parsed = parseDeliverArgs(argv);
  } catch (err) {
    process.stderr.write(`rad deliver: ${err.message}\n`);
    process.stderr.write(`Usage: ${DELIVER_USAGE}\n`);
    return err.exitCode ?? 1;
  }

  const { feature, modelExplicit } = parsed;

  if (!isNonEmpty(feature)) {
    process.stderr.write('rad deliver: a feature name is required\n');
    process.stderr.write(`Usage: ${DELIVER_USAGE}\n`);
    return 1;
  }

  // Adapter selection. The environment (RAD_AGENT / RAD_AGENT_CMD) wins outright
  // when either is set; otherwise `agent:` in .rad/config.yml applies. The kind
  // picks the runner: 'command' (vendor-neutral CLI), 'sdk' (Anthropic SDK) or
  // 'acp' (an Agent Client Protocol v1 agent). Credential requirements differ per
  // path and are validated in resolveAgent — an injected ctx.runWave (tests)
  // skips construction and the credential check. Config is read once, here.
  const configLoad = await loadDeliverConfig(repoRoot);
  const selected = selectDeliverAgent(ctx, configLoad);
  if (selected.code !== undefined) return selected.code;
  const { selection } = selected;
  // acp honours no model (ACP v1 has no stable selector), so only an explicit
  // --model reaches it, where createAcpAdapter turns it into its one warning.
  const model = selection.kind === 'acp' && !modelExplicit ? undefined : parsed.model;

  // Failed-attempt cap: parsed BEFORE setup so a malformed value exits 2 with
  // no worktree created and no event appended.
  const failedCap = maxFailedAttemptsFromEnv();
  if (!failedCap.ok) {
    process.stderr.write(
      `rad deliver: ${MAX_FAILED_ATTEMPTS_ENV} must be a positive integer (got '${failedCap.raw}')\n`,
    );
    return USAGE_EXIT_CODE;
  }

  // Settings + hooks dir: validated BEFORE setup so an invalid config or a
  // malformed hooks dir exits 2 with no worktree created and no event appended.
  // Uses the config loaded once above, from repoRoot.
  if (!configLoad.ok) return refuseInvalidDeliverConfig(configLoad.errors);
  const settings = configLoad.doc?.settings ?? {};
  const hooksCheck = resolveHooksDir(process.env, repoRoot, settings);
  if (!hooksCheck.ok) {
    process.stderr.write(
      `rad deliver: ${hooksCheck.source} must be a directory path (got ${JSON.stringify(hooksCheck.raw)})\n`,
    );
    return USAGE_EXIT_CODE;
  }

  // Delivered rerun: BEFORE --resume eligibility (a delivered feature has no
  // stopped run to resume) and before setup — it never calls the spine, so
  // nothing is appended after pr-opened.
  const delivered = await deliveredShortCircuit({ ctx, sh, repoRoot, feature });
  if (delivered !== null) return delivered;

  // --resume eligibility: BEFORE setup, so a refusal exits 2 with no worktree
  // created and no event appended. Without --resume this yields resume: null
  // and the spine call below is unchanged (AC#7 byte-for-byte).
  const eligibility = resolveResume({ ...parsed, feature, repoRoot, sh });
  if (eligibility.refusal !== undefined) {
    process.stderr.write(`rad deliver: ${eligibility.refusal}\n`);
    return USAGE_EXIT_CODE;
  }
  const { resume } = eligibility;

  // Worktree isolation is the DEFAULT (worktreeEnabled): RAD_WORKTREE exactly
  // '0' = OFF (main checkout, no worktree port, everything rooted at repoRoot);
  // unset, empty, or any other value = ON: the gate is read
  // from the work-branch tip, then plan, state store, agent, and every
  // check-*.sh / open-pr.sh run are rooted at an isolated git worktree on the
  // work branch. RAD_WORKTREE_DIR (optional base dir) is read by the lifecycle
  // script itself, so we just let it flow through the environment.
  const setupOpts = { ctx, feature, model, selection, repoRoot, sh };
  const setup = worktreeEnabled()
    ? await setupWorktreeRun(setupOpts)
    : await setupMainRun(setupOpts);
  if (setup.code !== undefined) return setup.code;
  const { root, planCtx, state, runWave, worktree } = setup;

  const matrix = loadMatrix();

  // Optional cumulative token budget. RAD_TOKEN_BUDGET, when a positive integer,
  // arms the spine's budget breaker; unset/invalid/0 leaves it null (disabled).
  const parsedBudget = Number.parseInt(process.env.RAD_TOKEN_BUDGET, 10);
  const tokenBudget = Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : null;

  const now = () => new Date().toISOString();
  const workBranch = resolveWorkBranch(setup, planCtx, feature);
  const scriptCtx = makeScriptCtx({ sh, repoRoot, root, feature, branch: workBranch, state });
  const port = buildPreparePort({ ctx, sh, repoRoot, root, feature, workBranch });
  const finishPort = port.code === undefined ? buildFinishPort({ ctx, sh, root, feature, workBranch }) : port;
  if (finishPort.code !== undefined) {
    // Before the spine, like a setup failure: keep the worktree for inspection.
    if (worktree) preserveAfterSetupFailure(worktree, feature, root);
    return finishPort.code;
  }
  const runHooks = makeRunHooks({
    hookShell: ctx.sh ?? spawnHook, root, hooksDir: resolveHooksDir(process.env, root, settings).dir, now,
  });

  let result;
  try {
    result = await deliverSpine({
      feature,
      state,
      docs: null,
      matrix,
      gates: null,
      runWave,
      // Sync/merge/in-progress before any wave; a stop exits via reportStop.
      prepare: port.prepare,
      // Mark the plan complete before open-pr.sh; publish pr-opened after it.
      finish: finishPort.finish,
      // Scripts run with cwd = root: repoRoot today, the worktree when isolated.
      // Each gets its real argv from SCRIPT_ARGS; an unknown script throws.
      sh: makeSpineScriptPort({ sh, repoRoot, root, scriptCtx }),
      now,
      runHooks,
      pushGuard: true,
      tokenBudget,
      // Per-wave `Verify:` commands, passed through exactly as tokenBudget is.
      // Empty for a plan that declares none, which leaves the spine's behavior
      // and its event sequence unchanged.
      waveVerify: planCtx.waveVerify,
      // Per-wave promised test files (parseTestsByWave): the presence gate after
      // wave k checks only waves <= k's promises; {} skips the gate entirely.
      testsByWave: planCtx.testsByWave,
      // Per-wave `Model:` ids (parseWaveModels — the sole Model: parser), recorded
      // on each wave-started. Empty for a plan that declares none.
      waveModels: planCtx.waveModels,
      // Effective capability classes of constrained waves only, recorded on each
      // wave-started. Empty for an undeclared plan with no deny list.
      waveCapabilities: planCtx.waveEffective,
      approvalIntact: makeApprovalIntact({ root, state, feature }),
      maxFailedAttempts: failedCap.cap,
      // Only a --resume run passes the key; otherwise the call is today's.
      ...(resume ? { resume } : {}),
    });
  } catch (err) {
    // Unexpected spine throw: still preserve the worktree (so the operator can
    // inspect it) before rethrowing-as-exit. Cleanup is keyed off the returned
    // terminal object below for the normal path; this guards the abnormal one.
    if (worktree) preserveAfterSetupFailure(worktree, feature, root);
    // Sanitize: a deep spine/SDK error could otherwise surface a credential.
    const safe = sanitizeErrorMessage(err?.message ?? String(err));
    process.stderr.write(`rad deliver: unexpected error — ${safe}\n`);
    return 1;
  }

  const evidence = completionEvidence(result, state, feature);
  // An afterPr failure comes after pr-opened: the run is delivered, so its
  // worktree is torn down like a completed one; the exit still reports the stop.
  const deliveredButUnpublished = result.afterPr === true;

  // Worktree cleanup: complete (tear down) only on EVIDENCED success or a
  // delivered run, preserve (keep for inspection) on any other stop or an ok
  // the log does not confirm.
  if (worktree) {
    const completed = evidence.completed || deliveredButUnpublished;
    const cleanupCode = finishWorktree({ worktree, completed, sh, root, feature });
    if (cleanupCode !== null) return cleanupCode;
  }
  if (deliveredButUnpublished) return reportStop({ result, feature, worktree: null, root });

  if (evidence.completed) {
    // Best-effort publish (RAD_SYNC-gated): deliver recorded wave events on the
    // work-branch tip; push it so the process memory is portable across machines.
    // Never fails the verb (offline-fail-safe). Worktree mode pushes the branch it
    // isolated; otherwise the plan's `Branch:` header is canonical, else rad/<feature>.
    bestEffortSyncPush(repoRoot, workBranch, sh);
    process.stdout.write(
      `rad deliver: ok feature=${feature} waves=${result.waves} status=complete\n`,
    );
    return 0;
  }

  if (result.ok) {
    // The spine said ok but the log does not evidence it: fail closed.
    process.stderr.write(
      `rad deliver: failed feature=${feature} completion not evidenced (${evidence.detail})` +
      (worktree ? ` worktree=${root}` : '') +
      '\n',
    );
    return FAILED_EXIT_CODE;
  }

  // Structured failure line (machine-greppable); exit code by stop class.
  return reportStop({ result, feature, worktree, root });
}

/**
 * Bootstrap dual-write part (b): write the plan-doc Status header fields — the
 * human-readable mirror of the approval, written for the reader of the plan, not
 * for any gate. Updates `Status`, `Approved-By`, `Approved-At` in place, and in
 * proxy mode also `Recorded-By` and `Approval-Evidence` (inserted after the
 * existing header block if not already present). Preserves all other content.
 *
 * DISPLAY-ONLY (Decision 2): the plan-doc `Status: approved` header is a HUMAN-
 * readable mirror, NOT the authority. Authority is the appended `approved` event
 * (recordApproval → frozen `role` field), evaluated by the pure gate fold
 * (`rad gate`, state.gate / evaluateGate). The deliver gate reads the event log,
 * not this header — never re-derive approval authority from this doc-write.
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
  } else if (isNonEmpty(fields.recordedBy)) {
    // Non-proxy mirror of the recorder: direct human approval passes
    // recordedBy = the running architect (recorder == approver), mirrored here.
    upsert('Recorded-By', fields.recordedBy);
  }

  writeFileSync(planFile, lines.join('\n'), 'utf8');
}

/** Approval-blocker check script, resolved under `<repoRoot>/scripts/`. */
const APPROVAL_BLOCKERS_SCRIPT = 'check-approval-blockers.sh';
/** check-approval-blockers.sh exit code meaning "blockers remain" (0 = clear). */
const BLOCKERS_REMAIN_EXIT = 1;
/** Separator between a waiver id and its justification on a stdout line. */
const WAIVER_FIELD_SEPARATOR = '\t';

/**
 * First TAB field of the provenance line check-approval-blockers.sh prints when
 * the effective high-risk pattern is non-default. Matched EXACTLY — a line whose
 * first field merely starts with this string is an ordinary waiver id.
 */
const HIGH_RISK_PATTERN_TAG = 'high-risk-pattern';

/**
 * Parse check-approval-blockers.sh exit-0 stdout into
 * `{ waivers: [{id, justification}], highRiskPattern?: string }`.
 * Blank lines are ignored. Throws (the caller fails closed — nothing unparseable
 * is ever silently dropped) on: a non-blank line without a TAB, a second
 * `high-risk-pattern` tag, or a tag with an empty value. The pattern value is
 * kept verbatim (it contains regex metacharacters such as | ( ) ^ $).
 */
function parseBlockerStdout(stdout) {
  const waivers = [];
  let highRiskPattern;
  for (const line of String(stdout ?? '').split('\n')) {
    if (line.trim() === '') continue;
    const sep = line.indexOf(WAIVER_FIELD_SEPARATOR);
    if (sep === -1) throw new Error(`malformed waiver line (no TAB): ${JSON.stringify(line)}`);
    const first = line.slice(0, sep);
    const rest = line.slice(sep + 1);
    if (first !== HIGH_RISK_PATTERN_TAG) {
      waivers.push({ id: first, justification: rest });
      continue;
    }
    if (highRiskPattern !== undefined) throw new Error(`duplicate ${HIGH_RISK_PATTERN_TAG} line`);
    if (rest === '') throw new Error(`empty ${HIGH_RISK_PATTERN_TAG} value`);
    highRiskPattern = rest;
  }
  return highRiskPattern === undefined ? { waivers } : { waivers, highRiskPattern };
}

/**
 * Run check-approval-blockers.sh against the plan doc. Returns
 * `{ ok: true, waivers, highRiskPattern? }` ONLY on exit 0 with parseable stdout; every other
 * outcome (blockers, any other status, a thrown spawn, bad stdout) is
 * `{ ok: false, message }` — the approve boundary fails closed.
 */
function checkApprovalBlockers(sh, repoRoot, planFile) {
  const script = join(repoRoot, 'scripts', APPROVAL_BLOCKERS_SCRIPT);
  const failed = (detail) => ({
    ok: false,
    message: `rad approve: refused — approval blocker check failed (${detail})\n`,
  });
  let result;
  try {
    result = sh(script, [planFile], { cwd: repoRoot });
  } catch (err) {
    return failed(`spawn error: ${err.message}`);
  }
  if (result.status === BLOCKERS_REMAIN_EXIT) {
    return {
      ok: false,
      message: `rad approve: refused — unresolved approval blockers\n${result.stderr ?? ''}`,
    };
  }
  if (result.status !== 0) {
    return failed(`exit ${result.status}: ${String(result.stderr ?? '').trim()}`);
  }
  try {
    return { ok: true, ...parseBlockerStdout(result.stdout) };
  } catch (err) {
    return failed(err.message);
  }
}

/** `rad approve` exit codes: 1 = refused/failed before or during recording (existing contract); 2 = publish refusal or trailer usage error. */
const APPROVE_FAILED_EXIT = 1;
const APPROVE_REFUSED_EXIT = 2;
const APPROVE_VERB = 'rad approve';
const APPROVE_LABEL_STATUS = 'approved';

/** Print the usage line after a parse error; returns `code`. */
function approveUsageError(message, code) {
  process.stderr.write(`rad approve: ${message}\n`);
  process.stderr.write(`Usage: ${APPROVE_USAGE}\n`);
  return code;
}

/**
 * Parse and pre-validate argv. Every trailer refusal (invalid trailer, or
 * `--trailer` with `--no-commit`) is exit 2 and runs before any read or write.
 *
 * @returns {{ code: number } | { feature: string, onBehalfOf?: string, evidence?: string, noCommit: boolean, trailers: string[] }}
 */
function parseApproveRequest(argv) {
  let parsed;
  try {
    parsed = parseApproveArgs(argv);
  } catch (err) {
    return { code: approveUsageError(err.message, APPROVE_FAILED_EXIT) };
  }
  if (parsed.noCommit && parsed.trailers.length > 0) {
    return { code: approveUsageError('--trailer is only valid without --no-commit (there is no commit to carry it)', APPROVE_REFUSED_EXIT) };
  }
  for (const t of parsed.trailers) {
    const err = validateTrailer(t);
    if (err !== null) return { code: approveUsageError(`invalid --trailer: ${err}`, APPROVE_REFUSED_EXIT) };
  }
  if (!isNonEmpty(parsed.feature)) {
    return { code: approveUsageError('a feature name is required', APPROVE_FAILED_EXIT) };
  }
  return parsed;
}

/** Proxy mode: --evidence is mandatory and the named approver must be an architect. */
function resolveProxyApprover(sh, repoRoot, { onBehalfOf, evidence }, runningUser) {
  if (!isNonEmpty(evidence)) {
    process.stderr.write('rad approve: --on-behalf-of requires --evidence (cite where the architect approved)\n');
    return { code: APPROVE_FAILED_EXIT };
  }
  const roleCheck = sh(join(repoRoot, 'scripts', 'check-role.sh'), ['architect', repoRoot, onBehalfOf], { cwd: repoRoot });
  if (roleCheck.status !== 0) {
    process.stderr.write(`rad approve: '${onBehalfOf}' is not a configured architect in .rad/config.yml — cannot record their approval\n`);
    if (isNonEmpty(roleCheck.stderr)) process.stderr.write(roleCheck.stderr);
    return { code: APPROVE_FAILED_EXIT };
  }
  return { approvedBy: onBehalfOf, recordedBy: runningUser, proxy: true };
}

/** Direct mode: the running user must be a configured architect. */
function resolveDirectApprover(sh, repoRoot, runningUser) {
  const roleCheck = sh(join(repoRoot, 'scripts', 'check-role.sh'), ['architect', repoRoot], { cwd: repoRoot });
  if (roleCheck.status !== 0) {
    process.stderr.write('rad approve: permission denied — direct approval requires the architect role\n');
    if (isNonEmpty(roleCheck.stdout)) process.stderr.write(roleCheck.stdout);
    return { code: APPROVE_FAILED_EXIT };
  }
  return { approvedBy: runningUser, recordedBy: runningUser, proxy: false };
}

/**
 * Authority. approvedBy = the HUMAN architect whose judgment this is;
 * recordedBy = whoever physically ran it. Every refusal is exit 1.
 *
 * @returns {{ code: number } | { approvedBy: string, recordedBy: string, proxy: boolean }}
 */
function resolveApprover(sh, repoRoot, req) {
  // `--evidence` is only meaningful alongside `--on-behalf-of` (proxy mode); a
  // direct approval carrying evidence is refused before any identity or role check.
  if (!isNonEmpty(req.onBehalfOf) && isNonEmpty(req.evidence)) {
    process.stderr.write('rad approve: --evidence is only valid with --on-behalf-of\n');
    return { code: APPROVE_FAILED_EXIT };
  }
  const userResult = sh('git', ['config', 'user.email'], { cwd: repoRoot });
  const runningUser = (userResult.stdout || '').trim();
  if (!isNonEmpty(runningUser)) {
    process.stderr.write('rad approve: cannot determine git user.email — set your git identity first\n');
    return { code: APPROVE_FAILED_EXIT };
  }
  return isNonEmpty(req.onBehalfOf)
    ? resolveProxyApprover(sh, repoRoot, req, runningUser)
    : resolveDirectApprover(sh, repoRoot, runningUser);
}

/**
 * The bootstrap DUAL-WRITE: (a) append the `approved` event (recordApproval
 * validates the transition first — an illegal move such as a same-fingerprint
 * duplicate throws and nothing is written), then (b) mirror the plan-doc header.
 *
 * @returns {{ code: number } | { ts: string }}
 */
function recordApprovalAndStatus(store, a) {
  const ts = new Date().toISOString();
  try {
    store.recordApproval({
      feature: a.feature,
      // The event-log actor is the human identity; recordApproval freezes the
      // verified role token into the event's `role` field at write-time.
      actor: a.who.approvedBy,
      recordedBy: a.who.recordedBy,
      ts,
      evidence: a.who.proxy ? a.evidence : undefined,
      fingerprint: a.planHash,
      waivers: a.blockers.waivers,
      highRiskPattern: a.blockers.highRiskPattern,
    });
  } catch (err) {
    process.stderr.write(`rad approve: cannot record approval — ${err.message}\n`);
    return { code: APPROVE_FAILED_EXIT };
  }
  writePlanStatus(a.planFile, { approvedBy: a.who.approvedBy, approvedAt: ts, recordedBy: a.who.recordedBy, evidence: a.evidence, proxy: a.who.proxy });
  return { ts };
}

/** The structured, machine-greppable success line; `suffix` carries the publish fields. */
function printApproveOk(feature, who, ts, suffix = '') {
  const recorded = who.proxy ? ` recorded-by=${who.recordedBy}` : '';
  process.stdout.write(
    `rad approve: ok feature=${feature} status=approved approved-by=${who.approvedBy}${recorded} approved-at=${ts} proxy=${who.proxy}${suffix}\n`,
  );
}

/**
 * Resume view of an approval already recorded for this exact plan body: the
 * commit message's identities come from the frozen event, falling back to this
 * run's values. Re-approval = more than one approved event in the log.
 */
function resumedApproval(history, latest, a) {
  const evidence = latest.data?.evidence ?? a.evidence;
  const who = {
    approvedBy: latest.actor ?? a.who.approvedBy,
    recordedBy: latest.recordedBy ?? a.who.recordedBy,
    proxy: a.who.proxy || isNonEmpty(evidence),
  };
  const approvals = history.filter((e) => e && e.type === 'approved').length;
  return { who, evidence, ts: latest.ts, reapproval: approvals > 1 };
}

/**
 * Record the approval (or resume one already recorded for this plan body).
 * The re-approval subject is decided from the log BEFORE the new event lands.
 */
function recordOrResume(store, a) {
  let history;
  try {
    history = store.history(a.feature);
  } catch (err) {
    process.stderr.write(`rad approve: cannot read the event log — ${err.message}\n`);
    return { code: APPROVE_FAILED_EXIT };
  }
  const latest = latestApprovedEvent(history);
  if (latest?.data?.fingerprint === a.planHash) return { ...resumedApproval(history, latest, a), resumed: true };
  const reapproval = latest !== null;
  const rec = recordApprovalAndStatus(store, a);
  if (rec.code !== undefined) return rec;
  return { who: a.who, evidence: a.evidence, ts: rec.ts, reapproval, resumed: false };
}

/**
 * Default (commit) path: refuse unless publish-ready (nothing written), record
 * or resume, then commit the plan + event log, push (fail closed), and label.
 */
function approveAndPublish(sh, store, a) {
  const refusal = requirePublishReady(sh, a.repoRoot, a.workBranch);
  if (refusal !== null) {
    process.stderr.write(`rad approve: refused — ${refusal}\n`);
    return APPROVE_REFUSED_EXIT;
  }
  const rec = recordOrResume(store, a);
  if (rec.code !== undefined) return rec.code;
  const message = approveCommitMessage(a.planText, {
    feature: a.feature, reapproval: rec.reapproval, approvedBy: rec.who.approvedBy,
    recordedBy: rec.who.recordedBy, evidence: rec.evidence, proxy: rec.who.proxy,
  }, a.trailers);
  const result = publishPlanChange(sh, a.repoRoot, {
    verb: APPROVE_VERB,
    branch: a.workBranch,
    paths: [`.agents/plans/${a.feature}.md`, `.agents/state/${a.feature}/events.jsonl`],
    message,
    issue: planIssueNumber(a.planText),
    labelStatus: APPROVE_LABEL_STATUS,
  });
  if (result.code !== 0) {
    process.stderr.write(`rad approve: ${result.message}\n`);
    return APPROVE_FAILED_EXIT;
  }
  const resumed = rec.resumed ? ' resumed=true' : '';
  printApproveOk(a.feature, rec.who, rec.ts, ` committed=${result.committed} pushed=${result.pushed}${resumed}`);
  return 0;
}

/**
 * `approve <feature> [--on-behalf-of <name>] [--evidence <text>] [--no-commit] [--trailer "Key: Value"]...`.
 *
 * Enforces architect authority with parity to the prose rules and, on success,
 * performs the bootstrap DUAL-WRITE: (a) appends the `approved` event via
 * recordApproval(...) AND (b) writes the plan-doc Status header. No model call,
 * no PR.
 *
 * By default it then publishes: commits ONLY the plan doc and the event log on
 * the work branch, pushes (failure is exit 1, resumable by rerun), and labels
 * the issue `approved`. A rerun whose latest approved event already covers this
 * plan body (same fingerprint) skips recording and resumes the publish.
 * `--no-commit` keeps the record-only flow (and its best-effort RAD_SYNC push).
 *
 * Authority:
 *   - Direct mode (no --on-behalf-of): the running git user MUST be a configured
 *     architect (check-role.sh architect). approvedBy/recordedBy = running user.
 *   - Proxy mode (--on-behalf-of <name> + required --evidence <text>): <name>
 *     MUST validate as a configured architect (check-role.sh architect <repoRoot>
 *     <name>); the running user need NOT be an architect. approvedBy = <name>,
 *     recordedBy = running user.
 *
 * Attribution: the event-log `actor` is the human identity (approvedBy);
 * recordApproval freezes the verified role token into the event's `role` field,
 * which gates.yaml's requiredRole rule matches. The role trust boundary itself
 * lives in check-role.sh, consulted before recording.
 *
 * Exit codes: 0 ok; 1 authority/blocker/record refusal or a failed publish step
 * (rerun resumes); 2 publish refusal or trailer usage error (nothing written).
 *
 * @param {string[]} argv - args after `approve`
 * @param {{ repoRoot: string, sh?: typeof defaultSh }} ctx
 * @returns {Promise<number>}
 */
export async function approveCommand(argv, ctx) {
  const { repoRoot } = ctx;
  const sh = ctx.sh ?? defaultSh;
  const req = parseApproveRequest(argv);
  if (req.code !== undefined) return req.code;
  const { feature, evidence } = req;
  const planFile = join(repoRoot, '.agents', 'plans', `${feature}.md`);
  if (!existsSync(planFile)) {
    process.stderr.write(`rad approve: no plan doc at .agents/plans/${feature}.md\n`);
    return APPROVE_FAILED_EXIT;
  }
  const store = createGitStateStore({ repoRoot, sh });
  const planText = readFileSync(planFile, 'utf8');
  // The plan doc's `Branch:` header is canonical; else the RAD_BRANCH_PREFIX convention.
  const workBranch = planWorkBranch(parsePlanCtx(planText).branch, feature);
  // Fingerprint of the approved plan body (mutable header excluded by construction);
  // attested into the approved event so a later edit can fail the gate closed.
  const planHash = planFingerprint(planText).hash;
  const who = resolveApprover(sh, repoRoot, req);
  if (who.code !== undefined) return who.code;
  // Blocker check runs in BOTH modes, after authority and before any write.
  // Only exit 0 from the script permits recording (fail-closed).
  const blockers = checkApprovalBlockers(sh, repoRoot, planFile);
  if (!blockers.ok) {
    process.stderr.write(blockers.message);
    return APPROVE_FAILED_EXIT;
  }
  const a = { repoRoot, feature, evidence, planFile, planText, planHash, workBranch, who, blockers, trailers: req.trailers };
  if (!req.noCommit) return approveAndPublish(sh, store, a);
  const rec = recordApprovalAndStatus(store, a);
  if (rec.code !== undefined) return rec.code;
  // Record-only: best-effort RAD_SYNC publish, never fails the verb (offline-fail-safe).
  bestEffortSyncPush(repoRoot, workBranch, sh);
  printApproveOk(feature, who, rec.ts);
  return 0;
}

/**
 * `plan-fingerprint <planFile>`.
 *
 * Read-only: prints the SHA-256 fingerprint of a plan doc's body (the mutable
 * header is excluded by construction in planFingerprint) to stdout and exits 0.
 * The gate-read boundary (scripts/check-plan-approved.sh) shells out to this so
 * the hash has a SINGLE source of truth (harness/plan-fingerprint.js) — the bash
 * boundary never reimplements the digest. No model call, no PR, no push.
 *
 * @param {string[]} argv - args after `plan-fingerprint`
 * @param {{ repoRoot: string }} ctx
 * @returns {Promise<number>}
 */
export async function planFingerprintCommand(argv, ctx) {
  const [planFile, ...rest] = argv;
  if (!isNonEmpty(planFile) || rest.length > 0) {
    process.stderr.write('rad plan-fingerprint: exactly one <planFile> is required\n');
    process.stderr.write('Usage: rad plan-fingerprint <planFile>\n');
    return 1;
  }
  let planText;
  try {
    planText = readFileSync(planFile, 'utf8');
  } catch (err) {
    process.stderr.write(`rad plan-fingerprint: cannot read '${planFile}' — ${err.message}\n`);
    return 1;
  }
  process.stdout.write(`${planFingerprint(planText).hash}\n`);
  return 0;
}

/**
 * `architecture-approve <slug> [--on-behalf-of <name>] [--evidence <text>]`.
 *
 * Records the frozen `architecture-approved` audit event (to the reserved
 * `_architecture` project log) attesting that /rad-design's agent architecture
 * was signed off by an architect. The store role-checks the architect identity
 * (onBehalfOf) at write-time and freezes the role token into the event.
 *
 * Proxy handling mirrors `approve`:
 *   - Direct mode (no --on-behalf-of): the running git user is the architect
 *     whose authority is frozen; the store role-checks them. recordedBy = runner.
 *   - Proxy mode (--on-behalf-of <name> + required --evidence): <name> is the
 *     architect (role-checked by the store); recordedBy = the running user.
 *
 * Pure git/state work: no model call, no PR, no push.
 *
 * @param {string[]} argv - args after `architecture-approve`
 * @param {{ repoRoot: string, sh?: typeof defaultSh }} ctx
 * @returns {Promise<number>}
 */
export async function architectureApproveCommand(argv, ctx) {
  const { repoRoot } = ctx;
  const sh = ctx.sh ?? defaultSh;

  let parsed;
  try {
    // Reuse the approve parser: same positional + --on-behalf-of/--evidence shape.
    parsed = parseApproveArgs(argv);
  } catch (err) {
    process.stderr.write(`rad architecture-approve: ${err.message}\n`);
    process.stderr.write('Usage: rad architecture-approve <slug> [--on-behalf-of <name>] [--evidence <text>]\n');
    return 1;
  }

  const { feature: slug, onBehalfOf, evidence } = parsed;

  if (!isNonEmpty(slug)) {
    process.stderr.write('rad architecture-approve: a slug is required\n');
    process.stderr.write('Usage: rad architecture-approve <slug> [--on-behalf-of <name>] [--evidence <text>]\n');
    return 1;
  }

  // `--evidence` is only meaningful in proxy mode, mirroring approve.
  if (!isNonEmpty(onBehalfOf) && isNonEmpty(evidence)) {
    process.stderr.write('rad architecture-approve: --evidence is only valid with --on-behalf-of\n');
    return 1;
  }

  const store = createGitStateStore({ repoRoot, sh });

  // Resolve the running git user (the recorder).
  const userResult = sh('git', ['config', 'user.email'], { cwd: repoRoot });
  const runningUser = (userResult.stdout || '').trim();
  if (!isNonEmpty(runningUser)) {
    process.stderr.write('rad architecture-approve: cannot determine git user.email — set your git identity first\n');
    return 1;
  }

  // architect identity (role-checked by the store) and recorder provenance.
  let architect;
  let recordedBy;
  let proxy = false;
  if (isNonEmpty(onBehalfOf)) {
    proxy = true;
    if (!isNonEmpty(evidence)) {
      process.stderr.write('rad architecture-approve: --on-behalf-of requires --evidence (cite where the architect approved)\n');
      return 1;
    }
    architect = onBehalfOf;
    recordedBy = runningUser;
  } else {
    architect = runningUser;
    recordedBy = runningUser;
  }

  const ts = new Date().toISOString();

  try {
    store.recordArchitectureApproved({
      slug,
      onBehalfOf: architect,
      recordedBy,
      evidence: proxy ? evidence : undefined,
      ts,
    });
  } catch (err) {
    process.stderr.write(`rad architecture-approve: cannot record architecture approval — ${err.message}\n`);
    return 1;
  }

  if (proxy) {
    process.stdout.write(
      `rad architecture-approve: ok slug=${slug} approved-by=${architect} recorded-by=${recordedBy} approved-at=${ts} proxy=true\n`,
    );
  } else {
    process.stdout.write(
      `rad architecture-approve: ok slug=${slug} approved-by=${architect} approved-at=${ts} proxy=false\n`,
    );
  }
  return 0;
}

/**
 * Hand-rolled argv parser for `status`. Returns the optional `--phase <value>`
 * filter. Throws on unknown flags or a flag missing its value.
 *
 * @param {string[]} argv
 * @returns {{ phase?: string }}
 */
function parseStatusArgs(argv) {
  let phase;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--phase') {
      const val = argv[i + 1];
      if (val === undefined) throw new Error('--phase requires a value');
      phase = val;
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option '${arg}'`);
    } else {
      throw new Error(`unexpected argument '${arg}'`);
    }
  }

  return { phase };
}

/**
 * `status [--phase <phase>]`.
 *
 * Read-only: lists all known rad/ features and their current phase. No git
 * writes, no events appended, no plan-doc mutations.
 *
 * @param {string[]} argv - args after `status`
 * @param {{ repoRoot: string, sh?: typeof defaultSh }} ctx
 * @returns {Promise<number>}
 */
export async function statusCommand(argv, ctx) {
  const { repoRoot } = ctx;
  const sh = ctx.sh ?? defaultSh;

  let parsed;
  try {
    parsed = parseStatusArgs(argv);
  } catch (err) {
    process.stderr.write(`rad status: ${err.message}\n`);
    process.stderr.write('Usage: rad status [--phase <phase>]\n');
    return 1;
  }

  const { phase } = parsed;
  const state = createGitStateStore({ repoRoot, sh });

  const features = state.list(phase ? { phase } : {});

  if (features.length === 0) {
    process.stdout.write('rad status: no features found\n');
    return 0;
  }

  // Compute column widths. Feature column grows with longest name; Status and
  // Branch are fixed-width enough to hold any phase name and rad/<feature>.
  const featureWidth = Math.max('Feature'.length, ...features.map((f) => f.feature.length));
  const statusWidth = 16;

  const header = `${'Feature'.padEnd(featureWidth)}  ${'Status'.padEnd(statusWidth)}  Branch`;
  const divider = `${'-'.repeat(featureWidth)}  ${'-'.repeat(statusWidth)}  ------`;
  const rows = features.map(
    (f) =>
      `${f.feature.padEnd(featureWidth)}  ${(f.phase ?? '').padEnd(statusWidth)}  rad/${f.feature}`,
  );

  process.stdout.write([header, divider, ...rows, ''].join('\n'));
  return 0;
}

/**
 * Hand-rolled argv parser for `gate`. Returns the two positionals (feature,
 * name) and the optional `--stdin` flag. Throws on unknown flags or extra
 * positionals so malformed invocations fail loudly rather than mis-parse.
 *
 * @param {string[]} argv
 * @returns {{ feature?: string, name?: string, stdin: boolean }}
 */
function parseGateArgs(argv) {
  let feature;
  let name;
  let stdin = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--stdin') {
      stdin = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option '${arg}'`);
    } else if (feature === undefined) {
      feature = arg;
    } else if (name === undefined) {
      name = arg;
    } else {
      throw new Error(`unexpected argument '${arg}'`);
    }
  }

  return { feature, name, stdin };
}

/**
 * Read all of stdin synchronously and parse it as JSONL into an event history.
 * Mirrors the store's crash-tolerant readEvents: blank lines skipped, an
 * unparseable line dropped (never fatal) — so a partially-corrupt branch-tip log
 * still evaluates over the events it CAN parse. Untrusted input: nothing here
 * executes or trusts the parsed objects beyond what evaluateGate's pure fold
 * reads (event type + frozen role); no eval, no prototype merge.
 *
 * @returns {import('./events.js').Event[]}
 */
function readEventsFromStdin() {
  return parseEventsJsonl(readFileSync(0, 'utf8')); // fd 0 = stdin
}

/**
 * Parse JSONL text into an event history (crash-tolerant, as described on
 * readEventsFromStdin). Shared by `rad gate --stdin` and deliver's branch-tip
 * gate read so both evaluate the identical history.
 *
 * @param {string} raw
 * @returns {import('./events.js').Event[]}
 */
function parseEventsJsonl(raw) {
  const events = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
  return events;
}

/**
 * `gate <feature> <name> [--stdin]`.
 *
 * Read-only: evaluates the named gate (the existing pure fold) over the
 * feature's event log and exits 0 when `passed` is true, non-zero otherwise.
 * Writes nothing — no events appended, no plan-doc mutation, no git writes.
 *
 *   - default: reads the local on-disk log via state.gate(feature, name).
 *   - --stdin: reads a JSONL event log from stdin (e.g. a branch-tip log piped
 *     in before checkout) and evaluates it via the same exported gate fold
 *     (evaluateGate), so the predicate is identical to the on-disk path.
 *
 * Fails CLOSED: a missing/empty log yields an empty history → the fold reports
 * `passed: false` → non-zero exit. Absence never passes the gate.
 *
 * @param {string[]} argv - args after `gate`
 * @param {{ repoRoot: string, sh?: typeof defaultSh }} ctx
 * @returns {Promise<number>}
 */
export async function gateCommand(argv, ctx) {
  const { repoRoot } = ctx;
  const sh = ctx.sh ?? defaultSh;

  let parsed;
  try {
    parsed = parseGateArgs(argv);
  } catch (err) {
    process.stderr.write(`rad gate: ${err.message}\n`);
    process.stderr.write('Usage: rad gate <feature> <name> [--stdin]\n');
    return 1;
  }

  const { feature, name, stdin } = parsed;

  if (!isNonEmpty(feature) || !isNonEmpty(name)) {
    process.stderr.write('rad gate: a feature name and a gate name are required\n');
    process.stderr.write('Usage: rad gate <feature> <name> [--stdin]\n');
    return 1;
  }

  let result;
  try {
    if (stdin) {
      // Feed the piped JSONL through the SAME pure fold the on-disk path uses.
      result = evaluateGate(name, readEventsFromStdin());
    } else {
      const state = createGitStateStore({ repoRoot, sh });
      result = await state.gate(feature, name);
    }
  } catch (err) {
    // Unknown gate name, missing rules, or stdin read failure — fail closed.
    process.stderr.write(`rad gate: ${err.message}\n`);
    return 1;
  }

  // Structured success/result line (machine-greppable single line).
  const satisfiedBy = result.satisfiedBy
    ? `${result.satisfiedBy.role}:${result.satisfiedBy.actor}`
    : 'none';
  process.stdout.write(
    `rad gate: feature=${feature} gate=${name} passed=${result.passed} ` +
    `required-role=${result.requiredRole} satisfied-by=${satisfiedBy} ` +
    `source=${stdin ? 'stdin' : 'log'}\n`,
  );

  return result.passed ? 0 : 1;
}

/**
 * Hand-rolled argv parser for `stop-status`: one positional feature and the
 * optional `--stdin` flag. Throws on unknown flags or extra positionals.
 *
 * @param {string[]} argv
 * @returns {{ feature?: string, stdin: boolean }}
 */
function parseStopStatusArgs(argv) {
  let feature;
  let stdin = false;
  for (const arg of argv) {
    if (arg === '--stdin') {
      stdin = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option '${arg}'`);
    } else if (feature === undefined) {
      feature = arg;
    } else {
      throw new Error(`unexpected argument '${arg}'`);
    }
  }
  return { feature, stdin };
}

/**
 * STRICT JSONL parse for `stop-status --stdin`: unlike the crash-tolerant
 * parseEventsJsonl, a line that is not a JSON object throws. A dropped line
 * could hide the deliver-started that makes a stop no longer dormant, so a
 * malformed log is an error (exit 1), never a silent `dormant`.
 *
 * @param {string} raw
 * @returns {Object[]}
 */
function parseEventsJsonlStrict(raw) {
  const events = [];
  raw.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`malformed event log: line ${index + 1} is not valid JSON (${err.message})`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`malformed event log: line ${index + 1} is not a JSON object`);
    }
    events.push(parsed);
  });
  return events;
}

/** The single stdout line for a stop-status result. */
function formatStopStatus(stop) {
  if (!stop) return 'none';
  const wave = stop.wave ?? 'unknown';
  return `dormant class=${stop.class} reason=${stop.reason} wave=${wave} decision="${stop.decision}"`;
}

/**
 * `stop-status <feature> [--stdin]`.
 *
 * Read-only: folds the feature's event log (or a piped JSONL log with --stdin)
 * through dormantStop and prints exactly one line — `dormant class=... reason=...
 * wave=... decision="..."` or `none` — exit 0. A malformed log or read error →
 * stderr, exit 1. Bad argv → usage on stderr, exit 2. Writes nothing.
 *
 * @param {string[]} argv - args after `stop-status`
 * @param {{ repoRoot: string, sh?: typeof defaultSh }} ctx
 * @returns {Promise<number>}
 */
export async function stopStatusCommand(argv, ctx) {
  const { repoRoot } = ctx;
  const sh = ctx.sh ?? defaultSh;
  let parsed;
  try {
    parsed = parseStopStatusArgs(argv);
  } catch (err) {
    process.stderr.write(`rad stop-status: ${err.message}\nUsage: ${STOP_STATUS_USAGE}\n`);
    return USAGE_EXIT_CODE;
  }
  const { feature, stdin } = parsed;
  if (!isNonEmpty(feature)) {
    process.stderr.write(`rad stop-status: a feature name is required\nUsage: ${STOP_STATUS_USAGE}\n`);
    return USAGE_EXIT_CODE;
  }
  let stop;
  try {
    const history = stdin
      ? parseEventsJsonlStrict(readFileSync(0, 'utf8')) // fd 0 = stdin
      : createGitStateStore({ repoRoot, sh }).history(feature);
    stop = dormantStop(history);
  } catch (err) {
    process.stderr.write(`rad stop-status: ${sanitizeErrorMessage(err?.message ?? String(err))}\n`);
    return 1;
  }
  process.stdout.write(`${formatStopStatus(stop)}\n`);
  return 0;
}

/** Suggested remedy per deficit proxy (#93) — advisory wording, never a verdict. */
const FORECAST_REMEDIES = Object.freeze({
  opaqueAbstraction: 'a boundary/decomposition note',
  missingDocumentation: 'a comment explaining the governing constraint',
  insufficientTesting: 'a characterization test for the uncovered behavior',
});
/** Plan-path set source of truth: plan_scope_paths in scripts/lib/plan-paths.sh. */
const PLAN_SCOPE_PATHS_SCRIPT = '. scripts/lib/plan-paths.sh && plan_scope_paths "$1"';
/** Repo-relative dirs `rad forecast` folds across (read-only). */
const PLANS_DIR = join('.agents', 'plans');
const STATE_DIR = join('.agents', 'state');
const EVENTS_FILE = 'events.jsonl';

/** Exactly one positional `<plan>`; throws on unknown flags or extras. */
function parseForecastArgs(argv) {
  let plan;
  for (const arg of argv) {
    if (arg.startsWith('--')) throw new Error(`unknown option '${arg}'`);
    if (plan !== undefined) throw new Error(`unexpected argument '${arg}'`);
    plan = arg;
  }
  if (!isNonEmpty(plan)) throw new Error('a plan path is required');
  return plan;
}

/** The plan's declared path set, via plan_scope_paths (never re-parsed in JS). */
function forecastScopePaths(sh, repoRoot, planPath) {
  const res = sh('bash', ['-c', PLAN_SCOPE_PATHS_SCRIPT, '_', planPath], { cwd: repoRoot });
  if (res.status !== 0) {
    throw new Error(`plan_scope_paths failed: ${(res.stderr || `exit ${res.status}`).trim()}`);
  }
  return res.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
}

/** Sorted entry names of a dir, or [] when it does not exist. */
function sortedEntries(dir, opts = {}) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => (opts.dirs ? e.isDirectory() : e.isFile()))
    .map((e) => e.name)
    .sort();
}

/** task title -> declared File: paths, merged across every plan under .agents/plans. */
function forecastTaskFiles(repoRoot) {
  const dir = join(repoRoot, PLANS_DIR);
  const acc = {};
  for (const name of sortedEntries(dir).filter((n) => n.endsWith('.md'))) {
    mergeTaskFiles(acc, taskFilesFromPlanText(readFileSync(join(dir, name), 'utf8')));
  }
  return acc;
}

/**
 * Every feature's event log, concatenated; an event omitting `feature` is
 * stamped from its dir name. A malformed line throws naming the feature.
 */
function forecastHistory(repoRoot) {
  const dir = join(repoRoot, STATE_DIR);
  const history = [];
  let features = 0;
  for (const feature of sortedEntries(dir, { dirs: true })) {
    const log = join(dir, feature, EVENTS_FILE);
    if (!existsSync(log)) continue;
    let events;
    try {
      events = parseEventsJsonlStrict(readFileSync(log, 'utf8'));
    } catch (err) {
      throw new Error(`malformed event log for ${feature}: ${err.message}`);
    }
    features += 1;
    for (const e of events) history.push(isNonEmpty(e.feature) ? e : { ...e, feature });
  }
  return { history, features };
}

/** One advisory line per present deficit of each forecast row. */
function formatForecastRows(rows) {
  const lines = [];
  for (const { path, deficits } of rows) {
    for (const deficit of DEFICITS) {
      const entry = deficits[deficit];
      if (!entry) continue;
      lines.push(`forecast: ${path} — ${deficit} in ${entry.features.length} feature(s) `
        + `(${entry.features.join(', ')}); consider ${FORECAST_REMEDIES[deficit]}`);
    }
  }
  return lines;
}

/** The closing summary line. */
function forecastSummary(rowCount, pathCount, featureCount) {
  const history = `(history: ${featureCount} feature(s))`;
  if (rowCount === 0) return `forecast: no reliability signals for ${pathCount} path(s) ${history}`;
  return `forecast: ${rowCount} of ${pathCount} path(s) have reliability signals ${history}; `
    + 'advisory only — these are proxies, not verdicts';
}

/**
 * `forecast <plan>` — advisory, read-only plan-time readout: the #93 deficit
 * proxies recorded across every feature's event log, filtered to the paths the
 * plan declares. Bad argv / unreadable plan / plan_scope_paths failure → exit 2;
 * malformed event log → exit 1. Writes nothing.
 *
 * @param {string[]} argv - args after `forecast`
 * @param {{ repoRoot: string, sh?: typeof defaultSh }} ctx
 * @returns {Promise<number>}
 */
export async function forecastCommand(argv, ctx) {
  const { repoRoot } = ctx;
  const sh = ctx.sh ?? defaultSh;
  let plan;
  try {
    plan = parseForecastArgs(argv);
  } catch (err) {
    process.stderr.write(`rad forecast: ${err.message}\nUsage: ${FORECAST_USAGE}\n`);
    return USAGE_EXIT_CODE;
  }
  const planPath = resolve(repoRoot, plan);
  let paths;
  try {
    readFileSync(planPath, 'utf8');
  } catch (err) {
    process.stderr.write(`rad forecast: cannot read plan ${plan}: ${err.message}\n`);
    return USAGE_EXIT_CODE;
  }
  try {
    paths = forecastScopePaths(sh, repoRoot, planPath);
  } catch (err) {
    process.stderr.write(`rad forecast: ${err.message}\n`);
    return USAGE_EXIT_CODE;
  }
  return printForecast(repoRoot, paths);
}

/** Fold history + taskFiles, print rows and summary; exit 1 on a malformed log. */
function printForecast(repoRoot, paths) {
  let folded;
  try {
    folded = forecastHistory(repoRoot);
  } catch (err) {
    process.stderr.write(`rad forecast: ${err.message}\n`);
    return FAILED_EXIT_CODE;
  }
  const signals = fileDeficitSignals(folded.history, forecastTaskFiles(repoRoot));
  const rows = forecastForPaths(signals, paths);
  const lines = [...formatForecastRows(rows), forecastSummary(rows.length, paths.length, folded.features)];
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/** Feature grammar `rad digest` accepts (mirrors digest.js / the rad/<feature> branch grammar). */
const DIGEST_FEATURE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** Base used when get-default-branch.sh prints nothing. */
const DIGEST_FALLBACK_BASE = 'main';
/** Flags `rad digest` accepts; each takes exactly one value. */
const DIGEST_VALUE_FLAGS = Object.freeze({ '--branch': 'branch', '--base': 'base' });

/** One positional `<feature>` + optional `--branch <ref>` / `--base <ref>`; throws on anything else. */
function parseDigestArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = DIGEST_VALUE_FLAGS[arg];
      if (!key) throw new Error(`unknown option '${arg}'`);
      const value = argv[i + 1];
      if (!isNonEmpty(value) || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      out[key] = value;
      i += 1;
    } else if (out.feature === undefined) {
      out.feature = arg;
    } else {
      throw new Error(`unexpected argument '${arg}'`);
    }
  }
  if (!isNonEmpty(out.feature)) throw new Error('a feature name is required');
  if (!DIGEST_FEATURE_PATTERN.test(out.feature)) throw new Error(`invalid feature name '${out.feature}'`);
  return out;
}

/**
 * Strictly parse the feature's event log when present. A missing log is left to
 * digest.js (reported unavailable); a malformed one throws naming the feature.
 */
function assertDigestLogWellFormed(repoRoot, feature) {
  const log = join(repoRoot, STATE_DIR, feature, EVENTS_FILE);
  if (!existsSync(log)) return;
  try {
    parseEventsJsonlStrict(readFileSync(log, 'utf8'));
  } catch (err) {
    throw new Error(`malformed event log for ${feature}: ${err.message}`);
  }
}

/**
 * `digest <feature> [--branch <ref>] [--base <ref>]` — thin, read-only wrapper
 * over harness/digest.js: prints the ranked review digest as markdown. Branch
 * defaults to the plan's `Branch:` header (else `rad/<feature>`); base to
 * get-default-branch.sh output (else `main`). Bad argv / unreadable plan →
 * exit 2; malformed event log or base-resolution failure → exit 1. Writes nothing.
 *
 * @param {string[]} argv - args after `digest`
 * @param {{ repoRoot: string, sh?: typeof defaultSh }} ctx
 * @returns {Promise<number>}
 */
export async function digestCommand(argv, ctx) {
  const { repoRoot } = ctx;
  const sh = ctx.sh ?? defaultSh;
  let args;
  try {
    args = parseDigestArgs(argv);
  } catch (err) {
    process.stderr.write(`rad digest: ${err.message}\nUsage: ${DIGEST_USAGE}\n`);
    return USAGE_EXIT_CODE;
  }
  const { feature } = args;
  const planRel = join(PLANS_DIR, `${feature}.md`);
  let planText;
  try {
    planText = readFileSync(join(repoRoot, planRel), 'utf8');
  } catch (err) {
    process.stderr.write(`rad digest: cannot read plan ${planRel}: ${err.message}\n`);
    return USAGE_EXIT_CODE;
  }
  let branch;
  let base;
  try {
    assertDigestLogWellFormed(repoRoot, feature);
    branch = args.branch ?? resolveWorkBranch({}, parsePlanCtx(planText), feature);
    base = args.base ?? (readDefaultBranch({ sh, repoRoot, root: repoRoot, verb: 'rad digest' }) || DIGEST_FALLBACK_BASE);
  } catch (err) {
    process.stderr.write(`rad digest: ${err.message.replace(/^rad digest: /, '')}\n`);
    return FAILED_EXIT_CODE;
  }
  const inputs = await gatherDigestInputs({ repoRoot, sh, feature, branch, base });
  process.stdout.write(renderDigest(buildDigest(inputs)));
  return 0;
}

/** `git log` format for the PR body's commit list: one `<hash> <subject>` line per commit. */
const PR_BODY_LOG_FORMAT = '--format=%h %s';
/** Remote whose default-branch tip bounds the PR body's commit range. */
const PR_BODY_REMOTE = 'origin';
/** mkdtemp prefix for the branch-tip plan copy `rad pr-body` hands check-scope.sh. */
const PR_BODY_TMP_PREFIX = 'rad-pr-body-';

/** Run one PR-body source; a throw becomes `{ unavailable: reason }` so that section shows why. */
function prBodySource(fn) {
  try {
    return fn();
  } catch (err) {
    return { unavailable: err?.message ?? String(err) };
  }
}

/** `<hash> <subject>` → { hash, subject } (a subject-less line keeps an empty subject). */
function parsePrLogLine(line) {
  const at = line.indexOf(' ');
  return at === -1 ? { hash: line, subject: '' } : { hash: line.slice(0, at), subject: line.slice(at + 1) };
}

/** Commits on `ref` not on origin/<base>, oldest first. No base → throws (rendered unavailable). */
function readPrCommits({ sh, cwd, ref, base }) {
  if (!isNonEmpty(base)) throw new Error('no base branch resolved');
  const out = mainGit(sh, cwd, ['log', '--reverse', PR_BODY_LOG_FORMAT, `${PR_BODY_REMOTE}/${base}..${ref}`]);
  return out.split('\n').filter((line) => line.trim() !== '').map(parsePrLogLine);
}

/** Each `## Tests to Write` path with whether it exists at `ref`; unresolvable items pass through. */
function readPrTests({ sh, cwd, ref, planText }) {
  return testsToWritePaths(planText).map((item) => {
    if (!('path' in item)) return item;
    const res = sh('git', ['cat-file', '-e', `${ref}:${item.path}`], { cwd });
    return { path: item.path, present: res.status === 0 };
  });
}

/**
 * The PR-body inputs read at a git ref — 'HEAD' in a deliver run, the work
 * branch in `rad pr-body`. `plan` is the plan text or `{ unavailable }`;
 * `resolveBase` may throw (the commit list then renders unavailable).
 */
function gatherPrBodyRefInputs({ sh, cwd, ref, resolveBase, plan }) {
  const tests = typeof plan === 'string'
    ? prBodySource(() => readPrTests({ sh, cwd, ref, planText: plan }))
    : { unavailable: `plan unreadable (${plan.unavailable})` };
  return { commits: prBodySource(() => readPrCommits({ sh, cwd, ref, base: resolveBase() })), tests };
}

/**
 * check-scope.sh over the branch-tip plan: the text is written to a fresh temp
 * dir (always removed) since the plan may differ from the working tree's.
 */
function branchTipScope({ sh, repoRoot, feature, planText, branch, base }) {
  const dir = mkdtempSync(join(tmpdir(), PR_BODY_TMP_PREFIX));
  try {
    const planFile = join(dir, `${feature}.md`);
    writeFileSync(planFile, planText, 'utf8');
    const { passed, violations } = readScope(sh, repoRoot, planFile, branch, base);
    if (passed) return { passed: true };
    return { passed: false, violations: violations.map((v) => `${v.path} — ${v.detail}`) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The branch-tip event log, strictly parsed: malformed → throws (exit 1);
 * missing → reported on stderr and rendered as an empty history.
 */
function readPrBodyHistory({ feature, branch, repoRoot, sh }) {
  let tip;
  try {
    tip = readBranchTipHistory({ feature, branch, repoRoot, sh, parse: parseEventsJsonlStrict });
  } catch (err) {
    throw new Error(`malformed event log for ${feature}: ${err.message.replace(/^malformed event log: /, '')}`);
  }
  if (tip.ok) return tip.history;
  process.stderr.write(`rad pr-body: ${tip.reason}; waves render empty\n`);
  return [];
}

/**
 * `pr-body <feature> [--branch <ref>] [--base <ref>]` — read-only: prints the
 * deliver PR title and body as `rad deliver` would build them, sourced from the
 * work-branch tip. Branch defaults to `rad/<feature>`; base to
 * get-default-branch.sh output (else `main`). Bad argv or no plan at the tip →
 * exit 2; malformed event log or base-resolution failure → exit 1. No fetch;
 * the only write is a temp plan copy for check-scope.sh, always removed.
 *
 * @param {string[]} argv - args after `pr-body`
 * @param {{ repoRoot: string, sh?: typeof defaultSh }} ctx
 * @returns {Promise<number>}
 */
export async function prBodyCommand(argv, ctx) {
  const { repoRoot } = ctx;
  const sh = ctx.sh ?? defaultSh;
  let args;
  try {
    args = parseDigestArgs(argv);
  } catch (err) {
    process.stderr.write(`rad pr-body: ${err.message}\nUsage: ${PR_BODY_USAGE}\n`);
    return USAGE_EXIT_CODE;
  }
  const { feature } = args;
  const branch = args.branch ?? conventionWorkBranch(feature);
  const planPath = planRelPath(feature);
  const shown = sh('git', ['show', `${branch}:${planPath}`], { cwd: repoRoot });
  if (shown.status !== 0) {
    process.stderr.write(`rad pr-body: no plan at ${branch}:${planPath}\nUsage: ${PR_BODY_USAGE}\n`);
    return USAGE_EXIT_CODE;
  }
  const planText = String(shown.stdout ?? '');
  let history;
  let base;
  try {
    history = readPrBodyHistory({ feature, branch, repoRoot, sh });
    base = args.base ?? (readDefaultBranch({ sh, repoRoot, root: repoRoot, verb: 'rad pr-body' }) || DIGEST_FALLBACK_BASE);
  } catch (err) {
    process.stderr.write(`rad pr-body: ${err.message.replace(/^rad pr-body: /, '')}\n`);
    return FAILED_EXIT_CODE;
  }
  const { title, body } = buildPrBody({
    feature,
    planPath,
    planText,
    history,
    ...gatherPrBodyRefInputs({ sh, cwd: repoRoot, ref: branch, resolveBase: () => base, plan: planText }),
    scope: prBodySource(() => branchTipScope({ sh, repoRoot, feature, planText, branch, base })),
  });
  process.stdout.write(`${title}\n\n${body}`);
  return 0;
}

/** Reviewer name grammar: it becomes a path segment under .claude/agents/. */
const REVIEWER_PATTERN = /^[a-z0-9-]+$/;
/** Base ref grammar (no leading '-': it is interpolated into a git diff instruction). */
const REVIEW_BASE_PATTERN = /^[A-Za-z0-9._/-]+$/;
/** Review-lane command env vars, in precedence order. */
const REVIEW_AGENT_ENV_VARS = Object.freeze(['RAD_REVIEW_AGENT_CMD', 'RAD_AGENT_CMD']);
/** Env var overriding the review wall-clock ceiling, in whole seconds. */
const REVIEW_TIMEOUT_ENV = 'RAD_REVIEW_TIMEOUT_SECONDS';
const REVIEW_DEFAULT_TIMEOUT_SECONDS = 600;
const REVIEW_FALLBACK_BASE = 'main';

function isSafeReviewBase(ref) {
  return REVIEW_BASE_PATTERN.test(ref) && !ref.startsWith('-');
}

/** One positional `<reviewer>` + optional `--base <ref>`; throws on anything else. */
function parseReviewArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base') {
      const value = argv[i + 1];
      if (!isNonEmpty(value) || !isSafeReviewBase(value)) throw new Error('--base requires a valid ref');
      out.base = value;
      i += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option '${arg}'`);
    } else if (out.reviewer === undefined) {
      out.reviewer = arg;
    } else {
      throw new Error(`unexpected argument '${arg}'`);
    }
  }
  if (!isNonEmpty(out.reviewer)) throw new Error('a reviewer name is required');
  if (!REVIEWER_PATTERN.test(out.reviewer)) throw new Error(`invalid reviewer name '${out.reviewer}'`);
  return out;
}

/** The summary-line source name when the review command comes from the config. */
const REVIEW_CONFIG_SOURCE = 'agent.command';
/** The only config adapter whose command the review lane can spawn. */
const REVIEW_CONFIG_ADAPTER = 'command';
const NO_REVIEW_AGENT_MESSAGE = 'rad review: no review agent configured'
  + ` — set RAD_REVIEW_AGENT_CMD, RAD_AGENT_CMD, or agent: in ${CONFIG_PATH}\n`;

/**
 * First non-empty review-lane command var → { cmd, source }; else the config's
 * agent.command when agent.adapter is 'command'; else null. `config` is the
 * loaded doc or null (missing or invalid config).
 */
function resolveReviewAgent(env, config) {
  const source = REVIEW_AGENT_ENV_VARS.find((name) => isNonEmpty(env[name]?.trim()));
  if (source) return { cmd: env[source], source };
  const agent = config?.agent;
  if (agent?.adapter === REVIEW_CONFIG_ADAPTER && isNonEmpty(agent.command)) {
    return { cmd: agent.command, source: REVIEW_CONFIG_SOURCE };
  }
  return null;
}

/**
 * The review agent, or { code } after writing the reason. An invalid config is
 * consulted as absent, so an environment command works as before; with nothing
 * resolved, the invalid config (not "nothing configured") is the reported reason.
 */
function reviewAgentOrRefuse(env, configLoad) {
  const agent = resolveReviewAgent(env, configLoad.ok ? configLoad.doc : null);
  if (agent) return { agent };
  if (!configLoad.ok && !configLoad.missing) {
    process.stderr.write(`rad review: ${CONFIG_PATH} is invalid: ${configLoad.errors.join('; ')}\n`);
  } else {
    process.stderr.write(NO_REVIEW_AGENT_MESSAGE);
  }
  return { code: USAGE_EXIT_CODE };
}

/** RAD_REVIEW_TIMEOUT_SECONDS → ms (default 600s); throws on a malformed value. */
function reviewTimeoutMs(env) {
  const raw = env[REVIEW_TIMEOUT_ENV];
  if (raw === undefined || raw === '') return REVIEW_DEFAULT_TIMEOUT_SECONDS * 1000;
  if (!POSITIVE_INTEGER_PATTERN.test(raw)) {
    throw new Error(`${REVIEW_TIMEOUT_ENV} must be a positive integer (got '${raw}')`);
  }
  return Number(raw) * 1000;
}

/** --base, else the default-branch script, else 'main'; throws on an unusable default. */
function resolveReviewBase(args, { sh, repoRoot }) {
  if (args.base !== undefined) return args.base;
  const base = readDefaultBranch({ sh, repoRoot, root: repoRoot, verb: 'rad review' }) || REVIEW_FALLBACK_BASE;
  if (!isSafeReviewBase(base)) throw new Error(`rad review: default branch '${base}' is not a valid ref`);
  return base;
}

/** The one-line stderr summary. Never includes the full command string. */
function reviewSummaryLine({ reviewer, agent, findings, result }) {
  const executable = basename(agent.cmd.trim().split(/\s+/)[0]);
  const count = findings ? String(findings.findings.length) : 'none';
  let line = `rad review: reviewer=${reviewer} agent=${agent.source} executable=${executable} findings=${count}`;
  if (!result.ok) {
    const error = sanitizeErrorMessage(String(result.error)).replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
    line += ` error="${error}"`;
  }
  return `${line}\n`;
}

/** Validate argv + config; returns the run inputs, or { code } after writing the reason. */
function prepareReview(argv, ctx, env, configLoad) {
  let args;
  try {
    args = parseReviewArgs(argv);
  } catch (err) {
    process.stderr.write(`rad review: ${err.message}\nUsage: ${REVIEW_USAGE}\n`);
    return { code: USAGE_EXIT_CODE };
  }
  const agentRel = join('.claude', 'agents', `${args.reviewer}.md`);
  let agentMd;
  try {
    agentMd = readFileSync(join(ctx.repoRoot, agentRel), 'utf8');
  } catch (err) {
    process.stderr.write(`rad review: cannot read reviewer agent ${agentRel}: ${err.message}\n`);
    return { code: USAGE_EXIT_CODE };
  }
  const resolved = reviewAgentOrRefuse(env, configLoad);
  if (resolved.code !== undefined) return resolved;
  const { agent } = resolved;
  let timeoutMs;
  try {
    timeoutMs = reviewTimeoutMs(env);
  } catch (err) {
    process.stderr.write(`rad review: ${err.message}\n`);
    return { code: USAGE_EXIT_CODE };
  }
  return { args, agentMd, agent, timeoutMs };
}

/**
 * `review <reviewer> [--base <ref>]` — run one `.claude/agents/<reviewer>.md`
 * reviewer through the review lane: RAD_REVIEW_AGENT_CMD if set, else
 * RAD_AGENT_CMD, else agent.command from .rad/config.yml (command adapter only),
 * spawned via runCommandPrompt (same allow-listed env as waves).
 * Prints the agent's stdout verbatim and a one-line stderr summary naming the
 * winning env var and the executable's basename only. Exit 0 when the output
 * carries a parseable rad-findings block; 1 when it does not or the run failed;
 * 2 on bad argv/config. Writes no events and does not affect `rad deliver`.
 *
 * @param {string[]} argv - args after `review`
 * @param {{ repoRoot: string, sh?: typeof defaultSh, env?: Object,
 *   runCommandPrompt?: typeof runCommandPrompt }} ctx
 * @returns {Promise<number>}
 */
export async function reviewCommand(argv, ctx) {
  const env = ctx.env ?? process.env;
  const prep = prepareReview(argv, ctx, env, await loadConfig(ctx.repoRoot));
  if (prep.code !== undefined) return prep.code;
  const { args, agentMd, agent, timeoutMs } = prep;
  const { reviewer } = args;
  let base;
  try {
    base = resolveReviewBase(args, { sh: ctx.sh ?? defaultSh, repoRoot: ctx.repoRoot });
  } catch (err) {
    process.stderr.write(`rad review: ${err.message.replace(/^rad review: /, '')}\n`);
    return FAILED_EXIT_CODE;
  }
  const run = ctx.runCommandPrompt ?? runCommandPrompt;
  const result = await run({
    cmd: agent.cmd,
    prompt: buildReviewPrompt(agentMd, { base }),
    repoRoot: ctx.repoRoot,
    timeoutMs,
    label: `rad review ${reviewer}`,
  });
  process.stdout.write(result.stdout ?? '');
  const findings = parseFindings(result.stdout);
  process.stderr.write(reviewSummaryLine({ reviewer, agent, findings, result }));
  return findings && result.ok ? 0 : FAILED_EXIT_CODE;
}

/**
 * Hand-rolled argv parser for the ownership verbs. Returns the positional
 * feature. Throws on unknown flags or extra positionals so malformed invocations
 * fail loudly rather than mis-parse.
 *
 * @param {string[]} argv
 * @returns {{ feature?: string }}
 */
function parseOwnerArgs(argv) {
  let feature;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      throw new Error(`unknown option '${arg}'`);
    } else if (feature === undefined) {
      feature = arg;
    } else {
      throw new Error(`unexpected argument '${arg}'`);
    }
  }
  return { feature };
}

/**
 * `owner-claim <feature>`.
 *
 * Claims the single-writer lock on a feature: appends an `owner-claimed` event
 * whose holder provenance (the resolving git identity) is frozen ONCE at
 * write-time by the store. The branch IS the lock — claiming records WHO holds
 * it. Pure git/state work: no model call, no PR, no push. This appends an event
 * the existing fold/reduce already accumulates; it adds NO gate branch.
 *
 * @param {string[]} argv - args after `owner-claim`
 * @param {{ repoRoot: string, sh?: typeof defaultSh }} ctx
 * @returns {Promise<number>}
 */
export async function ownerClaimCommand(argv, ctx) {
  return ownerVerb(argv, ctx, 'claim');
}

/**
 * `owner-release <feature>`.
 *
 * Releases the single-writer lock: appends an `owner-released` event, clearing
 * the holder the most recent `owner-claimed` established. Symmetric to
 * owner-claim. Pure git/state work; adds NO gate branch.
 *
 * @param {string[]} argv - args after `owner-release`
 * @param {{ repoRoot: string, sh?: typeof defaultSh }} ctx
 * @returns {Promise<number>}
 */
export async function ownerReleaseCommand(argv, ctx) {
  return ownerVerb(argv, ctx, 'release');
}

/**
 * Shared body for the two ownership verbs. `which` selects claim vs release; the
 * two paths are byte-for-byte symmetric apart from the store writer and the
 * structured output token.
 *
 * @param {string[]} argv
 * @param {{ repoRoot: string, sh?: typeof defaultSh }} ctx
 * @param {'claim'|'release'} which
 * @returns {Promise<number>}
 */
async function ownerVerb(argv, ctx, which) {
  const { repoRoot } = ctx;
  const sh = ctx.sh ?? defaultSh;
  const verb = which === 'claim' ? 'owner-claim' : 'owner-release';

  let parsed;
  try {
    parsed = parseOwnerArgs(argv);
  } catch (err) {
    process.stderr.write(`rad ${verb}: ${err.message}\n`);
    process.stderr.write(`Usage: rad ${verb} <feature>\n`);
    return 1;
  }

  const { feature } = parsed;
  if (!isNonEmpty(feature)) {
    process.stderr.write(`rad ${verb}: a feature name is required\n`);
    process.stderr.write(`Usage: rad ${verb} <feature>\n`);
    return 1;
  }

  const store = createGitStateStore({ repoRoot, sh });

  let result;
  try {
    result =
      which === 'claim'
        ? store.recordOwnerClaimed({ feature })
        : store.recordOwnerReleased({ feature });
  } catch (err) {
    process.stderr.write(`rad ${verb}: cannot record ${which} — ${err.message}\n`);
    return 1;
  }

  // Structured success line (machine-greppable single line).
  process.stdout.write(
    `rad ${verb}: ok feature=${feature} action=${which} holder=${result.holder} at=${result.ts}\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// rad config — init, read, validate, or migrate .rad/config.yml (#87)
// ---------------------------------------------------------------------------

/** Exit code for `rad config get` on a key the (valid) config does not carry. */
const CONFIG_KEY_ABSENT_EXIT_CODE = 3;
/** The operator-facing line for a repo with no config file yet. */
const CONFIG_MISSING_MESSAGE =
  `rad: no ${CONFIG_PATH} — run 'rad config init' (new install) or 'rad config migrate' (from a pre-#87 CLAUDE.md)\n`;

/** Print a config load failure (missing or invalid) to stderr; returns FAILED_EXIT_CODE. */
function reportConfigLoadFailure(loaded) {
  if (loaded.missing) {
    process.stderr.write(CONFIG_MISSING_MESSAGE);
  } else {
    process.stderr.write(`rad config: ${CONFIG_PATH} is invalid:\n`);
    for (const e of loaded.errors) process.stderr.write(`  - ${e}\n`);
  }
  return FAILED_EXIT_CODE;
}

/** Render a config value for stdout: scalar as-is; list one item per line (objects as compact JSON). */
function formatConfigValue(value) {
  const one = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (Array.isArray(value)) return value.map((v) => `${one(v)}\n`).join('');
  return `${one(value)}\n`;
}

async function configGet(args, repoRoot) {
  if (args.length !== 1 || args[0].startsWith('-')) return configUsage('get needs exactly one <key>');
  const loaded = await loadConfig(repoRoot);
  if (!loaded.ok) return reportConfigLoadFailure(loaded);
  const got = getConfigValue(loaded.doc, args[0]);
  if (!got.found) {
    process.stderr.write(`rad config: key '${args[0]}' is not set in ${CONFIG_PATH}\n`);
    return CONFIG_KEY_ABSENT_EXIT_CODE;
  }
  process.stdout.write(formatConfigValue(got.value));
  return 0;
}

async function configValidate(args, repoRoot) {
  if (args.length !== 0) return configUsage(`validate takes no arguments (got '${args[0]}')`);
  const loaded = await loadConfig(repoRoot);
  if (!loaded.ok) return reportConfigLoadFailure(loaded);
  process.stdout.write(`✓ ${CONFIG_PATH} valid\n`);
  return 0;
}

/** The env var that overrides each setting (counts only when non-empty). */
const SETTING_ENV_VARS = Object.freeze({ high_risk_patterns: 'RAD_HIGH_RISK_PATTERNS', hooks_dir: HOOKS_DIR_ENV });
/**
 * The value column for a setting on its built-in default. The defaults live
 * with their consumers (the shell high-risk pattern in plan-paths.sh) and are
 * never copied here.
 */
const SETTING_DEFAULT_VALUE = '(built-in)';

/** `{ source, value }` for one setting: env (non-empty) → config → default. */
function resolveSetting(key, settings, env) {
  const fromEnv = env[SETTING_ENV_VARS[key]];
  if (isNonEmpty(fromEnv)) return { source: 'env', value: fromEnv };
  if (settings[key] !== undefined) return { source: 'config', value: settings[key] };
  return { source: 'default', value: SETTING_DEFAULT_VALUE };
}

/**
 * `config settings` — one `<key>\t<source>\t<value>` line per setting, in
 * SETTINGS_KEYS order. Exit 0 all resolved; 2 invalid config or a malformed
 * RAD_HOOKS_DIR (nothing on stdout); 2 bad argv. A missing config file means
 * every non-env setting is on its default.
 */
async function configSettings(args, repoRoot, env) {
  if (args.length !== 0) return configUsage(`settings takes no arguments (got '${args[0]}')`);
  const loaded = await loadConfig(repoRoot);
  if (!loaded.ok && !loaded.missing) {
    reportConfigLoadFailure(loaded);
    return USAGE_EXIT_CODE;
  }
  const settings = loaded.ok ? loaded.doc.settings ?? {} : {};
  const hooks = resolveHooksDir(env, repoRoot, settings);
  if (!hooks.ok) {
    process.stderr.write(`rad config: ${hooks.source} must be a directory path (got ${JSON.stringify(hooks.raw)})\n`);
    return USAGE_EXIT_CODE;
  }
  for (const key of SETTINGS_KEYS) {
    const { source, value } = resolveSetting(key, settings, env);
    process.stdout.write(`${key}\t${source}\t${value}\n`);
  }
  return 0;
}

/** Parse `migrate [--from <path>] [--force]`; throws on malformed argv. */
function parseMigrateArgs(args) {
  const out = { from: undefined, force: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--force') out.force = true;
    else if (args[i] === '--from') {
      if (!isNonEmpty(args[i + 1]) || args[i + 1].startsWith('--')) throw new Error('--from requires a path');
      out.from = args[i + 1];
      i += 1;
    } else throw new Error(`unknown argument '${args[i]}'`);
  }
  return out;
}

/** Build the validated migrated doc from CLAUDE.md text, or report why not (returns an exit code). */
function buildMigratedDoc(text, fromPath) {
  const migrated = migrateFromClaudeMd(text);
  for (const w of migrated.warnings) process.stderr.write(`rad config migrate: warning: ${w}\n`);
  if (migrated.missing.length) {
    process.stderr.write(`rad config migrate: ${fromPath} is missing required key(s): ${migrated.missing.join(', ')}\n`);
    return { code: FAILED_EXIT_CODE };
  }
  const errors = validateConfig(migrated.doc);
  if (errors.length) {
    process.stderr.write(`rad config migrate: migrated config from ${fromPath} is invalid:\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    return { code: FAILED_EXIT_CODE };
  }
  return { migrated };
}

async function configMigrate(args, repoRoot) {
  let opts;
  try {
    opts = parseMigrateArgs(args);
  } catch (err) {
    return configUsage(`migrate: ${err.message}`);
  }
  const fromPath = opts.from ? resolve(opts.from) : join(repoRoot, 'CLAUDE.md');
  const target = join(repoRoot, CONFIG_PATH);
  if (existsSync(target) && !opts.force) {
    process.stderr.write(`rad config migrate: ${target} already exists — pass --force to overwrite\n`);
    return FAILED_EXIT_CODE;
  }
  if (!existsSync(fromPath)) {
    process.stderr.write(`rad config migrate: cannot read ${fromPath}: no such file\n`);
    return FAILED_EXIT_CODE;
  }
  const built = buildMigratedDoc(readFileSync(fromPath, 'utf8'), fromPath);
  if (built.code !== undefined) return built.code;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, serializeConfig(built.migrated.doc));
  process.stdout.write(`rad config migrate: wrote ${CONFIG_PATH} (${fromPath} was not modified)\n`);
  process.stdout.write('Remove these config blocks from CLAUDE.md once the readers are cut over:\n');
  for (const b of built.migrated.blocks) process.stdout.write(`  ${b.name}: lines ${b.start}-${b.end}\n`);
  return 0;
}

/** `rad config init` flags that take a value, mapped to their parsed option key. */
const INIT_VALUE_FLAGS = Object.freeze({
  '--architect': 'architect', '--platform': 'platform', '--default-branch': 'defaultBranch',
  '--agent': 'agentPreset', '--agent-cmd': 'agentCmd', '--agent-adapter': 'agentAdapter',
});
/** The adapter `--agent-cmd` writes when `--agent-adapter` is not given. */
const INIT_DEFAULT_AGENT_ADAPTER = 'command';
/** The one adapter that takes no command. */
const INIT_SDK_ADAPTER = 'sdk';

/** Parse `init [--architect <id>] [--platform <p>] [--default-branch <b>] [agent flags] [--force]`; throws on malformed argv. */
function parseInitArgs(args) {
  const out = {
    architect: undefined, platform: undefined, defaultBranch: undefined,
    agentPreset: undefined, agentCmd: undefined, agentAdapter: undefined, force: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const key = INIT_VALUE_FLAGS[args[i]];
    if (args[i] === '--force') out.force = true;
    else if (key) {
      // An empty value is a value (validation rejects it); only a missing one is a usage error.
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${args[i]} requires a value`);
      out[key] = value;
      i += 1;
    } else throw new Error(`unknown argument '${args[i]}'`);
  }
  return out;
}

/** The `agent:` block a named preset writes — copied from AGENT_PRESETS, never redefined. Throws on an unknown name. */
function initAgentPreset(opts) {
  if (opts.agentCmd !== undefined || opts.agentAdapter !== undefined) {
    throw new Error('--agent cannot be combined with --agent-cmd or --agent-adapter');
  }
  if (!Object.hasOwn(AGENT_PRESETS, opts.agentPreset)) {
    throw new Error(`unknown --agent '${opts.agentPreset}' (expected ${Object.keys(AGENT_PRESETS).join(' | ')})`);
  }
  return { ...AGENT_PRESETS[opts.agentPreset] };
}

/**
 * Resolve the init agent flags to an `agent:` block, or undefined when none is
 * given. Throws (a usage error) on any contradictory or incomplete combination;
 * the block is still validated by validateConfig before anything is written.
 *
 * @returns {{ adapter: string, command?: string } | undefined}
 */
function resolveInitAgent(opts) {
  if (opts.agentPreset !== undefined) return initAgentPreset(opts);
  if (opts.agentCmd === undefined && opts.agentAdapter === undefined) return undefined;
  const adapter = opts.agentAdapter ?? INIT_DEFAULT_AGENT_ADAPTER;
  if (!AGENT_ADAPTERS.includes(adapter)) {
    throw new Error(`unknown --agent-adapter '${adapter}' (expected ${AGENT_ADAPTERS.join(' | ')})`);
  }
  if (adapter === INIT_SDK_ADAPTER) {
    if (opts.agentCmd !== undefined) throw new Error('--agent-adapter sdk takes no --agent-cmd');
    return { adapter };
  }
  if (opts.agentCmd === undefined) throw new Error(`--agent-adapter ${adapter} requires --agent-cmd`);
  return { adapter, command: opts.agentCmd };
}

/** The init summary suffix: `, agent=<adapter>:<command>` (`, agent=sdk` for the commandless sdk adapter) when an agent was set, else ''. */
function initAgentSummary(agent) {
  if (agent === undefined) return '';
  return agent.command === undefined ? `, agent=${agent.adapter}` : `, agent=${agent.adapter}:${agent.command}`;
}

/**
 * The installer's `git config user.email`, read in the repo root (argv form,
 * never a shell string). Git failure or empty output means "no identity".
 *
 * @returns {{ email: string, reason?: string }}
 */
function initGitIdentity(repoRoot) {
  try {
    const email = execFileSync('git', ['config', 'user.email'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return email ? { email } : { email: '', reason: 'git config user.email is empty' };
  } catch (err) {
    const detail = (err.stderr ?? '').toString().trim() || `exit ${err.status ?? 'unknown'}`;
    return { email: '', reason: `git config user.email is not set (${detail})` };
  }
}

/** Resolve the architect identity: --architect wins, else git email; returns { architect } or { code }. */
function resolveInitArchitect(opts, repoRoot) {
  if (opts.architect !== undefined) return { architect: opts.architect };
  const git = initGitIdentity(repoRoot);
  if (git.email) return { architect: git.email };
  process.stderr.write(`rad config init: no architect identity — ${git.reason}; pass --architect <id>\n`);
  return { code: FAILED_EXIT_CODE };
}

async function configInit(args, repoRoot) {
  let opts;
  let agent;
  try {
    opts = parseInitArgs(args);
    agent = resolveInitAgent(opts);
  } catch (err) {
    return configUsage(`init: ${err.message}`);
  }
  const target = join(repoRoot, CONFIG_PATH);
  if (existsSync(target) && !opts.force) {
    process.stderr.write(`rad config init: ${target} already exists — pass --force to overwrite\n`);
    return FAILED_EXIT_CODE;
  }
  const resolved = resolveInitArchitect(opts, repoRoot);
  if (resolved.code !== undefined) return resolved.code;
  const { platform, defaultBranch } = opts;
  const doc = buildInitConfig({ platform, defaultBranch, architect: resolved.architect, agent });
  const errors = validateConfig(doc);
  if (errors.length) {
    process.stderr.write('rad config init: refusing to write an invalid config:\n');
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    return FAILED_EXIT_CODE;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, serializeConfig(doc));
  process.stdout.write(`rad config init: wrote ${CONFIG_PATH} (architect=${doc.roles.architect[0]}, `
    + `platform=${doc.platform}, default_branch=${doc.default_branch}${initAgentSummary(doc.agent)})\n`);
  return 0;
}

function configUsage(message) {
  process.stderr.write(`rad config: ${message}\nUsage: ${CONFIG_USAGE}\n`);
  return USAGE_EXIT_CODE;
}

const CONFIG_ACTIONS = {
  get: configGet, validate: configValidate, settings: configSettings, migrate: configMigrate, init: configInit,
};

/**
 * `config get <key> | validate | migrate [--from <path>] [--force]
 *  | init [--architect <id>] [--platform <p>] [--default-branch <b>] [agent flags] [--force]`.
 *
 * get: prints the value (lists one item per line; scope-map rows as compact
 * JSON) — exit 0; absent key → 3; missing/invalid config → 1; bad argv → 2.
 * validate: exit 0 valid, 1 missing/invalid. settings: `<key>\t<source>\t<value>`
 * per setting (env | config | default) — exit 0; invalid config → 2, nothing on
 * stdout; bad argv → 2. migrate: writes .rad/config.yml
 * from CLAUDE.md (never edits it); refuses to overwrite without --force.
 * init: writes a fresh validated config (architect = --architect, else the
 * repo's git user.email; platform default manual, default_branch default main;
 * `agent:` only from --agent <preset>, or --agent-cmd [--agent-adapter], or
 * --agent-adapter sdk) — exit 0 written; 1 no identity / invalid value / exists without --force;
 * 2 bad argv. Nothing is written on any failure.
 *
 * @param {string[]} argv - args after `config`
 * @param {{ repoRoot: string, env?: Object }} ctx - env defaults to process.env
 * @returns {Promise<number>}
 */
export async function configCommand(argv, ctx) {
  const [action, ...args] = argv;
  const run = CONFIG_ACTIONS[action];
  if (!run) return configUsage(action === undefined ? 'an action is required' : `unknown action '${action}'`);
  return run(args, ctx.repoRoot, ctx.env ?? process.env);
}

/** Parse `<feature> [--plan <path>]`; throws on unknown flags, a valueless --plan, or extras. */
function parseCapabilitiesArgs(argv) {
  let feature;
  let plan;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--plan') {
      const value = argv[++i];
      if (!isNonEmpty(value) || value.startsWith('--')) throw new Error('--plan requires a <path>');
      plan = value;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option '${arg}'`);
    } else if (feature === undefined) {
      feature = arg;
    } else {
      throw new Error(`unexpected argument '${arg}'`);
    }
  }
  if (!isNonEmpty(feature)) throw new Error('a <feature> is required');
  return { feature, plan };
}

/** One output line: `wave N: <effective> (<source>)[; denied: <classes>]`. */
function formatWaveCapabilities(wave, entry) {
  const denied = entry.denied.length > 0 ? `; denied: ${entry.denied.join(', ')}` : '';
  return `wave ${wave}: ${entry.effective.join(', ')} (${entry.source})${denied}\n`;
}

/**
 * `capabilities <feature> [--plan <path>]` — read-only view of each wave's
 * effective capability classes (#85). Reads .agents/plans/<feature>.md (or
 * --plan, relative to the repo root) and the .rad/config.yml deny list, then
 * resolves through the SAME helper deliver uses, so a refusal reads the same.
 * Adapter-agnostic: the command-adapter refusal and the sdk tool mapping are
 * deliver-time checks and are NOT applied here. Writes nothing, appends no event.
 *
 * Exit 0 printed; 1 missing plan or invalid config; 2 bad argv, a malformed
 * Capabilities: line, or a denied explicit request.
 *
 * @param {string[]} argv - args after `capabilities`
 * @param {{ repoRoot: string }} ctx
 * @returns {Promise<number>}
 */
export async function capabilitiesCommand(argv, ctx) {
  let args;
  try {
    args = parseCapabilitiesArgs(argv);
  } catch (err) {
    process.stderr.write(`rad capabilities: ${err.message}\nUsage: ${CAPABILITIES_USAGE}\n`);
    return USAGE_EXIT_CODE;
  }
  const planLabel = args.plan ?? `.agents/plans/${args.feature}.md`;
  const planFile = resolve(ctx.repoRoot, planLabel);
  if (!existsSync(planFile)) {
    process.stderr.write(`rad capabilities: no plan doc at ${planLabel}\n`);
    return FAILED_EXIT_CODE;
  }
  const planCtx = parsePlanCtx(readFileSync(planFile, 'utf8'));
  const resolved = await resolvePlanCapabilities({ planCtx, root: ctx.repoRoot, planLabel });
  if (!resolved.ok) {
    process.stderr.write(`rad capabilities: ${resolved.error}\n`);
    return resolved.configInvalid ? FAILED_EXIT_CODE : USAGE_EXIT_CODE;
  }
  for (const [wave, entry] of Object.entries(resolved.byWave)) {
    process.stdout.write(formatWaveCapabilities(wave, entry));
  }
  return 0;
}

/** Action order for the install summary line. */
const INSTALL_ACTIONS = ['write', 'keep', 'deleted', 'backup-write'];
/** Report-line prefixes of the install verbs. */
const INSTALL_CORE_PREFIX = 'rad install-core';
const INSTALL_PRESET_PREFIX = 'rad install-preset';
/** How a stale line names what a path is no longer part of, per layer. */
const STALE_LABELS = Object.freeze({ [CORE_LAYER]: 'core', [PRESET_LAYER]: 'in the preset' });
/** A source tree must carry this file to be a RAD source (guards a wrong --source). */
const SOURCE_MARKER = 'harness/cli.js';

/**
 * Parse `--flag <value>` pairs for the install verbs. `allowed` lists the
 * accepted flags; throws on an unknown flag, a valueless flag, a repeat, or a
 * positional.
 */
function parseInstallFlags(argv, allowed) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!allowed.includes(flag)) {
      throw new Error(flag.startsWith('--') ? `unknown option '${flag}'` : `unexpected argument '${flag}'`);
    }
    const value = argv[++i];
    if (!isNonEmpty(value) || value.startsWith('--')) throw new Error(`${flag} requires a <dir>`);
    const key = flag.slice(2);
    if (key in out) throw new Error(`${flag} given more than once`);
    out[key] = value;
  }
  return out;
}

/** The source checkout's commit sha, or 'unknown' (a tarball or non-git source is valid; recorded, not fatal). */
function sourceRadVersion(sourceRoot) {
  try {
    return execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || UNKNOWN_RAD_VERSION;
  } catch {
    return UNKNOWN_RAD_VERSION;
  }
}

/** One stdout line per path that was not a plain write, naming where any copy went. */
function installReportLines(plan, backupDir) {
  const lines = [];
  for (const { path, action } of plan.actions) {
    if (action === 'keep') lines.push(`keep: ${path} (local edit kept; new version staged at ${PENDING_DIR}/${path})`);
    if (action === 'deleted') lines.push(`deleted: ${path} (removed locally; not restored)`);
    if (action === 'backup-write') lines.push(`backup-write: ${path} (previous copy at ${backupDir}/${path})`);
  }
  const label = STALE_LABELS[plan.layer] ?? plan.layer;
  for (const path of plan.stale) lines.push(`stale: ${path} (no longer ${label}; left in place, dropped from manifest)`);
  return lines;
}

/** `<prefix>: write N, keep N, deleted N, backup-write N, stale N`. */
function installSummaryLine(prefix, plan) {
  const counts = INSTALL_ACTIONS.map((a) => `${a} ${plan.actions.filter((x) => x.action === a).length}`);
  return `${prefix}: ${counts.join(', ')}, stale ${plan.stale.length}`;
}

/** Validate install-core argv; returns { sourceRoot, targetRoot } or an error string. */
function resolveInstallCoreArgs(argv, repoRoot) {
  let flags;
  try {
    flags = parseInstallFlags(argv, ['--source', '--target']);
  } catch (err) {
    return { error: err.message };
  }
  if (!flags.source) return { error: '--source <dir> is required' };
  const sourceRoot = resolve(flags.source);
  if (!existsSync(join(sourceRoot, SOURCE_MARKER))) return { error: `${flags.source} is not a RAD source (no ${SOURCE_MARKER})` };
  return { sourceRoot, targetRoot: flags.target ? resolve(flags.target) : repoRoot };
}

/** Refuse an install whose layer takes over paths another layer owns; nothing is written. */
function reportInstallConflicts(prefix, plan) {
  for (const path of plan.conflicts) {
    process.stderr.write(
      `${prefix}: ${path} is owned by layer '${plan.carried[path].layer}'; ${plan.layer} will not take it over\n`,
    );
  }
  process.stderr.write(`${prefix}: nothing written\n`);
  return USAGE_EXIT_CODE;
}

/**
 * `install-core --source <dir> [--target <dir>]` — install or upgrade the core
 * file set (#71). Unmodified and absent files are written; a local edit is kept
 * and the new version staged; a locally deleted file is not restored; an
 * unbaselined differing file is backed up, then overwritten. Writes
 * .rad/installed.json. Target defaults to the CLI's repo root.
 *
 * Exit 0 all written; 1 any keep or deleted; 2 bad argv, a non-RAD source, a
 * malformed existing manifest, or a core path another layer owns (nothing
 * written: fail closed, never "absent", never a take-over).
 *
 * @param {string[]} argv - args after `install-core`
 * @param {{ repoRoot: string, now?: Date }} ctx
 * @returns {Promise<number>}
 */
export async function installCoreCommand(argv, ctx) {
  const args = resolveInstallCoreArgs(argv, ctx.repoRoot);
  if (args.error) {
    process.stderr.write(`rad install-core: ${args.error}\nUsage: ${INSTALL_CORE_USAGE}\n`);
    return USAGE_EXIT_CODE;
  }
  const read = readManifest(args.targetRoot);
  if (!read.ok && !read.missing) {
    process.stderr.write(`rad install-core: ${read.error}; nothing written\n`);
    return USAGE_EXIT_CODE;
  }
  const plan = planInstall({ ...args, manifest: read.ok ? read.manifest : null });
  if (plan.conflicts.length) return reportInstallConflicts(INSTALL_CORE_PREFIX, plan);
  const { backupDir } = applyInstall({
    ...args, plan, now: ctx.now ?? new Date(), radVersion: sourceRadVersion(args.sourceRoot),
  });
  for (const line of [installSummaryLine(INSTALL_CORE_PREFIX, plan), ...installReportLines(plan, backupDir)]) {
    process.stdout.write(`${line}\n`);
  }
  return plan.actions.some((a) => a.action === 'keep' || a.action === 'deleted') ? FAILED_EXIT_CODE : 0;
}

/** Report-line prefix of `rad install-hooks`. */
const INSTALL_HOOKS_PREFIX = 'rad install-hooks';
/** Target-relative Claude Code project settings file install-hooks merges into. */
const CLAUDE_SETTINGS_PATH = '.claude/settings.json';
/** Target-relative hook script the registration runs; it must exist before it is registered. */
const DELIVER_GATE_HOOK_SCRIPT = 'scripts/deliver-gate-hook.mjs';

/**
 * The current settings text for install-hooks: { text } (null when absent) or
 * { error }. Refuses a missing hook script (registering it would fail every
 * Skill call) and a settings path that is a symlink, directory, or other
 * non-regular file (lstat: a link is never followed).
 */
function readHookSettings(targetRoot) {
  const script = join(targetRoot, DELIVER_GATE_HOOK_SCRIPT);
  if (!existsSync(script) || !lstatSync(script).isFile()) {
    return { error: `${DELIVER_GATE_HOOK_SCRIPT} is missing or not a regular file; install core first; nothing written` };
  }
  const settingsPath = join(targetRoot, CLAUDE_SETTINGS_PATH);
  let stat;
  try {
    stat = lstatSync(settingsPath);
  } catch (err) {
    if (err.code === 'ENOENT') return { text: null };
    return { error: `${CLAUDE_SETTINGS_PATH}: cannot stat (${err.code ?? err.message}); nothing written` };
  }
  if (!stat.isFile()) return { error: `${CLAUDE_SETTINGS_PATH} is not a regular file (symlink or directory); nothing written` };
  return { text: readFileSync(settingsPath, 'utf8') };
}

/** Write settings text atomically: a temp file in the same directory, then rename over the target. */
function writeHookSettingsAtomic(targetRoot, text) {
  const settingsPath = join(targetRoot, CLAUDE_SETTINGS_PATH);
  mkdirSync(dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, settingsPath);
}

/**
 * `install-hooks [--target <dir>]` — register the deliver-gate PreToolUse hook
 * in <target>/.claude/settings.json (#186). Created/added are written
 * atomically; present writes nothing. Target defaults to the CLI's repo root.
 *
 * Exit 0 created/added/present; 2 bad argv, a missing hook script, a
 * non-regular settings path, or settings the merge cannot handle (nothing
 * written: fail closed, existing settings are never overwritten).
 *
 * @param {string[]} argv - args after `install-hooks`
 * @param {{ repoRoot: string }} ctx
 * @returns {Promise<number>}
 */
export async function installHooksCommand(argv, ctx) {
  let flags;
  try {
    flags = parseInstallFlags(argv, ['--target']);
  } catch (err) {
    process.stderr.write(`${INSTALL_HOOKS_PREFIX}: ${err.message}\nUsage: ${INSTALL_HOOKS_USAGE}\n`);
    return USAGE_EXIT_CODE;
  }
  const targetRoot = flags.target ? resolve(flags.target) : ctx.repoRoot;
  const current = readHookSettings(targetRoot);
  if (current.error) {
    process.stderr.write(`${INSTALL_HOOKS_PREFIX}: ${current.error}\n`);
    return USAGE_EXIT_CODE;
  }
  const merged = mergeDeliverGateHook(current.text);
  if (merged.error) {
    process.stderr.write(`${INSTALL_HOOKS_PREFIX}: ${CLAUDE_SETTINGS_PATH}: ${merged.error}; nothing written\n`);
    return USAGE_EXIT_CODE;
  }
  if (merged.status !== 'present') writeHookSettingsAtomic(targetRoot, merged.text);
  process.stdout.write(`${INSTALL_HOOKS_PREFIX}: ${merged.status} ${CLAUDE_SETTINGS_PATH}\n`);
  return 0;
}

/** The boolean flag that re-applies the recorded preset (parseInstallFlags only takes value flags). */
const REAPPLY_FLAG = '--reapply';
/** What an operator does when the recorded preset source is gone. */
const REAPPLY_FIX = 'pass --preset <dir> to install.sh, or rad install-preset --source <dir>';

/**
 * Validate install-preset argv; returns { presetDir, targetRoot },
 * { reapply: true, targetRoot }, or an error string. `--reapply` is stripped
 * before the value-flag parse so install-core/status parsing is unchanged.
 */
function resolveInstallPresetArgs(argv, repoRoot) {
  const reapplyCount = argv.filter((a) => a === REAPPLY_FLAG).length;
  if (reapplyCount > 1) return { error: `${REAPPLY_FLAG} given more than once` };
  let flags;
  try {
    flags = parseInstallFlags(argv.filter((a) => a !== REAPPLY_FLAG), ['--source', '--target']);
  } catch (err) {
    return { error: err.message };
  }
  const targetRoot = flags.target ? resolve(flags.target) : repoRoot;
  if (reapplyCount && flags.source) return { error: `--source and ${REAPPLY_FLAG} are mutually exclusive` };
  if (reapplyCount) return { reapply: true, targetRoot };
  if (!flags.source) return { error: '--source <dir> is required' };
  return { presetDir: resolve(flags.source), targetRoot };
}

/**
 * The preset dir `--reapply` re-installs from: { presetDir }, { none: true }
 * when no preset is recorded, or { errors } (no/malformed manifest, or a
 * recorded source that is missing or not a directory). Reads only.
 */
function recordedPresetSource(targetRoot) {
  const read = readManifest(targetRoot);
  if (read.missing) return { errors: [PRESET_NEEDS_CORE_ERROR] };
  if (!read.ok) return { errors: [read.error] };
  const source = read.manifest.preset?.source;
  if (!read.manifest.preset) return { none: true };
  if (!isNonEmpty(source) || !existsSync(source) || !statSync(source).isDirectory()) {
    return { errors: [`recorded preset source ${source} is missing or not a directory; ${REAPPLY_FIX}`] };
  }
  return { presetDir: source };
}

/** The installed manifest a preset overlays: { manifest } or { errors } (absent core is a refusal, never "fresh"). */
function presetBaseManifest(targetRoot, presetName) {
  const read = readManifest(targetRoot);
  if (read.missing) return { errors: [PRESET_NEEDS_CORE_ERROR] };
  if (!read.ok) return { errors: [read.error] };
  const installed = read.manifest.preset;
  if (installed && installed.name !== presetName) {
    return { errors: [`preset '${installed.name}' is already installed; switching to '${presetName}' is not supported`] };
  }
  return { manifest: read.manifest };
}

/** The target's config text, once it loads and validates: { text } or { errors }. */
async function presetTargetConfig(targetRoot) {
  const config = await loadConfig(targetRoot);
  if (config.missing) return { errors: [`no ${CONFIG_PATH} in the target; run rad config init first`] };
  if (!config.ok) return { errors: config.errors.map((e) => `${CONFIG_PATH} is invalid: ${e}`) };
  return { text: readFileSync(join(targetRoot, CONFIG_PATH), 'utf8') };
}

/**
 * Every install-preset refusal, in order, before anything is written. Returns
 * { errors } or { conflictPlan } to refuse, else { preset, plan, seeded }.
 */
async function preparePresetInstall({ presetDir, targetRoot }) {
  const read = await readPreset(presetDir);
  if (!read.ok) return { errors: read.errors.map((e) => `invalid preset: ${e}`) };
  const { preset } = read;
  const base = presetBaseManifest(targetRoot, preset.name);
  if (base.errors) return base;
  const config = await presetTargetConfig(targetRoot);
  if (config.errors) return config;
  const planned = planPresetInstall({ presetDir, files: preset.files, targetRoot, manifest: base.manifest });
  if (!planned.ok) return { errors: [planned.error] };
  if (planned.plan.conflicts.length) return { conflictPlan: planned.plan };
  const seeded = await seedSettings(config.text, preset.settings);
  if (!seeded.ok) return { errors: [seeded.error] };
  return { preset, plan: planned.plan, seeded };
}

/** Print each install-preset refusal, then `nothing written`; exit 2. */
function reportPresetRefusal(errors) {
  for (const e of errors) process.stderr.write(`${INSTALL_PRESET_PREFIX}: ${e}\n`);
  process.stderr.write(`${INSTALL_PRESET_PREFIX}: nothing written\n`);
  return USAGE_EXIT_CODE;
}

/** One stdout line per preset setting: seeded, kept, or unseeded (left for the operator). */
function settingsReportLines({ seeded, kept, unseeded }) {
  return [
    ...seeded.map((k) => `seeded: ${k}`),
    ...kept.map((k) => `kept: ${k}`),
    ...unseeded.map((k) => `unseeded: ${k} (settings: block exists; add it by hand)`),
  ];
}

/**
 * `install-preset (--source <dir> | --reapply) [--target <dir>]` — install or
 * upgrade a preset's files over an installed core (same per-file rules as
 * install-core) and seed its settings into .rad/config.yml. `--reapply` reads
 * the source from the manifest's recorded preset and then behaves exactly as
 * `--source <recorded>`; with no preset recorded it is a no-op (exit 0). Target
 * defaults to the CLI's repo root. Re-running the same preset is idempotent.
 *
 * Exit 0 all written and seeded; 1 any keep, deleted, or unseeded setting;
 * 2 (nothing written) bad argv, an invalid preset, no or a malformed manifest,
 * a missing or invalid config, a different preset already installed, a path
 * another layer owns, or (--reapply) a recorded source that is not a directory.
 *
 * @param {string[]} argv - args after `install-preset`
 * @param {{ repoRoot: string, now?: Date }} ctx
 * @returns {Promise<number>}
 */
export async function installPresetCommand(argv, ctx) {
  const parsed = resolveInstallPresetArgs(argv, ctx.repoRoot);
  if (parsed.error) {
    process.stderr.write(`${INSTALL_PRESET_PREFIX}: ${parsed.error}\nUsage: ${INSTALL_PRESET_USAGE}\n`);
    return USAGE_EXIT_CODE;
  }
  const recorded = parsed.reapply ? recordedPresetSource(parsed.targetRoot) : { presetDir: parsed.presetDir };
  if (recorded.none) {
    process.stdout.write(`${INSTALL_PRESET_PREFIX}: no preset recorded; nothing to do\n`);
    return 0;
  }
  const args = { presetDir: recorded.presetDir, targetRoot: parsed.targetRoot };
  const prep = recorded.errors ? recorded : await preparePresetInstall(args);
  if (prep.conflictPlan) return reportInstallConflicts(INSTALL_PRESET_PREFIX, prep.conflictPlan);
  if (prep.errors) return reportPresetRefusal(prep.errors);
  const { preset, plan, seeded } = prep;
  const { backupDir } = applyPresetInstall({
    ...args, plan, now: ctx.now ?? new Date(), name: preset.name, version: preset.version,
  });
  if (seeded.seeded.length) writeConfigAtomic(args.targetRoot, seeded.text);
  const lines = [installSummaryLine(INSTALL_PRESET_PREFIX, plan), ...installReportLines(plan, backupDir), ...settingsReportLines(seeded)];
  for (const line of lines) process.stdout.write(`${line}\n`);
  const fileIncomplete = plan.actions.some((a) => a.action === 'keep' || a.action === 'deleted');
  return fileIncomplete || seeded.unseeded.length ? FAILED_EXIT_CODE : 0;
}

/**
 * `install-status [--target <dir>]` — read-only drift report against
 * .rad/installed.json. Prints `preset: <name> <version> (<source>)` first when a
 * preset is recorded, then `modified: [<layer>] <path>` / `missing: [<layer>] <path>`.
 *
 * Exit 0 clean; 1 drift or no manifest; 2 bad argv or a malformed manifest.
 *
 * @param {string[]} argv - args after `install-status`
 * @param {{ repoRoot: string }} ctx
 * @returns {Promise<number>}
 */
export async function installStatusCommand(argv, ctx) {
  let flags;
  try {
    flags = parseInstallFlags(argv, ['--target']);
  } catch (err) {
    process.stderr.write(`rad install-status: ${err.message}\nUsage: ${INSTALL_STATUS_USAGE}\n`);
    return USAGE_EXIT_CODE;
  }
  const targetRoot = flags.target ? resolve(flags.target) : ctx.repoRoot;
  const read = readManifest(targetRoot);
  if (read.missing) {
    process.stderr.write(`rad install-status: no ${MANIFEST_PATH} — run install.sh --upgrade\n`);
    return FAILED_EXIT_CODE;
  }
  if (!read.ok) {
    process.stderr.write(`rad install-status: ${read.error}\n`);
    return USAGE_EXIT_CODE;
  }
  const { preset } = read.manifest;
  if (preset) process.stdout.write(`preset: ${preset.name} ${preset.version} (${preset.source})\n`);
  const { modified, missing } = installDrift({ targetRoot, manifest: read.manifest });
  for (const { path, layer } of modified) process.stdout.write(`modified: [${layer}] ${path}\n`);
  for (const { path, layer } of missing) process.stdout.write(`missing: [${layer}] ${path}\n`);
  return modified.length + missing.length > 0 ? FAILED_EXIT_CODE : 0;
}

/** The flags `rad acp-check` accepts, each taking one value. */
const ACP_CHECK_FLAGS = ['--cmd', '--timeout'];

/**
 * Parse `acp-check` argv. Throws on an unknown flag, a missing or repeated
 * value, a missing --cmd, or a --timeout that is not a positive integer.
 *
 * @param {string[]} argv
 * @returns {{ cmd: string, timeoutMs?: number }}
 */
function parseAcpCheckArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!ACP_CHECK_FLAGS.includes(flag)) {
      throw new Error(flag.startsWith('--') ? `unknown option '${flag}'` : `unexpected argument '${flag}'`);
    }
    const value = argv[++i];
    if (!isNonEmpty(value) || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag in flags) throw new Error(`${flag} given more than once`);
    flags[flag] = value;
  }
  if (!isNonEmpty(flags['--cmd'])) throw new Error('--cmd is required');
  const timeout = flags['--timeout'];
  if (timeout !== undefined && !POSITIVE_INTEGER_PATTERN.test(timeout)) {
    throw new Error(`--timeout must be a positive integer number of seconds (got '${timeout}')`);
  }
  return { cmd: flags['--cmd'], timeoutMs: timeout === undefined ? undefined : Number(timeout) * 1000 };
}

/**
 * `acp-check --cmd "<agent>" [--timeout <seconds>]` — run checkAcpAgent once
 * against the agent (cwd: the repo root) and print `PASS <name>` or
 * `FAIL <name>: <detail>` per check run, then one summary line. --timeout
 * bounds the whole check and defaults to the wave timeout. Writes no events
 * and no files.
 *
 * Exit 0 every check passed; 1 a check failed; 2 bad argv.
 *
 * @param {string[]} argv - args after `acp-check`
 * @param {{ repoRoot: string }} ctx
 * @returns {Promise<number>}
 */
export async function acpCheckCommand(argv, ctx) {
  let args;
  try {
    args = parseAcpCheckArgs(argv);
  } catch (err) {
    process.stderr.write(`rad acp-check: ${err.message}\nUsage: ${ACP_CHECK_USAGE}\n`);
    return USAGE_EXIT_CODE;
  }
  const report = await checkAcpAgent({ cmd: args.cmd, repoRoot: ctx.repoRoot, timeoutMs: args.timeoutMs });
  for (const { name, ok, detail } of report.checks) {
    process.stdout.write(ok ? `PASS ${name}\n` : `FAIL ${name}: ${detail}\n`);
  }
  const total = ACP_CHECK_NAMES.length;
  const passed = report.checks.filter((c) => c.ok).length;
  process.stdout.write(`rad acp-check: ${report.ok ? 'ok' : 'failed'}, ${passed} of ${total} checks passed\n`);
  return report.ok ? 0 : FAILED_EXIT_CODE;
}

/** Prefix for every `rad generate` stderr line. */
const GENERATE_PREFIX = 'rad generate';

/**
 * Parse `generate` argv. Throws on an unknown flag, a stray argument, a
 * repeated flag, or a `--root` with no value.
 *
 * @param {string[]} argv
 * @returns {{ check: boolean, root?: string }}
 */
function parseGenerateArgs(argv) {
  const out = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--check') {
      if (out.check) throw new Error('--check given more than once');
      out.check = true;
      continue;
    }
    if (flag !== '--root') {
      throw new Error(flag.startsWith('--') ? `unknown option '${flag}'` : `unexpected argument '${flag}'`);
    }
    const value = argv[++i];
    if (!isNonEmpty(value) || value.startsWith('--')) throw new Error('--root requires a <dir>');
    if ('root' in out) throw new Error('--root given more than once');
    out.root = value;
  }
  return out;
}

/** Print each error (already path-prefixed) to stderr; exit 2. */
function reportGenerateErrors(errors) {
  for (const e of errors) process.stderr.write(`${GENERATE_PREFIX}: ${e}\n`);
  return USAGE_EXIT_CODE;
}

/** Name every conflict on stderr, then `nothing written`; exit 2. */
function reportGenerateConflicts(conflicts) {
  for (const { path, reason } of conflicts) process.stderr.write(`${GENERATE_PREFIX}: conflict ${path}: ${reason}\n`);
  process.stderr.write(`${GENERATE_PREFIX}: nothing written\n`);
  return USAGE_EXIT_CODE;
}

/** `--check`: print drift then orphans; exit 1 when either is non-empty, else 0. */
function reportGenerateCheck(plan) {
  for (const path of plan.drift) process.stdout.write(`drift ${path}\n`);
  for (const path of plan.orphans) process.stdout.write(`orphan ${path}\n`);
  return plan.drift.length + plan.orphans.length > 0 ? FAILED_EXIT_CODE : 0;
}

/**
 * Write mode: apply the plan, then print `wrote`, `unchanged`, and `orphan`
 * lines. Orphans are reported for the operator to delete (never deleted here)
 * and do not fail write mode; `--check` is the gate that fails on them.
 */
function writeGenerated(root, plan) {
  let wrote;
  try {
    ({ wrote } = applyGenerate(root, plan));
  } catch (err) {
    process.stderr.write(`${GENERATE_PREFIX}: ${err.message}\n`);
    return USAGE_EXIT_CODE;
  }
  for (const path of wrote) process.stdout.write(`wrote ${path}\n`);
  for (const path of plan.unchanged) process.stdout.write(`unchanged ${path}\n`);
  for (const path of plan.orphans) process.stdout.write(`orphan ${path}\n`);
  return 0;
}

/**
 * `generate [--check] [--root <dir>]` — render every output for the sources
 * under <root>/.rad/ (root defaults to the repo root). Default mode writes them;
 * `--check` writes nothing and reports `drift <path>` (missing or differing)
 * and `orphan <path>` (a marked file with no source). An unmarked file at an
 * output path is a conflict: named on stderr, and nothing is written.
 *
 * Exit 0 clean or written; 1 drift or orphans under --check; 2 bad argv, no
 * .rad/, a source error, or any conflict.
 *
 * @param {string[]} argv - args after `generate`
 * @param {{ repoRoot: string }} ctx
 * @returns {Promise<number>}
 */
export async function generateCommand(argv, ctx) {
  let args;
  try {
    args = parseGenerateArgs(argv);
  } catch (err) {
    process.stderr.write(`${GENERATE_PREFIX}: ${err.message}\nUsage: ${GENERATE_USAGE}\n`);
    return USAGE_EXIT_CODE;
  }
  const root = args.root ? resolve(args.root) : ctx.repoRoot;
  const read = await readSources(root);
  if (!read.ok) return reportGenerateErrors(read.errors);
  const rendered = renderOutputs(read.sources);
  if (!rendered.ok) return reportGenerateErrors(rendered.errors);
  const plan = planGenerate(root, rendered.outputs);
  if (plan.conflicts.length) return reportGenerateConflicts(plan.conflicts);
  return args.check ? reportGenerateCheck(plan) : writeGenerated(root, plan);
}

/**
 * True when `invokedPath` (process.argv[1]) names this module. Both sides are
 * compared by realpath: import.meta.url is always the real path, while argv[1]
 * is the path as invoked — through a symlink a raw compare is false and main()
 * silently never runs (#168, a fail-open gate bypass). If realpath throws (the
 * invoked path does not exist) the raw strings are compared instead, which can
 * only under-match, never run main() for a foreign path.
 *
 * @param {string | undefined} invokedPath - process.argv[1]
 * @param {string} modulePath - fileURLToPath(import.meta.url)
 * @returns {boolean}
 */
export function isMainModule(invokedPath, modulePath) {
  if (!invokedPath) return false;
  let invoked;
  let self;
  try {
    invoked = realpathSync(invokedPath);
    self = realpathSync(modulePath);
  } catch {
    return invokedPath === modulePath;
  }
  return invoked === self;
}

// Run only when invoked as a script (not when imported by a test).
if (isMainModule(process.argv[1], fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`rad: ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
