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
import { evaluateGate } from './gates.js';
import { makeWorktreeLifecycle } from './adapters/worktree.js';
import { deliverSpine } from './spine.js';
import { createCommandAdapter } from './adapters/agent/command.js';
import { sanitizeErrorMessage } from './adapters/agent/contract.js';
import { loadMatrix } from './matrix.js';

const SUBCOMMANDS = {
  approve: {
    summary: 'Record an architect approval (event + plan-doc Status) on the work branch.',
    usage: 'rad approve <feature> [--on-behalf-of <name>] [--evidence <text>]',
    // run is wired below, after the command is defined, to keep the table near
    // the top of the file while letting the implementation read top-down.
    run: (argv, ctx) => approveCommand(argv, ctx),
  },
  deliver: {
    summary: 'Run approved plan wave execution via Claude Agent SDK.',
    usage: 'rad deliver <feature> [--model <model-id>]',
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
 * Hand-rolled argv parser for `deliver`. Returns the positional feature and the
 * optional `--model <id>` value. Throws on a flag that is missing its value or
 * on extra positionals so malformed invocations fail loudly.
 *
 * @param {string[]} argv
 * @returns {{ feature?: string, model: string }}
 */
function parseDeliverArgs(argv) {
  let feature;
  let model = 'claude-opus-4-8';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--model') {
      const val = argv[i + 1];
      if (val === undefined) throw new Error('--model requires a value');
      model = val;
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option '${arg}'`);
    } else if (feature === undefined) {
      feature = arg;
    } else {
      throw new Error(`unexpected argument '${arg}'`);
    }
  }

  return { feature, model };
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
 * Parse a plan doc text to extract the planCtx fields needed by runWave.
 *
 * @param {string} text - full plan doc text
 * @returns {{ branch: string, acceptanceCriteria: string[], waveModels: Record<number, string>, executionNotes: { doNotTouch: string[], keyFiles: string[], reminders: string[] } }}
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
    executionNotes: { doNotTouch, keyFiles, reminders },
  };
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
    process.stdout.write('Usage: rad deliver <feature> [--model <model-id>]\n');
    process.stdout.write('\nRun approved plan wave execution via Claude Agent SDK.\n');
    return 0;
  }

  let parsed;
  try {
    parsed = parseDeliverArgs(argv);
  } catch (err) {
    process.stderr.write(`rad deliver: ${err.message}\n`);
    process.stderr.write('Usage: rad deliver <feature> [--model <model-id>]\n');
    return 1;
  }

  const { feature, model } = parsed;

  if (!isNonEmpty(feature)) {
    process.stderr.write('rad deliver: a feature name is required\n');
    process.stderr.write('Usage: rad deliver <feature> [--model <model-id>]\n');
    return 1;
  }

  // Adapter selection (ENV-driven, no config-file loader). RAD_AGENT picks the
  // runner: 'command' (default, vendor-neutral CLI) or 'sdk' (Anthropic SDK).
  // Credential requirements differ per path and are validated below, just
  // before constructing the chosen adapter — an injected ctx.runWave (tests)
  // skips construction and therefore skips the credential check entirely.
  const agentKind = isNonEmpty(process.env.RAD_AGENT) ? process.env.RAD_AGENT.trim() : 'command';
  if (!ctx.runWave && agentKind !== 'command' && agentKind !== 'sdk') {
    process.stderr.write(`rad deliver: unknown RAD_AGENT '${agentKind}' (expected 'command' or 'sdk')\n`);
    return 1;
  }

  const planFile = join(repoRoot, '.agents', 'plans', `${feature}.md`);
  if (!existsSync(planFile)) {
    process.stderr.write(`rad deliver: no plan doc at .agents/plans/${feature}.md\n`);
    return 1;
  }

  // Read and parse the plan file for planCtx (execution notes, branch, AC list).
  const planText = readFileSync(planFile, 'utf8');
  const planCtx = parsePlanCtx(planText);
  planCtx.feature = feature;
  planCtx.executionLog = `.agents/logs/${feature}-${new Date().toISOString().slice(0, 10)}.md`;

  const claudeMd = join(repoRoot, 'CLAUDE.md');
  const state = createGitStateStore({ repoRoot, sh, claudeMd });

  // Gate check: approved status must be established before any wave execution.
  const g = await state.gate(feature, 'approved');
  if (!g.passed) {
    process.stderr.write(`rad deliver: gate not passed for '${feature}' — ${g.reason}\n`);
    return 1;
  }

  // Accept an injected runWave (for tests) or construct the selected adapter.
  let runWave;
  if (ctx.runWave) {
    runWave = ctx.runWave;
  } else if (agentKind === 'sdk') {
    // SDK path: requires ANTHROPIC_API_KEY (checked before any SDK construction
    // or model call). Credentials are the SDK's concern, not the command path's.
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!isNonEmpty(apiKey)) {
      process.stderr.write('rad deliver: ANTHROPIC_API_KEY is required\n');
      return 1;
    }
    // Lazy-load the SDK adapter: only the sdk branch imports it, so cli.js (and
    // the gate/approve/command paths) load with the SDK absent.
    const { createRunWave } = await import('./adapters/agent/sdk.js');
    const adapter = createRunWave({ apiKey, model, repoRoot });
    // Bind planCtx so deliverSpine's single-argument runWave(wave) call works.
    runWave = (wave) => adapter(wave, planCtx);
  } else {
    // Command path (default): no ANTHROPIC_API_KEY required — credentials are
    // the configured command's concern. RAD_AGENT_CMD is mandatory here.
    const cmd = process.env.RAD_AGENT_CMD;
    if (!isNonEmpty(cmd)) {
      process.stderr.write('rad deliver: RAD_AGENT_CMD is required when RAD_AGENT=command\n');
      return 1;
    }
    const adapter = createCommandAdapter({ cmd, repoRoot, model });
    runWave = (wave) => adapter(wave, planCtx);
  }

  const matrix = loadMatrix();

  // Optional cumulative token budget. RAD_TOKEN_BUDGET, when a positive integer,
  // arms the spine's budget breaker; unset/invalid/0 leaves it null (disabled).
  const parsedBudget = Number.parseInt(process.env.RAD_TOKEN_BUDGET, 10);
  const tokenBudget = Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : null;

  // Optional worktree isolation. RAD_WORKTREE follows the env-knob convention:
  // unset/empty = OFF (exact today's behavior — main checkout, no worktree port,
  // sh bound to repoRoot); any non-empty value = ON. When ON, the deliver run is
  // isolated into a git worktree on the work branch so every check-*.sh / open-pr.sh
  // runs against an isolated tree. RAD_WORKTREE_DIR (optional base dir) is read by
  // the lifecycle script itself, so we just let it flow through the environment.
  const worktreeEnabled = isNonEmpty(process.env.RAD_WORKTREE);

  // shCwd is the directory the spine's scripts run in: repoRoot today, the
  // worktree path when isolation is enabled. Defaults to repoRoot so the OFF
  // path is byte-for-byte unchanged.
  let shCwd = repoRoot;
  let worktree = null;
  if (worktreeEnabled) {
    // The lifecycle adapter shells out via the same sh port, pinned to repoRoot so
    // `git worktree` and the script path resolve against the main checkout.
    worktree = makeWorktreeLifecycle({
      sh: (file, args) => sh(file, args, { cwd: repoRoot }),
      now: () => new Date().toISOString(),
    });
    // The work branch is the SAME rad/<feature> branch this deliver runs on. A git
    // worktree cannot check out a branch already checked out in the main tree, so
    // `git worktree add <dir> <branch>` will fail with a clear error if the main
    // checkout is currently on the work branch. v1 surfaces that failure rather
    // than detaching/relocating: RAD_WORKTREE requires the work branch not be
    // checked out in the main tree. The plan's `Branch:` header is canonical;
    // fall back to the rad/<feature> convention when it is absent.
    const workBranch = isNonEmpty(planCtx.branch) ? planCtx.branch : `rad/${feature}`;
    try {
      shCwd = worktree.create(feature, workBranch);
    } catch (err) {
      const safe = sanitizeErrorMessage(err?.message ?? String(err));
      process.stderr.write(`rad deliver: worktree create failed — ${safe}\n`);
      return 1;
    }
  }

  let result;
  try {
    result = await deliverSpine({
      feature,
      state,
      docs: null,
      matrix,
      gates: null,
      runWave,
      sh: (script, feat) => sh(join(repoRoot, script), [feat], { cwd: shCwd }),
      now: () => new Date().toISOString(),
      tokenBudget,
    });
  } catch (err) {
    // Unexpected spine throw: still preserve the worktree (so the operator can
    // inspect it) before rethrowing-as-exit. Cleanup is keyed off the returned
    // terminal object below for the normal path; this guards the abnormal one.
    if (worktree) {
      try { worktree.preserve(feature); } catch { /* preserve is best-effort here */ }
    }
    // Sanitize: a deep spine/SDK error could otherwise surface a credential.
    const safe = sanitizeErrorMessage(err?.message ?? String(err));
    process.stderr.write(`rad deliver: unexpected error — ${safe}\n`);
    return 1;
  }

  // Worktree cleanup, keyed off the spine's terminal-result shape: complete (tear
  // down) on success, preserve (keep for inspection) on any stopped terminal.
  if (worktree) {
    if (result.ok) {
      worktree.complete(feature);
    } else {
      worktree.preserve(feature);
    }
  }

  if (result.ok) {
    process.stdout.write(
      `rad deliver: ok feature=${feature} waves=${result.waves} status=complete\n`,
    );
    return 0;
  }

  // Structured failure line (machine-greppable). When a worktree was preserved,
  // surface its path so the operator can find the isolated tree.
  process.stderr.write(
    `rad deliver: failed feature=${feature} stopped=${result.stopped}` +
    (result.wave !== undefined ? ` wave=${result.wave}` : '') +
    (result.action ? ` action=${result.action}` : '') +
    (result.check ? ` check=${result.check}` : '') +
    (result.spent !== undefined ? ` spent=${result.spent}` : '') +
    (result.budget !== undefined ? ` budget=${result.budget}` : '') +
    (worktree ? ` worktree=${shCwd}` : '') +
    '\n',
  );
  return 1;
}

/**
 * Bootstrap dual-write part (b): write the plan-doc Status header fields so the
 * existing `/rad-deliver` gate (check-plan-approved.sh, which reads the doc
 * Status) passes. Updates `Status`, `Approved-By`, `Approved-At` in place, and
 * in proxy mode also `Recorded-By` and `Approval-Evidence` (inserted after the
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
    // Non-proxy mirror of the recorder (e.g. the severity-gate policy path, where
    // recordedBy='policy'). Direct human approval omits it (recorder == approver).
    upsert('Recorded-By', fields.recordedBy);
  }

  writeFileSync(planFile, lines.join('\n'), 'utf8');
}

/**
 * Run the deterministic severity classifier (scripts/classify-low-risk.sh) over
 * a plan file. Returns `{ low, patterns }`.
 *
 * FAIL-CLOSED: the verdict is LOW only on an exit code of exactly 0. Any
 * non-zero exit (not-low, usage error, unset allowlist) OR a spawn failure
 * (script missing / not executable) yields `{ low: false }` — the caller falls
 * through to the human-approval path. We never auto-clear on uncertainty.
 *
 * `patterns` is parsed from the script's `low-risk patterns: <value>` stdout
 * line so the policy event can record WHY the change cleared. It is best-effort
 * audit metadata only; it never affects the low/not-low decision.
 *
 * @param {string} repoRoot
 * @param {string} planFile - absolute path to the plan doc being approved
 * @param {typeof defaultSh} sh - injectable shell-out helper
 * @returns {{ low: boolean, patterns: string[] }}
 */
function classifyLowRisk(repoRoot, planFile, sh) {
  const script = join(repoRoot, 'scripts', 'classify-low-risk.sh');
  if (!existsSync(script)) return { low: false, patterns: [] };

  const res = sh(script, [planFile], { cwd: repoRoot });
  if (res.status !== 0) return { low: false, patterns: [] };

  // Parse `low-risk patterns: <value>` from stdout (best-effort audit metadata).
  let patterns = [];
  for (const line of (res.stdout || '').split('\n')) {
    const m = /^low-risk patterns:\s*(.+)$/.exec(line.trim());
    if (m && m[1].trim() !== '<unset>') {
      patterns = m[1]
        .split('|')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
    }
  }
  return { low: true, patterns };
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

  const planFile = join(repoRoot, '.agents', 'plans', `${feature}.md`);
  if (!existsSync(planFile)) {
    process.stderr.write(`rad approve: no plan doc at .agents/plans/${feature}.md\n`);
    return 1;
  }

  const store = createGitStateStore({ repoRoot, sh, claudeMd });

  // ── Severity-routed auto-clear (pre-branch) ───────────────────────────────
  // BEFORE the human-approval path, ask the deterministic classifier whether
  // this plan's scope is provably LOW risk (auto-clearable). The classifier is
  // fail-closed: only an exit code of 0 (LOW) takes the policy path; any
  // non-zero exit, a spawn failure, or an unset allowlist falls through to the
  // UNCHANGED human path below. Proxy-mode (--on-behalf-of) is an explicit human
  // judgment already in hand, so it never auto-clears.
  if (!isNonEmpty(onBehalfOf)) {
    const verdict = classifyLowRisk(repoRoot, planFile, sh);
    if (verdict.low) {
      const ts = new Date().toISOString();
      const scope = store.plan(feature)?.files ?? [];
      try {
        store.recordPolicyApproval({
          feature,
          patterns: verdict.patterns,
          scope,
          ts,
        });
      } catch (err) {
        process.stderr.write(`rad approve: cannot record policy approval — ${err.message}\n`);
        return 1;
      }
      writePlanStatus(planFile, {
        approvedBy: 'severity-gate',
        approvedAt: ts,
        recordedBy: 'policy',
      });
      process.stdout.write(
        `rad approve: ok feature=${feature} status=approved approved-by=severity-gate recorded-by=policy approved-at=${ts} auto-clear=true reason=low-risk\n`,
      );
      return 0;
    }
  }

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

  const ts = new Date().toISOString();

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
  const claudeMd = join(repoRoot, 'CLAUDE.md');
  const state = createGitStateStore({ repoRoot, sh, claudeMd });

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
  const raw = readFileSync(0, 'utf8'); // fd 0 = stdin
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
      const claudeMd = join(repoRoot, 'CLAUDE.md');
      const state = createGitStateStore({ repoRoot, sh, claudeMd });
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

// Run only when invoked as a script (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`rad: ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
