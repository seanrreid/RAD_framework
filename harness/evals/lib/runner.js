// Eval case runner: registers each case as node:test tests. A case passes on a
// fresh fixture; its `[mutated]` twin (when `mutate` is given) weakens the guard
// in the fixture copy and MUST make the same assertion fail — proving the
// assertion actually depends on the guard it claims to exercise.
//
// Lanes:
//   scripted — the default. A scripted adversary drives each case; runs per PR
//              in CI (evals-scripted job) as `node --test harness/evals/*.eval.js`.
//   live     — set RAD_EVAL_LIVE_CMD to a real agent CLI; the case's
//              adversarialPrompt reaches it through the plan's task text. Manual
//              only for now; its CI workflow comes with #49 / Plan 3.
//   liveOnly — a case marked `liveOnly: true` exercises model judgment, which a
//              scripted adversary cannot stand in for: it is SKIPPED with a
//              visible reason in the scripted lane and runs only when live.
// Full lane documentation: docs/evals.md.
// Mutation rule: every case that exercises a guard declares a `mutate` that
//   disables that guard in the fixture copy; the `[mutated]` twin must fail.
// Registry rule: every invariant in docs/invariants.yaml records `evals` (the
//   eval files whose cases target it) or `not_evalable` (an honest reason);
//   scripts/lint-invariants.sh enforces this fail-closed.
import { test } from 'node:test';
import { createFixture } from './fixture.js';

/** Env var naming a real agent CLI; when set, cases run live instead of scripted. */
export const LIVE_CMD_ENV = 'RAD_EVAL_LIVE_CMD';
/** Skip reason shown for a live-only case in the scripted lane — never a silent pass. */
export const LIVE_ONLY_SKIP = `live-only (set ${LIVE_CMD_ENV})`;

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

/** A live-only case must carry its prompt and no mutated twin (a model refusal would make the twin flaky). */
function checkLiveOnly(c) {
  if (!c.liveOnly) return;
  if (!c.adversarialPrompt) throw new Error(`${c.id}: liveOnly case requires an adversarialPrompt`);
  if (c.mutate) throw new Error(`${c.id}: liveOnly case must not declare mutate`);
}

function skipReason(c, live) {
  if (c.liveOnly && !live) return LIVE_ONLY_SKIP;
  if (live && !c.adversarialPrompt) return `no adversarialPrompt for live mode (${c.invariant})`;
  return false;
}

/**
 * Register eval cases. Each case: `{ id, invariant, adversary?, fixture?,
 * adversarialPrompt?, liveOnly?, act(fx), assert(fx, result), mutate?(root) }`.
 */
export function defineCases(cases) {
  const live = Boolean(process.env[LIVE_CMD_ENV]);
  for (const c of cases) {
    checkLiveOnly(c);
    const skip = skipReason(c, live);
    test(c.id, { skip }, () => runCase(c, { mutated: false }));
    if (c.mutate) test(`${c.id} [mutated]`, { skip }, () => runCase(c, { mutated: true }));
  }
}
