import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWavePrompt,
  extractWaveResultBlock,
  parseWaveResult,
  resultToOutcome,
  classifyError,
  withTimeout,
} from '../adapters/agent/contract.js';

// The fixed matrix outcome vocabulary (harness/matrix.yaml). resultToOutcome
// and the adapters must only ever emit a string from this set.
const VALID_MATRIX_OUTCOMES = new Set([
  'success',
  'fail-tests',
  'fail-scope',
  'fail-protocol',
  'fail-timeout',
  'no-changes',
  'abort-user',
]);

// ---------------------------------------------------------------------------
// resultToOutcome — AC#2 result→outcome reconciliation
// ---------------------------------------------------------------------------

test('resultToOutcome — all complete maps to success', () => {
  const parsed = {
    status: 'complete',
    tasks: [
      { status: 'complete' },
      { status: 'done_with_concerns' },
    ],
  };
  const outcome = resultToOutcome(parsed);
  assert.equal(outcome, 'success');
  assert.ok(VALID_MATRIX_OUTCOMES.has(outcome));
});

test('resultToOutcome — a blocked_* task maps to a valid matrix failure outcome', () => {
  const parsed = {
    status: 'failed',
    tasks: [
      { status: 'complete' },
      { status: 'blocked_code' },
    ],
  };
  const outcome = resultToOutcome(parsed);
  assert.ok(VALID_MATRIX_OUTCOMES.has(outcome), `outcome '${outcome}' must be a matrix outcome`);
  assert.notEqual(outcome, 'success', 'a blocked task must not be reported as success');
});

test('resultToOutcome — empty / unparseable maps to fail-protocol', () => {
  assert.equal(resultToOutcome({ status: 'failed', tasks: [] }), 'fail-protocol');
  assert.equal(resultToOutcome(null), 'fail-protocol');
  assert.equal(resultToOutcome({}), 'fail-protocol');
});

// ---------------------------------------------------------------------------
// buildWavePrompt — AC#2 prompt shape
// ---------------------------------------------------------------------------

test('buildWavePrompt — includes the task titles and the branch', () => {
  const wave = {
    n: 2,
    type: 'sequential',
    tasks: [
      { title: 'First task title', file: 'a.js', what: 'do a' },
      { title: 'Second task title', file: 'b.js', what: 'do b' },
    ],
  };
  const planCtx = {
    feature: 'demo',
    branch: 'rad/demo',
    executionLog: '.agents/logs/demo.md',
  };
  const prompt = buildWavePrompt(wave, planCtx);
  assert.ok(prompt.includes('rad/demo'), 'prompt should include the branch');
  assert.ok(prompt.includes('First task title'), 'prompt should include task 1 title');
  assert.ok(prompt.includes('Second task title'), 'prompt should include task 2 title');
});

// ---------------------------------------------------------------------------
// parseWaveResult — AC#2 round-trip of a sample WAVE_RESULT block
// ---------------------------------------------------------------------------

test('parseWaveResult — round-trips a sample WAVE_RESULT block', () => {
  const sample = [
    'WAVE_RESULT',
    'wave: 3',
    'status: complete',
    'tasks:',
    '  - title: Wire the thing',
    '    status: complete',
    '    commit: abc1234',
    '    concern: —',
    '    error: —',
    '  - title: Test the thing',
    '    status: done_with_concerns',
    '    commit: def5678',
    '    concern: flaky on CI',
    '    error: —',
    'END_WAVE_RESULT',
  ].join('\n');

  const block = extractWaveResultBlock(sample);
  assert.ok(block, 'block should be extracted');
  const parsed = parseWaveResult(block);

  assert.equal(parsed.status, 'complete');
  assert.equal(parsed.tasks.length, 2);
  assert.equal(parsed.tasks[0].title, 'Wire the thing');
  assert.equal(parsed.tasks[0].status, 'complete');
  assert.equal(parsed.tasks[0].commit, 'abc1234');
  assert.equal(parsed.tasks[1].title, 'Test the thing');
  assert.equal(parsed.tasks[1].status, 'done_with_concerns');
  assert.equal(parsed.tasks[1].concern, 'flaky on CI');

  // The parsed result reconciles to a matrix outcome (round-trip closes here).
  assert.equal(resultToOutcome(parsed), 'success');
});

// ---------------------------------------------------------------------------
// classifyError — AC#2 retry buckets
// ---------------------------------------------------------------------------

test('classifyError — transient: 429 / rate limit / network', () => {
  assert.equal(classifyError({ status: 429 }), 'transient');
  assert.equal(classifyError(new Error('rate limit exceeded')), 'transient');
  assert.equal(classifyError({ code: 'ECONNRESET' }), 'transient');
  assert.equal(classifyError(new Error('socket hang up: network error')), 'transient');
});

test('classifyError — permanent: not-found / auth', () => {
  assert.equal(classifyError({ status: 404 }), 'permanent');
  assert.equal(classifyError({ status: 401 }), 'permanent');
  assert.equal(classifyError(new Error('authentication failed')), 'permanent');
  assert.equal(classifyError(new Error('resource not found')), 'permanent');
});

test('classifyError — model: malformed / invalid json', () => {
  assert.equal(classifyError(new Error('malformed response')), 'model');
  const syntax = new SyntaxError('Unexpected token < in JSON');
  assert.equal(classifyError(syntax), 'model');
});

test('classifyError — resource: token / context limit', () => {
  assert.equal(classifyError(new Error('token limit reached')), 'resource');
  assert.equal(classifyError(new Error('maximum context length exceeded')), 'resource');
});

// ---------------------------------------------------------------------------
// withTimeout — AC#2 aborts a never-resolving promise past the deadline
// ---------------------------------------------------------------------------

test('withTimeout — rejects a never-resolving promise past the deadline and aborts', async () => {
  const never = new Promise(() => {});
  const ac = new AbortController();

  await assert.rejects(
    () => withTimeout(never, 10, ac),
    /timed out/,
    'should reject with a timeout error',
  );
  assert.equal(ac.signal.aborted, true, 'the AbortController should have been aborted');
});

test('withTimeout — a fast promise resolves before the deadline', async () => {
  const fast = Promise.resolve('done');
  const value = await withTimeout(fast, 1000);
  assert.equal(value, 'done');
});
