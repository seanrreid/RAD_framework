#!/usr/bin/env node
/**
 * Deterministic fake ACP v1 agent for harness/test/acp-adapter.test.js (and the
 * Wave 2 cli tests). Speaks newline-delimited JSON-RPC 2.0 on stdio.
 *
 * Usage: node fake-agent.mjs <scenario> [traceFile]
 *   scenario  - one of the SCENARIOS keys or HANDSHAKE_SCENARIOS below
 *   traceFile - optional; the agent appends `pid <n>`, `recv <method> <params>`
 *               and lifecycle lines so tests can assert on the wire
 *
 * The env is not used for configuration: the adapter forwards only an
 * allow-listed env, so everything travels on argv.
 */
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const [scenario, traceFile] = process.argv.slice(2);
/** Scenarios that fail before any session/prompt, so they have no SCENARIOS entry. */
const HANDSHAKE_SCENARIOS = ['wrong-version', 'non-json'];
const SESSION_ID = 'sess-fake';
const UNSUPPORTED_VERSION = 2;

const block = (status, taskStatus, error = '—') => [
  'WAVE_RESULT', 'wave: 1', `status: ${status}`, 'tasks:',
  '  - title: Fake task', `    status: ${taskStatus}`, '    commit: abc1234',
  '    concern: —', `    error: ${error}`, 'END_WAVE_RESULT',
].join('\n');
const GOOD_BLOCK = `All done.\n${block('complete', 'complete')}`;
const failBlock = (error) => block('failed', 'blocked_code', error);

const trace = (line) => { if (traceFile) appendFileSync(traceFile, `${line}\n`); };
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const update = (u) => send({ method: 'session/update', params: { sessionId: SESSION_ID, update: u } });
const say = (text) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const reply = (msg, stopReason) => send({ id: msg.id, result: { stopReason } });
const finish = (msg, text, stopReason = 'end_turn') => { say(text); reply(msg, stopReason); };

let nextAgentId = 0;
const awaiting = new Map();
/** Send an agent -> client request and resolve with the client's full response message. */
function request(method, params) {
  const id = `agent-${nextAgentId++}`;
  send({ id, method, params });
  return new Promise((resolve) => awaiting.set(id, resolve));
}

/** Updates the client must ignore or not collect into the turn text. */
function emitNoise() {
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: failBlock('thought leaked') } });
  update({ sessionUpdate: 'tool_call', toolCallId: 'call-0', title: 'Read file', kind: 'read', status: 'completed' });
  update({ sessionUpdate: 'future_update_kind', anything: true });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } });
  send({ method: '_vendor/ping', params: {} });
}

const BOTH_ONCE = [
  { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
];
const ALWAYS_ONLY = [
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'never', name: 'Always reject', kind: 'reject_always' },
];
/** Each request and the exact outcome the client must answer with (default capabilities). */
const PERMISSION_CASES = [
  { kind: 'edit', options: BOTH_ONCE, expect: { outcome: 'selected', optionId: 'allow' } },
  { kind: 'fetch', options: BOTH_ONCE, expect: { outcome: 'selected', optionId: 'reject' } },
  { kind: 'other', options: BOTH_ONCE, expect: { outcome: 'selected', optionId: 'reject' } },
  { kind: 'edit', options: ALWAYS_ONLY, expect: { outcome: 'cancelled' } },
];

async function askPermissions(msg) {
  const mismatches = [];
  for (const [i, c] of PERMISSION_CASES.entries()) {
    const toolCall = { toolCallId: `call-${i + 1}`, kind: c.kind, title: `${c.kind} something` };
    const res = await request('session/request_permission', { sessionId: SESSION_ID, toolCall, options: c.options });
    const got = JSON.stringify(res.result?.outcome);
    if (got !== JSON.stringify(c.expect)) mismatches.push(`case ${i + 1} got ${got}`);
  }
  finish(msg, mismatches.length ? failBlock(mismatches.join('; ')) : GOOD_BLOCK);
}

async function readFileRequest(msg) {
  const res = await request('fs/read_text_file', { sessionId: SESSION_ID, path: '/etc/hosts' });
  const ok = res.error?.code === -32601 && res.result === undefined;
  finish(msg, ok ? GOOD_BLOCK : failBlock(`fs request answered ${JSON.stringify(res)}`));
}

let promptCount = 0;
let hangingPrompt = null;

/** Per-scenario session/prompt behaviour. */
const SCENARIOS = {
  complete: (msg) => {
    emitNoise();
    say(GOOD_BLOCK.slice(0, 25));
    say(GOOD_BLOCK.slice(25));
    update({
      sessionUpdate: 'usage_update', used: 1200, size: 200000,
      inputTokens: 100, outputTokens: 40, cachedReadTokens: 7, cost: { amount: 0.25, currency: 'USD' },
    });
    reply(msg, 'end_turn');
  },
  'max-tokens': (msg) => finish(msg, GOOD_BLOCK, 'max_tokens'),
  'usage-absent': (msg) => finish(msg, GOOD_BLOCK),
  'usage-malformed': (msg) => {
    update({ sessionUpdate: 'usage_update', inputTokens: 'lots', outputTokens: null, totalTokens: -1 });
    finish(msg, GOOD_BLOCK);
  },
  'usage-context-only': (msg) => {
    update({ sessionUpdate: 'usage_update', used: 1200, size: 200000, cost: { amount: 0.5, currency: 'USD' } });
    finish(msg, GOOD_BLOCK);
  },
  'reprompt-good': (msg) => finish(msg, promptCount === 1 ? 'Done, but no block.' : GOOD_BLOCK),
  'reprompt-bad': (msg) => finish(msg, 'Still no block.'),
  'unknown-id': () => send({ id: 999, result: {} }),
  refusal: (msg) => finish(msg, 'I will not do that.', 'refusal'),
  'unknown-stop': (msg) => finish(msg, GOOD_BLOCK, 'exploded'),
  'unsolicited-cancel': (msg) => finish(msg, GOOD_BLOCK, 'cancelled'),
  hang: (msg) => { hangingPrompt = msg; },
  'ignore-cancel': () => {},
  crash: () => {
    say('Working on it...');
    process.stderr.write('boom: fake agent crashed mid-turn\n');
    process.exit(3);
  },
  // Completes the turn but stays up after stdin closes (exits on SIGTERM): fails acp-check's shutdown.
  linger: (msg) => finish(msg, GOOD_BLOCK),
  'fs-request': readFileRequest,
  permissions: askPermissions,
};

function onInitialize(msg) {
  const protocolVersion = scenario === 'wrong-version' ? UNSUPPORTED_VERSION : 1;
  // `complete` advertises an auth method: the client must not refuse the session over it.
  const authMethods = scenario === 'complete' ? [{ id: 'agent-login', name: 'Log in' }] : [];
  send({ id: msg.id, result: { protocolVersion, agentCapabilities: { loadSession: false }, authMethods } });
}

function onNewSession(msg) {
  if (scenario === 'non-json') {
    process.stdout.write('this is not json\n');
    return;
  }
  send({ id: msg.id, result: { sessionId: SESSION_ID } });
}

function onMessage(msg) {
  if (msg.method) trace(`recv ${msg.method} ${JSON.stringify(msg.params ?? null)}`);
  if (msg.method === undefined && awaiting.has(msg.id)) {
    awaiting.get(msg.id)(msg);
    awaiting.delete(msg.id);
    return;
  }
  if (msg.method === 'initialize') onInitialize(msg);
  else if (msg.method === 'session/new') onNewSession(msg);
  else if (msg.method === 'session/prompt') {
    promptCount += 1;
    SCENARIOS[scenario](msg);
  } else if (msg.method === 'session/cancel' && hangingPrompt) {
    reply(hangingPrompt, 'cancelled');
  }
}

// `node --test` discovers every .mjs under test/ and runs it with no argv and an
// open stdin; with no scenario this file is not being used as an agent.
if (scenario === undefined) process.exit(0);
if (!(scenario in SCENARIOS) && !HANDSHAKE_SCENARIOS.includes(scenario)) {
  process.stderr.write(`fake-agent: unknown scenario '${scenario}'\n`);
  process.exit(2);
}
trace(`pid ${process.pid}`);
/** Scenarios that keep running after stdin closes. */
const OUTLIVES_STDIN = ['ignore-cancel', 'linger'];
if (scenario === 'ignore-cancel') process.on('SIGTERM', () => trace('SIGTERM ignored'));
if (OUTLIVES_STDIN.includes(scenario)) setInterval(() => {}, 1_000);
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => onMessage(JSON.parse(line)));
rl.on('close', () => {
  trace('stdin closed');
  if (!OUTLIVES_STDIN.includes(scenario)) process.exit(0);
});
