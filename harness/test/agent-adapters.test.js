import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createCommandAdapter } from '../adapters/agent/command.js';
import { createRunWave } from '../adapters/agent/sdk.js';
import { deliverCommand } from '../cli.js';

const NODE = process.execPath;
const HERE = dirname(fileURLToPath(import.meta.url));

// A minimal wave + planCtx the adapters can run against.
const WAVE = {
  n: 1,
  type: 'sequential',
  tasks: [{ title: 'Task one', file: 'a.js', what: 'do a' }],
};
const PLAN_CTX = {
  feature: 'demo',
  branch: 'rad/demo',
  executionLog: '.agents/logs/demo.md',
  executionNotes: { doNotTouch: [], keyFiles: [], reminders: [] },
  acceptanceCriteria: ['demo criterion'],
};

// A valid WAVE_RESULT body a fake agent can emit on stdout.
const GOOD_RESULT = [
  'WAVE_RESULT',
  'wave: 1',
  'status: complete',
  'tasks:',
  '  - title: Task one',
  '    status: complete',
  '    commit: abc1234',
  '    concern: —',
  '    error: —',
  'END_WAVE_RESULT',
].join('\n');

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rad-adapters-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Write a tiny node script to `dir` that runs the given body, and return the
 * cmd string `node <path>` the command adapter can tokenize (no spaces in the
 * path so the whitespace tokenizer keeps it intact).
 */
function fakeCmd(dir, name, body) {
  const file = join(dir, name);
  writeFileSync(file, body, 'utf8');
  return `${NODE} ${file}`;
}

// ===========================================================================
// Command adapter — AC#3
// ===========================================================================

test('command adapter — success without ANTHROPIC_API_KEY in env', async () => {
  await withTempDir(async (dir) => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const cmd = fakeCmd(
        dir,
        'good.js',
        `process.stdout.write(${JSON.stringify(GOOD_RESULT)});\n`,
      );
      const runWave = createCommandAdapter({ cmd, repoRoot: dir });
      const result = await runWave(WAVE, PLAN_CTX);
      assert.equal(result.outcome, 'success');
      assert.equal(result.status, 'complete');
    } finally {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });
});

test('command adapter — timeout maps to fail-timeout', async () => {
  await withTempDir(async (dir) => {
    // A script that never writes and never exits within the deadline.
    const cmd = fakeCmd(dir, 'hang.js', 'setTimeout(() => {}, 60000);\n');
    const runWave = createCommandAdapter({ cmd, repoRoot: dir, timeoutMs: 50 });
    const result = await runWave(WAVE, PLAN_CTX);
    assert.equal(result.outcome, 'fail-timeout');
    assert.equal(result.status, 'failed');
  });
});

test('command adapter — missing WAVE_RESULT triggers exactly one reprompt then fail-protocol', async () => {
  await withTempDir(async (dir) => {
    // Count invocations via an append-only marker file; emit no WAVE_RESULT.
    const counter = join(dir, 'count.txt');
    const cmd = fakeCmd(
      dir,
      'noblock.js',
      `const fs=require('fs');fs.appendFileSync(${JSON.stringify(counter)},'x');` +
        `process.stdout.write('I did some work but forgot the block.');\n`,
    );
    const runWave = createCommandAdapter({ cmd, repoRoot: dir });
    const result = await runWave(WAVE, PLAN_CTX);
    assert.equal(result.outcome, 'fail-protocol');
    // Initial attempt + exactly one reprompt = 2 invocations.
    const fs = await import('node:fs');
    const calls = fs.readFileSync(counter, 'utf8').length;
    assert.equal(calls, 2, `expected exactly 2 invocations (1 reprompt); got ${calls}`);
  });
});

test('command adapter — non-zero exit is classified terminally', async () => {
  await withTempDir(async (dir) => {
    const cmd = fakeCmd(
      dir,
      'fail.js',
      `process.stderr.write('boom');process.exit(7);\n`,
    );
    const runWave = createCommandAdapter({ cmd, repoRoot: dir });
    const result = await runWave(WAVE, PLAN_CTX);
    assert.equal(result.status, 'failed');
    assert.notEqual(result.outcome, 'success');
    // The synthetic failure surfaces the non-zero exit summary.
    assert.ok(
      result.tasks[0].error.includes('code 7'),
      `error should mention exit code 7; got ${result.tasks[0].error}`,
    );
  });
});

test('command adapter — child env omits a sentinel but forwards USER (allow-list)', async () => {
  await withTempDir(async (dir) => {
    const SENTINEL = 'RAD_TEST_SENTINEL_SECRET';
    process.env[SENTINEL] = 'leak-me-if-you-can';
    process.env.USER = 'rad-test-user';
    try {
      // The fake agent emits a valid WAVE_RESULT ONLY when the sentinel is
      // absent from its env AND USER is present; if the sentinel leaked, or
      // USER did not make it through, it writes nothing, so the adapter would
      // fall through to fail-protocol. Asserting success thus proves the
      // allow-list omitted the sentinel while forwarding USER.
      const cmd = fakeCmd(
        dir,
        'reportenv.js',
        `if(process.env[${JSON.stringify(SENTINEL)}]===undefined&&process.env.USER===${JSON.stringify('rad-test-user')}){` +
          `process.stdout.write(${JSON.stringify(GOOD_RESULT)});}` +
          `else{process.stdout.write('LEAKED');}\n`,
      );
      const runWave = createCommandAdapter({ cmd, repoRoot: dir });
      const result = await runWave(WAVE, PLAN_CTX);
      assert.equal(result.outcome, 'success', 'sentinel must not reach the child env, and USER must');
    } finally {
      delete process.env[SENTINEL];
    }
  });
});

test('command adapter — child env has no USER key when parent USER is unset', async () => {
  await withTempDir(async (dir) => {
    const savedUser = process.env.USER;
    delete process.env.USER;
    try {
      // Asserts absence (no USER key at all), not an empty string — mirrors
      // buildChildEnv's "skip undefined keys" behavior.
      const cmd = fakeCmd(
        dir,
        'reportnouser.js',
        `if(!Object.prototype.hasOwnProperty.call(process.env,'USER')){` +
          `process.stdout.write(${JSON.stringify(GOOD_RESULT)});}` +
          `else{process.stdout.write('USER_LEAKED:'+JSON.stringify(process.env.USER));}\n`,
      );
      const runWave = createCommandAdapter({ cmd, repoRoot: dir });
      const result = await runWave(WAVE, PLAN_CTX);
      assert.equal(result.outcome, 'success', 'child env must have no USER key when parent USER is unset');
    } finally {
      if (savedUser !== undefined) process.env.USER = savedUser;
    }
  });
});

// ===========================================================================
// SDK adapter — AC#3 (injected fake `query`, no network)
// ===========================================================================

/**
 * Build a fake async-generator `query` that yields an assistant text block then
 * a successful result. Captures the options it was handed for later assertion.
 */
function fakeQuery(text, captured) {
  return function query(opts) {
    if (captured) captured.opts = opts.options;
    return (async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
      yield { type: 'result', is_error: false, result: '' };
    })();
  };
}

test('sdk adapter — success via injected query', async () => {
  const runWave = createRunWave({
    apiKey: 'sk-ant-fake-key-value-1234567890',
    model: 'claude-test',
    query: fakeQuery(GOOD_RESULT),
  });
  const result = await runWave(WAVE, PLAN_CTX);
  assert.equal(result.outcome, 'success');
  assert.equal(result.status, 'complete');
});

test('sdk adapter — timeout maps to fail-timeout', async () => {
  // A query that never yields — withTimeout fires.
  const hangingQuery = () =>
    (async function* () {
      await new Promise(() => {});
      yield { type: 'result', is_error: false, result: '' };
    })();

  const runWave = createRunWave({
    apiKey: 'sk-ant-fake-key',
    query: hangingQuery,
    timeoutMs: 50,
    sleep: () => Promise.resolve(),
  });
  const result = await runWave(WAVE, PLAN_CTX);
  assert.equal(result.outcome, 'fail-timeout');
});

test('sdk adapter — env handed to the SDK is the allow-list (omits a sentinel)', async () => {
  const SENTINEL = 'RAD_TEST_SDK_SENTINEL';
  process.env[SENTINEL] = 'do-not-forward';
  try {
    const captured = {};
    const runWave = createRunWave({
      apiKey: 'sk-ant-fake-key-value-1234567890',
      query: fakeQuery(GOOD_RESULT, captured),
    });
    await runWave(WAVE, PLAN_CTX);
    const env = captured.opts.env;
    assert.equal(env[SENTINEL], undefined, 'sentinel must NOT be forwarded to the SDK');
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-fake-key-value-1234567890', 'key is injected');
  } finally {
    delete process.env[SENTINEL];
  }
});

test('sdk adapter — a fake key value never appears in a thrown/logged string', async () => {
  const KEY = 'sk-ant-supersecret-key-abcdefghijklmnop';
  // A query that throws an error embedding the key — the adapter must sanitize
  // it before it lands in the synthetic failure tasks.
  const leakyQuery = () =>
    (async function* () {
      // eslint-disable-next-line no-unused-vars
      yield { type: 'assistant', message: { content: [] } };
      throw new Error(`auth failed using ${KEY} — not found`);
    })();

  const runWave = createRunWave({
    apiKey: KEY,
    query: leakyQuery,
    sleep: () => Promise.resolve(),
  });
  const result = await runWave(WAVE, PLAN_CTX);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(KEY), 'the key must never appear in the surfaced result');
});

// ===========================================================================
// Per-wave model tiering — AC#2
// ===========================================================================

test('sdk adapter — a wave with a declared model invokes the query with that model', async () => {
  const captured = {};
  const runWave = createRunWave({
    apiKey: 'sk-ant-fake-key-value-1234567890',
    model: 'claude-opus-4-8', // deliver default (construction-time)
    query: fakeQuery(GOOD_RESULT, captured),
  });
  // planCtx declares a per-wave override for wave 1.
  const planCtx = { ...PLAN_CTX, waveModels: { 1: 'claude-haiku-4-5' } };
  await runWave({ ...WAVE, n: 1 }, planCtx);
  assert.equal(captured.opts.model, 'claude-haiku-4-5', 'declared per-wave model is used');
});

test('sdk adapter — a wave without a declared model uses the deliver default', async () => {
  const captured = {};
  const runWave = createRunWave({
    apiKey: 'sk-ant-fake-key-value-1234567890',
    model: 'claude-opus-4-8', // deliver default (construction-time)
    query: fakeQuery(GOOD_RESULT, captured),
  });
  // waveModels has an entry for wave 2 only; wave 1 must fall back to default.
  const planCtx = { ...PLAN_CTX, waveModels: { 2: 'claude-haiku-4-5' } };
  await runWave({ ...WAVE, n: 1 }, planCtx);
  assert.equal(captured.opts.model, 'claude-opus-4-8', 'falls back to deliver default');
});

// ===========================================================================
// deliverCommand adapter selection — AC#4
// ===========================================================================

async function withTempRepo(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'rad-select-'));
  try {
    return await fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function writeApprovedPlan(repoRoot, feature) {
  const plansDir = join(repoRoot, '.agents', 'plans');
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(
    join(plansDir, `${feature}.md`),
    [
      `# ${feature}`,
      '',
      'Status: approved',
      `Branch: rad/${feature}`,
      '',
      '## Acceptance Criteria',
      '',
      '1. Example criterion.',
    ].join('\n'),
    'utf8',
  );
  const stateDir = join(repoRoot, '.agents', 'state', feature);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'events.jsonl'),
    JSON.stringify({ type: 'approved', actor: 'a@b.c', role: 'architect', ts: '2026-01-01T00:00:00.000Z' }) + '\n',
    'utf8',
  );
}

const okSh = () => ({ status: 0, stdout: '', stderr: '' });

test('deliverCommand — sdk selection requires ANTHROPIC_API_KEY', async () => {
  await withTempRepo(async (repoRoot) => {
    const feature = 'sel-sdk';
    writeApprovedPlan(repoRoot, feature);

    const saved = { key: process.env.ANTHROPIC_API_KEY, agent: process.env.RAD_AGENT };
    delete process.env.ANTHROPIC_API_KEY;
    process.env.RAD_AGENT = 'sdk';
    let stderr = '';
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c, ...r) => { stderr += c; return orig(c, ...r); };
    let code;
    try {
      code = await deliverCommand([feature], { repoRoot, sh: okSh });
    } finally {
      process.stderr.write = orig;
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.agent !== undefined) process.env.RAD_AGENT = saved.agent; else delete process.env.RAD_AGENT;
    }
    assert.equal(code, 1);
    assert.ok(stderr.includes('ANTHROPIC_API_KEY'));
  });
});

test('deliverCommand — command selection requires RAD_AGENT_CMD, not the key', async () => {
  await withTempRepo(async (repoRoot) => {
    const feature = 'sel-cmd';
    writeApprovedPlan(repoRoot, feature);

    const saved = {
      key: process.env.ANTHROPIC_API_KEY,
      agent: process.env.RAD_AGENT,
      cmd: process.env.RAD_AGENT_CMD,
    };
    delete process.env.ANTHROPIC_API_KEY;
    process.env.RAD_AGENT = 'command';
    delete process.env.RAD_AGENT_CMD;
    let stderr = '';
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c, ...r) => { stderr += c; return orig(c, ...r); };
    let code;
    try {
      code = await deliverCommand([feature], { repoRoot, sh: okSh });
    } finally {
      process.stderr.write = orig;
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.agent !== undefined) process.env.RAD_AGENT = saved.agent; else delete process.env.RAD_AGENT;
      if (saved.cmd !== undefined) process.env.RAD_AGENT_CMD = saved.cmd;
    }
    assert.equal(code, 1);
    assert.ok(stderr.includes('RAD_AGENT_CMD'));
    assert.ok(!stderr.includes('ANTHROPIC_API_KEY'));
  });
});
