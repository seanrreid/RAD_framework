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
import { resumeFrom, totalUsage, findOrphanAttempts, priorAttemptState } from './events.js';
import { OUTCOME_VOCAB } from './hook-runner.js';
import { classifyStop } from './stops.js';

/** The fail-closed aborting outcome a veto resolves to when its token is somehow
 * not a member of the frozen vocabulary. Mirrors the runner's own fallback so an
 * invalid token NEVER reaches resolveOutcome (an unknown outcome throws in the
 * matrix). The runner already validates and falls back; we defend here too. */
const VETO_ABORT_OUTCOME = 'abort-user';

/** Validate a veto outcome against the frozen 7-outcome vocabulary BEFORE it
 * reaches resolveOutcome. Fail-closed: an unrecognized token becomes
 * 'abort-user' (which the matrix resolves to `abort`), never an unknown token. */
function safeVetoOutcome(outcome) {
  return OUTCOME_VOCAB.has(outcome) ? outcome : VETO_ABORT_OUTCOME;
}

/** Result fields copied onto `deliver-stopped` data when the terminal knows them. */
const STOP_CONTEXT_KEYS = ['wave', 'action', 'outcome'];

/**
 * The ONE exit for every post-`deliver-started` terminal (#77): append a single
 * audit-only `deliver-stopped` event classifying the stop, then return `result`
 * unchanged (a non-empty free-text `result.reason` is carried as `detail`).
 * classifyStop throws on an unknown shape; that throw is NOT caught —
 * an unclassifiable terminal is a harness bug and must surface, not be bucketed.
 * Classification runs before the append, so a throw appends nothing.
 */
function stopRun(result, { state, feature, now }) {
  const { class: cls, reason, decision } = classifyStop(result);
  const context = {};
  for (const key of STOP_CONTEXT_KEYS) {
    if (result[key] !== undefined && result[key] !== null) context[key] = result[key];
  }
  // The spine's free-text reason (#161) — omitted, never undefined, when absent,
  // so stops without one append byte-identical data.
  if (typeof result.reason === 'string' && result.reason !== '') context.detail = result.reason;
  state.append({
    feature,
    type: 'deliver-stopped',
    actor: 'harness',
    ts: now(),
    data: { class: cls, reason, decision, ...context },
  });
  return result;
}

/** Stop key a THROWING prepare port is converted to (fail-closed, never swallowed:
 * the thrown message becomes the stop's detail). */
const PREPARE_FAILED = 'prepare-failed';

/** Prepare-result fields copied onto the stop result for decision placeholders. */
const PREPARE_STOP_KEYS = ['base', 'branch'];

/**
 * Run the OPTIONAL prepare port (sync/merge/in-progress) once, before any wave.
 * Success appends the audit-only `run-prepared` with the port's data and
 * returns null; a failure (or a throw) returns the stop result for stopRun.
 */
async function runPrepare({ prepare, state, feature, now }) {
  let r;
  try {
    r = await prepare();
  } catch (err) {
    r = { ok: false, stopped: PREPARE_FAILED, detail: errorMessage(err) };
  }
  if (r && r.ok === true) {
    state.append({ feature, type: 'run-prepared', actor: 'harness', ts: now(), data: r.data });
    return null;
  }
  const result = { stopped: r?.stopped, ok: false, detail: r?.detail };
  // Carried as deliver-stopped `detail` by stopRun when non-empty.
  if (typeof r?.detail === 'string') result.reason = r.detail;
  for (const key of PREPARE_STOP_KEYS) {
    if (r?.[key] !== undefined && r[key] !== null) result[key] = r[key];
  }
  return result;
}

/** Neutral approval-integrity port. The default injected `approvalIntact`:
 * always intact, so omitting it changes nothing (the between-wave re-check then
 * reduces to re-running the approved gate). */
const ALWAYS_INTACT = () => ({ ok: true });

/** Render a thrown value's message for a stop reason. */
function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

/** Stop reason when an `approved` event lands inside the current run (#158). */
const APPROVED_DURING_RUN_REASON =
  'an approved event was recorded during this run (re-approval must happen between runs, not within one)';

/**
 * The `approved` events recorded after the LATEST `deliver-started` — i.e.
 * inside the current run. Pure; [] for non-array input or no deliver-started;
 * never throws. Approval changes happen BETWEEN runs: a wave agent sharing the
 * architect's git identity can record an approval mid-run (#158), and the run
 * must refuse to act on it. The event is never removed — it stays as evidence.
 */
export function approvedDuringRun(history) {
  if (!Array.isArray(history)) return [];
  let start = -1;
  history.forEach((e, i) => {
    if (e && e.type === 'deliver-started') start = i;
  });
  if (start < 0) return [];
  return history.slice(start + 1).filter((e) => e && e.type === 'approved');
}

/**
 * Between-wave approval re-check (#77): does the approval this run started
 * under still hold? Re-runs the `approved` gate, then the injected
 * `approvalIntact` port. FAIL-CLOSED: a port that throws, or returns anything
 * but `{ ok: true }`, is NOT intact. Returns null when approval holds, else a
 * reason string for the `approval-changed` stop.
 */
async function approvalChangeReason({ state, feature, approvalIntact }) {
  // Checked FIRST: the gate below reads the LATEST approval, which a mid-run
  // approval would satisfy — so a run-scoped approval must stop before it (#158).
  if (approvedDuringRun(state.history(feature)).length > 0) return APPROVED_DURING_RUN_REASON;
  const g = await state.gate(feature, 'approved');
  if (!g.passed) return `approved gate no longer passes: ${g.reason}`;
  let intact;
  try {
    intact = await approvalIntact();
  } catch (err) {
    return `approvalIntact threw: ${errorMessage(err)}`;
  }
  if (!intact || intact.ok !== true) {
    return `approval not intact: ${(intact && intact.reason) || 'no reason given'}`;
  }
  return null;
}

/**
 * Append the audit-only `run-resumed` event (resume-with-operator-context):
 * records the operator's context and the stop it resumes from. Only the stop's
 * identifying fields are recorded — `wave` only when the stop carried one.
 */
function appendRunResumed({ state, feature, now, resume }) {
  const { class: cls, reason, wave } = resume.stop;
  const stop = { class: cls, reason };
  if (wave !== undefined && wave !== null) stop.wave = wave;
  state.append({
    feature,
    type: 'run-resumed',
    actor: 'harness',
    recordedBy: resume.recordedBy,
    ts: now(),
    data: { context: resume.context, recordedBy: resume.recordedBy, stop },
  });
}

/** The one wave-attempt outcome the failed-attempt cap does NOT count. */
const SUCCESS_OUTCOME = 'success';

/**
 * Count non-success `wave-attempt` events since the latest `deliver-stopped`
 * (or from log start when there is none), across ALL waves. Pure. A stop resets
 * the count, so a re-run after a stop gets a fresh failed-attempt budget.
 *
 * @param {Array<{ type: string, data?: { outcome?: string } }>} history
 * @returns {number}
 */
export function failedAttemptsSinceStop(history) {
  let failed = 0;
  for (const event of history) {
    if (event.type === 'deliver-stopped') failed = 0;
    else if (event.type === 'wave-attempt' && event.data?.outcome !== SUCCESS_OUTCOME) failed += 1;
  }
  return failed;
}

/** The cap is on only for a positive integer; null/0/negative/non-integer = off. */
function capEnabled(cap) {
  return Number.isInteger(cap) && cap > 0;
}

/** Bounded attempt budget per wave — the hard ceiling. The doom-loop breaker is
 * the early exit; this cap only bites when every attempt fails *differently*. */
const MAX_ATTEMPTS = 3;

/** Reason stamped on the synthetic wave-attempt and the wave-failed a resume
 * appends when it converges an orphan (a `wave-started` whose attempt never
 * recorded a `wave-attempt` — the process died mid-agent, issue #119). */
const ORPHAN_REASON = 'orphaned';

/** The EXISTING outcome an orphan converges to. The matrix routes it to
 * `surface`: a crashed attempt is handed to the operator, never silently
 * retried (its in-flight work and token spend are unrecoverable). */
const ORPHAN_OUTCOME = 'fail-timeout';

/** Matrix actions whose attempt is fingerprinted for the doom-loop breaker. */
const FINGERPRINTED_ACTIONS = new Set(['retry', 'revision']);

/** The executing verification gate: runs a plan-declared command and reads its
 * REAL exit code. Distinct from check-tests-present.sh (file presence) by
 * design — neither replaces the other (issue #91). */
const VERIFY_SCRIPT = 'scripts/check-verify.sh';

/** Exit code check-verify.sh RESERVES for "the declared command exceeded its
 * timeout and was killed". It maps to the EXISTING `fail-timeout` outcome
 * (matrix action `surface`), never `fail-tests` (`revision`): a retry cannot fix
 * a hang, so a wedged command must surface rather than burn the attempt budget.
 * Kept in lockstep with VERIFY_TIMEOUT_STATUS in scripts/check-verify.sh. */
const VERIFY_TIMEOUT_STATUS = 124;

/** The scope guardrail, also run per wave (#77) after an advancing outcome so
 * an out-of-scope edit stops the run AT the wave that made it, not after every
 * later wave has built on it. The end post-check (POST_CHECKS) is kept. */
const SCOPE_SCRIPT = 'scripts/check-scope.sh';

/** The EXISTING outcome a failed per-wave scope check demotes to (matrix `abort`). */
const SCOPE_FAIL_OUTCOME = 'fail-scope';

/**
 * Per-wave scope gate: run check-scope.sh through the `sh` port (the same call
 * shape as the end post-check). Returns null when it passes — the caller then
 * appends NOTHING extra — else the demotion `{ outcome, gateOutput, gated }`,
 * with gate-derived fingerprint fields only (mirroring the Verify demotion).
 */
function scopeDemotion(sh, feature) {
  const scope = sh(SCOPE_SCRIPT, feature);
  if (scope.status === 0) return null;
  return {
    outcome: SCOPE_FAIL_OUTCOME,
    gateOutput: scope.stdout ?? '',
    gated: {
      outcome: SCOPE_FAIL_OUTCOME,
      gateStatus: scope.status,
      categories: ['check-scope'],
      summary: `check-scope gate failed (status ${scope.status})`,
    },
  };
}

/** Reads the remote default branch's tip sha (via the `sh` port; the CLI maps it
 * to `default-tip.sh origin <base>`). Read immediately before and after every
 * runWave when `pushGuard` is on, so a wave that pushed to the default branch is
 * caught at the attempt that did it. */
const PUSH_GUARD_SCRIPT = 'scripts/default-tip.sh';

/** The EXISTING outcome a moved default tip demotes to (matrix `abort`): a push
 * to the default branch is a protocol violation, never a retryable failure. */
const PUSH_GUARD_OUTCOME = 'fail-protocol';

/**
 * Push guard: compare the default-tip reads taken around runWave. Returns null
 * when the tip did not move OR either read failed (the caller records the
 * unavailability as audit, never demotes on it), else the demotion
 * `{ outcome, gateOutput, gated }` with gate-derived fingerprint fields only.
 */
function pushGuardDemotion(before, after) {
  if (before.status !== 0 || after.status !== 0) return null;
  if ((before.stdout ?? '').trim() === (after.stdout ?? '').trim()) return null;
  return {
    outcome: PUSH_GUARD_OUTCOME,
    gateOutput: '',
    gated: {
      outcome: PUSH_GUARD_OUTCOME,
      gateStatus: 1,
      categories: ['push-guard'],
      summary: 'default branch tip moved during the wave',
    },
  };
}

/** Append the audit-only `push-check-unavailable` when either tip read failed;
 * carries the first non-zero status. A no-op when both reads succeeded. */
function recordPushCheckUnavailable({ state, feature, now, wave, attempt, before, after }) {
  const status = before.status !== 0 ? before.status : after.status;
  if (status === 0) return;
  state.append({
    feature,
    type: 'push-check-unavailable',
    actor: 'harness',
    ts: now(),
    data: { wave: wave.n, attempt, status },
  });
}

/** Post-check guardrails, run in order after all waves. The test-PRESENCE gate
 * now runs per-wave (a promised-but-absent test file blocks AT the wave that
 * promised it, not at the end), so check-tests-present is no longer an end
 * post-check — only scope + PR remain. */
const POST_CHECKS = ['check-scope.sh', 'open-pr.sh'];

/** Neutral no-op hook runner. The default injected `runHooks`: returns the same
 * empty result an absent hooks dir produces, so wiring hooks into the spine
 * changes NOTHING when no hooks are configured (AC#1 — backward compat). */
const NOOP_HOOKS = () => ({ ran: [], veto: null, failures: [] });

/** Neutral no-op hook pre-flight. The default injected `hookPreflight`: does
 * nothing. With no hooks dir there is nothing to validate, so omitting a real
 * pre-flight is exactly today's behavior (AC#1 — absent dir changes nothing). */
const NOOP_PREFLIGHT = () => {};

/**
 * Fire the hook runner at one lifecycle point and record what it observed.
 *
 * OBSERVE-ONLY (this wave): every hook that ran becomes a `hook-observed` event;
 * every failure becomes a `hook-failed` event. Neither alters wave flow — observe
 * is fail-open by construction (we only append events). The veto reroute is
 * Wave 3; the result's `veto` is intentionally NOT routed into resolveOutcome
 * here. See TODO(wave3) at the call seam.
 *
 * @param {Function} runHooks - injected runner: (point, ctx) => { ran, veto, failures }
 * @param {string} point - lifecycle point name
 * @param {Object} ctx - { feature, wave, outcome }
 * @param {Object} args - { state, feature, now } for event stamping
 * @returns {{ ran: Array, veto: (Object|null), failures: Array }} the runner result (unrouted)
 */
function fireHooks(runHooks, point, ctx, { state, feature, now }) {
  const res = runHooks(point, ctx) || { ran: [], veto: null, failures: [] };
  for (const entry of res.ran || []) {
    state.append({
      feature,
      type: 'hook-observed',
      actor: 'harness',
      ts: now(),
      data: { point, hook: entry.hook, outcome: entry.outcome, source: 'hook' },
    });
  }
  for (const failure of res.failures || []) {
    state.append({
      feature,
      type: 'hook-failed',
      actor: 'harness',
      ts: now(),
      data: { point, hook: failure.hook, outcome: failure.reason, source: 'hook' },
    });
  }
  return res;
}

/** Task statuses the wave contract treats as passing. Mirrors the passing set in
 * adapters/agent/contract.js resultToOutcome — restated here rather than
 * imported so the spine keeps its no-adapter-dependency layering. */
const PASSING_TASK_STATUSES = new Set(['complete', 'done_with_concerns']);

/**
 * The first task the agent reported as NOT passing — the one that blocked the
 * wave. `tasks` is an OPTIONAL contract field, so an adapter that reported none
 * (and a demotion where every reported task passed but a gate failed) yields
 * null and the retry prompt simply carries no task line.
 *
 * @param {unknown} tasks - the wave result's optional per-task records
 * @returns {{ title: string, status: string, error: string } | null}
 */
function blockingTask(tasks) {
  if (!Array.isArray(tasks)) return null;
  const t = tasks.find((task) => task && !PASSING_TASK_STATUSES.has(task.status));
  return t ? { title: t.title, status: t.status, error: t.error } : null;
}

/**
 * Capture the failing attempt as `priorFailure` context for the NEXT attempt
 * (issue #90: today every retry rebuilds an identical prompt, so a retry differs
 * from its predecessor only by model nondeterminism).
 *
 * FAIL-OPEN, deliberately. CLAUDE.md's default is fail-closed, but that rule
 * governs GATE and CHECK boundaries; this is prompt enrichment and decides
 * nothing. A capture failure therefore RECORDS its reason with context (a
 * `capture-failed` event carrying wave, attempt, and the error message) and
 * degrades to the priorFailure-absent prompt — today's behavior. It never
 * blocks, fails, or retries the wave: losing the enrichment must never be worse
 * than never having had it. The error is recorded, never swallowed.
 *
 * @param {Object} args
 * @param {number} args.attempt - the 1-based attempt that just failed
 * @param {string} args.outcome - the matrix outcome that failed
 * @param {string} args.output - the failing gate's captured stdout ('' when none)
 * @param {Object} args.result - the raw runWave result (for its optional tasks)
 * @param {Object} args.wave - the wave descriptor (for event context)
 * @param {Object} args.state - StateStore, for the degrade record
 * @param {string} args.feature
 * @param {() => string} args.now
 * @returns {Object|null} the capture, or null when it degraded
 */
function capturePriorFailure({ attempt, outcome, output, result, wave, state, feature, now }) {
  try {
    return {
      attempt,
      outcome,
      task: blockingTask(result.tasks),
      // '' → undefined so the renderer's truthiness check (never key presence)
      // omits an empty excerpt instead of rendering an empty code fence.
      excerpt: output || undefined,
    };
  } catch (err) {
    state.append({
      feature,
      type: 'capture-failed',
      actor: 'harness',
      ts: now(),
      data: {
        wave: wave.n,
        attempt,
        outcome,
        what: 'prior-failure',
        reason: err && err.message ? err.message : String(err),
      },
    });
    return null;
  }
}

/** A model id is declared only when it is a non-empty string; otherwise null. */
function declaredModel(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Record that attempt `attempt` of `wave` is about to run the agent. Appended
 * AFTER the pre-wave hooks pass (a vetoed attempt never ran) and immediately
 * BEFORE runWave, so a crash mid-agent leaves a `wave-started` with no matching
 * `wave-attempt` — the orphan a later resume converges. `model` is spread only
 * when one is declared — the plan's `Model:` map (`waveModels`, keyed by wave
 * number) wins over a descriptor-level `wave.model` — so the key is absent
 * otherwise. An empty-string or non-string value counts as undeclared.
 * `capabilities` (the wave's effective classes) is spread only for a wave
 * present in `waveCapabilities` (constrained waves only), so an unconstrained
 * wave's event is byte-identical to before capabilities existed.
 */
function appendWaveStarted({ state, feature, now, wave, attempt, waveModels, waveCapabilities }) {
  const declared = declaredModel(waveModels[wave.n]) ?? declaredModel(wave.model);
  const model = declared ? { model: declared } : {};
  const effective = waveCapabilities[wave.n];
  const capabilities = Array.isArray(effective) ? { capabilities: [...effective] } : {};
  state.append({
    feature,
    type: 'wave-started',
    actor: 'harness',
    ts: now(),
    data: { wave: wave.n, attempt, ...model, ...capabilities },
  });
}

/**
 * Build a `wave-attempt` event's data. `attempt` is always recorded;
 * `fingerprint` (the digest the doom-loop compares) only when `print` is set,
 * i.e. the resolved action was retry/revision; `permissions` (the acp adapter's
 * permission decisions) only when `result.permissions` is a non-empty array.
 * Optional keys are spread, never present-and-undefined. Post-wave veto
 * provenance keeps its prior shape.
 */
function attemptData({ wave, attempt, outcome, result, evidence, vetoSource, print }) {
  const printEvidence = print ? { fingerprint: print } : {};
  const hasPermissions = Array.isArray(result.permissions) && result.permissions.length > 0;
  const permissions = hasPermissions ? { permissions: result.permissions } : {};
  const base = {
    wave: wave.n, attempt, outcome, usage: result.usage, ...evidence, ...printEvidence, ...permissions,
  };
  return vetoSource
    ? { ...base, source: 'hook', point: vetoSource.point, hook: vetoSource.hook }
    : base;
}

/**
 * Converge every orphaned attempt of `wave` (issue #119) BEFORE its attempt
 * loop: each gets a synthetic `wave-attempt {wave, attempt, outcome:
 * 'fail-timeout', reason: 'orphaned'}`, the outcome is routed through the matrix
 * (→ `surface`), the observe-only `on-error` hook fires, and one
 * `wave-failed {wave, action, reason: 'orphaned'}` is appended. Idempotent: the
 * synthetic wave-attempt matches its `wave-started`, so a second resume finds
 * no orphan. Returns the existing matrix-terminal
 * result shape, or null when the wave has no orphan.
 */
function convergeOrphans({ history, wave, matrix, state, feature, now, runHooks }) {
  const orphans = findOrphanAttempts(history).filter((o) => o.wave === wave.n);
  if (orphans.length === 0) return null;
  for (const { attempt } of orphans) {
    state.append({
      feature,
      type: 'wave-attempt',
      actor: 'harness',
      ts: now(),
      data: { wave: wave.n, attempt, outcome: ORPHAN_OUTCOME, reason: ORPHAN_REASON },
    });
  }
  const { action } = resolveOutcome('implement', ORPHAN_OUTCOME, matrix);
  // ── Hook: on-error (observe-only). Fired at this wave-failed terminal
  // (orphan surface), mirroring the matrix abort/surface terminal. ──
  fireHooks(
    runHooks,
    'on-error',
    { feature, wave: wave.n, outcome: ORPHAN_OUTCOME },
    { state, feature, now },
  );
  state.append({
    feature,
    type: 'wave-failed',
    actor: 'harness',
    ts: now(),
    data: { wave: wave.n, action, reason: ORPHAN_REASON },
  });
  return { stopped: 'matrix', ok: false, wave: wave.n, action, outcome: ORPHAN_OUTCOME };
}

/**
 * Run the deliver spine for one feature.
 *
 * @param {Object} args
 * @param {string} args.feature
 * @param {import('./events.js').StateStore} args.state
 * @param {Object} args.docs - ArtifactStore (read/write); unused branches reserved
 * @param {Object} args.matrix - a pre-loaded stop-condition matrix
 * @param {Object} args.gates - the loaded gate policy (passed through for parity)
 * @param {(wave: Object, attemptCtx: { attempt: number, priorFailure: (Object|null), operatorContext?: Object }) => Promise<{ outcome: string }>} args.runWave
 *   MODEL boundary. The second argument is ADDITIVE attempt context: the 1-based
 *   `attempt` number and the previous attempt's captured `priorFailure` (null on
 *   the first attempt, and whenever capture degraded), plus `operatorContext` on
 *   the run's first call only when `resume` is set. A runWave/adapter that
 *   IGNORES it behaves exactly as it did before it existed — the spine's control
 *   flow does not depend on the callee reading it.
 * @param {(script: string, feature: string) => { status: number }} args.sh - Bash boundary
 * @param {() => string} args.now - injected clock (ISO timestamp)
 * @param {number} [args.maxAttempts] - per-wave attempt ceiling (defaults to MAX_ATTEMPTS); injectable for tests
 * @param {number} [args.tokenBudget] - optional cumulative token ceiling; 0/null/undefined disables the breaker (no behavior change)
 * @param {Record<number, string>} [args.waveVerify] - optional per-wave verification
 *   commands, keyed by wave number (parsed from the plan's `Verify:` lines by
 *   cli.js and passed through, exactly as tokenBudget is). A wave ABSENT from the
 *   map runs no command and records no `verify` key — so a plan declaring no
 *   `Verify:` anywhere produces the event sequence it did before this existed.
 *   The spine never executes the command itself: it hands it to
 *   scripts/check-verify.sh through the injected `sh` port, which owns the
 *   allow-listed env, the timeout, and the output cap.
 * @param {Record<number, string>} [args.waveModels] - optional per-wave model ids,
 *   keyed by wave number (parsed from the plan's `Model:` lines by cli.js
 *   parseWaveModels and passed through, exactly as waveVerify is). Recorded as
 *   `model` on each `wave-started`. A wave ABSENT from the map (or mapped to an
 *   empty/non-string value) records no `model` key — so a plan declaring no
 *   `Model:` anywhere produces the event sequence it did before this existed.
 * @param {Record<number, string[]>} [args.waveCapabilities] - optional per-wave
 *   EFFECTIVE capability classes, keyed by wave number, for capability-constrained
 *   waves only (resolved by cli.js from the plan's `Capabilities:` lines and the
 *   project deny list). Recorded as `capabilities` on each `wave-started`. A wave
 *   ABSENT from the map records no `capabilities` key, so a plan with no
 *   declaration and no deny list produces the event sequence it did before this
 *   existed. Recording only: enforcement is the agent adapter's job.
 * @param {(point: string, ctx: Object) => { ran: Array, veto: (Object|null), failures: Array }} [args.runHooks]
 *   wave-lifecycle hook runner (from createHookRunner). OBSERVE-ONLY in this wave:
 *   fired at six lifecycle points, its observations/failures are recorded as
 *   hook-observed / hook-failed events. Defaults to a neutral no-op so that with
 *   NO hooks dir the appended event sequence is byte-for-byte identical to before
 *   (AC#1). The veto reroute is Wave 3 — not implemented here.
 * @param {() => void} [args.hookPreflight] - deliver-start hook directory probe.
 *   Run ONCE right after `deliver-started`, it discovers/validates the hooks dir
 *   up front so an unreadable or malformed dir surfaces deterministically/early
 *   rather than mid-wave. An ABSENT dir is a silent no-op (the common case —
 *   changes nothing). Reuses the runner's own discovery (no duplicated FS logic);
 *   defaults to a no-op so omitting it is exactly today's behavior (AC#1). It may
 *   throw on a malformed dir; the spine lets that surface to the caller.
 * @param {{ context: string, recordedBy: string, stop: { class: string, reason: string, decision: string, wave?: number, action?: string, outcome?: string } }|null} [args.resume]
 *   OPTIONAL operator resume context (the latest stop's data plus the operator's
 *   free-text context). When set, an audit-only `run-resumed` event is appended
 *   directly after `deliver-started` (never when the entry gate refuses), and the
 *   FIRST runWave call of this run — whichever wave/attempt that is — receives
 *   `operatorContext: { context, stop }` on its attemptCtx; every later call omits
 *   the key. Null/absent adds no event and no attemptCtx key (byte-for-byte today).
 * @param {boolean} [args.pushGuard] - OPTIONAL push guard (default false). When
 *   true, the default branch tip is read through `sh(PUSH_GUARD_SCRIPT, feature)`
 *   immediately before and after every runWave. A moved tip demotes that attempt
 *   to `fail-protocol` (matrix `abort`) regardless of the agent's outcome, and
 *   overrides any presence/Verify/scope demotion or post-wave veto. A failed read
 *   appends an audit-only `push-check-unavailable` and does not demote. False
 *   never calls the script — the event sequence is byte-for-byte today's.
 * @param {() => Promise<{ ok: true, data: { base: string, merged: boolean, fastForwarded: boolean, committed: boolean, pushed: boolean } } | { ok: false, stopped: ('merge-conflict'|'prepare-failed'), detail: string, base?: string, branch?: string }>} [args.prepare]
 *   OPTIONAL prepare port (sync, merge origin/<base>, in-progress commit). Run
 *   ONCE after `deliver-started`, any `run-resumed`, and the hook pre-flight, and
 *   BEFORE orphan convergence and the first wave. `ok` appends an audit-only
 *   `run-prepared` carrying `data`; otherwise the run stops through stopRun
 *   (`merge-conflict` = needs-decision, `prepare-failed` = failed). A port that
 *   THROWS is treated as `prepare-failed` with the error message as detail.
 *   Absent (default) runs nothing — the event sequence is byte-for-byte today's.
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
  waveVerify = {},
  waveModels = {},
  waveCapabilities = {},
  runHooks = NOOP_HOOKS,
  hookPreflight = NOOP_PREFLIGHT,
  approvalIntact = ALWAYS_INTACT,
  maxFailedAttempts = null,
  resume = null,
  pushGuard = false,
  prepare = null,
}) {
  // ── DET gate: approval. The human (or proxy) decided earlier; here we ENFORCE
  // it. A blocked gate is a normal outcome — return structured, append nothing
  // destructive, and never call runWave. ──
  const g = await state.gate(feature, 'approved');
  if (!g.passed) {
    return { stopped: 'gate', gate: 'approved', reason: g.reason };
  }

  state.append({ feature, type: 'deliver-started', actor: 'harness', ts: now() });
  if (resume) appendRunResumed({ state, feature, now, resume });
  // Every return below this line is a stop (except success) and MUST go
  // through stopRun so the run's last event is exactly one `deliver-stopped`.
  const stopCtx = { state, feature, now };

  // ── Hook pre-flight (Task 2.2). Validate the hooks dir ONCE up front so an
  // unreadable/malformed dir surfaces deterministically here rather than mid-wave.
  // Reuses the runner's discovery (injected) — no duplicated FS logic. An ABSENT
  // dir is a silent no-op (default NOOP_PREFLIGHT): nothing to validate, nothing
  // changes. A malformed dir is allowed to throw to the caller. ──
  hookPreflight();

  // ── Prepare (sync/merge/in-progress). OPTIONAL injected port: absent changes
  // nothing. Runs before orphan convergence and every wave, so a conflict stops
  // the run before any agent touches the branch. ──
  if (prepare) {
    const prepStop = await runPrepare({ prepare, state, feature, now });
    if (prepStop) return stopRun(prepStop, stopCtx);
  }

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
  // touching the first non-skipped wave, run ONE cumulative test-PRESENCE check
  // to confirm every test file the plan promised so far exists on disk. If one
  // is absent, escalate — don't build on a base with unwritten tests. Nothing
  // here executes a test, so this says nothing about whether the prior work
  // behaves correctly; execution-based verification does not exist yet (see
  // issue #89). A fresh run (nothing skipped) does not run this. ──
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

  // Cumulative failed-attempt count for the cap, seeded from the log so it
  // spans resumed runs until a deliver-stopped resets it.
  let failedAttempts = failedAttemptsSinceStop(history);

  // Operator resume context rides on the FIRST runWave call of this run only —
  // not attempt===1: skipped waves and resumed attempt counts make that wrong.
  let operatorContextPending = Boolean(resume);

  // ── DET wave loop — the MATRIX decides what happens next, not a counter. ──
  for (const wave of waves) {
    if (completed.has(wave.n)) continue;

    // Approval re-check fires before EVERY wave — the run's first included —
    // ahead of the budget check and any wave-started: an edited (or
    // un-approved) plan must stop before any agent runs. #151 exempted the
    // first wave on the premise that the entry gate covered it, but the gate
    // fold ignores the plan fingerprint, so only this check catches an edit
    // made after approval (#77).
    const reason = await approvalChangeReason({ state, feature, approvalIntact });
    if (reason) {
      return stopRun({ stopped: 'approval-changed', ok: false, wave: wave.n, reason }, stopCtx);
    }

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
      return stopRun({ stopped: 'token-budget', ok: false, wave: wave.n, spent, budget: tokenBudget }, stopCtx);
    }

    if (completed.size > 0 && !resumeVerified) {
      resumeVerified = true; // run exactly once, before the first non-skipped wave
      const verify = sh('scripts/check-tests-present.sh', feature);
      if (verify.status !== 0) {
        return stopRun({ stopped: 'resume-verify', ok: false }, stopCtx);
      }
    }

    // ── Orphan convergence (#119): an attempt whose process died mid-agent left
    // a `wave-started` with no `wave-attempt`. Surface it to the operator via
    // the matrix before any new attempt runs. Its token spend was never
    // recorded, so the budget breaker under-counts it — that is unrecoverable. ──
    const orphaned = convergeOrphans({ history, wave, matrix, state, feature, now, runHooks });
    if (orphaned) return stopRun(orphaned, stopCtx);

    // ── Resume seeding (#119): continue the attempt budget and the doom-loop
    // fingerprint from attempts recorded since the wave's last terminal
    // wave-failed. After a terminal stop the wave re-runs with a full budget; a
    // legacy log (no fingerprint) seeds null and cannot trip the breaker. ──
    const prior = priorAttemptState(history, wave.n);
    let lastPrint = prior.lastPrint;
    let advanced = false;
    // Back-pressure (issue #90): the previous attempt's captured failure, fed to
    // the NEXT attempt so a retry differs by more than model nondeterminism.
    // Scoped per wave and null on the first attempt — a retry that carries no
    // capture is exactly today's behavior.
    let priorFailure = null;

    for (let attempt = prior.attempts + 1; attempt <= maxAttempts; attempt += 1) {
      // ── Failed-attempt cap (#77): checked before the pre-wave hooks and any
      // wave-started, so a capped run does no further agent work. ──
      if (capEnabled(maxFailedAttempts) && failedAttempts >= maxFailedAttempts) {
        return stopRun(
          { stopped: 'failed-attempt-cap', ok: false, wave: wave.n, failed: failedAttempts, cap: maxFailedAttempts },
          stopCtx,
        );
      }

      // ── Hook: pre-wave (veto-capable point). Fired BEFORE runWave. A veto here
      // aborts the wave without running the agent: route the veto outcome through
      // the existing matrix and terminate the same way an agent-emitted outcome
      // would. The veto outcome is validated against the frozen vocabulary first
      // (fail-closed → 'abort-user') so an unknown token never reaches the matrix.
      // First-veto-wins is enforced in the runner. ──
      const preVeto = fireHooks(
        runHooks,
        'pre-wave',
        { feature, wave: wave.n, outcome: null },
        { state, feature, now },
      ).veto;
      if (preVeto) {
        const vetoOutcome = safeVetoOutcome(preVeto.outcome);
        const provenance = { point: 'pre-wave', hook: preVeto.hook, outcome: vetoOutcome, source: 'hook' };
        state.append({ feature, type: 'hook-veto', actor: 'harness', ts: now(), data: provenance });
        const { action } = resolveOutcome('implement', vetoOutcome, matrix);
        state.append({
          feature,
          type: 'wave-failed',
          actor: 'harness',
          ts: now(),
          data: { wave: wave.n, action, outcome: vetoOutcome, source: 'hook', point: 'pre-wave', hook: preVeto.hook },
        });
        return stopRun(
          { stopped: 'hook-veto', ok: false, wave: wave.n, action, outcome: vetoOutcome, point: 'pre-wave', hook: preVeto.hook },
          stopCtx,
        );
      }

      appendWaveStarted({ state, feature, now, wave, attempt, waveModels, waveCapabilities });

      // ADDITIVE second argument: attempt context. A runWave that ignores it is
      // unchanged; one that reads it can make attempt N+1 differ from attempt N.
      const attemptCtx = { attempt, priorFailure };
      if (operatorContextPending) {
        attemptCtx.operatorContext = { context: resume.context, stop: resume.stop };
        operatorContextPending = false;
      }
      const tipBefore = pushGuard ? sh(PUSH_GUARD_SCRIPT, feature) : null;
      const result = await runWave(wave, attemptCtx);
      const tipAfter = pushGuard ? sh(PUSH_GUARD_SCRIPT, feature) : null;
      if (pushGuard) {
        recordPushCheckUnavailable({ state, feature, now, wave, attempt, before: tipBefore, after: tipAfter });
      }

      // ── Hook: post-wave (veto-capable point). Fired after the wave result,
      // before the per-wave test-presence gate. A veto here REPLACES the wave's
      // outcome with the veto outcome and routes it through the existing matrix —
      // generalizing the check-tests-present success→fail-tests demotion below to
      // any fixed-vocabulary outcome. Validated fail-closed first; first-veto-wins
      // is enforced in the runner. ──
      const postVeto = fireHooks(
        runHooks,
        'post-wave',
        { feature, wave: wave.n, outcome: result.outcome },
        { state, feature, now },
      ).veto;
      let vetoSource = null; // { point, hook } when a post-wave veto drove the outcome

      // ── Per-wave test-PRESENCE gate. A wave the model thinks succeeded only
      // advances if every test file the plan promised exists on disk at THIS
      // point — otherwise the wave claimed test work it never wrote. DEMOTE it to
      // fail-tests so the existing retry/revision path (bounded budget +
      // doom-loop fingerprint) handles it; the wave then blocks here instead of
      // advancing on an unwritten test.
      //
      // The presence guarantee is narrow, and worth stating plainly: a wave does
      // not advance if a promised test file is ABSENT. That gate never executes a
      // test and never consults a test runner, so a present-but-empty or outright
      // failing test satisfies it. The EXECUTING gate below closes that hole
      // (issue #89) for waves that declare a `Verify:` command — the two stay
      // separate checks, and neither replaces the other (issue #91). ──
      let { outcome } = result;
      let gated = result;
      // Evidence of an executed verification, spread (not assigned) onto the
      // attempt event so the key is ABSENT — never present-and-undefined — when
      // no command ran. A wave with no `Verify:` line must append an event
      // byte-identical to a pre-verification one.
      let verifyEvidence = {};
      // The failing gate's captured stdout, fed forward as the retry prompt's
      // excerpt. Prompt input ONLY — it is never recorded on an event and never
      // reaches the fingerprint, so it cannot change the doom-loop verdict.
      let gateOutput = '';
      if (postVeto) {
        // A post-wave veto is authoritative: it REPLACES the model's outcome with
        // the (validated, fail-closed) veto outcome and routes THAT through the
        // matrix — exactly generalizing the check-tests-present demotion to any
        // outcome. It supersedes the per-wave test-presence gate (the operator has
        // already decided).
        const vetoOutcome = safeVetoOutcome(postVeto.outcome);
        vetoSource = { point: 'post-wave', hook: postVeto.hook };
        state.append({
          feature,
          type: 'hook-veto',
          actor: 'harness',
          ts: now(),
          data: { point: 'post-wave', hook: postVeto.hook, outcome: vetoOutcome, source: 'hook' },
        });
        outcome = vetoOutcome;
        gated = {
          outcome,
          categories: ['hook-veto'],
          summary: `post-wave hook veto (${postVeto.hook})`,
        };
      } else if (resolveOutcome('implement', outcome, matrix).action === 'advance') {
        const gate = sh('scripts/check-tests-present.sh', feature);
        if (gate.status !== 0) {
          outcome = 'fail-tests';
          gateOutput = gate.stdout ?? '';
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
        } else {
          // ── Per-wave EXECUTING gate. When the plan declared a `Verify:` command
          // for this wave, the harness runs it and reads its REAL exit code — the
          // one thing the presence gate cannot tell us. The command itself is
          // arbitrary shell from a human-approved plan, so the spine never
          // executes it: check-verify.sh does, through the SAME `sh` port every
          // other guardrail uses (unchanged shape), and owns the allow-listed env,
          // the timeout, and the output cap.
          //
          // A failure supplies a different INPUT TOKEN to the matrix; it never
          // adds a branch here and never invents an outcome. The matrix stays the
          // sole authority on what happens next. ──
          const command = waveVerify[wave.n];
          if (command) {
            const run = sh(VERIFY_SCRIPT, command);
            verifyEvidence = {
              verify: { command, status: run.status, passed: run.status === 0 },
            };
            if (run.status !== 0) {
              // A killed-on-timeout command is NOT a retryable test failure: a
              // retry cannot fix a hang, so it takes the existing `fail-timeout`
              // token (matrix action `surface`) instead of `fail-tests`.
              outcome = run.status === VERIFY_TIMEOUT_STATUS ? 'fail-timeout' : 'fail-tests';
              // check-verify.sh already bounds this excerpt (40 lines / 8000
              // bytes); the prompt renderer caps it again, unconditionally.
              gateOutput = run.stdout ?? '';
              // Same stable-fingerprint discipline as the presence gate above:
              // gate-derived fields only, so two identical failures hash equally.
              gated = {
                outcome,
                gateStatus: run.status,
                categories: ['check-verify'],
                summary: `check-verify gate failed (status ${run.status})`,
              };
            }
          }
          // ── Per-wave SCOPE gate (#77). Only an outcome still advancing after
          // the presence and Verify gates is checked; a failure demotes it to
          // fail-scope BEFORE the attempt is recorded or the matrix resolves. ──
          if (resolveOutcome('implement', outcome, matrix).action === 'advance') {
            const demoted = scopeDemotion(sh, feature);
            if (demoted) ({ outcome, gateOutput, gated } = demoted);
          }
        }
      }

      // ── Push guard. Applied REGARDLESS of the reported outcome (a push to the
      // default branch is a protocol violation even on a failing attempt) and
      // LAST, so it overrides every demotion and veto above; the outcome is then
      // no longer the veto's, so the veto provenance tag is dropped. ──
      const pushDemoted = pushGuard ? pushGuardDemotion(tipBefore, tipAfter) : null;
      if (pushDemoted) {
        ({ outcome, gateOutput, gated } = pushDemoted);
        vetoSource = null;
      }

      // `tasks` rides on the same REAL runWave result as `usage` and is likewise
      // OPTIONAL — the adapter contract (docs/rad-wave-contract.md) attaches it
      // only when the agent reported a non-empty task list. Spread, not assigned,
      // so the key is ABSENT rather than present-and-undefined when the result
      // carries none: a tasks-free result must append an event byte-identical to
      // a pre-tasks one. It is DATA-ONLY — no fold in events.js reads it.
      const taskEvidence = result.tasks ? { tasks: result.tasks } : {};

      // The MATRIX decides what happens next — never inline retry arithmetic.
      // Resolved BEFORE the attempt is recorded so a failing (retry/revision)
      // attempt can carry the SAME fingerprint the doom-loop breaker compares —
      // which lets a resumed run seed `lastPrint` from the log (issue #119).
      const { action } = resolveOutcome('implement', outcome, matrix);
      const print = FINGERPRINTED_ACTIONS.has(action) ? fingerprint(gated) : null;

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
        //
        // Provenance (Task 3.2): when a post-wave veto drove the outcome, tag the
        // attempt with source/point/hook so a veto-originated outcome is
        // distinguishable from an agent-emitted one. Absent a veto the shape is
        // unchanged — no provenance keys are added.
        //
        // Verification evidence (Task 3.3): when the wave declared a `Verify:`
        // command and it actually ran, record { command, status, passed } so the
        // event log carries what was executed and what really happened — not a
        // self-classification. Spread, so a wave that declared none appends an
        // event with NO `verify` key at all.
        //
        // Durability (#119): `attempt` always; `fingerprint` only on retry/revision.
        data: attemptData({
          wave,
          attempt,
          outcome,
          result,
          evidence: { ...taskEvidence, ...verifyEvidence },
          vetoSource,
          print,
        }),
      });

      // Accumulate this attempt's token spend for the budget breaker. Usage is
      // OPTIONAL (a command adapter may emit none) — a missing total contributes
      // 0, never NaN.
      spent += result.usage?.total ?? 0;
      if (outcome !== SUCCESS_OUTCOME) failedAttempts += 1;

      // ── Hook: on-outcome (observe-only). Fired after the matrix resolves the
      // outcome, before the action is dispatched. Observe + emit only. ──
      fireHooks(
        runHooks,
        'on-outcome',
        { feature, wave: wave.n, outcome },
        { state, feature, now },
      );

      if (action === 'advance') {
        // ── Hook: wave-complete (observe-only). Fired in the advance block as the
        // wave is recorded complete. Observe + emit only. ──
        fireHooks(
          runHooks,
          'wave-complete',
          { feature, wave: wave.n, outcome },
          { state, feature, now },
        );
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
        // ── Hook: on-retry (observe-only). Fired in the retry/revision branch.
        // Observe + emit only. ──
        fireHooks(
          runHooks,
          'on-retry',
          { feature, wave: wave.n, outcome },
          { state, feature, now },
        );
        // Doom-loop breaker: an identical *failure* fingerprint twice in a row
        // means the retry is provably stuck — abort rather than burn the budget.
        // Only failing (retry/revision) outcomes are fingerprinted here, so a
        // genuine success can never trip the breaker (it advances above first).
        // `print` was computed above, before the attempt was recorded.
        if (print === lastPrint) {
          // ── Hook: on-error (observe-only). Fired at this wave-failed terminal
          // (doom-loop). Observe + emit only. ──
          fireHooks(
            runHooks,
            'on-error',
            { feature, wave: wave.n, outcome },
            { state, feature, now },
          );
          state.append({
            feature,
            type: 'wave-failed',
            actor: 'harness',
            ts: now(),
            data: vetoSource
              ? { wave: wave.n, reason: 'doom-loop', source: 'hook', point: vetoSource.point, hook: vetoSource.hook }
              : { wave: wave.n, reason: 'doom-loop' },
          });
          return stopRun({ stopped: 'doom-loop', ok: false, wave: wave.n, outcome }, stopCtx);
        }
        lastPrint = print;
        // Back-pressure (issue #90): carry THIS attempt's failure into the next
        // one so the retry prompt differs. Deliberately placed AFTER the
        // fingerprint/doom-loop decision above — the capture is prompt input
        // only and never participates in that verdict or in MAX_ATTEMPTS.
        priorFailure = capturePriorFailure({
          attempt,
          outcome,
          output: gateOutput,
          result,
          wave,
          state,
          feature,
          now,
        });
        continue; // within the bounded budget; the cap is the hard ceiling.
      }

      // 'abort' | 'surface' (and any other declared terminal action).
      // ── Hook: on-error (observe-only). Fired at this wave-failed terminal
      // (matrix abort/surface). Observe + emit only. ──
      fireHooks(
        runHooks,
        'on-error',
        { feature, wave: wave.n, outcome },
        { state, feature, now },
      );
      state.append({
        feature,
        type: 'wave-failed',
        actor: 'harness',
        ts: now(),
        data: vetoSource
          ? { wave: wave.n, action, outcome, source: 'hook', point: vetoSource.point, hook: vetoSource.hook }
          : { wave: wave.n, action },
      });
      return stopRun({ stopped: 'matrix', ok: false, wave: wave.n, action, outcome }, stopCtx);
    }

    if (!advanced) {
      // Budget exhausted without an advance (and without a doom-loop trip).
      // ── Hook: on-error (observe-only). Fired at this wave-failed terminal
      // (budget-exhausted). Observe + emit only. ──
      fireHooks(
        runHooks,
        'on-error',
        { feature, wave: wave.n, outcome: null },
        { state, feature, now },
      );
      state.append({
        feature,
        type: 'wave-failed',
        actor: 'harness',
        ts: now(),
        data: { wave: wave.n, reason: 'budget-exhausted' },
      });
      return stopRun({ stopped: 'budget', ok: false, wave: wave.n }, stopCtx);
    }
  }

  // An approval recorded during the LAST wave has no next pre-wave re-check to
  // catch it: refuse to post-check or open the PR on it (#158). History-only —
  // the approvalIntact port is deliberately NOT called here (one call per wave).
  if (approvedDuringRun(state.history(feature)).length > 0) {
    const lastWave = waves.length > 0 ? waves[waves.length - 1].n : undefined;
    return stopRun(
      { stopped: 'approval-changed', ok: false, wave: lastWave, reason: APPROVED_DURING_RUN_REASON },
      stopCtx,
    );
  }

  // ── DET post-checks: existing bash guardrails, called by path via the injected
  // `sh`. A non-zero exit halts the spine before the PR is recorded. ──
  for (const script of POST_CHECKS) {
    const check = sh(`scripts/${script}`, feature);
    if (check.status !== 0) {
      return stopRun({ stopped: 'post-check', ok: false, check: script, status: check.status }, stopCtx);
    }
  }

  state.append({ feature, type: 'pr-opened', actor: 'harness', ts: now() });

  return { ok: true, waves: waves.length };
}
