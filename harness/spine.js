/**
 * The rad-deliver spine — deterministic control flow over the ports.
 *
 * This is the migration target of `.claude/commands/team/rad-deliver.md`: the
 * prose DET steps (approval gate → deliver-started → per-wave loop → post-checks
 * → pr-opened) collapse into one pure control-flow function. It mirrors the
 * `## rad-deliver as a harness spine` example in docs/harness-state-store.md.
 *
 * Everything probabilistic or side-effecting is INJECTED, so the function is
 * deterministic and unit-testable with zero real model / git / gh:
 *   - `runWave` — the MODEL boundary (async; given a wave, returns a result
 *                 `{ outcome, ... }`). The spine never calls a real model.
 *   - `sh`      — the Bash boundary (given a script path + args, returns
 *                 `{ status, ... }`; non-zero status = failure). Wraps the
 *                 existing scripts/check-*.sh + open-pr.sh guardrails, which are
 *                 CALLED, never modified.
 *   - `now`     — an injected clock returning an ISO timestamp. The spine never
 *                 calls Date.now()/new Date() directly.
 *   - `state`   — a StateStore (append/history/phase/plan/gate/...); `gate()` is
 *                 async.
 *   - `docs`    — an ArtifactStore (read/write).
 *
 * Every terminal path returns a STRUCTURED object the caller/tests inspect; the
 * spine never throws for an expected outcome and never calls process.exit. The
 * "what happens next" decision lives in the matrix (resolveOutcome), never in
 * inline retry arithmetic; the doom-loop breaker uses fingerprint().
 */

import { resolveOutcome } from './matrix.js';
import { fingerprint } from './fingerprint.js';

/** Bounded attempt budget per wave (Case uses two cycles). */
const MAX_ATTEMPTS = 3;

/** Post-check guardrails, run in order after every wave advances. */
const POST_CHECKS = ['check-scope.sh', 'check-tests.sh', 'open-pr.sh'];

/**
 * Run the deliver spine for one feature.
 *
 * @param {Object} args
 * @param {string} args.feature
 * @param {import('./events.js').StateStore} args.state
 * @param {Object} args.docs - ArtifactStore (read/write); unused branches reserved
 * @param {Object} args.matrix - a pre-loaded stop-condition matrix
 * @param {Object} args.gates - the loaded gate policy (passed through for parity)
 * @param {(wave: Object) => Promise<{ outcome: string }>} args.runWave - MODEL boundary
 * @param {(script: string, feature: string) => { status: number }} args.sh - Bash boundary
 * @param {() => string} args.now - injected clock (ISO timestamp)
 * @returns {Promise<Object>} structured terminal result
 */
export async function deliverSpine({
  feature,
  state,
  docs, // eslint-disable-line no-unused-vars -- reserved ArtifactStore port
  matrix,
  gates, // eslint-disable-line no-unused-vars -- loaded policy, parity with ports
  runWave,
  sh,
  now,
}) {
  // ── DET gate: approval. The human (or proxy) decided earlier; here we ENFORCE
  // it. A blocked gate is a normal outcome — return structured, append nothing
  // destructive, and never call runWave. ──
  const g = await state.gate(feature, 'approved');
  if (!g.passed) {
    return { stopped: 'gate', gate: 'approved', reason: g.reason };
  }

  state.append({ feature, type: 'deliver-started', actor: 'harness', ts: now() });

  const plan = state.plan(feature);
  const waves = (plan && plan.waves) || [];

  // ── DET wave loop — the MATRIX decides what happens next, not a counter. ──
  for (const wave of waves) {
    let lastPrint = null;
    let advanced = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const result = await runWave(wave);

      state.append({
        feature,
        type: 'wave-attempt',
        actor: 'harness',
        ts: now(),
        data: { wave: wave.n, outcome: result.outcome },
      });

      // Doom-loop breaker: an identical failure fingerprint twice in a row means
      // the work is provably stuck — abort immediately rather than burn budget.
      const print = fingerprint(result);
      if (print === lastPrint) {
        state.append({
          feature,
          type: 'wave-failed',
          actor: 'harness',
          ts: now(),
          data: { wave: wave.n, reason: 'doom-loop' },
        });
        return {
          stopped: 'doom-loop',
          ok: false,
          wave: wave.n,
          outcome: result.outcome,
        };
      }
      lastPrint = print;

      const { action } = resolveOutcome('implement', result.outcome, matrix);
      if (action === 'advance') {
        state.append({
          feature,
          type: 'wave-complete',
          actor: 'harness',
          ts: now(),
          data: { wave: wave.n },
        });
        advanced = true;
        break;
      }
      if (action === 'retry' || action === 'revision') {
        // Loop again, within the bounded budget. The doom-loop breaker is the
        // early-exit; the budget cap is the hard ceiling.
        continue;
      }
      // 'abort' | 'surface' (and any other declared terminal action).
      state.append({
        feature,
        type: 'wave-failed',
        actor: 'harness',
        ts: now(),
        data: { wave: wave.n, action },
      });
      return {
        stopped: 'matrix',
        ok: false,
        wave: wave.n,
        action,
        outcome: result.outcome,
      };
    }

    if (!advanced) {
      // Budget exhausted without an advance (and without a doom-loop trip).
      state.append({
        feature,
        type: 'wave-failed',
        actor: 'harness',
        ts: now(),
        data: { wave: wave.n, reason: 'budget-exhausted' },
      });
      return { stopped: 'budget', ok: false, wave: wave.n };
    }
  }

  // ── DET post-checks: existing bash guardrails, called by path via the injected
  // `sh`. A non-zero exit halts the spine before the PR is recorded. ──
  for (const script of POST_CHECKS) {
    const check = sh(`scripts/${script}`, feature);
    if (check.status !== 0) {
      return { stopped: 'post-check', ok: false, check: script, status: check.status };
    }
  }

  state.append({ feature, type: 'pr-opened', actor: 'harness', ts: now() });

  return { ok: true, waves: waves.length };
}
