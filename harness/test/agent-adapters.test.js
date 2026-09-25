import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  createCommandAdapter,
  probeCommand,
  PREFLIGHT_PROMPT,
  PREFLIGHT_TIMEOUT_MS,
} from '../adapters/agent/command.js';
import { withTimeout } from '../adapters/agent/contract.js';
import { createRunWave } from '../adapters/agent/sdk.js';
import { deliverCommand } from '../cli.js';
import { deliverSpine } from '../spine.js';
import { loadMatrix } from '../matrix.js';

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

test('command adapter — non-zero exit with empty stderr falls back to stdout excerpt', async () => {
  await withTempDir(async (dir) => {
    const cmd = fakeCmd(
      dir,
      'stdout-only.js',
      `process.stdout.write('Not logged in - please run /login');process.exit(3);\n`,
    );
    const runWave = createCommandAdapter({ cmd, repoRoot: dir });
    const result = await runWave(WAVE, PLAN_CTX);
    assert.equal(result.status, 'failed');
    const error = result.tasks[0].error;
    assert.ok(error.includes('code 3'), `error should mention exit code 3; got ${error}`);
    assert.ok(
      error.includes('Not logged in - please run /login'),
      `error should carry the stdout excerpt; got ${error}`,
    );
    assert.ok(error.includes('(stdout)'), `error should tag the excerpt's origin; got ${error}`);
  });
});

test('command adapter — non-zero exit with non-empty stderr is unchanged and omits stdout', async () => {
  await withTempDir(async (dir) => {
    const cmd = fakeCmd(
      dir,
      'both-streams.js',
      `process.stdout.write('STDOUT_SHOULD_NOT_APPEAR');` +
        `process.stderr.write('actual stderr reason');process.exit(5);\n`,
    );
    const runWave = createCommandAdapter({ cmd, repoRoot: dir });
    const result = await runWave(WAVE, PLAN_CTX);
    assert.equal(result.status, 'failed');
    const error = result.tasks[0].error;
    assert.ok(error.includes('code 5'), `error should mention exit code 5; got ${error}`);
    assert.ok(
      error.includes('actual stderr reason'),
      `error should carry the stderr text; got ${error}`,
    );
    assert.ok(
      !error.includes('STDOUT_SHOULD_NOT_APPEAR'),
      `stderr present — stdout must not be appended; got ${error}`,
    );
    assert.ok(!error.includes('(stdout)'), `stderr present — no stdout tag expected; got ${error}`);
  });
});

test('command adapter — stdout fallback excerpt is capped at 500 bytes and sanitized', async () => {
  await withTempDir(async (dir) => {
    const head = 'STDOUT_HEAD_MARKER ';
    const secret = `sk-ant-${'S'.repeat(20)} `;
    const filler = 'pad '.repeat(150); // well past the 500-byte cap before the tail marker
    const tail = 'STDOUT_TAIL_MARKER_SHOULD_BE_CUT';
    const stdoutBody = head + secret + filler + tail;
    const cmd = fakeCmd(
      dir,
      'stdout-overflow.js',
      `process.stdout.write(${JSON.stringify(stdoutBody)});process.exit(9);\n`,
    );
    const runWave = createCommandAdapter({ cmd, repoRoot: dir });
    const result = await runWave(WAVE, PLAN_CTX);
    assert.equal(result.status, 'failed');
    const error = result.tasks[0].error;
    assert.ok(error.includes('(stdout)'), `error should tag the excerpt's origin; got ${error}`);
    assert.ok(
      error.includes('STDOUT_HEAD_MARKER'),
      `excerpt should include content within the first 500 bytes; got ${error}`,
    );
    assert.ok(
      !error.includes('STDOUT_TAIL_MARKER_SHOULD_BE_CUT'),
      `excerpt should be capped before the 500-byte tail marker; got ${error}`,
    );
    assert.ok(
      error.includes('[REDACTED]') && !error.includes('S'.repeat(20)),
      `excerpt should be sanitized like the stderr path; got ${error}`,
    );
  });
});

// ===========================================================================
// Command adapter — startup failure classification (agent-startup-preflight AC#1, AC#2)
// ===========================================================================

test('command adapter — non-zero exit with empty output is fail-protocol', async () => {
  await withTempDir(async (dir) => {
    const cmd = fakeCmd(dir, 'silent-fail.js', 'process.exit(1);\n');
    const runWave = createCommandAdapter({ cmd, repoRoot: dir });
    const result = await runWave(WAVE, PLAN_CTX);
    assert.equal(result.outcome, 'fail-protocol');
    assert.equal(result.status, 'failed');
    assert.ok(result.tasks[0].error.includes('code 1'), `got ${result.tasks[0].error}`);
  });
});

test('command adapter — non-zero exit with stdout-only reason is fail-protocol and keeps the #117 excerpt', async () => {
  await withTempDir(async (dir) => {
    const cmd = fakeCmd(
      dir,
      'not-logged-in.js',
      `process.stdout.write('Not logged in - please run /login');process.exit(3);\n`,
    );
    const runWave = createCommandAdapter({ cmd, repoRoot: dir });
    const result = await runWave(WAVE, PLAN_CTX);
    assert.equal(result.outcome, 'fail-protocol');
    assert.equal(result.status, 'failed');
    assert.equal(
      result.tasks[0].error,
      'command exited with code 3: (stdout) Not logged in - please run /login',
    );
  });
});

test('command adapter — ENOENT spawn error is fail-protocol', async () => {
  await withTempDir(async (dir) => {
    const cmd = join(dir, 'no-such-agent-binary');
    const runWave = createCommandAdapter({ cmd, repoRoot: dir });
    const result = await runWave(WAVE, PLAN_CTX);
    assert.equal(result.outcome, 'fail-protocol');
    assert.equal(result.status, 'failed');
    assert.ok(result.tasks[0].error.includes('ENOENT'), `got ${result.tasks[0].error}`);
  });
});

test('command adapter — whitespace-only cmd (empty argv) is fail-protocol', async () => {
  await withTempDir(async (dir) => {
    const runWave = createCommandAdapter({ cmd: '   ', repoRoot: dir });
    const result = await runWave(WAVE, PLAN_CTX);
    assert.equal(result.outcome, 'fail-protocol');
    assert.ok(result.tasks[0].error.includes('empty cmd'), `got ${result.tasks[0].error}`);
  });
});

test('command adapter — non-zero exit WITH a WAVE_RESULT block keeps the retryable path', async () => {
  await withTempDir(async (dir) => {
    const cmd = fakeCmd(
      dir,
      'reported-fail.js',
      `process.stdout.write(${JSON.stringify(GOOD_RESULT)});process.stderr.write('tests red');process.exit(2);\n`,
    );
    const runWave = createCommandAdapter({ cmd, repoRoot: dir });
    const result = await runWave(WAVE, PLAN_CTX);
    assert.equal(result.outcome, 'fail-tests');
    assert.equal(result.status, 'failed');
    assert.equal(result.tasks[0].error, 'command exited with code 2: tests red');
  });
});

/** Minimal in-memory StateStore for driving deliverSpine (mirrors spine.test.js). */
function makeSpineState(plan) {
  const appended = [];
  return {
    appended,
    async gate() { return { passed: true, reason: 'ok', satisfiedBy: { actor: 'architect' } }; },
    append(event) { appended.push(event); },
    plan() { return plan; },
    history() { return appended; },
    phase() { return null; },
    list() { return []; },
  };
}

test('deliverSpine + command adapter — an agent that can never start stops after ONE attempt via matrix abort', async () => {
  await withTempDir(async (dir) => {
    const counter = join(dir, 'count.txt');
    const cmd = fakeCmd(
      dir,
      'never-starts.js',
      `require('fs').appendFileSync(${JSON.stringify(counter)},'x');` +
        `process.stdout.write('Not logged in');process.exit(1);\n`,
    );
    const adapter = createCommandAdapter({ cmd, repoRoot: dir });
    let attempts = 0;
    const runWave = async (wave, planCtx) => {
      attempts += 1;
      return adapter(wave, planCtx ?? PLAN_CTX);
    };
    const state = makeSpineState({ waves: [{ n: 1 }] });
    let t = 0;
    const result = await deliverSpine({
      feature: 'demo',
      state,
      docs: {},
      matrix: loadMatrix(),
      gates: {},
      runWave,
      sh: () => ({ status: 0 }),
      now: () => `t${t++}`,
    });
    assert.equal(result.stopped, 'matrix');
    assert.equal(result.action, 'abort');
    assert.equal(attempts, 1, 'the spine must not retry a startup failure');
    const fs = await import('node:fs');
    assert.equal(fs.readFileSync(counter, 'utf8').length, 1, 'the agent must be spawned exactly once');
    const failed = state.appended.filter((e) => e.type === 'wave-failed');
    assert.equal(failed.length, 1);
    assert.deepEqual(failed[0].data, { wave: 1, action: 'abort' });
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
// probeCommand — agent-startup-preflight AC#3
// ===========================================================================

test('probeCommand — exports a fixed one-line prompt and a named timeout', () => {
  assert.equal(PREFLIGHT_PROMPT, 'Reply with the single word OK.');
  assert.equal(PREFLIGHT_TIMEOUT_MS, 60_000);
});

test('probeCommand — exit 0 resolves ok without parsing the reply', async () => {
  await withTempDir(async (dir) => {
    const cmd = fakeCmd(dir, 'ok.js', `process.stdout.write('definitely not the word');\n`);
    assert.deepEqual(await probeCommand({ cmd, repoRoot: dir }), { ok: true });
  });
});

test('probeCommand — exit 1 with a stdout-only reason resolves not-ok carrying that text', async () => {
  await withTempDir(async (dir) => {
    const cmd = fakeCmd(dir, 'nologin.js', `process.stdout.write('Not logged in');process.exit(1);\n`);
    const result = await probeCommand({ cmd, repoRoot: dir });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'command exited with code 1: (stdout) Not logged in');
  });
});

test('probeCommand — stdout excerpt is capped and sanitized', async () => {
  await withTempDir(async (dir) => {
    const body = `sk-ant-${'S'.repeat(20)} ` + 'pad '.repeat(150) + 'TAIL_SHOULD_BE_CUT';
    const cmd = fakeCmd(dir, 'long.js', `process.stdout.write(${JSON.stringify(body)});process.exit(4);\n`);
    const result = await probeCommand({ cmd, repoRoot: dir });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('[REDACTED]') && !result.error.includes('S'.repeat(20)), result.error);
    assert.ok(!result.error.includes('TAIL_SHOULD_BE_CUT'), result.error);
  });
});

test('probeCommand — missing executable resolves not-ok (never throws)', async () => {
  await withTempDir(async (dir) => {
    const result = await probeCommand({ cmd: join(dir, 'no-such-agent-binary'), repoRoot: dir });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('ENOENT'), result.error);
  });
});

test('probeCommand — empty or whitespace-only cmd resolves not-ok', async () => {
  assert.equal((await probeCommand({ cmd: '' })).ok, false);
  const blank = await probeCommand({ cmd: '   ' });
  assert.equal(blank.ok, false);
  assert.ok(blank.error.includes('empty cmd'), blank.error);
});

test('probeCommand — timeout resolves not-ok', async () => {
  await withTempDir(async (dir) => {
    const cmd = fakeCmd(dir, 'slow.js', 'setTimeout(() => {}, 2000);\n');
    const result = await probeCommand({ cmd, repoRoot: dir, timeoutMs: 50 });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('timed out after 50ms'), result.error);
  });
});

// ===========================================================================
// Kill-on-timeout — deliver-path-robustness AC#1 / AC#2 / AC#3
// ===========================================================================

/** How long a hanging fake sleeps before it would write its marker. */
const HANG_SLEEP_MS = 30_000;
/** Adapter deadline for the kill tests — long enough for node to start. */
const KILL_TEST_TIMEOUT_MS = 1_000;
/** "Promptly": far under HANG_SLEEP_MS, with headroom for a loaded CI box. */
const PROMPT_RESOLVE_CEILING_MS = 10_000;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    throw err;
  }
}

/** Poll until `pid` is gone or `withinMs` elapses; returns final liveness. */
async function waitForDeath(pid, withinMs) {
  const deadline = Date.now() + withinMs;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return isAlive(pid);
}

/**
 * A fake agent that records its PID, then sleeps HANG_SLEEP_MS and would write
 * `marker` afterwards. With `trapTerm` it ignores SIGTERM (armed before the PID
 * file exists, so a readable PID implies the trap is live).
 */
function hangingAgent(dir, { trapTerm = false } = {}) {
  const pidFile = join(dir, 'agent.pid');
  const marker = join(dir, 'marker.txt');
  const cmd = fakeCmd(
    dir,
    trapTerm ? 'hang-trap.js' : 'hang-pid.js',
    `const fs=require('fs');` +
      (trapTerm ? `process.on('SIGTERM',()=>{});` : '') +
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));` +
      `setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'late'),${HANG_SLEEP_MS});\n`,
  );
  return { cmd, pidFile, marker };
}

/** Run `fn(agent)` and always reap the fake by PID so no stray process leaks. */
async function withHangingAgent(dir, opts, fn) {
  const agent = hangingAgent(dir, opts);
  const fs = await import('node:fs');
  try {
    return await fn(agent, () => Number(fs.readFileSync(agent.pidFile, 'utf8')));
  } finally {
    if (fs.existsSync(agent.pidFile)) {
      const pid = Number(fs.readFileSync(agent.pidFile, 'utf8'));
      if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  }
}

test('probeCommand — timeout kills the agent, never writes the marker, resolves promptly', async () => {
  await withTempDir(async (dir) => {
    await withHangingAgent(dir, {}, async (agent, readPid) => {
      const started = Date.now();
      const result = await probeCommand({ cmd: agent.cmd, repoRoot: dir, timeoutMs: KILL_TEST_TIMEOUT_MS });
      assert.ok(Date.now() - started < PROMPT_RESOLVE_CEILING_MS, 'resolved promptly after the deadline');
      assert.equal(result.ok, false);
      assert.equal(result.error, `agent preflight timed out after ${KILL_TEST_TIMEOUT_MS}ms`);
      assert.equal(await waitForDeath(readPid(), 3_000), false, 'agent PID is gone after the timeout');
      const fs = await import('node:fs');
      assert.equal(fs.existsSync(agent.marker), false, 'post-timeout marker never written');
    });
  });
});

test('command adapter — wave timeout kills the agent and keeps the exact wave message', async () => {
  await withTempDir(async (dir) => {
    await withHangingAgent(dir, {}, async (agent, readPid) => {
      const runWave = createCommandAdapter({ cmd: agent.cmd, repoRoot: dir, timeoutMs: KILL_TEST_TIMEOUT_MS });
      const started = Date.now();
      const result = await runWave(WAVE, PLAN_CTX);
      assert.ok(Date.now() - started < PROMPT_RESOLVE_CEILING_MS, 'resolved promptly after the deadline');
      assert.equal(result.outcome, 'fail-timeout', '_isRadTimeout still routes to fail-timeout');
      assert.equal(result.tasks[0].error, `wave timed out after ${KILL_TEST_TIMEOUT_MS}ms`);
      assert.equal(await waitForDeath(readPid(), 3_000), false, 'agent PID is gone after the timeout');
      const fs = await import('node:fs');
      assert.equal(fs.existsSync(agent.marker), false, 'post-timeout marker never written');
    });
  });
});

test('command adapter — a SIGTERM-ignoring agent is SIGKILLed after the grace', async () => {
  await withTempDir(async (dir) => {
    await withHangingAgent(dir, { trapTerm: true }, async (agent, readPid) => {
      const runWave = createCommandAdapter({
        cmd: agent.cmd, repoRoot: dir, timeoutMs: KILL_TEST_TIMEOUT_MS, killGraceMs: 200,
      });
      const result = await runWave(WAVE, PLAN_CTX);
      assert.equal(result.outcome, 'fail-timeout');
      const pid = readPid();
      assert.equal(await waitForDeath(pid, 3_000), false, 'agent PID is gone after the SIGKILL grace');
    });
  });
});

test('withTimeout — label names the timeout; default stays "wave"; sentinel set on both', async () => {
  const never = () => new Promise(() => {});
  const waveErr = await withTimeout(never(), 10).catch((e) => e);
  assert.equal(waveErr.message, 'wave timed out after 10ms');
  assert.equal(waveErr._isRadTimeout, true);
  const probeErr = await withTimeout(never(), 10, undefined, 'agent preflight').catch((e) => e);
  assert.equal(probeErr.message, 'agent preflight timed out after 10ms');
  assert.equal(probeErr._isRadTimeout, true);
});

test('probeCommand — child gets the probe prompt on stdin and only the allow-listed env', async () => {
  await withTempDir(async (dir) => {
    const SENTINEL = 'RAD_TEST_PROBE_SENTINEL';
    process.env[SENTINEL] = 'leak-me-if-you-can';
    try {
      const cmd = fakeCmd(
        dir,
        'probe-check.js',
        `let s='';process.stdin.on('data',(d)=>{s+=d;});process.stdin.on('end',()=>{` +
          `const leaked=process.env[${JSON.stringify(SENTINEL)}]!==undefined;` +
          `if(s===${JSON.stringify(PREFLIGHT_PROMPT)}&&!leaked){process.exit(0);}` +
          `process.stdout.write('stdin='+JSON.stringify(s)+' leaked='+leaked);process.exit(1);});\n`,
      );
      const result = await probeCommand({ cmd, repoRoot: dir });
      assert.deepEqual(result, { ok: true }, `probe child saw: ${result.error}`);
    } finally {
      delete process.env[SENTINEL];
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

// ===========================================================================
// deliverCommand startup preflight — AC#4 / AC#5
// ===========================================================================

// Every env knob that could steer these deliver runs; saved and restored per test.
const PREFLIGHT_ENV_KEYS = [
  'RAD_AGENT', 'RAD_AGENT_CMD', 'RAD_AGENT_PREFLIGHT', 'ANTHROPIC_API_KEY',
  'RAD_WORKTREE', 'RAD_SYNC', 'RAD_TOKEN_BUDGET',
];

const PREFLIGHT_FAIL_PREFIX =
  'rad deliver: RAD_AGENT_CMD failed to start under the adapter env ' +
  '(it must authenticate without inherited env vars): ';

/** An approved plan that also declares one wave, so the spine calls runWave. */
function writeApprovedWavePlan(repoRoot, feature) {
  writeApprovedPlan(repoRoot, feature);
  const planFile = join(repoRoot, '.agents', 'plans', `${feature}.md`);
  const waveBlock = '\n\n## Waves\n\n### Wave 1\n\n#### Task 1.1: Do a\nFile: a.js\n';
  writeFileSync(planFile, waveBlock, { encoding: 'utf8', flag: 'a' });
}

/** Event types recorded for a feature (the approved seed event included). */
async function eventTypes(repoRoot, feature) {
  const fs = await import('node:fs');
  const file = join(repoRoot, '.agents', 'state', feature, 'events.jsonl');
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
}

/**
 * A fake agent that logs each invocation to `log` ('P' for the preflight
 * prompt, 'W' for anything else) and exits with the given codes.
 */
function loggingAgent(dir, log, { probeExit, waveExit }) {
  return fakeCmd(
    dir,
    'logging-agent.js',
    `const fs=require('fs');let s='';process.stdin.on('data',(d)=>{s+=d;});` +
      `process.stdin.on('end',()=>{const p=s===${JSON.stringify(PREFLIGHT_PROMPT)};` +
      `fs.appendFileSync(${JSON.stringify(log)},p?'P':'W');` +
      `if(!p||${probeExit}!==0)process.stdout.write('Not logged in');` +
      `process.exit(p?${probeExit}:${waveExit});});\n`,
  );
}

/** Run deliverCommand with a scoped env and captured stderr. */
async function runDeliver(env, argv, ctx) {
  const saved = Object.fromEntries(PREFLIGHT_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of PREFLIGHT_ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  let stderr = '';
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (c, ...r) => { stderr += c; return orig(c, ...r); };
  try {
    return { code: await deliverCommand(argv, ctx), stderr };
  } finally {
    process.stderr.write = orig;
    for (const k of PREFLIGHT_ENV_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k]; else delete process.env[k];
    }
  }
}

async function invocations(log) {
  const fs = await import('node:fs');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
}

test('deliverCommand preflight — a failing probe returns 1 with the exact message and appends no events', async () => {
  await withTempRepo(async (repoRoot) => {
    const feature = 'pf-fail';
    writeApprovedWavePlan(repoRoot, feature);
    const log = join(repoRoot, 'calls.txt');
    const cmd = loggingAgent(repoRoot, log, { probeExit: 1, waveExit: 1 });

    const { code, stderr } = await runDeliver({ RAD_AGENT_CMD: cmd }, [feature], { repoRoot, sh: okSh });

    assert.equal(code, 1);
    assert.ok(stderr.includes(`${PREFLIGHT_FAIL_PREFIX}`), stderr);
    assert.ok(stderr.includes('Not logged in'), 'the probe error excerpt is surfaced');
    assert.equal(await invocations(log), 'P', 'only the probe ran — no wave was attempted');
    assert.deepEqual(await eventTypes(repoRoot, feature), ['approved'], 'no events appended');
  });
});

test('deliverCommand preflight — RAD_AGENT_PREFLIGHT=off skips the probe', async () => {
  await withTempRepo(async (repoRoot) => {
    const feature = 'pf-off';
    writeApprovedWavePlan(repoRoot, feature);
    const log = join(repoRoot, 'calls.txt');
    const cmd = loggingAgent(repoRoot, log, { probeExit: 1, waveExit: 1 });

    const { code, stderr } = await runDeliver(
      { RAD_AGENT_CMD: cmd, RAD_AGENT_PREFLIGHT: 'off' }, [feature], { repoRoot, sh: okSh },
    );

    assert.equal(code, 1, 'the always-failing agent still fails — at Wave 1 instead');
    assert.ok(!stderr.includes(PREFLIGHT_FAIL_PREFIX), stderr);
    assert.ok(!(await invocations(log)).includes('P'), 'the probe prompt was never sent');
    const types = await eventTypes(repoRoot, feature);
    assert.ok(types.includes('deliver-started'), types.join(','));
    assert.ok(types.includes('wave-failed'), types.join(','));
  });
});

test('deliverCommand preflight — any value other than exactly "off" still probes', async () => {
  await withTempRepo(async (repoRoot) => {
    const feature = 'pf-upper-off';
    writeApprovedWavePlan(repoRoot, feature);
    const log = join(repoRoot, 'calls.txt');
    const cmd = loggingAgent(repoRoot, log, { probeExit: 1, waveExit: 1 });

    const { code, stderr } = await runDeliver(
      { RAD_AGENT_CMD: cmd, RAD_AGENT_PREFLIGHT: 'OFF' }, [feature], { repoRoot, sh: okSh },
    );

    assert.equal(code, 1);
    assert.ok(stderr.includes(PREFLIGHT_FAIL_PREFIX), stderr);
    assert.equal(await invocations(log), 'P');
  });
});

test('deliverCommand preflight — a passing probe proceeds to wave execution', async () => {
  await withTempRepo(async (repoRoot) => {
    const feature = 'pf-pass';
    writeApprovedWavePlan(repoRoot, feature);
    const log = join(repoRoot, 'calls.txt');
    // Probe succeeds; the wave then fails to start, proving we got past preflight.
    const cmd = loggingAgent(repoRoot, log, { probeExit: 0, waveExit: 1 });

    const { stderr } = await runDeliver({ RAD_AGENT_CMD: cmd }, [feature], { repoRoot, sh: okSh });

    assert.ok(!stderr.includes(PREFLIGHT_FAIL_PREFIX), stderr);
    assert.equal(await invocations(log), 'PW', 'probe first, then exactly one wave attempt');
    const types = await eventTypes(repoRoot, feature);
    assert.ok(types.includes('deliver-started'), types.join(','));
  });
});

test('deliverCommand preflight — RAD_AGENT=sdk never probes RAD_AGENT_CMD', async () => {
  await withTempRepo(async (repoRoot) => {
    const feature = 'pf-sdk';
    // No waves: the SDK adapter is constructed but never called (no network).
    writeApprovedPlan(repoRoot, feature);
    const log = join(repoRoot, 'calls.txt');
    const cmd = loggingAgent(repoRoot, log, { probeExit: 1, waveExit: 1 });

    const { stderr } = await runDeliver(
      { RAD_AGENT: 'sdk', ANTHROPIC_API_KEY: 'sk-test-not-real', RAD_AGENT_CMD: cmd },
      [feature],
      { repoRoot, sh: okSh },
    );

    assert.ok(!stderr.includes(PREFLIGHT_FAIL_PREFIX), stderr);
    assert.equal(await invocations(log), '', 'RAD_AGENT_CMD was never spawned');
    assert.ok((await eventTypes(repoRoot, feature)).includes('deliver-started'));
  });
});

test('deliverCommand preflight — an injected ctx.runWave never probes', async () => {
  await withTempRepo(async (repoRoot) => {
    const feature = 'pf-injected';
    writeApprovedPlan(repoRoot, feature);
    const log = join(repoRoot, 'calls.txt');
    const cmd = loggingAgent(repoRoot, log, { probeExit: 1, waveExit: 1 });
    const runWave = async () => { throw new Error('no waves declared — must not be called'); };

    const { stderr } = await runDeliver({ RAD_AGENT_CMD: cmd }, [feature], { repoRoot, sh: okSh, runWave });

    assert.ok(!stderr.includes(PREFLIGHT_FAIL_PREFIX), stderr);
    assert.equal(await invocations(log), '', 'RAD_AGENT_CMD was never spawned');
  });
});
