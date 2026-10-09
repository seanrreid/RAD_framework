// `rad exercise` — runs a plan's optional `## Exercise` block against the built
// branch. This file holds the pure block parser (no I/O, never throws) and the
// isolated recipe runner (Launch process group, Teardown, detached worktree).
// It must not import harness/cli.js (agent resolution and config are injected).

import { spawn, spawnSync } from 'node:child_process';
import { buildChildEnv, KILL_GRACE_MS } from './adapters/agent/command.js';
import { sanitizeErrorMessage } from './adapters/agent/contract.js';

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
