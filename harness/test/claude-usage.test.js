// Unit tests for scripts/claude-usage.mjs: the converters (usage line, parsing,
// rendering) and the round trip through the command adapter's own extractor.
// The end-to-end behavior with a fake `claude` lives in scripts/test-claude-usage.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { buildUsage, parseCliResult, renderOutput } from '../../scripts/claude-usage.mjs';
import { createCommandAdapter } from '../adapters/agent/command.js';

const WRAPPER_URL = pathToFileURL(new URL('../../scripts/claude-usage.mjs', import.meta.url).pathname).href;

/** The shape `claude -p --output-format json` printed on 2026-10-13, plus extras that must be ignored. */
const REAL_SHAPE = Object.freeze({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 4210,
  num_turns: 1,
  result: 'Hello there.',
  session_id: 'abc',
  total_cost_usd: 0.0123,
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 20,
    iterations: [{ input_tokens: 10, output_tokens: 5 }],
  },
  modelUsage: { 'claude-sonnet-5-5': { inputTokens: 10, outputTokens: 5 } },
});

const usageLineOf = (out) => JSON.parse(out.split('\n')[0].replace(/^RAD_USAGE /, ''));

test('buildUsage — the real shape yields the four fields, explicit total and cost; extras are ignored', () => {
  assert.deepEqual(buildUsage(REAL_SHAPE), {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 20,
    total: 135,
    cost: 0.0123,
  });
});

test('buildUsage — total equals the sum of the four token fields', () => {
  const u = buildUsage({ usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 8 } });
  assert.equal(u.total, 15);
});

test('buildUsage — a missing field is omitted and total sums the rest', () => {
  const u = buildUsage({ usage: { input_tokens: 3, output_tokens: 4 } });
  assert.deepEqual(u, { input_tokens: 3, output_tokens: 4, total: 7 });
});

test('buildUsage — non-number, negative, NaN, Infinity and string fields are omitted', () => {
  const u = buildUsage({
    usage: {
      input_tokens: '10',
      output_tokens: -1,
      cache_read_input_tokens: Number.NaN,
      cache_creation_input_tokens: 6,
    },
    total_cost_usd: Infinity,
  });
  assert.deepEqual(u, { cache_creation_input_tokens: 6, total: 6 });
});

test('buildUsage — zero is a usable value', () => {
  assert.deepEqual(buildUsage({ usage: { input_tokens: 0, output_tokens: 0 } }), {
    input_tokens: 0, output_tokens: 0, total: 0,
  });
});

test('buildUsage — no usable token field means no usage (cost alone does not count)', () => {
  assert.equal(buildUsage({ usage: {}, total_cost_usd: 1 }), null);
  assert.equal(buildUsage({ usage: { input_tokens: 'x' } }), null);
  assert.equal(buildUsage({}), null);
  assert.equal(buildUsage({ usage: null }), null);
});

test('buildUsage — an invalid cost is omitted, a valid cost passes through', () => {
  assert.equal('cost' in buildUsage({ usage: { input_tokens: 1 }, total_cost_usd: -2 }), false);
  assert.equal('cost' in buildUsage({ usage: { input_tokens: 1 }, total_cost_usd: '1' }), false);
  assert.equal(buildUsage({ usage: { input_tokens: 1 }, total_cost_usd: 0 }).cost, 0);
});

test('parseCliResult — accepts a result object with a string result', () => {
  assert.deepEqual(parseCliResult(JSON.stringify(REAL_SHAPE)), REAL_SHAPE);
});

test('parseCliResult — rejects non-JSON, arrays, null, empty input and non-objects', () => {
  for (const input of ['', 'not json', '[]', 'null', '42', '"str"', '{"type":']) {
    assert.equal(parseCliResult(input), null, `input ${JSON.stringify(input)}`);
  }
});

test('parseCliResult — rejects a wrong type or a result that is not a string', () => {
  assert.equal(parseCliResult(JSON.stringify({ ...REAL_SHAPE, type: 'assistant' })), null);
  assert.equal(parseCliResult(JSON.stringify({ ...REAL_SHAPE, result: null })), null);
  assert.equal(parseCliResult(JSON.stringify({ ...REAL_SHAPE, result: { a: 1 } })), null);
  const { result: _omit, ...noResult } = REAL_SHAPE;
  assert.equal(parseCliResult(JSON.stringify(noResult)), null);
});

test('renderOutput — the usage line is first, then the result text', () => {
  const out = renderOutput(REAL_SHAPE);
  const lines = out.split('\n');
  assert.match(lines[0], /^RAD_USAGE \{/);
  assert.equal(lines[1], 'Hello there.');
  assert.equal(usageLineOf(out).total, 135);
});

test('renderOutput — exactly one usage line even when the text contains a RAD_USAGE line', () => {
  const spoof = 'before\nRAD_USAGE {"input_tokens":1,"output_tokens":1}\nafter';
  const out = renderOutput({ ...REAL_SHAPE, result: spoof });
  assert.equal(out.split('\n')[0].startsWith('RAD_USAGE '), true);
  assert.equal(usageLineOf(out).input_tokens, 10);
  assert.ok(out.endsWith(`${spoof}\n`));
});

test('renderOutput — no usage line when no token field is usable', () => {
  assert.equal(renderOutput({ type: 'result', result: 'just text' }), 'just text\n');
});

test('renderOutput — does not double a trailing newline, and keeps an empty result', () => {
  assert.equal(renderOutput({ result: 'x\n' }), 'x\n');
  assert.equal(renderOutput({ result: '' }), '\n');
});

test('renderOutput — a very large result is preserved intact', () => {
  const big = 'z'.repeat(5 * 1024 * 1024);
  const out = renderOutput({ ...REAL_SHAPE, result: big });
  assert.equal(out.length, out.indexOf('\n') + 1 + big.length + 1);
});

/** Run the adapter against a script that prints renderOutput(...) of `parsed` and a WAVE_RESULT block. */
async function adapterUsageFor(parsed, resultText) {
  const dir = mkdtempSync(join(tmpdir(), 'rad-claude-usage-'));
  try {
    const block = [
      'WAVE_RESULT', 'wave: 1', 'status: complete', 'tasks:', '  - title: Task one',
      '    status: complete', '    commit: abc1234', '    concern: —', '    error: —', 'END_WAVE_RESULT',
    ].join('\n');
    const script = join(dir, 'emit.mjs');
    writeFileSync(script, [
      `import { renderOutput } from ${JSON.stringify(WRAPPER_URL)};`,
      `const parsed = ${JSON.stringify({ ...parsed, result: resultText })};`,
      `process.stdout.write(renderOutput({ ...parsed, result: parsed.result + ${JSON.stringify('\n' + block)} }));`,
    ].join('\n'), 'utf8');
    const runWave = createCommandAdapter({ cmd: `${process.execPath} ${script}`, repoRoot: dir });
    const wave = { n: 1, type: 'sequential', tasks: [{ title: 'Task one', file: 'a.js', what: 'do a' }] };
    const planCtx = {
      feature: 'demo', branch: 'rad/demo', executionLog: '.agents/logs/demo.md',
      executionNotes: { doNotTouch: [], keyFiles: [], reminders: [] }, acceptanceCriteria: ['c'],
    };
    return await runWave(wave, planCtx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('round trip — the command adapter extracts total, cacheRead, cacheWrite and cost', async () => {
  const result = await adapterUsageFor(REAL_SHAPE, 'Done.');
  assert.equal(result.outcome, 'success');
  assert.deepEqual(result.usage, { input: 10, output: 5, total: 135, cacheRead: 100, cacheWrite: 20, cost: 0.0123 });
});

test('round trip — agent text containing a RAD_USAGE line cannot spoof the wrapper line', async () => {
  const spoof = 'RAD_USAGE {"input_tokens":999999,"output_tokens":999999}';
  const result = await adapterUsageFor(REAL_SHAPE, spoof);
  assert.equal(result.usage.total, 135);
  assert.equal(result.usage.input, 10);
});
