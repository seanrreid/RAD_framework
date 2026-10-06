/**
 * ACP (Agent Client Protocol) v1 wave adapter: the third provider adapter,
 * beside sdk.js and command.js. A hand-written, zero-dependency client: Node
 * built-ins only, never @agentclientprotocol/sdk.
 *
 * Interface (identical to the other adapters): runWave(wave, planCtx) -> result
 * with `outcome` + `status`, and the OPTIONAL `tasks`, `usage` and
 * `permissions` keys (omitted when there is nothing to report). The WAVE_RESULT
 * text path is contract.js, so identical turn text yields identical outcomes on
 * the command and acp paths.
 *
 * Wire: newline-delimited JSON-RPC 2.0 over the agent's stdio. Spec pinned to
 * protocolVersion 1 (https://agentclientprotocol.com/protocol/overview and the
 * v1 schema, schema/v1/schema.json in agentclientprotocol/agent-client-protocol,
 * checked 2026-10-06).
 *
 * Constraints:
 *   - Fail closed. Every unexpected protocol state ends the attempt with a named
 *     outcome; every await is bounded by the attempt deadline or a grace timer.
 *   - One process and one session per attempt; the process is shut down on every
 *     exit path, including thrown errors.
 *   - The child gets command.js's allow-listed env, never the full process.env.
 *   - RAD advertises no client capabilities (fs, terminal), so every agent
 *     request other than session/request_permission is answered -32601.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import {
  buildWavePrompt,
  extractWaveResultBlock,
  parseWaveResult,
  toWaveResult,
  resultToOutcome,
  syntheticFailure,
  sanitizeErrorMessage,
  normalizeUsage,
} from './contract.js';
import { buildChildEnv, tokenizeCommand, KILL_GRACE_MS, PREFLIGHT_TIMEOUT_MS } from './command.js';
import { DEFAULT_CAPABILITIES } from '../../capabilities.js';

/** The only ACP wire version RAD speaks. No negotiation up or down. */
export const ACP_PROTOCOL_VERSION = 1;

const JSONRPC_VERSION = '2.0';
/** JSON-RPC "method not found": the answer to every client method RAD does not serve. */
export const METHOD_NOT_FOUND = -32601;
const CLIENT_NAME = 'rad';
const CLIENT_VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;

/** Default wall-clock deadline per wave attempt (matches the command adapter). */
const DEFAULT_WAVE_TIMEOUT_MS = 600_000;
/** Hard cap on agent stdout; a flooding agent is killed rather than buffered into an OOM. */
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
/** Cap on captured stderr, and on the excerpts carried into failure messages. */
const STDERR_CAP_CHARS = 4_000;
const EXCERPT_CHARS = 500;
/** stdin error raised when the agent exits before reading; its exit decides the attempt. */
const STDIN_CLOSED_EARLY_CODE = 'EPIPE';

const PROTOCOL_FAILURE = 'fail-protocol';
const TIMEOUT_FAILURE = 'fail-timeout';
const SCOPE_FAILURE = 'fail-scope';

/** stopReasons whose turn text goes through the normal WAVE_RESULT parse. */
const PARSE_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'max_turn_requests']);
const REFUSAL_MESSAGE = 'agent refused the wave (ACP stopReason refusal)';
const MISSING_BLOCK_MESSAGE = 'No WAVE_RESULT block after one reprompt';
/** Sent once, in the same session, when a turn ends without a WAVE_RESULT block. */
const REPROMPT_TEXT =
  'Your previous response did not include the required WAVE_RESULT block. '
  + 'Reply with exactly one WAVE_RESULT ... END_WAVE_RESULT block for this wave, '
  + 'and nothing after it.';

/** The ordered `checkAcpAgent` checks; the run stops at the first failure. */
export const ACP_CHECK_NAMES = Object.freeze(['spawn', 'initialize', 'session/new', 'prompt', 'wave-result', 'shutdown']);
/** The one prompt `checkAcpAgent` sends: it asks for a fixed one-task WAVE_RESULT block. */
export const ACP_CHECK_PROMPT = [
  'This is a RAD ACP conformance check (rad acp-check). Do not use any tools and do not change any files.',
  'Reply with exactly this block and nothing after it:',
  '',
  'WAVE_RESULT', 'wave: 1', 'status: complete', 'tasks:',
  '  - title: ACP conformance check', '    status: complete', '    commit: —',
  '    concern: —', '    error: —', 'END_WAVE_RESULT',
].join('\n');

const INITIALIZE_PARAMS = Object.freeze({
  protocolVersion: ACP_PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
});

/**
 * ACP ToolKind -> RAD capability class. `other`, `switch_mode` and a missing
 * kind are deliberately absent: they are always refused.
 */
const TOOL_KIND_CLASS = Object.freeze({
  read: 'fs_read', search: 'fs_read', think: 'fs_read',
  edit: 'fs_write', delete: 'fs_write', move: 'fs_write',
  execute: 'shell',
  fetch: 'net',
});
const ALLOW_ONCE = 'allow_once';
const REJECT_ONCE = 'reject_once';

/**
 * Token fields mapped into normalizeUsage. Constraint: stable v1 `usage_update`
 * only carries `used` / `size` (context-window occupancy, not token spend) and
 * an optional `cost`, so a spec-conformant agent yields NO usage and the field
 * is omitted. These camelCase names are the UNSTABLE `Usage` type's
 * (schema.unstable.json); they are read off a usage_update only when an agent
 * sends them, never inferred from `used` / `size`.
 */
const ACP_USAGE_TOKEN_FIELDS = [
  ['inputTokens', 'input_tokens'],
  ['outputTokens', 'output_tokens'],
  ['totalTokens', 'total_tokens'],
  ['cachedReadTokens', 'cache_read_input_tokens'],
  ['cachedWriteTokens', 'cache_creation_input_tokens'],
];
/** normalizeUsage's `cost` is a USD figure; any other currency is left unmapped. */
const USAGE_COST_CURRENCY = 'USD';

/** A failure that ends one attempt with a named matrix outcome. */
class AcpFailure extends Error {
  constructor(outcome, message) {
    super(message);
    this.outcome = outcome;
  }
}

const protocolFailure = (message) => new AcpFailure(PROTOCOL_FAILURE, message);
const excerpt = (text) => sanitizeErrorMessage(String(text ?? '').slice(0, EXCERPT_CHARS));

/**
 * Tokenize RAD_AGENT_CMD for the acp path. A `{prompt}` placeholder is
 * rejected: the prompt travels over the protocol, never on argv.
 *
 * @param {string} cmd
 * @returns {string[]} argv
 */
function parseAgentCommand(cmd) {
  if (typeof cmd !== 'string' || cmd.trim() === '') {
    throw new Error('acp adapter: cmd is required (set RAD_AGENT_CMD)');
  }
  const { argv, usedPlaceholder } = tokenizeCommand(cmd, '', undefined);
  if (usedPlaceholder) {
    throw new Error('acp adapter: RAD_AGENT_CMD must not contain {prompt}; the prompt travels over ACP');
  }
  return argv;
}

// ── JSON-RPC connection over the agent's stdio ─────────────────────────────

/**
 * Send `signal` to a child that has not yet exited. ESRCH (it exited in
 * between) is the expected race; anything else is logged with context.
 */
function signalChild(child, signal) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(child.pid, signal);
  } catch (err) {
    if (err?.code === 'ESRCH') return;
    process.stderr.write(`acp adapter: failed to send ${signal} to agent pid ${child.pid}: ${err?.message ?? err}\n`);
  }
}

/** Write one message as a single line. JSON.stringify never emits a raw newline. */
function sendMessage(conn, message) {
  const { stdin } = conn.child;
  if (stdin.destroyed || !stdin.writable) return;
  stdin.write(`${JSON.stringify({ jsonrpc: JSONRPC_VERSION, ...message })}\n`);
}

/** End the connection: the first fatal error wins and rejects every pending request. */
function failConnection(conn, err) {
  if (conn.fatal) return;
  conn.fatal = err;
  for (const entry of conn.pending.values()) entry.reject(err);
  conn.pending.clear();
}

/** Settle the pending request a response answers; an unknown id is a protocol error. */
function settleResponse(conn, msg) {
  const entry = conn.pending.get(msg.id);
  if (!entry) {
    failConnection(conn, protocolFailure(`agent sent a response to unknown id ${JSON.stringify(msg.id)}`));
    return;
  }
  conn.pending.delete(msg.id);
  if (msg.error !== undefined && msg.error !== null) {
    const { code, message } = msg.error ?? {};
    entry.reject(protocolFailure(`agent returned an error for ${entry.method}: ${code} ${excerpt(message)}`));
    return;
  }
  entry.resolve(msg.result);
}

/** Parse and dispatch one stdout line. Anything that is not JSON-RPC 2.0 ends the session. */
function handleLine(conn, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    failConnection(conn, protocolFailure(`agent sent a line that is not JSON: ${excerpt(line)}`));
    return;
  }
  const isObject = msg !== null && typeof msg === 'object' && !Array.isArray(msg);
  if (!isObject || msg.jsonrpc !== JSONRPC_VERSION) {
    failConnection(conn, protocolFailure(`agent sent a message that is not JSON-RPC 2.0: ${excerpt(line)}`));
    return;
  }
  const hasId = msg.id !== undefined && msg.id !== null;
  if (typeof msg.method === 'string') {
    if (hasId) conn.handlers.onRequest(conn, msg);
    else conn.handlers.onNotification(conn, msg);
    return;
  }
  if (hasId && ('result' in msg || 'error' in msg)) {
    settleResponse(conn, msg);
    return;
  }
  failConnection(conn, protocolFailure(`agent sent an unrecognised JSON-RPC message: ${excerpt(line)}`));
}

/** Wire the child's streams and lifecycle events into the connection. */
function attachChildEvents(conn, markExited) {
  const { child } = conn;
  child.on('error', (err) => {
    failConnection(conn, protocolFailure(`could not run the ACP agent: ${err?.message ?? err}`));
    markExited();
  });
  child.on('close', (code, signal) => {
    const why = `agent process exited (code ${code}, signal ${signal}) before the session completed`;
    failConnection(conn, protocolFailure(`${why}: ${excerpt(conn.stderr)}`.trim()));
    markExited();
  });
  child.stdin.on('error', (err) => {
    if (err?.code === STDIN_CLOSED_EARLY_CODE) return;
    failConnection(conn, protocolFailure(`writing to the agent's stdin failed: ${err?.code ?? err?.message}`));
  });
  child.stderr.on('data', (chunk) => {
    if (conn.stderr.length < STDERR_CAP_CHARS) conn.stderr = (conn.stderr + chunk).slice(0, STDERR_CAP_CHARS);
  });
  child.stdout.on('data', (chunk) => {
    conn.stdoutBytes += chunk.length;
    if (conn.stdoutBytes <= MAX_STDOUT_BYTES) return;
    failConnection(conn, protocolFailure(`agent output exceeded ${MAX_STDOUT_BYTES} bytes; process killed`));
    signalChild(child, 'SIGKILL');
  });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => handleLine(conn, line));
}

/**
 * Spawn the agent and open a JSON-RPC connection to it.
 *
 * @param {string[]} argv
 * @param {string} cwd
 * @param {{ onRequest: Function, onNotification: Function }} handlers
 */
function openConnection(argv, cwd, handlers) {
  const [file, ...args] = argv;
  let child;
  try {
    child = spawn(file, args, { cwd, env: buildChildEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    throw protocolFailure(`could not run the ACP agent: ${err?.message ?? err}`);
  }
  let markExited;
  const exited = new Promise((resolveExit) => { markExited = resolveExit; });
  const conn = { child, handlers, exited, pending: new Map(), nextId: 0, fatal: null, stderr: '', stdoutBytes: 0 };
  attachChildEvents(conn, () => markExited());
  return conn;
}

/** Send a request; the promise settles on its response or the connection's first fatal error. */
function request(conn, method, params) {
  if (conn.fatal) return Promise.reject(conn.fatal);
  const id = conn.nextId++;
  const pending = new Promise((resolveRequest, reject) => {
    conn.pending.set(id, { method, resolve: resolveRequest, reject });
  });
  sendMessage(conn, { id, method, params });
  return pending;
}

/** Resolve true if the child exits within `ms`, false otherwise. Never rejects. */
function exitWithin(conn, ms) {
  let timer;
  const expired = new Promise((resolveTimer) => { timer = setTimeout(() => resolveTimer(false), ms); });
  return Promise.race([conn.exited.then(() => true), expired]).finally(() => clearTimeout(timer));
}

/** How `shutdown` ended: which step the agent finally exited on. */
const SHUTDOWN_GRACEFUL = 'stdin-close';
const SHUTDOWN_SIGTERM = 'SIGTERM';
const SHUTDOWN_SIGKILL = 'SIGKILL';
const SHUTDOWN_STUCK = 'still running after SIGKILL';
const SHUTDOWN_NOT_SPAWNED = 'not spawned';

/**
 * Shut the agent down. Graceful: close stdin and give it `killGraceMs` to exit.
 * Then (or straight away when not graceful) SIGTERM, and SIGKILL after another
 * `killGraceMs`. Every wait is bounded. Returns the step the agent exited on
 * (a SHUTDOWN_* value); the adapter ignores it, `checkAcpAgent` reports it.
 */
async function shutdown(conn, killGraceMs, { graceful }) {
  if (graceful) {
    if (!conn.child.stdin.destroyed) conn.child.stdin.end();
    if (await exitWithin(conn, killGraceMs)) return SHUTDOWN_GRACEFUL;
  }
  signalChild(conn.child, 'SIGTERM');
  if (await exitWithin(conn, killGraceMs)) return SHUTDOWN_SIGTERM;
  signalChild(conn.child, 'SIGKILL');
  if (await exitWithin(conn, killGraceMs)) return SHUTDOWN_SIGKILL;
  process.stderr.write(`acp adapter: agent pid ${conn.child.pid} did not exit after SIGKILL\n`);
  return SHUTDOWN_STUCK;
}

// ── Session: deadline, handlers, handshake, turns ──────────────────────────

/** A wall-clock deadline. `promise` RESOLVES on expiry so an unraced deadline never rejects unhandled. */
function createDeadline(ms, label) {
  let timer;
  const deadline = { expired: false, message: `${label} timed out after ${ms}ms` };
  deadline.promise = new Promise((resolveDeadline) => {
    timer = setTimeout(() => { deadline.expired = true; resolveDeadline(); }, ms);
  });
  deadline.clear = () => clearTimeout(timer);
  return deadline;
}

/** Race `promise` against the deadline; expiry rejects with a fail-timeout AcpFailure. */
function raceDeadline(promise, deadline) {
  const expiry = deadline.promise.then(() => { throw new AcpFailure(TIMEOUT_FAILURE, deadline.message); });
  return Promise.race([promise, expiry]);
}

/**
 * Answer one session/request_permission from the wave's effective capability
 * classes. Never selects allow_always / reject_always. Pure.
 *
 * @param {{ toolCall?: { kind?: string }, options?: Array<{ optionId: string, kind: string }> }} params
 * @param {string[]} effective
 * @returns {{ outcome: { outcome: 'selected', optionId: string } | { outcome: 'cancelled' },
 *   record: { kind: string|null, decision: 'allow'|'reject'|'cancelled' } }}
 */
export function decidePermission(params, effective) {
  const kind = typeof params?.toolCall?.kind === 'string' ? params.toolCall.kind : null;
  const capabilityClass = kind === null ? undefined : TOOL_KIND_CLASS[kind];
  const granted = capabilityClass !== undefined && Array.isArray(effective) && effective.includes(capabilityClass);
  const wanted = granted ? ALLOW_ONCE : REJECT_ONCE;
  const options = Array.isArray(params?.options) ? params.options : [];
  const option = options.find((o) => o?.kind === wanted && typeof o.optionId === 'string');
  if (!option) return { outcome: { outcome: 'cancelled' }, record: { kind, decision: 'cancelled' } };
  return {
    outcome: { outcome: 'selected', optionId: option.optionId },
    record: { kind, decision: granted ? 'allow' : 'reject' },
  };
}

/** ACP token counts are uint64 in the schema; anything else is malformed and left unmapped. */
const isTokenCount = (v) => Number.isSafeInteger(v) && v >= 0;

/** Map an update's token fields through normalizeUsage; undefined when nothing maps. */
function usageFromUpdate(update) {
  const raw = {};
  for (const [acpKey, radKey] of ACP_USAGE_TOKEN_FIELDS) {
    if (isTokenCount(update[acpKey])) raw[radKey] = update[acpKey];
  }
  if (update.cost?.currency === USAGE_COST_CURRENCY) raw.cost = update.cost.amount;
  return normalizeUsage(raw);
}

/** Apply one session/update for our session. Unknown update kinds are ignored, as the spec requires. */
function applySessionUpdate(session, params) {
  const update = params?.update;
  if (!update || typeof update !== 'object' || params.sessionId !== session.id) return;
  if (update.sessionUpdate === 'agent_message_chunk') {
    const { content } = update;
    if (content?.type === 'text' && typeof content.text === 'string') session.turnText += content.text;
    return;
  }
  if (update.sessionUpdate === 'usage_update') {
    const usage = usageFromUpdate(update);
    if (usage) session.usage = usage;
  }
}

/** The handlers a session installs on its connection. */
function sessionHandlers(session) {
  return {
    onNotification(_conn, msg) {
      if (msg.method === 'session/update') applySessionUpdate(session, msg.params);
    },
    onRequest(conn, msg) {
      if (msg.method !== 'session/request_permission') {
        sendMessage(conn, { id: msg.id, error: { code: METHOD_NOT_FOUND, message: `RAD does not serve ${msg.method}` } });
        return;
      }
      // After RAD's session/cancel the spec requires every pending permission
      // request to be answered `cancelled`.
      const { outcome, record } = session.cancelled
        ? { outcome: { outcome: 'cancelled' }, record: { kind: msg.params?.toolCall?.kind ?? null, decision: 'cancelled' } }
        : decidePermission(msg.params, session.effective);
      session.permissions.push(record);
      sendMessage(conn, { id: msg.id, result: { outcome } });
    },
  };
}

/** Build per-attempt session state. Nothing is spawned yet. */
function newSession({ argv, repoRoot, timeoutMs, killGraceMs, label }, effective) {
  return {
    argv,
    cwd: resolvePath(repoRoot ?? process.cwd()),
    killGraceMs,
    effective,
    deadline: createDeadline(timeoutMs, label),
    conn: null,
    id: null,
    turnText: '',
    usage: undefined,
    permissions: [],
    cancelled: false,
  };
}

/**
 * Spawn the agent, then `initialize` + `session/new`. A protocolVersion other
 * than 1 fails closed. `authMethods` is not acted on: RAD expects an already
 * authenticated agent, and a later auth error surfaces as a failure.
 */
async function handshake(session) {
  spawnAgent(session);
  await initializeAgent(session);
  await createAgentSession(session);
}

/** Handshake step 1: spawn the agent and open the JSON-RPC connection. */
function spawnAgent(session) {
  session.conn = openConnection(session.argv, session.cwd, sessionHandlers(session));
}

/** Handshake step 2: `initialize`; any protocolVersion other than 1 fails closed. */
async function initializeAgent(session) {
  const init = await raceDeadline(request(session.conn, 'initialize', INITIALIZE_PARAMS), session.deadline);
  if (init?.protocolVersion !== ACP_PROTOCOL_VERSION) {
    throw protocolFailure(
      `agent speaks ACP protocolVersion ${JSON.stringify(init?.protocolVersion)}; `
      + `RAD requires protocolVersion ${ACP_PROTOCOL_VERSION}`,
    );
  }
}

/** Handshake step 3: `session/new`, which must return a non-empty sessionId. */
async function createAgentSession(session) {
  const created = await raceDeadline(
    request(session.conn, 'session/new', { cwd: session.cwd, mcpServers: [] }),
    session.deadline,
  );
  if (typeof created?.sessionId !== 'string' || created.sessionId === '') {
    throw protocolFailure('agent returned no sessionId from session/new');
  }
  session.id = created.sessionId;
}

/**
 * After RAD's deadline: send session/cancel and give the in-flight prompt up to
 * killGraceMs to settle. Its value is deliberately unused: the attempt is
 * already fail-timeout whatever the agent answers.
 */
async function cancelTurn(session, inFlight) {
  session.cancelled = true;
  sendMessage(session.conn, { method: 'session/cancel', params: { sessionId: session.id } });
  let timer;
  const grace = new Promise((resolveGrace) => { timer = setTimeout(resolveGrace, session.killGraceMs); });
  await Promise.race([inFlight.then(() => undefined, () => undefined), grace]);
  clearTimeout(timer);
}

/** Map a turn's stopReason to its WAVE_RESULT block (or null), or throw the named failure. */
function blockForStop(session, stopReason) {
  if (PARSE_STOP_REASONS.has(stopReason)) return extractWaveResultBlock(session.turnText);
  if (stopReason === 'refusal') throw new AcpFailure(SCOPE_FAILURE, REFUSAL_MESSAGE);
  if (stopReason === 'cancelled') {
    throw protocolFailure('agent ended the turn as cancelled although RAD sent no session/cancel');
  }
  throw protocolFailure(`agent returned unknown stopReason ${JSON.stringify(stopReason)}`);
}

/** Run one prompt turn; returns the turn's WAVE_RESULT block or null. */
async function runTurn(session, text) {
  session.turnText = '';
  const inFlight = request(session.conn, 'session/prompt', {
    sessionId: session.id,
    prompt: [{ type: 'text', text }],
  });
  let response;
  try {
    response = await raceDeadline(inFlight, session.deadline);
  } catch (err) {
    if (err?.outcome === TIMEOUT_FAILURE) await cancelTurn(session, inFlight);
    throw err;
  }
  return blockForStop(session, response?.stopReason);
}

/** Attach the permission log to a result when any decision was made. */
function withPermissions(result, session) {
  if (session.permissions.length > 0) result.permissions = session.permissions;
  return result;
}

/** Hand-built terminal result carrying one synthetic failed task. */
function failureResult(outcome, waveId, message, session) {
  const result = { outcome, status: 'failed', tasks: syntheticFailure(waveId, sanitizeErrorMessage(message)).tasks };
  return withPermissions(result, session);
}

/** Close the session's process (if one was spawned) and clear its deadline; returns how it ended. */
async function closeSession(session) {
  session.deadline.clear();
  if (!session.conn) return SHUTDOWN_NOT_SPAWNED;
  return shutdown(session.conn, session.killGraceMs, { graceful: !session.deadline.expired });
}

/** One attempt: fresh process + session, the wave turn, at most one reprompt. */
async function runAttempt(session, prompt, waveId) {
  try {
    await handshake(session);
    let block = await runTurn(session, prompt);
    if (!block) block = await runTurn(session, REPROMPT_TEXT);
    if (!block) throw protocolFailure(MISSING_BLOCK_MESSAGE);
    return withPermissions(toWaveResult(parseWaveResult(block), session.usage), session);
  } catch (err) {
    if (!(err instanceof AcpFailure)) throw err;
    return failureResult(err.outcome, waveId, err.message, session);
  } finally {
    await closeSession(session);
  }
}

/**
 * Create an ACP-backed runWave.
 *
 * @param {Object} opts
 * @param {string} opts.cmd - RAD_AGENT_CMD; tokenized like the command path, `{prompt}` rejected
 * @param {string} [opts.repoRoot] - the agent's cwd and the session's `cwd`
 * @param {string} [opts.model] - a requested model; ACP v1 cannot carry it, so it only warns
 * @param {number} [opts.timeoutMs] - wall-clock deadline per wave attempt
 * @param {number} [opts.killGraceMs] - internal: grace before each kill step (tests)
 * @param {(message: string) => void} [opts.warn] - where the one ignored-model warning goes
 * @returns {(wave: Object, planCtx: Object) => Promise<{ outcome: string, status: string,
 *   tasks?: Array, usage?: Object, permissions?: Array<{ kind: string|null, decision: string }> }>}
 */
export function createAcpAdapter({
  cmd, repoRoot, model, timeoutMs = DEFAULT_WAVE_TIMEOUT_MS, killGraceMs = KILL_GRACE_MS,
  warn = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  const argv = parseAgentCommand(cmd);
  let warnedModel = false;

  return async function runWave(wave, planCtx) {
    const waveId = wave.n ?? wave.number ?? wave.id ?? '?';
    const prompt = buildWavePrompt(wave, planCtx);
    const requestedModel = planCtx?.waveModels?.[Number(waveId)] ?? model;
    if (requestedModel && !warnedModel) {
      warnedModel = true;
      warn(`acp adapter: model '${requestedModel}' ignored; ACP v1 has no stable model selector, so set the model in the agent's own config`);
    }
    const effective = planCtx?.waveEffective?.[Number(waveId)] ?? DEFAULT_CAPABILITIES;
    const session = newSession({ argv, repoRoot, timeoutMs, killGraceMs, label: 'wave' }, effective);
    return runAttempt(session, prompt, waveId);
  };
}

/**
 * Preflight: the `initialize` + `session/new` handshake only. No prompt, so no
 * model cost. Never throws for an agent failure.
 *
 * @param {Object} opts
 * @param {string} opts.cmd
 * @param {string} [opts.repoRoot]
 * @param {number} [opts.timeoutMs] - default PREFLIGHT_TIMEOUT_MS
 * @param {number} [opts.killGraceMs] - internal (tests)
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function probeAcp({
  cmd, repoRoot, timeoutMs = PREFLIGHT_TIMEOUT_MS, killGraceMs = KILL_GRACE_MS,
} = {}) {
  let argv;
  try {
    argv = parseAgentCommand(cmd);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const session = newSession({ argv, repoRoot, timeoutMs, killGraceMs, label: 'agent preflight' }, []);
  try {
    await handshake(session);
    return { ok: true };
  } catch (err) {
    if (!(err instanceof AcpFailure)) throw err;
    return { ok: false, error: sanitizeErrorMessage(err.message) };
  } finally {
    await closeSession(session);
  }
}

// ── Conformance check (rad acp-check) ──────────────────────────────────────

/** Resolve once the child has spawned; reject with an AcpFailure when it cannot run (e.g. ENOENT). */
function spawned(child) {
  return new Promise((resolveSpawn, reject) => {
    child.once('spawn', resolveSpawn);
    child.once('error', (err) => reject(protocolFailure(`could not run the ACP agent: ${err?.message ?? err}`)));
  });
}

/** `spawn`: the command parses and the process starts. */
async function checkSpawn(session, cmd) {
  try {
    session.argv = parseAgentCommand(cmd);
  } catch (err) {
    throw protocolFailure(err.message);
  }
  spawnAgent(session);
  await raceDeadline(spawned(session.conn.child), session.deadline);
  return `started pid ${session.conn.child.pid}`;
}

/** `wave-result`: the turn's block parses and maps to the `success` outcome. */
function checkWaveResult(block) {
  if (!block) throw protocolFailure('no WAVE_RESULT block in the turn text');
  const outcome = resultToOutcome(parseWaveResult(block));
  if (outcome !== 'success') throw protocolFailure(`WAVE_RESULT maps to outcome ${outcome}, expected success`);
  return 'WAVE_RESULT maps to outcome success';
}

/** Every check but `shutdown`, in ACP_CHECK_NAMES order; each returns its pass detail or throws an AcpFailure. */
const CHECK_STEPS = [
  ['spawn', (session, cmd) => checkSpawn(session, cmd)],
  ['initialize', async (session) => { await initializeAgent(session); return `protocolVersion ${ACP_PROTOCOL_VERSION}`; }],
  ['session/new', async (session) => { await createAgentSession(session); return `sessionId ${session.id}`; }],
  ['prompt', async (session) => {
    session.checkBlock = await runTurn(session, ACP_CHECK_PROMPT);
    return `stopReason in ${[...PARSE_STOP_REASONS].join(', ')}`;
  }],
  ['wave-result', (session) => checkWaveResult(session.checkBlock)],
];

/** Run the steps in order, stopping at the first failure (which is recorded). */
async function runChecks(session, cmd) {
  const checks = [];
  for (const [name, step] of CHECK_STEPS) {
    try {
      checks.push({ name, ok: true, detail: await step(session, cmd) });
    } catch (err) {
      if (!(err instanceof AcpFailure)) throw err;
      checks.push({ name, ok: false, detail: sanitizeErrorMessage(err.message) });
      break;
    }
  }
  return checks;
}

/** `shutdown`: the agent exited on stdin close alone, within the grace period. */
function shutdownCheck(ended, killGraceMs) {
  if (ended === SHUTDOWN_GRACEFUL) {
    return { name: 'shutdown', ok: true, detail: `exited within ${killGraceMs}ms of stdin closing` };
  }
  const detail = `did not exit within ${killGraceMs}ms of stdin closing (ended at: ${ended})`;
  return { name: 'shutdown', ok: false, detail };
}

/**
 * Conformance check for an ACP agent: one process, one session, one prompt,
 * through the adapter's own handshake and turn machinery. The checks run in
 * ACP_CHECK_NAMES order and stop at the first failure. Permission requests get
 * the default policy (DEFAULT_CAPABILITIES). Writes nothing. Never throws for
 * an agent failure.
 *
 * @param {Object} opts
 * @param {string} opts.cmd - the agent command, tokenized like RAD_AGENT_CMD
 * @param {string} [opts.repoRoot] - the agent's cwd and the session's `cwd`
 * @param {number} [opts.timeoutMs] - deadline for the whole check (default: the wave timeout)
 * @param {number} [opts.killGraceMs] - the shutdown grace period; internal (tests)
 * @returns {Promise<{ ok: boolean, checks: Array<{ name: string, ok: boolean, detail: string }> }>}
 */
export async function checkAcpAgent({
  cmd, repoRoot, timeoutMs = DEFAULT_WAVE_TIMEOUT_MS, killGraceMs = KILL_GRACE_MS,
} = {}) {
  const session = newSession({ argv: null, repoRoot, timeoutMs, killGraceMs, label: 'acp-check' }, DEFAULT_CAPABILITIES);
  let checks;
  let ended;
  try {
    checks = await runChecks(session, cmd);
  } finally {
    ended = await closeSession(session);
  }
  if (checks.every((c) => c.ok)) checks.push(shutdownCheck(ended, killGraceMs));
  return { ok: checks.length === ACP_CHECK_NAMES.length && checks.every((c) => c.ok), checks };
}
