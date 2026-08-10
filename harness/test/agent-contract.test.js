import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWavePrompt,
  extractWaveResultBlock,
  parseWaveResult,
  resultToOutcome,
  toWaveResult,
  classifyError,
  withTimeout,
  PRIOR_FAILURE_FIELD_MAX_CHARS,
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

test('buildWavePrompt — AC#5: includes a frugality/truncate reminder', () => {
  const wave = { n: 1, type: 'sequential', tasks: [{ title: 'T', file: 'a.js', what: 'do' }] };
  const planCtx = { feature: 'demo', branch: 'rad/demo', executionLog: '.agents/logs/demo.md' };
  const prompt = buildWavePrompt(wave, planCtx);
  assert.ok(/[Tt]runcate/.test(prompt), 'prompt should instruct truncating large outputs');
  assert.ok(
    prompt.includes('do not paste entire files'),
    'prompt should discourage pasting entire files/logs into reasoning',
  );
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

// --- Review fixes: escalation mapping + safe unknown-status default ---

test('resultToOutcome — blocked_spec/blocked_intent escalate to fail-scope (non-retryable)', () => {
  // The wave taxonomy says these are NOT fixable by retry — they must route to
  // the abort/escalate path (fail-scope), not the revision/retry path (fail-tests).
  const spec = resultToOutcome({ status: 'failed', tasks: [{ status: 'blocked_spec' }] });
  assert.equal(spec, 'fail-scope');
  const intent = resultToOutcome({
    status: 'failed',
    tasks: [{ status: 'complete' }, { status: 'blocked_intent' }],
  });
  assert.equal(intent, 'fail-scope');
});

test('resultToOutcome — a plain blocked_code stays fail-tests (retryable)', () => {
  const outcome = resultToOutcome({ status: 'failed', tasks: [{ status: 'blocked_code' }] });
  assert.equal(outcome, 'fail-tests');
});

test('parseWaveResult — an unrecognized task status defaults to non-passing, never success', () => {
  const block = [
    'wave: 1',
    'status: complete',
    'tasks:',
    '  - title: typo status',
    '    status: blocked-code',       // hyphen typo — not a valid status
    '    commit: abc1234',
    '    concern: —',
    '    error: —',
  ].join('\n');
  const parsed = parseWaveResult(block);
  assert.notEqual(parsed.tasks[0].status, 'complete');
  // A malformed status must NOT be silently reported as a passing wave.
  assert.equal(resultToOutcome(parsed), 'fail-tests');
});

// ---------------------------------------------------------------------------
// toWaveResult — AC#6 `tasks` pass-through and malformed degradation
//
// `toWaveResult` is the single place every adapter builds its return value, so
// the optional contract fields are defined once. The property under test is that
// OPTIONAL means OMITTED: a key that has nothing to say is absent, never present
// and undefined — that is what keeps a tasks-free wave-attempt event
// byte-identical to a pre-`tasks` one.
// ---------------------------------------------------------------------------

test('toWaveResult — a non-empty tasks list is passed through, not collapsed by the outcome mapping', () => {
  const parsed = {
    status: 'complete',
    tasks: [
      { title: 'One', status: 'complete' },
      { title: 'Two', status: 'done_with_concerns' },
    ],
  };
  const usage = { input: 10, output: 5, total: 15 };
  const result = toWaveResult(parsed, usage);

  assert.equal(result.outcome, 'success');
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.tasks, parsed.tasks, 'per-task records survive the mapping');
  assert.deepEqual(result.usage, usage);
});

test('toWaveResult — AC#6 malformed or absent tasks DEGRADE TO OMISSION: the key is absent, and nothing throws', () => {
  // Every shape an adapter could realistically hand over when the WAVE_RESULT
  // block was missing, empty, or unparseable.
  const malformed = [
    null,
    undefined,
    {},
    { status: 'failed' },
    { status: 'failed', tasks: [] },
    { status: 'failed', tasks: null },
    { status: 'failed', tasks: 'not-an-array' },
    { status: 'failed', tasks: 42 },
  ];
  for (const parsed of malformed) {
    const result = toWaveResult(parsed);
    assert.ok(
      !('tasks' in result),
      `tasks must be ABSENT (not undefined) for ${JSON.stringify(parsed)}`,
    );
    assert.ok(!('usage' in result), 'usage must be ABSENT when the adapter observed none');
    assert.deepEqual(Object.keys(result), ['outcome', 'status']);
    assert.ok(VALID_MATRIX_OUTCOMES.has(result.outcome));
  }
});

test('toWaveResult — the pass-through NEVER changes the outcome: it is resultToOutcome alone, every time', () => {
  // The degradation must not itself introduce a failure mode. Whatever
  // resultToOutcome says about a shape (including its pre-existing
  // no-parseable-tasks → fail-protocol), toWaveResult repeats verbatim.
  const shapes = [
    null,
    {},
    { status: 'failed', tasks: [] },
    { status: 'failed', tasks: 'not-an-array' },
    { status: 'complete', tasks: [{ title: 'A', status: 'complete' }] },
    { status: 'failed', tasks: [{ title: 'A', status: 'blocked_code' }] },
    { status: 'failed', tasks: [{ title: 'A', status: 'blocked_spec' }] },
  ];
  for (const parsed of shapes) {
    assert.equal(
      toWaveResult(parsed).outcome,
      resultToOutcome(parsed),
      `outcome drifted for ${JSON.stringify(parsed)}`,
    );
  }
});

test('toWaveResult — a falsy usage is omitted rather than recorded as an empty object', () => {
  const parsed = { status: 'complete', tasks: [{ title: 'A', status: 'complete' }] };
  for (const usage of [undefined, null, 0, false]) {
    const result = toWaveResult(parsed, usage);
    assert.ok(!('usage' in result), `usage must be absent for ${String(usage)}`);
  }
});

// ---------------------------------------------------------------------------
// buildWavePrompt — AC#4 the optional `## Prior Attempt Failure` section
//
// The section is the whole point of #90: without it, a bounded retry re-sends a
// byte-identical prompt and differs from its predecessor only by model
// nondeterminism. Two properties matter — absence changes nothing, and the
// truncation cap actually BITES (an untruncated failing suite in the retry
// prompt reproduces the context flood this feature exists to prevent).
// ---------------------------------------------------------------------------

const PROMPT_CTX = {
  feature: 'demo',
  branch: 'rad/demo',
  executionLog: '.agents/logs/demo.md',
};
const PROMPT_WAVE = { n: 1, type: 'sequential', tasks: [{ title: 'T', file: 'a.js', what: 'do' }] };

test('buildWavePrompt — AC#4 absent priorFailure renders the prompt byte-for-byte as before the section existed', () => {
  const legacy = buildWavePrompt(PROMPT_WAVE, PROMPT_CTX); // no key at all
  for (const priorFailure of [null, undefined]) {
    const explicit = buildWavePrompt(PROMPT_WAVE, { ...PROMPT_CTX, priorFailure });
    assert.equal(explicit, legacy, `an explicit ${String(priorFailure)} must change nothing`);
  }
  assert.ok(!legacy.includes('Prior Attempt Failure'), 'no section on a first attempt');
});

test('buildWavePrompt — AC#4 a prior failure renders the outcome, the blocking task, and the output excerpt', () => {
  const prompt = buildWavePrompt(PROMPT_WAVE, {
    ...PROMPT_CTX,
    priorFailure: {
      attempt: 1,
      outcome: 'fail-tests',
      task: { title: 'Wire the thing', status: 'blocked_code', error: 'assertion failed' },
      excerpt: '2 tests failed in foo.test.js',
    },
  });
  assert.ok(prompt.includes('## Prior Attempt Failure'), 'section heading rendered');
  assert.ok(prompt.includes('Attempt 1'), 'names which attempt failed');
  assert.ok(prompt.includes('fail-tests'), 'names the outcome');
  assert.ok(prompt.includes('Wire the thing'), 'names the blocking task');
  assert.ok(prompt.includes('blocked_code'), 'reports the blocking task status');
  assert.ok(prompt.includes('assertion failed'), 'reports the task error');
  assert.ok(prompt.includes('2 tests failed in foo.test.js'), 'carries the verification excerpt');
});

test('buildWavePrompt — AC#4 truncation BITES: an oversized excerpt is capped at PRIOR_FAILURE_FIELD_MAX_CHARS, tail kept', () => {
  const OVERSIZE = PRIOR_FAILURE_FIELD_MAX_CHARS * 10;
  const excerpt = 'HEAD-MARKER' + 'x'.repeat(OVERSIZE) + 'TAIL-MARKER';
  const baseline = buildWavePrompt(PROMPT_WAVE, PROMPT_CTX);
  const prompt = buildWavePrompt(PROMPT_WAVE, {
    ...PROMPT_CTX,
    priorFailure: { attempt: 1, outcome: 'fail-tests', excerpt },
  });

  assert.ok(
    prompt.includes(`(truncated: last ${PRIOR_FAILURE_FIELD_MAX_CHARS} of ${excerpt.length} chars)`),
    'the cap is reported when it bites',
  );
  assert.ok(prompt.includes('TAIL-MARKER'), 'the TAIL is what survives — where runners summarize');
  assert.ok(!prompt.includes('HEAD-MARKER'), 'the head was truncated away');
  // The whole prompt grew by at most the cap plus the section scaffolding — NOT
  // by the 40000-char excerpt. This is the assertion that would fail if the cap
  // were ever made best-effort.
  assert.ok(
    prompt.length < baseline.length + PRIOR_FAILURE_FIELD_MAX_CHARS + 500,
    `prompt grew to ${prompt.length}; the cap did not bite`,
  );
});

test('buildWavePrompt — AC#4 the cap applies to the reported task error too, not only the excerpt', () => {
  const error = 'e'.repeat(PRIOR_FAILURE_FIELD_MAX_CHARS * 3);
  const baseline = buildWavePrompt(PROMPT_WAVE, PROMPT_CTX);
  const prompt = buildWavePrompt(PROMPT_WAVE, {
    ...PROMPT_CTX,
    priorFailure: {
      attempt: 2,
      outcome: 'fail-tests',
      task: { title: 'T', status: 'blocked_code', error },
    },
  });
  assert.ok(
    prompt.includes(`(truncated: last ${PRIOR_FAILURE_FIELD_MAX_CHARS} of ${error.length} chars)`),
    'an oversized task error is capped as well',
  );
  assert.ok(prompt.length < baseline.length + PRIOR_FAILURE_FIELD_MAX_CHARS + 500);
});
