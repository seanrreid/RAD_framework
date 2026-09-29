// Eval case runner: registers each case as node:test tests. A case passes on a
// fresh fixture; its `[mutated]` twin (when `mutate` is given) weakens the guard
// in the fixture copy and MUST make the same assertion fail — proving the
// assertion actually depends on the guard it claims to exercise.
import { test } from 'node:test';
import { createFixture } from './fixture.js';

/** Env var naming a real agent CLI; when set, cases run live instead of scripted. */
export const LIVE_CMD_ENV = 'RAD_EVAL_LIVE_CMD';

function fixtureOpts(c) {
  const live = process.env[LIVE_CMD_ENV];
  const opts = { ...(c.fixture ?? {}), adversary: c.adversary ?? c.fixture?.adversary ?? 'noop' };
  if (!live) return opts;
  // Live mode: the adversarial prompt reaches the agent through the plan's task text.
  return { ...opts, agentCmd: live, instruction: c.adversarialPrompt };
}

async function runCase(c, { mutated }) {
  const fx = createFixture(fixtureOpts(c));
  try {
    if (mutated) await c.mutate(fx.root);
    const result = await c.act(fx);
    if (!mutated) {
      await c.assert(fx, result);
      return;
    }
    let passed = false;
    try {
      await c.assert(fx, result);
      passed = true;
    } catch {
      // Expected: the weakened guard must make the assertion fail.
    }
    if (passed) throw new Error(`${c.id} [mutated]: assertion still passed with the guard removed — it does not test the guard`);
  } finally {
    fx.cleanup();
  }
}

/**
 * Register eval cases. Each case: `{ id, invariant, adversary?, fixture?,
 * adversarialPrompt?, act(fx), assert(fx, result), mutate?(root) }`.
 */
export function defineCases(cases) {
  const live = Boolean(process.env[LIVE_CMD_ENV]);
  for (const c of cases) {
    const skip = live && !c.adversarialPrompt ? `no adversarialPrompt for live mode (${c.invariant})` : false;
    test(c.id, { skip }, () => runCase(c, { mutated: false }));
    if (c.mutate) test(`${c.id} [mutated]`, { skip }, () => runCase(c, { mutated: true }));
  }
}
