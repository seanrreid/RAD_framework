/**
 * Characterization of the command and SDK adapters (#252, part 2 of 6).
 *
 * Runs the REAL adapters over a fixed scenario matrix and compares each
 * normalized result to fixtures/adapter-golden.json, which was generated from
 * the adapters BEFORE their function-length refactor. A refactor must leave
 * every record unchanged. `UPDATE_GOLDEN=1` rewrites the golden file; without it
 * the test only reads and compares. Nothing nondeterministic is recorded: the
 * temp dir is normalized to <TMP>, no pids or timings, and the SDK retry delay
 * (random jitter) is counted, never compared.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createCommandAdapter, probeCommand, runCommandPrompt } from '../adapters/agent/command.js';
import { createRunWave } from '../adapters/agent/sdk.js';

const NODE = process.execPath;
const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(HERE, 'fixtures', 'adapter-golden.json');
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === '1';

const TEST_API_KEY = 'sk-ant-fake-key-value-1234567890';
const SHORT_TIMEOUT_MS = 400;
const KILL_GRACE_MS = 100;
const OUTPUT_CAP_BYTES = 10 * 1024 * 1024;
const OVERSIZE_PROMPT_CHARS = 1024 * 1024;
const SDK_ENV = { PATH: '/usr/bin', HOME: '/home/golden', LANG: 'C', LC_ALL: 'C', TMPDIR: '/tmp', TERM: 'dumb' };

const WAVE = { n: 1, type: 'sequential', tasks: [{ title: 'Task one', file: 'a.js', what: 'do a' }] };
const PLAN_CTX = {
  feature: 'demo',
  branch: 'rad/demo',
  executionLog: '.agents/logs/demo.md',
  executionNotes: { doNotTouch: [], keyFiles: [], reminders: [] },
  acceptanceCriteria: ['demo criterion'],
};

const GOOD_RESULT = [
  'WAVE_RESULT', 'wave: 1', 'status: complete', 'tasks:',
  '  - title: Task one', '    status: complete', '    commit: abc1234',
  '    concern: —', '    error: —', 'END_WAVE_RESULT',
].join('\n');

// ---------------------------------------------------------------------------
// Command adapter
// ---------------------------------------------------------------------------

/** One fake agent; argv[2] selects the behavior, a marker file marks call 2. */
const FAKE_AGENT = `
const fs = require('node:fs');
const path = require('node:path');
const scenario = process.argv[2];
const GOOD = ${JSON.stringify(GOOD_RESULT)};
const flood = () => {
  const chunk = 'x'.repeat(1024 * 1024);
  const pump = () => { while (process.stdout.write(chunk)) {} process.stdout.once('drain', pump); };
  process.stdout.on('error', () => process.exit(0));
  pump();
};
const echoBlock = (text) => GOOD.replace('Task one', text.replace(/\\s+/g, ' '));
const secondCall = () => {
  const marker = path.join(__dirname, 'marker-' + scenario);
  const seen = fs.existsSync(marker);
  fs.writeFileSync(marker, '1');
  return seen;
};
const readStdin = (done) => { let s = ''; process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => done(s)); };
const behaviors = {
  success: () => { process.stdout.write(GOOD); },
  'success-usage': () => { process.stdout.write(GOOD + '\\nRAD_USAGE {"input_tokens":10,"output_tokens":5,"cost":0.5,"cache_read_input_tokens":2,"cache_creation_input_tokens":3}\\n'); },
  'bad-usage': () => { process.stdout.write(GOOD + '\\nRAD_USAGE {not json}\\n'); },
  'reprompt-only': () => { process.stdout.write(secondCall() ? GOOD : 'no block here'); },
  'no-block': () => { process.stdout.write('still no block'); },
  'exit-block': () => { process.stdout.write(GOOD); process.exitCode = 1; },
  'exit-stderr': () => { process.stderr.write('boom: bad flag'); process.exitCode = 2; },
  'exit-stdout': () => { process.stdout.write('Not logged in'); process.exitCode = 1; },
  'exit-silent': () => { process.exitCode = 3; },
  hang: () => { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); },
  flood,
  'model-echo': () => { process.stdout.write(echoBlock('model=' + process.argv[3] + ' cwd=' + process.cwd())); },
  'prompt-echo': () => { process.stdout.write(echoBlock('prompt=' + process.argv[3].slice(0, 40))); },
  'stdin-echo': () => { readStdin((s) => process.stdout.write(JSON.stringify({ stdin: s.slice(0, 40), len: s.length }))); },
  'no-read': () => { process.stdout.write(GOOD); },
};
behaviors[scenario]();
`;

function normalizer(dir) {
  // Longest first: on macOS the realpath (/private/var/...) contains the plain path.
  const variants = [...new Set([realpathSync(dir), dir])];
  return (value) => {
    let text = JSON.stringify(value === undefined ? null : value);
    for (const v of variants) text = text.split(JSON.stringify(v).slice(1, -1)).join('<TMP>');
    return JSON.parse(text);
  };
}

/** Record a result plus its own-key list, so key presence is part of the contract. */
function record(result, normalize) {
  const isObject = result && typeof result === 'object';
  return { keys: isObject ? Object.keys(result) : null, result: normalize(result) };
}

/** Run `fn`; record a thrown error as { threw: { name, message } }. */
async function capture(fn, normalize) {
  try {
    return record(await fn(), normalize);
  } catch (err) {
    return { threw: { name: err.name, message: normalize(err.message) } };
  }
}

/** Overflow stdout length varies with chunking; record only that it respected the cap. */
function withinCap(result) {
  if (typeof result.stdout !== 'string') return result;
  return { ...result, stdout: { withinCap: Buffer.byteLength(result.stdout) <= OUTPUT_CAP_BYTES } };
}

const BIG_WAVE = { ...WAVE, tasks: [{ title: 'Task one', file: 'a.js', what: 'x'.repeat(OVERSIZE_PROMPT_CHARS) }] };

function commandScenarios(dir, agent) {
  const cmd = (name, extra = '') => `${NODE} ${agent} ${name}${extra}`;
  const run = (name, opts = {}, wave = WAVE, ctx = PLAN_CTX) =>
    () => createCommandAdapter({ cmd: cmd(name), repoRoot: dir, ...opts })(wave, ctx);
  const timed = { timeoutMs: SHORT_TIMEOUT_MS, killGraceMs: KILL_GRACE_MS };
  const prompt = (name, opts = {}) => () => runCommandPrompt({ prompt: 'hello', repoRoot: dir, ...opts, cmd: cmd(name) });
  const probe = (name, opts = {}) => () => probeCommand({ repoRoot: dir, ...opts, cmd: cmd(name) });
  return {
    'wave:success': run('success'),
    'wave:success-usage': run('success-usage'),
    'wave:malformed-usage': run('bad-usage'),
    'wave:block-only-on-reprompt': run('reprompt-only'),
    'wave:no-block-after-reprompt': run('no-block'),
    'wave:exit-nonzero-with-block': run('exit-block'),
    'wave:exit-nonzero-stderr': run('exit-stderr'),
    'wave:exit-nonzero-stdout-only': run('exit-stdout'),
    'wave:exit-nonzero-no-output': run('exit-silent'),
    'wave:enoent': () => createCommandAdapter({ cmd: '/nonexistent/rad-binary', repoRoot: dir })(WAVE, PLAN_CTX),
    'wave:whitespace-cmd': () => createCommandAdapter({ cmd: '   ', repoRoot: dir })(WAVE, PLAN_CTX),
    'wave:missing-cmd': () => createCommandAdapter({ repoRoot: dir })(WAVE, PLAN_CTX),
    'wave:timeout': run('hang', timed),
    'wave:output-overflow': run('flood'),
    'wave:model-token-default': () => createCommandAdapter({ cmd: cmd('model-echo', ' {model}'), repoRoot: dir, model: 'm-default' })(WAVE, PLAN_CTX),
    'wave:model-token-wave-override': () => createCommandAdapter({ cmd: cmd('model-echo', ' {model}'), repoRoot: dir, model: 'm-default' })(WAVE, { ...PLAN_CTX, waveModels: { 1: 'm-wave' } }),
    'wave:model-token-unset': () => createCommandAdapter({ cmd: cmd('model-echo', ' {model}'), repoRoot: dir })(WAVE, PLAN_CTX),
    'wave:prompt-token': () => createCommandAdapter({ cmd: cmd('prompt-echo', ' {prompt}'), repoRoot: dir })(WAVE, PLAN_CTX),
    'wave:prompt-never-read': run('no-read', {}, BIG_WAVE),
    'wave:string-wave-id': () => createCommandAdapter({ cmd: cmd('success'), repoRoot: dir })({ ...WAVE, n: undefined, id: 'w-x' }, PLAN_CTX),
    'probe:ok': probe('success'),
    'probe:exit-nonzero-stderr': probe('exit-stderr'),
    'probe:exit-nonzero-stdout-only': probe('exit-stdout'),
    'probe:enoent': () => probeCommand({ cmd: '/nonexistent/rad-binary', repoRoot: dir }),
    'probe:empty-cmd': () => probeCommand({ cmd: '', repoRoot: dir }),
    'probe:whitespace-cmd': () => probeCommand({ cmd: '   ', repoRoot: dir }),
    'probe:timeout': probe('hang', timed),
    'probe:output-overflow': probe('flood'),
    'prompt:ok-stdin': prompt('stdin-echo'),
    'prompt:ok-prompt-token': () => runCommandPrompt({ cmd: cmd('prompt-echo', ' {prompt}'), prompt: 'hello', repoRoot: dir }),
    'prompt:exit-nonzero-stderr': prompt('exit-stderr'),
    'prompt:exit-nonzero-stdout-only': prompt('exit-stdout'),
    'prompt:enoent': () => runCommandPrompt({ cmd: '/nonexistent/rad-binary', prompt: 'hello', repoRoot: dir }),
    'prompt:timeout-label': prompt('hang', { ...timed, label: 'review' }),
    'prompt:output-overflow': async () => withinCap(await prompt('flood', { label: 'review' })()),
    'prompt:blank-cmd-throws': () => runCommandPrompt({ cmd: '  ', prompt: 'hello' }),
    'prompt:non-string-prompt-throws': () => runCommandPrompt({ cmd: 'x', prompt: 42 }),
  };
}

async function collectCommandRecords() {
  const dir = mkdtempSync(join(tmpdir(), 'rad-characterize-cmd-'));
  const normalize = normalizer(dir);
  const agent = join(dir, 'agent.cjs');
  writeFileSync(agent, FAKE_AGENT, 'utf8');
  const records = {};
  try {
    for (const [name, fn] of Object.entries(commandScenarios(dir, agent))) {
      records[name] = await capture(fn, normalize);
    }
  } finally {
    // Let SIGKILL-after-grace land on any hang agent before removing its dir.
    await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS * 3));
    rmSync(dir, { recursive: true, force: true });
  }
  return records;
}

// ---------------------------------------------------------------------------
// SDK adapter
// ---------------------------------------------------------------------------

const assistantText = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const resultOk = (result = '', usage) => ({ type: 'result', is_error: false, result, ...(usage ? { usage } : {}) });
const resultError = (errors, usage) => ({ type: 'result', is_error: true, ...(errors ? { errors } : {}), ...(usage ? { usage } : {}) });
const thrown = (message, props = {}) => ({ throws: Object.assign(new Error(message), props) });
const hang = (messages = []) => ({ messages, hang: true });

/** A scripted query: each call replays the next attempt; the last repeats. */
function scriptedQuery(attempts, calls) {
  return function query({ prompt, options }) {
    const attempt = attempts[Math.min(calls.length, attempts.length - 1)];
    calls.push({ prompt, options });
    return (async function* () {
      for (const message of attempt.messages ?? []) yield message;
      if (attempt.throws) throw attempt.throws;
      if (attempt.hang) {
        await new Promise((resolve) => options.abortController.signal.addEventListener('abort', resolve));
      }
    })();
  };
}

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const GOOD_MESSAGES = [assistantText(GOOD_RESULT), resultOk()];
const USAGE = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 7, cache_creation_input_tokens: 9 };

/** The query options minus the abortController object, with env reduced to its keys. */
function describeCall({ prompt, options }) {
  const { abortController, env, ...rest } = options;
  return { promptSha: sha(prompt), hasAbortController: abortController instanceof AbortController, envKeys: Object.keys(env).sort(), options: rest };
}

const SDK_SCENARIOS = {
  'success-assistant-text': { attempts: [{ messages: GOOD_MESSAGES }] },
  'success-result-string': { attempts: [{ messages: [resultOk(GOOD_RESULT)] }] },
  'usage-normalized': { attempts: [{ messages: [assistantText(GOOD_RESULT), resultOk('', USAGE)] }] },
  'usage-unusable': { attempts: [{ messages: [assistantText(GOOD_RESULT), resultOk('', { input_tokens: 'many' })] }] },
  'error-result-with-key': { attempts: [{ messages: [resultError([`bad credential ${TEST_API_KEY} rejected`])] }] },
  'error-result-without-key': { attempts: [{ messages: [resultError(['something went wrong'])] }] },
  'error-result-no-errors-array': { attempts: [{ messages: [resultError(undefined)] }] },
  'error-result-with-usage': { attempts: [{ messages: [resultError(['quota exceeded: token limit'], USAGE)] }] },
  'transient-then-success': { attempts: [thrown('rate limit', { status: 429 }), thrown('upstream', { status: 503 }), { messages: GOOD_MESSAGES }] },
  'transient-exhausted': { attempts: [thrown('rate limit', { status: 429 })] },
  'permanent-error': { attempts: [thrown('Unauthorized', { status: 401 })] },
  'unknown-error': { attempts: [thrown('something odd')] },
  'model-error': { attempts: [thrown('malformed response from model')] },
  'resource-error': { attempts: [thrown('context length exceeded')] },
  'timeout-no-usage': { attempts: [hang()], opts: { timeoutMs: 50 } },
  'timeout-with-usage': { attempts: [hang([resultOk('', USAGE)])], opts: { timeoutMs: 50 } },
  'block-only-on-reprompt': { attempts: [{ messages: [assistantText('no block'), resultOk()] }, { messages: GOOD_MESSAGES }] },
  'no-block-after-reprompt': { attempts: [{ messages: [assistantText('no block'), resultOk()] }] },
  'transient-during-reprompt': { attempts: [{ messages: [assistantText('no block'), resultOk()] }, thrown('socket hang up'), { messages: GOOD_MESSAGES }] },
  'model-default': { attempts: [{ messages: GOOD_MESSAGES }], opts: { model: 'm-default', repoRoot: '/repo/root', maxTurns: 7 } },
  'model-wave-override': { attempts: [{ messages: GOOD_MESSAGES }], opts: { model: 'm-default' }, ctx: { waveModels: { 1: 'm-wave' } } },
  'model-unset-no-repo-root': { attempts: [{ messages: GOOD_MESSAGES }] },
  'capabilities-unconstrained': { attempts: [{ messages: GOOD_MESSAGES }], ctx: { waveEffective: { 2: ['fs_read'] } } },
  'capabilities-constrained': { attempts: [{ messages: GOOD_MESSAGES }], ctx: { waveEffective: { 1: ['fs_read', 'net'] } } },
  'capabilities-unmappable': { attempts: [{ messages: GOOD_MESSAGES }], ctx: { waveEffective: { 1: ['fs_read', 'mcp'] } } },
  'string-wave-id': { attempts: [{ messages: GOOD_MESSAGES }], wave: { ...WAVE, n: undefined, id: 'w-x' } },
};

async function runSdkScenario({ attempts, opts = {}, ctx = {}, wave = WAVE }) {
  const calls = [];
  let sleeps = 0;
  const runWave = createRunWave({
    apiKey: TEST_API_KEY,
    query: scriptedQuery(attempts, calls),
    sleep: async () => { sleeps += 1; },
    ...opts,
  });
  const result = await runWave(wave, { ...PLAN_CTX, ...ctx });
  return { ...record(result, (v) => JSON.parse(JSON.stringify(v ?? null))), sleepCalls: sleeps, queryCalls: calls.map(describeCall) };
}

async function collectSdkRecords() {
  const saved = Object.fromEntries(Object.keys(SDK_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, SDK_ENV);
  const records = {};
  try {
    for (const [name, scenario] of Object.entries(SDK_SCENARIOS)) {
      records[name] = await runSdkScenario(scenario).catch((err) => ({ threw: { name: err.name, message: err.message } }));
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Golden comparison
// ---------------------------------------------------------------------------

const actual = { command: await collectCommandRecords(), sdk: await collectSdkRecords() };
if (UPDATE_GOLDEN) writeFileSync(GOLDEN_PATH, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));

test('characterization — golden file covers exactly the scenario matrix', () => {
  assert.deepEqual(Object.keys(golden.command).sort(), Object.keys(actual.command).sort());
  assert.deepEqual(Object.keys(golden.sdk).sort(), Object.keys(actual.sdk).sort());
});

for (const group of ['command', 'sdk']) {
  for (const name of Object.keys(actual[group])) {
    test(`characterization — ${group} adapter: ${name}`, () => {
      assert.deepEqual(actual[group][name], golden[group][name]);
    });
  }
}
