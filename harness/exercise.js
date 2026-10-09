// `rad exercise` — runs a plan's optional `## Exercise` block against the built
// branch. This file holds the pure block parser (no I/O, never throws) and the
// isolated recipe runner (Launch process group, Teardown, detached worktree).
// It must not import harness/cli.js (agent resolution and config are injected).

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildChildEnv, KILL_GRACE_MS } from './adapters/agent/command.js';
import { sanitizeErrorMessage } from './adapters/agent/contract.js';
import { runCommandPrompt } from './adapters/agent/command.js';
import { makeWorktreeLifecycle } from './adapters/worktree.js';
import { defaultSh } from './adapters/git-state-store.js';
import { parseFindings } from './review.js';

const SHELL = '/bin/sh';
const OUTPUT_TAIL_CHARS = 4000;
const GROUP_POLL_MS = 25;
const TEARDOWN_TIMEOUT_MS = 60_000;
const WORKTREE_NAME_PREFIX = 'exercise-';

const EXERCISE_HEADING = /^##\s+Exercise\s*$/i;
const CRITERIA_HEADING = /^##\s+Acceptance Criteria\s*$/i;
const LEVEL2_HEADING = /^##\s/;
const NUMBERED_CRITERION = /^(?:[-*]\s+)?(?:AC#)?(\d+)[.:)]\s/;
// `Key:` or `Key (qualifier):` at the start of a line, optionally bulleted.
const KEY_LINE = /^(?:[-*]\s+)?([A-Z][A-Za-z]*)(?:\s*\(([^)]*)\))?\s*:\s*(.*)$/;
const AC_REF = /^AC#(\d+)$/i;
const COMMAND_KEYS = { launch: 'launch', teardown: 'teardown' };

function emptyBlock() {
  return { present: false, launch: null, teardown: null, drive: null, observes: [], warnings: [] };
}

function splitLines(text) {
  return text.split(/\r?\n/);
}

/** Numbers of the plan's numbered Acceptance Criteria (`1. ...` or `- AC#1: ...`). */
function criterionNumbers(lines) {
  const numbers = new Set();
  let inCriteria = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (LEVEL2_HEADING.test(trimmed)) {
      inCriteria = CRITERIA_HEADING.test(trimmed);
      continue;
    }
    const m = inCriteria ? NUMBERED_CRITERION.exec(trimmed) : null;
    if (m) numbers.add(Number(m[1]));
  }
  return numbers;
}

/** Lines of the `## Exercise` section, or null when the plan has none. */
function exerciseLines(lines) {
  const start = lines.findIndex((l) => EXERCISE_HEADING.test(l.trim()));
  if (start === -1) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (LEVEL2_HEADING.test(line.trim())) break;
    body.push(line);
  }
  return body;
}

function stripBackticks(value) {
  const m = /^`([^`]*)`$/.exec(value.trim());
  return (m ? m[1] : value).trim();
}

function recordObserve(block, qualifier, text, criteria) {
  const ref = qualifier === undefined ? null : AC_REF.exec(qualifier.trim());
  const ac = ref ? Number(ref[1]) : null;
  if (ac === null) {
    block.warnings.push(`Observe line has no (AC#N): "${text}"`);
  } else if (!criteria.has(ac)) {
    block.warnings.push(`Observe references AC#${ac}, which is not among the plan's numbered Acceptance Criteria`);
  }
  block.observes.push({ ac, text });
}

function recordKey(block, key, qualifier, value, criteria) {
  const name = key.toLowerCase();
  if (name === 'observe') return recordObserve(block, qualifier, value.trim(), criteria);
  if (name === 'drive') {
    block.drive = value.trim() || null;
  } else if (COMMAND_KEYS[name]) {
    const command = stripBackticks(value);
    if (command === '') block.warnings.push(`${key}: is empty`);
    block[COMMAND_KEYS[name]] = command || null;
  } else {
    block.warnings.push(`unknown key "${key}:" in the Exercise block`);
  }
}

/**
 * Parses the optional `## Exercise` section of a plan doc.
 * `present` is true only when at least one Observe line exists; a block without
 * one is treated as absent (and warned about). Warnings are advisory, never errors.
 *
 * @param {string} planText
 * @returns {{present: boolean, launch: string|null, teardown: string|null,
 *            drive: string|null, observes: {ac: number|null, text: string}[], warnings: string[]}}
 */
export function parseExerciseBlock(planText) {
  const block = emptyBlock();
  if (typeof planText !== 'string') return block;
  const lines = splitLines(planText);
  const body = exerciseLines(lines);
  if (body === null) return block;

  const criteria = criterionNumbers(lines);
  for (const line of body) {
    const m = KEY_LINE.exec(line.trim());
    if (m) recordKey(block, m[1], m[2], m[3], criteria);
  }
  block.present = block.observes.length > 0;
  if (!block.present) block.warnings.push('Exercise block has no Observe lines; it will be skipped');
  return block;
}

// ---------------------------------------------------------------------------
// Isolated recipe runner
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True while any process in group `pid` is alive (signal 0 probes only). */
function groupAlive(pid, killFn) {
  try {
    killFn(-pid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    return true; // EPERM: the group exists but is not ours to signal
  }
}

/** Signal the whole group; ESRCH (already gone) is the expected race. */
function signalGroup(pid, signal, killFn, log) {
  try {
    killFn(-pid, signal);
  } catch (err) {
    if (err?.code === 'ESRCH') return;
    log(`rad exercise: failed to send ${signal} to launch group ${pid}: ${err?.message ?? err}\n`);
  }
}

/**
 * Start `command` via `/bin/sh -c` in `cwd` as the leader of its own process
 * group, under the agent adapter's env allow-list. Never throws: a spawn
 * failure resolves `exited` with `{ code: null, signal: null, error }`.
 *
 * @returns {{ pid: number|undefined, tail: () => string,
 *             hasExited: () => boolean,
 *             exited: Promise<{code: number|null, signal: string|null, error?: string}> }}
 */
export function startLaunch({ command, cwd, env = buildChildEnv(), spawnFn = spawn }) {
  let tail = '';
  let done = false;
  const append = (chunk) => {
    tail = (tail + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
  };
  let child;
  let settle;
  const exited = new Promise((resolve) => { settle = resolve; });
  const finish = (result) => {
    if (done) return;
    done = true;
    settle(result);
  };
  try {
    child = spawnFn(SHELL, ['-c', command], {
      cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    finish({ code: null, signal: null, error: sanitizeErrorMessage(err?.message ?? String(err)) });
    return { pid: undefined, tail: () => tail, hasExited: () => done, exited };
  }
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('error', (err) => finish({
    code: null, signal: null, error: sanitizeErrorMessage(err?.message ?? String(err)),
  }));
  child.on('close', (code, signal) => finish({ code, signal }));
  return { pid: child.pid, tail: () => tail, hasExited: () => done, exited };
}

/**
 * Terminate the Launch process group: SIGTERM to `-pid`, then SIGKILL after the
 * grace period if any member (e.g. a grandchild) is still alive. Resolves once
 * the group is gone or the kill has been sent. Never throws.
 */
export async function stopGroup(launch, {
  killGraceMs = KILL_GRACE_MS,
  killFn = process.kill,
  log = (m) => process.stderr.write(m),
} = {}) {
  const pid = launch?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return;
  signalGroup(pid, 'SIGTERM', killFn, log);
  const deadline = Date.now() + killGraceMs;
  while (groupAlive(pid, killFn) && Date.now() < deadline) await sleep(GROUP_POLL_MS);
  if (!groupAlive(pid, killFn)) return;
  signalGroup(pid, 'SIGKILL', killFn, log);
  const killDeadline = Date.now() + killGraceMs;
  while (groupAlive(pid, killFn) && Date.now() < killDeadline) await sleep(GROUP_POLL_MS);
}

/**
 * Run `Teardown:` under the same scrubbed env. A failure (non-zero exit, signal,
 * spawn error, timeout) is logged to stderr with its exit code and returned as
 * `ok: false`; it never throws, so it cannot change the command's exit code.
 *
 * @returns {{ ok: boolean, code: number|null, output: string }}
 */
export function runTeardown({
  command, cwd, env = buildChildEnv(), timeoutMs = TEARDOWN_TIMEOUT_MS,
  spawnSyncFn = spawnSync, log = (m) => process.stderr.write(m),
}) {
  if (!command) return { ok: true, code: 0, output: '' };
  const r = spawnSyncFn(SHELL, ['-c', command], {
    cwd, env, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-OUTPUT_TAIL_CHARS);
  const code = typeof r.status === 'number' ? r.status : null;
  if (r.error || code !== 0) {
    const reason = sanitizeErrorMessage(r.error?.message ?? (r.signal ? `signal ${r.signal}` : output));
    log(`rad exercise: teardown failed (exit code ${code ?? 'none'}): ${reason}\n`);
    return { ok: false, code, output };
  }
  return { ok: true, code, output };
}

/** Name of the throwaway worktree for `feature`. */
export function exerciseWorktreeName(feature) {
  return `${WORKTREE_NAME_PREFIX}${feature}`;
}

/**
 * Create a detached worktree at commit `tip` (a SHA, so the branch stays free in
 * the main checkout), run `fn(dir)`, and always remove the worktree afterwards.
 * A removal failure is logged and never masks `fn`'s result or error. A create
 * failure propagates (nothing to clean up).
 *
 * @param {{ create(name: string, ref: string): string, complete(name: string, dir?: string): void }} worktree
 */
export async function withDetachedWorktree({
  worktree, feature, tip, fn, log = (m) => process.stderr.write(m),
}) {
  const name = exerciseWorktreeName(feature);
  const dir = worktree.create(name, tip);
  try {
    return await fn(dir);
  } finally {
    try {
      worktree.complete(name, dir);
    } catch (err) {
      log(`rad exercise: worktree removal failed: ${sanitizeErrorMessage(err?.message ?? String(err))}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// The `rad exercise` command
// ---------------------------------------------------------------------------

export const EXERCISE_USAGE = 'rad exercise <feature> [--check]';
const USAGE_EXIT = 2;
const FAILED_EXIT = 1;
const FEATURE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const TIMEOUT_ENV = 'RAD_EXERCISE_TIMEOUT_SECONDS';
const BLOCKING_ENV = 'RAD_EXERCISE_BLOCKING';
const DEFAULT_TIMEOUT_SECONDS = 600;
const LAUNCH_SETTLE_MS = 1000;
const MIN_AGENT_MS = 1000;
const TRUTHY = new Set(['1', 'true']);
const FALSY = new Set(['', '0', 'false']);
const CRITERION_TEXT = /^(?:[-*]\s+)?(?:AC#)?(\d+)[.:)]\s+(.*)$/;

/** `<feature> [--check]`; throws on anything else. */
function parseExerciseArgs(argv) {
  const out = { check: false };
  for (const arg of argv) {
    if (arg === '--check') out.check = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option '${arg}'`);
    else if (out.feature === undefined) out.feature = arg;
    else throw new Error(`unexpected argument '${arg}'`);
  }
  if (!out.feature) throw new Error('a feature name is required');
  if (!FEATURE_PATTERN.test(out.feature)) throw new Error(`invalid feature name '${out.feature}'`);
  return out;
}

/** Env knobs → { timeoutMs, mode }; throws on a malformed value. */
function readKnobs(env) {
  const rawTimeout = env[TIMEOUT_ENV];
  let timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000;
  if (rawTimeout !== undefined && rawTimeout !== '') {
    if (!POSITIVE_INTEGER.test(rawTimeout)) {
      throw new Error(`${TIMEOUT_ENV} must be a positive integer (got '${rawTimeout}')`);
    }
    timeoutMs = Number(rawTimeout) * 1000;
  }
  const rawBlocking = (env[BLOCKING_ENV] ?? '').trim().toLowerCase();
  if (!TRUTHY.has(rawBlocking) && !FALSY.has(rawBlocking)) {
    throw new Error(`${BLOCKING_ENV} must be 1, true, 0, false or empty (got '${env[BLOCKING_ENV]}')`);
  }
  return { timeoutMs, mode: TRUTHY.has(rawBlocking) ? 'blocking' : 'observe-only' };
}

/** AC number → criterion text, from the plan's numbered Acceptance Criteria. */
function criterionTexts(planText) {
  const texts = new Map();
  let inCriteria = false;
  for (const line of splitLines(planText)) {
    const trimmed = line.trim();
    if (LEVEL2_HEADING.test(trimmed)) {
      inCriteria = CRITERIA_HEADING.test(trimmed);
      continue;
    }
    const m = inCriteria ? CRITERION_TEXT.exec(trimmed) : null;
    if (m) texts.set(Number(m[1]), m[2]);
  }
  return texts;
}

/** The agent prompt: what to drive, what to observe, Launch's output so far. */
export function buildExercisePrompt(block, planText, launchTail) {
  const texts = criterionTexts(planText);
  const observes = block.observes.map((o) => {
    const ac = o.ac === null ? '' : ` (AC#${o.ac}${texts.has(o.ac) ? `: ${texts.get(o.ac)}` : ''})`;
    return `- Observe${ac}: ${o.text}`;
  });
  return [
    'You are exercising a built branch against its approved plan. Launch has already started the app in this directory.',
    '',
    `Drive: ${block.drive ?? '(none given)'}`,
    '',
    'Observe:',
    ...observes,
    '',
    'Launch output (tail):',
    '```',
    launchTail.trim() || '(no output yet)',
    '```',
    '',
    'Report what you observed. End your response with a ````rad-findings block holding a JSON object',
    '{"findings": [...]}; every finding uses "reviewer": "exercise" and "category": "behavior".',
    'An empty findings array means every Observe line held.',
  ].join('\n');
}

function summaryLine({ feature, agent, mode, findings, error, status }) {
  if (status) return `rad exercise: feature=${feature} status=${status} mode=${mode}\n`;
  const executable = basename(agent.cmd.trim().split(/\s+/)[0]);
  const count = findings ? String(findings.findings.length) : 'none';
  let line = `rad exercise: feature=${feature} agent=${agent.source} executable=${executable} mode=${mode} findings=${count}`;
  if (error) {
    const safe = sanitizeErrorMessage(String(error)).replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
    line += ` error="${safe}"`;
  }
  return `${line}\n`;
}

/** Throwing wrapper: the branch tip commit SHA, so the worktree is detached. */
function branchTip({ sh, repoRoot, feature }) {
  const r = sh('git', ['rev-parse', '--verify', `rad/${feature}^{commit}`], { cwd: repoRoot });
  const tip = String(r.stdout ?? '').trim();
  if (r.status !== 0 || !tip) throw new Error(`cannot resolve branch rad/${feature}`);
  return tip;
}

/** Launch → agent → cleanup inside `dir`; returns { result, launchFailure }. */
async function runInWorktree({ dir, block, planText, agent, deadline, ctx, run }) {
  const launch = block.launch ? startLaunch({ command: block.launch, cwd: dir }) : null;
  try {
    if (launch) {
      await Promise.race([launch.exited, sleep(ctx.launchSettleMs ?? LAUNCH_SETTLE_MS)]);
      const early = launch.hasExited() ? await launch.exited : null;
      if (early && (early.error || early.code !== 0)) {
        return { launchFailure: early.error ?? `Launch exited with code ${early.code ?? early.signal}` };
      }
    }
    const result = await run({
      cmd: agent.cmd,
      prompt: buildExercisePrompt(block, planText, launch ? launch.tail() : ''),
      repoRoot: dir,
      timeoutMs: Math.max(deadline - Date.now(), MIN_AGENT_MS),
      label: 'rad exercise',
    });
    const done = launch?.hasExited() ? await launch.exited : null;
    if (done && (done.error || done.code !== 0)) {
      return { launchFailure: done.error ?? `Launch exited with code ${done.code ?? done.signal} before the agent returned` };
    }
    return { result };
  } finally {
    if (launch) await stopGroup(launch, { killGraceMs: ctx.killGraceMs });
    runTeardown({ command: block.teardown, cwd: dir });
  }
}

/** Plan text, or null (after writing the reason) when unreadable. */
function readPlan(repoRoot, feature) {
  try {
    return readFileSync(join(repoRoot, '.agents', 'plans', `${feature}.md`), 'utf8');
  } catch (err) {
    process.stderr.write(`rad exercise: cannot read plan doc .agents/plans/${feature}.md: ${err.code ?? err.message}\n`);
    return null;
  }
}

function usageError(message) {
  process.stderr.write(`rad exercise: ${message}\nUsage: ${EXERCISE_USAGE}\n`);
  return USAGE_EXIT;
}

/** Validate argv, plan and env knobs → run inputs, or { code } after the reason is written. */
function prepareExercise(argv, ctx, env) {
  let args;
  try {
    args = parseExerciseArgs(argv);
  } catch (err) {
    return { code: usageError(err.message) };
  }
  const planText = readPlan(ctx.repoRoot, args.feature);
  if (planText === null) return { code: USAGE_EXIT };
  const block = parseExerciseBlock(planText);
  if (args.check) {
    for (const w of block.warnings) process.stdout.write(`warning: ${w}\n`);
    return { code: 0 };
  }
  let knobs;
  try {
    knobs = readKnobs(env);
  } catch (err) {
    return { code: usageError(err.message) };
  }
  return { args, planText, block, ...knobs };
}

/**
 * `exercise <feature> [--check]` — run the plan's `## Exercise` block against
 * the branch tip in a throwaway detached worktree. Not a security sandbox: the
 * approved plan is the control. Exit 0 with a parsed rad-findings block (or a
 * skip / --check); 1 when Launch or the agent fails or no findings parse; 2 on
 * usage, config or env errors.
 *
 * @param {string[]} argv
 * @param {{ repoRoot: string, env?: Object, sh?: Function,
 *   resolveAgent: (env: Object) => Promise<{agent: {cmd: string, source: string}} | {code: number}>,
 *   runCommandPrompt?: Function, launchSettleMs?: number, killGraceMs?: number }} ctx
 * @returns {Promise<number>}
 */
export async function exerciseCommand(argv, ctx) {
  const env = ctx.env ?? process.env;
  const prep = prepareExercise(argv, ctx, env);
  if (prep.code !== undefined) return prep.code;
  const { args, planText, block, timeoutMs, mode } = prep;
  const { feature } = args;
  for (const w of block.warnings) process.stderr.write(`warning: ${w}\n`);
  if (!block.present) {
    process.stdout.write('Exercise: skipped (no recipe)\n');
    process.stderr.write(summaryLine({ feature, mode, status: 'skipped' }));
    return 0;
  }
  const resolved = await ctx.resolveAgent(env);
  if (resolved.code !== undefined) return resolved.code;
  const { agent } = resolved;
  const sh = ctx.sh ?? defaultSh;
  const outcome = await executeExercise({ ctx, sh, feature, block, planText, agent, timeoutMs });
  const findings = outcome.error === undefined && outcome.result.ok ? parseFindings(outcome.result.stdout) : null;
  const error = outcome.error ?? (outcome.result.ok ? (findings ? undefined : 'no parsable rad-findings block') : outcome.result.error);
  if (error === undefined) process.stdout.write(outcome.result.stdout ?? '');
  process.stderr.write(summaryLine({ feature, agent, mode, findings, error }));
  return error === undefined ? 0 : FAILED_EXIT;
}

/** Worktree + run; folds every setup/launch failure into { error }. */
async function executeExercise({ ctx, sh, feature, block, planText, agent, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  const run = ctx.runCommandPrompt ?? runCommandPrompt;
  const worktree = makeWorktreeLifecycle({
    sh: (file, a) => sh(file, a, { cwd: ctx.repoRoot }),
    now: () => new Date().toISOString(),
  });
  try {
    const tip = branchTip({ sh, repoRoot: ctx.repoRoot, feature });
    const out = await withDetachedWorktree({
      worktree, feature, tip,
      fn: (dir) => runInWorktree({ dir, block, planText, agent, deadline, ctx, run }),
    });
    return out.launchFailure ? { error: `Launch failed: ${out.launchFailure}` } : out;
  } catch (err) {
    return { error: err?.message ?? String(err) };
  }
}
