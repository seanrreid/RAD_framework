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
import { resumeFrom, totalUsage } from './events.js';

/** Bounded attempt budget per wave — the hard ceiling. The doom-loop breaker is
 * the early exit; this cap only bites when every attempt fails *differently*. */
const MAX_ATTEMPTS = 3;

/** Post-check guardrails, run in order after all waves. The test gate now runs
 * per-wave (a regression blocks AT the introducing wave, not at the end), so
 * check-tests is no longer an end post-check — only scope + PR remain. */
const POST_CHECKS = ['check-scope.sh', 'open-pr.sh'];

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
 * @param {number} [args.maxAttempts] - per-wave attempt ceiling (defaults to MAX_ATTEMPTS); injectable for tests
 * @param {number} [args.tokenBudget] - optional cumulative token ceiling; 0/null/undefined disables the breaker (no behavior change)
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
  maxAttempts = MAX_ATTEMPTS,
  tokenBudget = null,
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

  // ── Resume: waves that already advanced on a prior run carry a `wave-complete`
  // event. Skip them — never re-run runWave or append duplicate attempt/complete
  // events. Keyed strictly off `wave-complete`, so a wave that crashed mid-run
  // (attempt logged, never advanced) is NOT skipped and resumes here. ──
  const history = state.history(feature);
  const completed = resumeFrom(history);

  // ── Resume verify (cheap, once): if a prior run already advanced one or more
  // waves, the per-wave gate that guarded THIS run never ran for them. Before
  // touching the first non-skipped wave, run ONE cumulative test gate to confirm
  // the prior work is still green. If it is broken, escalate — don't build on a
  // broken base. A fresh run (nothing skipped) does not run this. ──
  let resumeVerified = false;

  // ── Token-budget circuit breaker. OPTIONAL: a non-positive `tokenBudget`
  // (unset/0/negative) fully disables it. Otherwise we accumulate each wave's
  // recorded usage (`result.usage.total`, missing → 0) and, BEFORE starting the
  // next wave, graceful-abort if cumulative spend has reached/exceeded the
  // budget — a terminal return in the style of the other `stopped:` paths.
  //
  // Seeded from prior runs' recorded usage so a RESUMED deliver INHERITS earlier
  // spend: the budget is a lifetime ceiling for the feature, not a fresh
  // per-invocation allowance (a crash-looping deliver can't blow past it by
  // resuming). On a fresh run the log carries no wave-attempt usage, so this is 0. ──
  let spent = totalUsage(history).total;

  // ── DET wave loop — the MATRIX decides what happens next, not a counter. ──
  for (const wave of waves) {
    if (completed.has(wave.n)) continue;

    // Budget check fires before running THIS wave (and before resume-verify) so
    // an over-budget run stops without doing any further model work.
    if (tokenBudget > 0 && spent >= tokenBudget) {
      state.append({
        feature,
        type: 'wave-failed',
        actor: 'harness',
        ts: now(),
        data: { wave: wave.n, reason: 'token-budget', spent, budget: tokenBudget },
      });
      return { stopped: 'token-budget', ok: false, wave: wave.n, spent, budget: tokenBudget };
    }

    if (completed.size > 0 && !resumeVerified) {
      resumeVerified = true; // run exactly once, before the first non-skipped wave
      const verify = sh('scripts/check-tests.sh', feature);
      if (verify.status !== 0) {
        return { stopped: 'resume-verify', ok: false };
      }
    }

    let lastPrint = null;
    let advanced = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await runWave(wave);

      // ── Per-wave test gate. A wave the model thinks succeeded only advances if
      // the cumulative tests are green at THIS point — otherwise it introduced a
      // regression. DEMOTE it to fail-tests so the existing retry/revision path
      // (bounded budget + doom-loop fingerprint) handles it; the wave then blocks
      // here instead of advancing a broken base. ──
      let { outcome } = result;
      let gated = result;
      if (resolveOutcome('implement', outcome, matrix).action === 'advance') {
        const gate = sh('scripts/check-tests.sh', feature);
        if (gate.status !== 0) {
          outcome = 'fail-tests';
          // Fingerprint STABLE, gate-derived fields — NOT the model's variable
          // result text. Two consecutive gate failures must hash equally so the
          // doom-loop breaker trips at the cap instead of burning every attempt
          // when the model merely rewords its output between identical failures.
          gated = {
            outcome,
            gateStatus: gate.status,
            categories: ['check-tests'],
            summary: `check-tests gate failed (status ${gate.status})`,
          };
        }
      }

      state.append({
        feature,
        type: 'wave-attempt',
        actor: 'harness',
        ts: now(),
        // Usage rides on the REAL runWave result — record it even when the
        // per-wave gate demoted `outcome` to fail-tests above (the demoted
        // `gated` object carries no usage). Usage is OPTIONAL: an adapter that
        // emits none leaves `result.usage` undefined and the key is included as
        // undefined, which folds/serializes the same as a legacy event.
        data: { wave: wave.n, outcome, usage: result.usage },
      });

      // Accumulate this attempt's token spend for the budget breaker. Usage is
      // OPTIONAL (a command adapter may emit none) — a missing total contributes
      // 0, never NaN.
      spent += result.usage?.total ?? 0;

      // The MATRIX decides what happens next — never inline retry arithmetic.
      const { action } = resolveOutcome('implement', outcome, matrix);

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
        // Doom-loop breaker: an identical *failure* fingerprint twice in a row
        // means the retry is provably stuck — abort rather than burn the budget.
        // Only failing (retry/revision) outcomes are fingerprinted here, so a
        // genuine success can never trip the breaker (it advances above first).
        const print = fingerprint(gated);
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
            outcome,
          };
        }
        lastPrint = print;
        continue; // within the bounded budget; the cap is the hard ceiling.
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
        outcome,
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
