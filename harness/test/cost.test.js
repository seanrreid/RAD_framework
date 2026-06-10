/**
 * Cross-cutting cost / frugality behaviors for the cost-frugality-layer feature.
 *
 * Consolidates the behaviors that span more than one module: usage recording +
 * aggregation (events.js + spine.js), per-wave model selection (the adapters),
 * the token-budget breaker (spine.js), and the prompt frugality reminder
 * (contract.js). Module-local edge cases already live in events.test.js,
 * spine.test.js, and agent-adapters.test.js — this file does NOT duplicate them;
 * it asserts the end-to-end cost contract.
 *
 * Everything probabilistic/side-effecting is injected (fake state, fake runWave,
 * injectable SDK `query`) — no network, no real model, no filesystem.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deliverSpine } from '../spine.js';
import { totalUsage } from '../events.js';
import { loadMatrix } from '../matrix.js';
import { buildWavePrompt } from '../adapters/agent/contract.js';
import { createRunWave } from '../adapters/agent/sdk.js';

const MATRIX = loadMatrix();

/** In-memory fake StateStore: records appends; gate()/plan() are scripted. */
function makeFakeState({ gateResult, plan }) {
  const appended = [];
  return {
    appended,
    async gate() {
      return gateResult;
    },
    append(event) {
      appended.push(event);
    },
    plan() {
      return plan;
    },
    history() {
      return appended;
    },
    phase() {
      return null;
    },
    list() {
      return [];
    },
  };
}

const passingGate = { passed: true, reason: 'ok' };

function fixedClock() {
  let i = 0;
  return () => `t${i++}`;
}

// ── (1) Usage recording + aggregation, with a legacy (no-usage) event ──

test('(1) wave-attempt records adapter usage; legacy attempts (no usage) fold cleanly', async () => {
  const state = makeFakeState({
    gateResult: passingGate,
    plan: { waves: [{ n: 1 }, { n: 2 }] },
  });

  // Wave 1's adapter supplies usage; wave 2's adapter supplies NONE (legacy).
  const runWave = async (wave) =>
    wave.n === 1
      ? { outcome: 'success', usage: { input: 100, output: 40, total: 140 } }
      : { outcome: 'success' }; // no usage key at all

  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave,
    sh: () => ({ status: 0 }),
    now: fixedClock(),
  });
  assert.deepEqual(result, { ok: true, waves: 2 });

  const attempts = state.appended.filter((e) => e.type === 'wave-attempt');
  assert.equal(attempts.length, 2);
  // Wave 1 carries the recorded usage on the event payload.
  assert.deepEqual(attempts[0].data.usage, { input: 100, output: 40, total: 140 });
  // Wave 2's usage is absent (undefined) — folds the same as a legacy event.
  assert.equal(attempts[1].data.usage, undefined);

  // The pure aggregation tolerates the missing-usage event: it contributes 0.
  assert.deepEqual(totalUsage(state.appended), { input: 100, output: 40, total: 140 });

  // A history with NO usage anywhere folds to all-zeros, never NaN/throw.
  const legacyOnly = state.appended.map((e) =>
    e.type === 'wave-attempt' ? { ...e, data: { wave: e.data.wave } } : e,
  );
  assert.deepEqual(totalUsage(legacyOnly), { input: 0, output: 0, total: 0 });
});

// ── (2) Per-wave Model: selection via planCtx.waveModels, with a default ──

test('(2) planCtx.waveModels selects the per-wave model; default applies when absent', async () => {
  const seen = [];
  // Fake SDK query: records the model it was handed, emits a valid WAVE_RESULT.
  const fakeQuery = ({ options }) => {
    seen.push(options.model);
    return (async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text:
                'WAVE_RESULT\nwave: 1\nstatus: complete\ntasks:\n' +
                '  - title: t\n    status: complete\n    commit: abc\n' +
                'END_WAVE_RESULT',
            },
          ],
        },
      };
      yield { type: 'result', is_error: false, result: '' };
    })();
  };

  const runWave = createRunWave({
    apiKey: 'test-key',
    model: 'claude-opus-4-8', // construction-time DEFAULT
    query: fakeQuery,
  });

  // Wave 1 overrides the model; wave 2 declares none → default applies.
  const planCtx = { feature: 'demo', waveModels: { 1: 'claude-haiku-4-5' } };

  await runWave({ n: 1 }, planCtx);
  await runWave({ n: 2 }, planCtx);

  assert.equal(seen[0], 'claude-haiku-4-5'); // per-wave override won
  assert.equal(seen[1], 'claude-opus-4-8'); // fell back to the default
});

// ── (3) Token-budget breaker: graceful stop before the next wave; unset = no change ──

test('(3) RAD_TOKEN_BUDGET exceeded → stopped:token-budget before the next wave (no throw)', async () => {
  const state = makeFakeState({
    gateResult: passingGate,
    plan: { waves: [{ n: 1 }, { n: 2 }] },
  });

  let calls = 0;
  // Wave 1 spends 150 tokens; the budget of 100 must stop the run before wave 2.
  const runWave = async () => {
    calls += 1;
    return { outcome: 'success', usage: { input: 100, output: 50, total: 150 } };
  };

  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave,
    sh: () => ({ status: 0 }),
    now: fixedClock(),
    tokenBudget: 100,
  });

  // Graceful structured terminal — never a throw, never a process.exit.
  assert.equal(result.stopped, 'token-budget');
  assert.equal(result.ok, false);
  assert.equal(result.wave, 2); // stopped BEFORE running wave 2
  assert.equal(result.spent, 150);
  assert.equal(result.budget, 100);
  assert.equal(calls, 1); // wave 2's model work never happened

  const failed = state.appended.find((e) => e.type === 'wave-failed');
  assert.equal(failed.data.reason, 'token-budget');
});

test('(3b) unset budget (null) → all waves run, no token-budget stop', async () => {
  const state = makeFakeState({
    gateResult: passingGate,
    plan: { waves: [{ n: 1 }, { n: 2 }] },
  });
  let calls = 0;
  const runWave = async () => {
    calls += 1;
    return { outcome: 'success', usage: { input: 999, output: 999, total: 1998 } };
  };

  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave,
    sh: () => ({ status: 0 }),
    now: fixedClock(),
    tokenBudget: null, // disabled
  });

  assert.deepEqual(result, { ok: true, waves: 2 });
  assert.equal(calls, 2); // both waves ran despite large spend
  assert.equal(
    state.appended.some((e) => e.type === 'wave-failed'),
    false,
  );
});

// ── (4) The frugality reminder lives in the wave prompt ──

test('(4) buildWavePrompt carries the truncate-outputs frugality reminder', () => {
  const prompt = buildWavePrompt(
    { n: 1, tasks: [] },
    { feature: 'demo', branch: 'rad/demo', executionLog: 'log.md' },
  );
  assert.match(prompt, /Truncate large file\/command outputs/);
  assert.match(prompt, /do not paste entire files or long logs/);
});

// ── (3c) Resume seeds `spent` from prior usage: budget is a LIFETIME ceiling ──
test('(3c) token budget is cumulative across resume — prior spend seeds the breaker', async () => {
  const state = makeFakeState({
    gateResult: passingGate,
    plan: { waves: [{ n: 1 }, { n: 2 }] },
  });
  // Prior run: wave 1 advanced and already spent 120 tokens (over the 100 budget).
  state.appended.push(
    { feature: 'demo', type: 'wave-attempt', data: { wave: 1, outcome: 'success', usage: { input: 80, output: 40, total: 120 } } },
    { feature: 'demo', type: 'wave-complete', data: { wave: 1 } },
  );

  let calls = 0;
  const runWave = async () => {
    calls += 1;
    return { outcome: 'success', usage: { input: 10, output: 10, total: 20 } };
  };

  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave,
    sh: () => ({ status: 0 }),
    now: fixedClock(),
    tokenBudget: 100,
  });

  // Seeded spend (120) already exceeds the budget, so the resumed run stops at
  // wave 2 WITHOUT running it — a fresh-start (spent=0) would have let it run.
  assert.equal(result.stopped, 'token-budget');
  assert.equal(result.spent, 120);
  assert.equal(result.wave, 2);
  assert.equal(calls, 0, 'no further model work once the lifetime budget is spent');
});

// ── (3d) A non-positive budget disables the breaker (spine API defensiveness) ──
test('(3d) a negative tokenBudget disables the breaker (does not fire on wave 1)', async () => {
  const state = makeFakeState({ gateResult: passingGate, plan: { waves: [{ n: 1 }] } });
  let calls = 0;
  const runWave = async () => {
    calls += 1;
    return { outcome: 'success', usage: { input: 10, output: 10, total: 20 } };
  };

  const result = await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: MATRIX,
    gates: {},
    runWave,
    sh: () => ({ status: 0 }),
    now: fixedClock(),
    tokenBudget: -5, // truthy but non-positive — must be treated as disabled
  });

  assert.deepEqual(result, { ok: true, waves: 1 });
  assert.equal(calls, 1, 'the wave ran — a negative budget never arms the breaker');
});
