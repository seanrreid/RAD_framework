import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  createAcpAdapter, probeAcp, decidePermission, checkAcpAgent, ACP_PROTOCOL_VERSION, ACP_CHECK_NAMES, ACP_CHECK_PROMPT,
} from '../adapters/agent/acp.js';
import { buildChildEnv, tokenizeCommand } from '../adapters/agent/command.js';
import { extractWaveResultBlock, parseWaveResult, toWaveResult } from '../adapters/agent/contract.js';
import { DEFAULT_CAPABILITIES } from '../capabilities.js';

const FAKE_AGENT = fileURLToPath(new URL('./fixtures/acp/fake-agent.mjs', import.meta.url));
/** Short timers keep the timeout and kill paths fast; real defaults are minutes / seconds. */
const FAST = { timeoutMs: 5_000, killGraceMs: 200 };
const SHORT_DEADLINE_MS = 400;

const WAVE = { n: 1, type: 'sequential', tasks: [{ title: 'Fake task', what: 'do it' }] };
const PLAN_CTX = { feature: 'acp-test', branch: 'rad/acp-test', executionLog: 'log.md' };
/** The same turn text the fake agent's GOOD_BLOCK emits, for command-path parity. */
const GOOD_TEXT = [
  'All done.', 'WAVE_RESULT', 'wave: 1', 'status: complete', 'tasks:',
  '  - title: Fake task', '    status: complete', '    commit: abc1234',
  '    concern: —', '    error: —', 'END_WAVE_RESULT',
].join('\n');

const workDir = mkdtempSync(join(tmpdir(), 'rad-acp-'));
test.after(() => rmSync(workDir, { recursive: true, force: true }));

let traceSeq = 0;
/** A fresh trace file path plus the RAD_AGENT_CMD that drives `scenario` with it. */
function fake(scenario) {
  const trace = join(workDir, `trace-${traceSeq++}.log`);
  return { trace, cmd: `${process.execPath} ${FAKE_AGENT} ${scenario} ${trace}` };
}

function readTrace(trace) {
  return existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter(Boolean) : [];
}
const received = (trace, method) => readTrace(trace).filter((l) => l.startsWith(`recv ${method} `));
const paramsOf = (line) => JSON.parse(line.slice(line.indexOf(' ', 5) + 1));
const pidOf = (trace) => Number(readTrace(trace).find((l) => l.startsWith('pid '))?.slice(4));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    throw err;
  }
}

async function runScenario(scenario, { planCtx = PLAN_CTX, ...opts } = {}) {
  const { trace, cmd } = fake(scenario);
  const runWave = createAcpAdapter({ cmd, repoRoot: workDir, ...FAST, ...opts });
  const result = await runWave(WAVE, planCtx);
  return { result, trace };
}

// --- command.js reuse (AC#5) -------------------------------------------------

test('command.js exports buildChildEnv: allow-listed keys only', () => {
  const env = buildChildEnv();
  for (const key of Object.keys(env)) {
    assert.ok(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'USER'].includes(key), key);
  }
});

test('command.js exports tokenizeCommand unchanged', () => {
  assert.deepEqual(tokenizeCommand('agent  --x {prompt}', 'P', undefined), { argv: ['agent', '--x', 'P'], usedPlaceholder: true });
  assert.deepEqual(tokenizeCommand('agent -m {model}', 'P', 'opus'), { argv: ['agent', '-m', 'opus'], usedPlaceholder: false });
});

// --- AC#1: client, handshake, wire -------------------------------------------

test('complete wave: handshake fields, single text prompt block, success with usage', async () => {
  const { result, trace } = await runScenario('complete');
  assert.equal(result.outcome, 'success');
  assert.equal(result.status, 'complete');
  assert.equal(result.tasks[0].commit, 'abc1234');
  assert.deepEqual(result.usage, { input: 100, output: 40, total: 140, cacheRead: 7, cost: 0.25 });
  assert.equal('permissions' in result, false);

  const init = paramsOf(received(trace, 'initialize')[0]);
  assert.equal(init.protocolVersion, ACP_PROTOCOL_VERSION);
  assert.deepEqual(init.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  assert.equal(init.clientInfo.name, 'rad');
  assert.equal(typeof init.clientInfo.version, 'string');
  assert.deepEqual(paramsOf(received(trace, 'session/new')[0]), { cwd: workDir, mcpServers: [] });
  const prompt = paramsOf(received(trace, 'session/prompt')[0]);
  assert.equal(prompt.sessionId, 'sess-fake');
  assert.equal(prompt.prompt.length, 1);
  assert.equal(prompt.prompt[0].type, 'text');
  assert.match(prompt.prompt[0].text, /You are executing Wave 1 of a RAD delivery/);
  assert.equal(isAlive(pidOf(trace)), false, 'no process outlives runWave');
});

test('identical turn text yields the same result as the command path', async () => {
  const { result } = await runScenario('usage-absent');
  assert.deepEqual(result, toWaveResult(parseWaveResult(extractWaveResultBlock(GOOD_TEXT))));
});

test('max_tokens with a complete block still parses to success', async () => {
  const { result } = await runScenario('max-tokens');
  assert.equal(result.outcome, 'success');
});

test('wrong protocolVersion: fail-protocol naming both versions, no prompt sent', async () => {
  const { result, trace } = await runScenario('wrong-version');
  assert.equal(result.outcome, 'fail-protocol');
  assert.match(result.tasks[0].error, /protocolVersion 2.*requires protocolVersion 1/);
  assert.equal(received(trace, 'session/new').length, 0);
});

test('a non-JSON line ends the session with fail-protocol', async () => {
  const { result } = await runScenario('non-json');
  assert.equal(result.outcome, 'fail-protocol');
  assert.match(result.tasks[0].error, /not JSON: this is not json/);
});

test('a response to an unknown id ends the session with fail-protocol', async () => {
  const { result } = await runScenario('unknown-id');
  assert.equal(result.outcome, 'fail-protocol');
  assert.match(result.tasks[0].error, /unknown id 999/);
});

test('an fs/read_text_file request is answered -32601 and the turn continues', async () => {
  const { result } = await runScenario('fs-request');
  assert.equal(result.outcome, 'success', result.tasks?.[0]?.error);
});

// --- AC#2: turns and outcomes ------------------------------------------------

test('missing block then a good reprompt: success, one session, two prompts', async () => {
  const { result, trace } = await runScenario('reprompt-good');
  assert.equal(result.outcome, 'success');
  assert.equal(received(trace, 'session/new').length, 1);
  const prompts = received(trace, 'session/prompt').map(paramsOf);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].prompt[0].text, /did not include the required WAVE_RESULT block/);
});

test('missing block twice: fail-protocol after exactly one reprompt', async () => {
  const { result, trace } = await runScenario('reprompt-bad');
  assert.equal(result.outcome, 'fail-protocol');
  assert.equal(result.tasks[0].error, 'No WAVE_RESULT block after one reprompt');
  assert.equal(received(trace, 'session/prompt').length, 2);
});

for (const scenario of ['usage-absent', 'usage-malformed', 'usage-context-only']) {
  test(`usage omitted, never guessed: ${scenario}`, async () => {
    const { result } = await runScenario(scenario);
    assert.equal(result.outcome, 'success');
    assert.equal('usage' in result, false);
  });
}

test('stopReason refusal: fail-scope with the named message', async () => {
  const { result } = await runScenario('refusal');
  assert.equal(result.outcome, 'fail-scope');
  assert.equal(result.tasks[0].error, 'agent refused the wave (ACP stopReason refusal)');
});

test('an unknown stopReason: fail-protocol', async () => {
  const { result } = await runScenario('unknown-stop');
  assert.equal(result.outcome, 'fail-protocol');
  assert.match(result.tasks[0].error, /unknown stopReason "exploded"/);
});

test('stopReason cancelled without a client cancel: fail-protocol', async () => {
  const { result } = await runScenario('unsolicited-cancel');
  assert.equal(result.outcome, 'fail-protocol');
});

test('a hung turn: session/cancel sent, fail-timeout, process dead', async () => {
  const { result, trace } = await runScenario('hang', { timeoutMs: SHORT_DEADLINE_MS });
  assert.equal(result.outcome, 'fail-timeout');
  assert.match(result.tasks[0].error, /wave timed out after 400ms/);
  assert.deepEqual(paramsOf(received(trace, 'session/cancel')[0]), { sessionId: 'sess-fake' });
  assert.equal(isAlive(pidOf(trace)), false);
});

test('an ignored cancel and SIGTERM: SIGKILL after the grace period', async () => {
  const { result, trace } = await runScenario('ignore-cancel', { timeoutMs: SHORT_DEADLINE_MS });
  assert.equal(result.outcome, 'fail-timeout');
  assert.ok(readTrace(trace).includes('SIGTERM ignored'));
  assert.equal(isAlive(pidOf(trace)), false);
});

test('a crash mid-turn: fail-protocol with the exit code and a stderr excerpt', async () => {
  const { result } = await runScenario('crash');
  assert.equal(result.outcome, 'fail-protocol');
  assert.match(result.tasks[0].error, /code 3/);
  assert.match(result.tasks[0].error, /boom: fake agent crashed mid-turn/);
});

test('ENOENT: fail-protocol after a single attempt', async () => {
  const runWave = createAcpAdapter({ cmd: join(workDir, 'no-such-acp-agent'), repoRoot: workDir, ...FAST });
  const result = await runWave(WAVE, PLAN_CTX);
  assert.equal(result.outcome, 'fail-protocol');
  assert.match(result.tasks[0].error, /ENOENT/);
});

test('a prompt-build error propagates (thrown, not a result) without spawning', async () => {
  const { trace, cmd } = fake('complete');
  const runWave = createAcpAdapter({ cmd, repoRoot: workDir, ...FAST });
  await assert.rejects(runWave(WAVE, { ...PLAN_CTX, operatorContext: { context: 5 } }), TypeError);
  assert.deepEqual(readTrace(trace), []);
});

test('a requested model is ignored with exactly one warning per adapter', async () => {
  const warnings = [];
  const { cmd } = fake('complete');
  const runWave = createAcpAdapter({ cmd, repoRoot: workDir, ...FAST, warn: (m) => warnings.push(m) });
  const planCtx = { ...PLAN_CTX, waveModels: { 1: 'opus' } };
  await runWave(WAVE, planCtx);
  await runWave(WAVE, planCtx);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /model 'opus' ignored/);
});

// --- AC#3: permission policy -------------------------------------------------

test('permission round-trip: edit allowed, fetch and other rejected, no allow_once cancelled', async () => {
  const { result } = await runScenario('permissions');
  assert.equal(result.outcome, 'success', result.tasks?.[0]?.error);
  assert.deepEqual(result.permissions, [
    { kind: 'edit', decision: 'allow' },
    { kind: 'fetch', decision: 'reject' },
    { kind: 'other', decision: 'reject' },
    { kind: 'edit', decision: 'cancelled' },
  ]);
});

const ONCE = [
  { optionId: 'a', kind: 'allow_once' },
  { optionId: 'A', kind: 'allow_always' },
  { optionId: 'r', kind: 'reject_once' },
];
const decide = (kind, effective = DEFAULT_CAPABILITIES, options = ONCE) =>
  decidePermission({ toolCall: { toolCallId: 'c', kind }, options }, effective);

test('decidePermission: tool kind to capability class mapping', () => {
  for (const kind of ['read', 'search', 'think']) assert.equal(decide(kind, ['fs_read']).record.decision, 'allow');
  for (const kind of ['edit', 'delete', 'move']) assert.equal(decide(kind, ['fs_write']).record.decision, 'allow');
  assert.equal(decide('execute', ['shell']).record.decision, 'allow');
  assert.equal(decide('fetch', ['net']).record.decision, 'allow');
  assert.equal(decide('execute', ['fs_read', 'fs_write']).record.decision, 'reject');
});

test('decidePermission: other, switch_mode and a missing kind are refused', () => {
  const all = ['fs_read', 'fs_write', 'shell', 'net', 'mcp'];
  for (const kind of ['other', 'switch_mode', undefined]) {
    assert.deepEqual(decide(kind, all).outcome, { outcome: 'selected', optionId: 'r' });
  }
  assert.equal(decide(undefined, all).record.kind, null);
});

test('decidePermission: never allow_always; no reject_once or bad options -> cancelled', () => {
  assert.deepEqual(decide('edit').outcome, { outcome: 'selected', optionId: 'a' });
  const alwaysOnly = [{ optionId: 'A', kind: 'allow_always' }, { optionId: 'R', kind: 'reject_always' }];
  assert.deepEqual(decide('edit', DEFAULT_CAPABILITIES, alwaysOnly).outcome, { outcome: 'cancelled' });
  assert.deepEqual(decide('fetch', DEFAULT_CAPABILITIES, alwaysOnly).outcome, { outcome: 'cancelled' });
  assert.deepEqual(decide('edit', DEFAULT_CAPABILITIES, 'nope').outcome, { outcome: 'cancelled' });
  const noEffective = decidePermission({ toolCall: { kind: 'edit' }, options: ONCE }, undefined);
  assert.deepEqual(noEffective.outcome, { outcome: 'selected', optionId: 'r' });
});

// --- command parsing and probeAcp --------------------------------------------

test('a {prompt} placeholder or a missing cmd is rejected', async () => {
  assert.throws(() => createAcpAdapter({ cmd: 'agent --ask {prompt}' }), /must not contain \{prompt\}/);
  assert.throws(() => createAcpAdapter({ cmd: '  ' }), /cmd is required/);
  const probe = await probeAcp({ cmd: 'agent {prompt}' });
  assert.equal(probe.ok, false);
  assert.match(probe.error, /\{prompt\}/);
});

test('probeAcp: handshake only, no prompt, process closed', async () => {
  const { trace, cmd } = fake('complete');
  assert.deepEqual(await probeAcp({ cmd, repoRoot: workDir, ...FAST }), { ok: true });
  assert.equal(received(trace, 'session/new').length, 1);
  assert.equal(received(trace, 'session/prompt').length, 0);
  assert.equal(isAlive(pidOf(trace)), false);
});

test('probeAcp: wrong version and ENOENT fail with a named error', async () => {
  const wrong = await probeAcp({ cmd: fake('wrong-version').cmd, repoRoot: workDir, ...FAST });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /protocolVersion 2/);
  const missing = await probeAcp({ cmd: join(workDir, 'no-such-acp-agent'), repoRoot: workDir, ...FAST });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /ENOENT/);
});

// --- checkAcpAgent: the rad acp-check conformance run (part 2, AC#2) ----------

const checkNames = (report) => report.checks.map((c) => c.name);
const lastCheck = (report) => report.checks[report.checks.length - 1];

test('checkAcpAgent: complete passes all six checks in order and leaves no process', async () => {
  const { trace, cmd } = fake('complete');
  const report = await checkAcpAgent({ cmd, repoRoot: workDir, ...FAST });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.deepEqual(checkNames(report), [...ACP_CHECK_NAMES]);
  assert.ok(report.checks.every((c) => c.ok && typeof c.detail === 'string'));
  assert.equal(received(trace, 'session/prompt').length, 1, 'exactly one prompt, no reprompt');
  assert.equal(paramsOf(received(trace, 'session/prompt')[0]).prompt[0].text, ACP_CHECK_PROMPT);
  assert.equal(isAlive(pidOf(trace)), false);
});

test('checkAcpAgent: the conformance prompt itself carries a success WAVE_RESULT block', () => {
  const parsed = parseWaveResult(extractWaveResultBlock(ACP_CHECK_PROMPT));
  assert.equal(toWaveResult(parsed).outcome, 'success');
  assert.equal(parsed.tasks.length, 1);
});

test('checkAcpAgent: wrong-version fails at initialize and runs no later check', async () => {
  const { trace, cmd } = fake('wrong-version');
  const report = await checkAcpAgent({ cmd, repoRoot: workDir, ...FAST });
  assert.equal(report.ok, false);
  assert.deepEqual(checkNames(report), ['spawn', 'initialize']);
  assert.equal(lastCheck(report).ok, false);
  assert.match(lastCheck(report).detail, /protocolVersion 2/);
  assert.equal(received(trace, 'session/new').length, 0);
});

test('checkAcpAgent: a turn with no block fails at wave-result (no reprompt)', async () => {
  const { trace, cmd } = fake('reprompt-bad');
  const report = await checkAcpAgent({ cmd, repoRoot: workDir, ...FAST });
  assert.equal(report.ok, false);
  assert.equal(lastCheck(report).name, 'wave-result');
  assert.match(lastCheck(report).detail, /no WAVE_RESULT block/);
  assert.equal(received(trace, 'session/prompt').length, 1);
});

test('checkAcpAgent: a crash mid-turn fails at prompt', async () => {
  const report = await checkAcpAgent({ cmd: fake('crash').cmd, repoRoot: workDir, ...FAST });
  assert.equal(lastCheck(report).name, 'prompt');
  assert.equal(lastCheck(report).ok, false);
  assert.match(lastCheck(report).detail, /exited/);
});

test('checkAcpAgent: ignore-cancel times out at prompt and the process is still killed', async () => {
  const { trace, cmd } = fake('ignore-cancel');
  const report = await checkAcpAgent({ cmd, repoRoot: workDir, timeoutMs: SHORT_DEADLINE_MS, killGraceMs: FAST.killGraceMs });
  assert.equal(report.ok, false);
  assert.equal(lastCheck(report).name, 'prompt');
  assert.match(lastCheck(report).detail, /acp-check timed out after 400ms/);
  assert.equal(isAlive(pidOf(trace)), false);
});

test('checkAcpAgent: an agent that outlives stdin close fails at shutdown', async () => {
  const { trace, cmd } = fake('linger');
  const report = await checkAcpAgent({ cmd, repoRoot: workDir, ...FAST });
  assert.equal(report.ok, false);
  assert.deepEqual(checkNames(report), [...ACP_CHECK_NAMES]);
  assert.equal(lastCheck(report).ok, false);
  assert.match(lastCheck(report).detail, /did not exit within 200ms of stdin closing \(ended at: SIGTERM\)/);
  assert.equal(isAlive(pidOf(trace)), false);
});

test('checkAcpAgent: ENOENT and an unparseable cmd fail at spawn', async () => {
  const missing = await checkAcpAgent({ cmd: join(workDir, 'no-such-acp-agent'), repoRoot: workDir, ...FAST });
  assert.deepEqual(checkNames(missing), ['spawn']);
  assert.match(lastCheck(missing).detail, /ENOENT/);
  for (const cmd of ['', 'agent {prompt}']) {
    const report = await checkAcpAgent({ cmd, repoRoot: workDir, ...FAST });
    assert.deepEqual(checkNames(report), ['spawn'], cmd);
    assert.equal(report.ok, false);
  }
});

test('checkAcpAgent: writes nothing into the agent cwd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rad-acp-check-'));
  try {
    const report = await checkAcpAgent({ cmd: `${process.execPath} ${FAKE_AGENT} complete`, repoRoot: root, ...FAST });
    assert.equal(report.ok, true);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
