// Characterization (golden) test for buildWavePrompt, classifyError and
// parseWaveResult. The golden file records the behavior of contract.js BEFORE
// the function-length refactor; it must never be regenerated afterwards.
// UPDATE_GOLDEN=1 writes the golden file; otherwise this test only compares.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildWavePrompt,
  classifyError,
  parseWaveResult,
} from '../adapters/agent/contract.js';

const GOLDEN_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'contract-golden.json',
);
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === '1';

// ---------------------------------------------------------------------------
// buildWavePrompt matrix
// ---------------------------------------------------------------------------

const baseCtx = {
  feature: 'demo-feature',
  branch: 'rad/demo-feature',
  executionLog: '.agents/logs/demo.md',
};
const baseWave = { n: 1, tasks: [] };
const fullNotes = {
  doNotTouch: ['a.js', 'b.js'],
  keyFiles: ['k1.js', 'k2.js'],
  reminders: ['remember one', 'remember two'],
};
const twoTasks = [
  { title: 'First', files: ['x.js', 'y.js'], what: 'do x', validate: 'check x' },
  { name: 'Named', file: 'z.js', what: 'do z' },
];

const PROMPT_CASES = [
  ['minimal wave', baseWave, baseCtx],
  ['empty executionNotes lists', baseWave, { ...baseCtx, executionNotes: { doNotTouch: [], keyFiles: [], reminders: [] } }],
  ['doNotTouch only', baseWave, { ...baseCtx, executionNotes: { doNotTouch: ['a.js'] } }],
  ['keyFiles only', baseWave, { ...baseCtx, executionNotes: { keyFiles: ['k.js'] } }],
  ['reminders only', baseWave, { ...baseCtx, executionNotes: { reminders: ['r'] } }],
  ['all notes present', baseWave, { ...baseCtx, executionNotes: fullNotes }],
  ['acceptance criteria empty', baseWave, { ...baseCtx, acceptanceCriteria: [] }],
  ['acceptance criteria present', baseWave, { ...baseCtx, acceptanceCriteria: ['first', 'second'] }],
  ['several tasks', { n: 2, tasks: twoTasks }, baseCtx],
  ['task with title/name fallback and missing fields', { n: 3, tasks: [{ title: 'T' }, { name: 'N' }, {}] }, baseCtx],
  ['task with files array vs file string', { n: 4, tasks: [{ files: ['a', 'b'] }, { file: 'c' }, { files: [] }] }, baseCtx],
  ['wave id from n', { n: 7, tasks: [] }, baseCtx],
  ['wave id from number', { number: 8, tasks: [] }, baseCtx],
  ['wave id from id', { id: 'w9', tasks: [] }, baseCtx],
  ['wave id none', { tasks: [] }, baseCtx],
  ['wave without tasks key', { n: 1 }, baseCtx],
  ['parallel wave type', { n: 1, type: 'parallel', tasks: [] }, baseCtx],
  ['prior failure full', baseWave, { ...baseCtx, priorFailure: { attempt: 2, outcome: 'fail-tests', task: { title: 'T', status: 'blocked_code', error: 'boom' }, excerpt: 'some output' } }],
  ['prior failure minimal', baseWave, { ...baseCtx, priorFailure: { outcome: 'fail-scope' } }],
  ['prior failure unnamed task and dash error', baseWave, { ...baseCtx, priorFailure: { task: { status: 'blocked_spec', error: '—' } } }],
  ['prior failure truncated fields', baseWave, { ...baseCtx, priorFailure: { attempt: 1, task: { title: 'T', error: 'e'.repeat(4500) }, excerpt: 'x'.repeat(4500) } }],
  ['operator context', baseWave, { ...baseCtx, operatorContext: { context: 'use approach B', stop: { class: 'needs-decision', reason: 'ambiguous', decision: 'pick one', wave: 3 } } }],
  ['operator context without stop wave', baseWave, { ...baseCtx, operatorContext: { context: 'hi', stop: { class: 'c', reason: 'r', decision: 'd' } } }],
  ['operator context with backtick fence', baseWave, { ...baseCtx, operatorContext: { context: 'a ```` b\n```\nc', stop: { class: 'c', reason: 'r', decision: 'd' } } }],
  ['verify command with timeout', { n: 1, tasks: [] }, { ...baseCtx, waveVerify: { 1: 'node --test x.js' }, verifyTimeoutSeconds: 1800 }],
  ['verify command with long backtick run', { n: 1, tasks: [] }, { ...baseCtx, waveVerify: { 1: 'echo `````x`````' }, verifyTimeoutSeconds: 60 }],
  ['verify blank command', { n: 1, tasks: [] }, { ...baseCtx, waveVerify: { 1: '   ' } }],
  ['no verify', { n: 1, tasks: [] }, { ...baseCtx, waveVerify: {} }],
  ['verify keyed by other wave', { n: 2, tasks: [] }, { ...baseCtx, waveVerify: { 1: 'x' } }],
  ['feature name with backticks', baseWave, { ...baseCtx, feature: 'we`ird`name' }],
  ['everything together', { n: 5, type: 'parallel', tasks: twoTasks }, {
    ...baseCtx,
    executionNotes: fullNotes,
    acceptanceCriteria: ['one', 'two'],
    priorFailure: { attempt: 3, outcome: 'fail-tests', task: { title: 'T', status: 'blocked_code', error: 'bad' }, excerpt: 'out' },
    operatorContext: { context: 'ctx', stop: { class: 'c', reason: 'r', decision: 'd', wave: 5 } },
    waveVerify: { 5: 'npm test' },
    verifyTimeoutSeconds: 900,
  }],
];

// ---------------------------------------------------------------------------
// classifyError matrix (inputs built lazily so Error objects are fresh)
// ---------------------------------------------------------------------------

const withName = (name, message = '') => {
  const e = new Error(message);
  e.name = name;
  return e;
};
const plain = (props) => ({ ...props });

const ERROR_CASES = [
  ['null', () => null],
  ['undefined', () => undefined],
  ['empty string', () => ''],
  ['string error plain', () => 'something odd'],
  ['string error rate limit', () => 'rate limit hit'],
  ['string error out of memory', () => 'out of memory'],
  ['number error', () => 42],
  ['plain Error unknown', () => new Error('mystery')],
  ['status 400', () => plain({ status: 400 })],
  ['status 401', () => plain({ status: 401 })],
  ['status 403', () => plain({ status: 403 })],
  ['status 404', () => plain({ status: 404 })],
  ['status 429', () => plain({ status: 429 })],
  ['status 500', () => plain({ status: 500 })],
  ['status 599', () => plain({ status: 599 })],
  ['statusCode 503', () => plain({ statusCode: 503 })],
  ['numeric code 502', () => plain({ code: 502 })],
  ['status string "500"', () => plain({ status: '500' })],
  ['code ECONNRESET', () => plain({ code: 'ECONNRESET' })],
  ['code ENOTFOUND', () => plain({ code: 'ENOTFOUND' })],
  ['code EAI_AGAIN', () => plain({ code: 'EAI_AGAIN' })],
  ['code ETIMEDOUT', () => plain({ code: 'ETIMEDOUT' })],
  ['code ECONNREFUSED', () => plain({ code: 'ECONNREFUSED' })],
  ['code ENOENT string', () => plain({ code: 'ENOENT' })],
  ['code UNKNOWN', () => plain({ code: 'WHATEVER' })],
  ['message oom', () => new Error('process hit OOM')],
  ['message out of memory', () => new Error('Out Of Memory')],
  ['message token limit', () => new Error('token limit exceeded')],
  ['message token-limit', () => new Error('token-limit exceeded')],
  ['message context length', () => new Error('context length exceeded')],
  ['message maximum context', () => new Error('maximum context reached')],
  ['message unauthorized', () => new Error('Unauthorized')],
  ['message forbidden', () => new Error('forbidden')],
  ['message permission', () => new Error('permission denied')],
  ['message authentication', () => new Error('authentication failed')],
  ['message not found', () => new Error('route not found')],
  ['message not-found', () => new Error('not-found')],
  ['message rate limit', () => new Error('rate limit exceeded')],
  ['message rate-limit', () => new Error('rate-limit')],
  ['message ratelimit', () => new Error('ratelimit')],
  ['message 429', () => new Error('got 429 back')],
  ['message timeout', () => new Error('request timeout')],
  ['message timed out', () => new Error('timed out')],
  ['message network', () => new Error('network down')],
  ['message socket', () => new Error('socket hang up')],
  ['message malformed', () => new Error('malformed response')],
  ['message invalid json', () => new Error('invalid json body')],
  ['message invalid-json', () => new Error('invalid-json')],
  ['message unexpected token', () => new Error('Unexpected token < in JSON')],
  ['mixed resource beats transient', () => new Error('token limit and rate limit')],
  ['mixed resource beats permanent', () => new Error('out of memory: permission denied')],
  ['mixed permanent beats transient', () => new Error('forbidden after timeout')],
  ['mixed transient beats model', () => new Error('network returned malformed data')],
  ['mixed 401 status beats transient message', () => Object.assign(new Error('timeout'), { status: 401 })],
  ['mixed 500 status beats model message', () => Object.assign(new Error('malformed'), { status: 500 })],
  ['mixed resource message beats 404 status', () => Object.assign(new Error('token limit'), { status: 404 })],
  ['mixed 429 status beats permanent-free message', () => Object.assign(new Error('hello'), { status: 429 })],
  ['mixed permanent message beats 500 status', () => Object.assign(new Error('forbidden'), { status: 500 })],
  ['raw name enoent lowercase', () => withName('enoent')],
  ['raw name ENOENT uppercase', () => withName('ENOENT')],
  ['raw name syntaxerror lowercase', () => withName('syntaxerror')],
  ['raw name SyntaxError', () => withName('SyntaxError')],
  ['raw name SyntaxError with message', () => withName('SyntaxError', 'bad input')],
  ['name TimeoutError', () => withName('TimeoutError', 'x')],
  ['empty object', () => ({})],
];

// ---------------------------------------------------------------------------
// parseWaveResult matrix
// ---------------------------------------------------------------------------

const PARSE_CASES = [
  ['empty block', ''],
  ['no tasks complete', 'wave: 1\nstatus: complete\ntasks:'],
  ['no tasks no status', 'wave: 1'],
  ['one complete task', 'wave: 1\nstatus: complete\ntasks:\n  - title: T1\n    status: complete\n    commit: abc123\n    concern: —\n    error: —'],
  ['two tasks mixed', 'status: failed\ntasks:\n  - title: A\n    status: done_with_concerns\n    commit: c1\n    concern: hmm\n    error: —\n  - title: B\n    status: blocked_spec\n    commit: —\n    concern: —\n    error: ambiguous'],
  ['unknown task status', 'status: complete\ntasks:\n  - title: A\n    status: weird'],
  ['empty task status value', 'status: complete\ntasks:\n  - title: A\n    status:  '],
  ['unknown wave status', 'status: partial\ntasks:\n  - title: A\n    status: complete'],
  ['duplicate top-level status last wins', 'status: failed\nstatus: complete\ntasks:\n  - title: A'],
  ['indented status before any task ignored', 'status: complete\n  status: failed\ntasks:\n  - title: A'],
  ['indented status after task belongs to task', 'status: complete\ntasks:\n  - title: A\n  status: blocked_intent'],
  ['tab indented status', 'status: complete\ntasks:\n\t- title: A\n\tstatus: blocked_code'],
  ['tab indented top-level status ignored', '\tstatus: complete\ntasks:'],
  ['field before any title', '    status: blocked_code\n    commit: zzz\ntasks:\n  - title: A'],
  ['CRLF line endings', 'wave: 1\r\nstatus: complete\r\ntasks:\r\n  - title: A\r\n    status: complete\r\n    commit: abc\r\n'],
  ['trailing whitespace', 'status: complete   \ntasks:\n  - title: A   \n    status: complete  \n    commit: abc   '],
  ['title with colon', 'status: complete\ntasks:\n  - title: Fix: the thing'],
  ['field without space after colon', 'status:complete\ntasks:\n  - title: A\n    commit:abc'],
  ['unindented task fields', 'status: complete\ntasks:\n- title: A\nstatus: blocked_code\ncommit: nope'],
  ['unknown field ignored', 'status: complete\ntasks:\n  - title: A\n    extra: stuff\n    commit: c'],
  ['repeated field last wins', 'status: complete\ntasks:\n  - title: A\n    commit: one\n    commit: two'],
  ['status complete only with blank lines', '\n\nstatus: complete\n\n'],
];

// ---------------------------------------------------------------------------
// Golden plumbing
// ---------------------------------------------------------------------------

function computeAll() {
  return {
    buildWavePrompt: Object.fromEntries(
      PROMPT_CASES.map(([name, wave, ctx]) => [name, buildWavePrompt(wave, ctx)]),
    ),
    classifyError: Object.fromEntries(
      ERROR_CASES.map(([name, make]) => [name, classifyError(make())]),
    ),
    parseWaveResult: Object.fromEntries(
      PARSE_CASES.map(([name, block]) => [name, parseWaveResult(block)]),
    ),
  };
}

if (UPDATE_GOLDEN) {
  fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
  fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(computeAll(), null, 2)}\n`);
}

const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

test('matrix sizes meet the plan minimums', () => {
  assert.ok(PROMPT_CASES.length >= 14, `prompt cases: ${PROMPT_CASES.length}`);
  assert.ok(ERROR_CASES.length >= 35, `error cases: ${ERROR_CASES.length}`);
  assert.ok(PARSE_CASES.length >= 15, `parse cases: ${PARSE_CASES.length}`);
});

test('golden file has exactly the matrix entries', () => {
  assert.deepStrictEqual(Object.keys(golden.buildWavePrompt), PROMPT_CASES.map((c) => c[0]));
  assert.deepStrictEqual(Object.keys(golden.classifyError), ERROR_CASES.map((c) => c[0]));
  assert.deepStrictEqual(Object.keys(golden.parseWaveResult), PARSE_CASES.map((c) => c[0]));
});

for (const [name, wave, ctx] of PROMPT_CASES) {
  test(`buildWavePrompt: ${name}`, () => {
    assert.strictEqual(buildWavePrompt(wave, ctx), golden.buildWavePrompt[name]);
  });
}

for (const [name, make] of ERROR_CASES) {
  test(`classifyError: ${name}`, () => {
    assert.strictEqual(classifyError(make()), golden.classifyError[name]);
  });
}

for (const [name, block] of PARSE_CASES) {
  test(`parseWaveResult: ${name}`, () => {
    assert.deepStrictEqual(parseWaveResult(block), golden.parseWaveResult[name]);
  });
}
