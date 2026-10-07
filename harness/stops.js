/**
 * Stop classification — the typed contract for how a deliver run ended (#77).
 *
 * The deliver spine never pauses: every stop is a terminal return. This module
 * maps each terminal result shape to exactly one `{ class, reason, decision }`:
 *   - `needs-decision` — a limit/policy a human can lift, or a non-deterministic
 *     condition (a retry, a raised limit, or a re-approval may succeed).
 *   - `failed`         — a deterministic check showed the work is wrong for the
 *     plan (re-running unchanged cannot succeed).
 *
 * Pure and total over the KNOWN shapes; fail-closed on everything else: an
 * unknown `stopped`, an unknown matrix/hook-veto `action`, or a malformed result
 * THROWS. There is deliberately no default class — a new terminal must be added
 * to STOP_TABLE, never silently bucketed. No attendedness input exists here.
 */

export const STOP_CLASSES = Object.freeze({
  NEEDS_DECISION: 'needs-decision',
  FAILED: 'failed',
});

const { NEEDS_DECISION, FAILED } = STOP_CLASSES;

/** Matrix actions a `matrix`/`hook-veto` terminal can carry, and their class.
 * Only terminal actions appear: advance/retry/revision never stop a run. */
const CLASS_BY_ACTION = Object.freeze({
  surface: NEEDS_DECISION,
  abort: FAILED,
});

/** Decision templates for the matrix-routed rows, keyed by action. */
const DECISION_BY_ACTION = Object.freeze({
  surface:
    '{wave}: {outcome} — non-deterministic failure (e.g. timeout/orphaned attempt); retry, raise the limit, or split the wave',
  abort: '{wave}: {outcome} — the work is wrong for the plan; fix the plan or the code and re-run',
});

/** Suffix a pre-wave hook veto appends to its matrix-row decision. */
const HOOK_VETO_SUFFIX = ' — vetoed by hook {hook} at {point}';

/**
 * The classification table. `byAction: true` rows take class + decision from
 * the result's matrix `action` and their `reason` is the matrix `outcome`;
 * every other row has a fixed class and `reason` is the `stopped` value.
 */
export const STOP_TABLE = Object.freeze({
  matrix: Object.freeze({ byAction: true, suffix: '' }),
  'hook-veto': Object.freeze({ byAction: true, suffix: HOOK_VETO_SUFFIX }),
  'doom-loop': Object.freeze({
    class: FAILED,
    decision: '{wave} failed identically twice — a retry cannot fix it',
  }),
  budget: Object.freeze({ class: FAILED, decision: '{wave} exhausted its attempts' }),
  'post-check': Object.freeze({ class: FAILED, decision: 'post-check {check} exited {status}' }),
  // Not in the #77 table as drafted; classified by its rule: the cumulative
  // test-PRESENCE check deterministically found a promised test file missing.
  'resume-verify': Object.freeze({
    class: FAILED,
    decision: 'resume verify: a test file promised by an already-completed wave is missing; restore it and re-run',
  }),
  'token-budget': Object.freeze({
    class: NEEDS_DECISION,
    decision: 'token budget {budget} reached (spent {spent}); raise RAD_TOKEN_BUDGET or stop',
  }),
  'failed-attempt-cap': Object.freeze({
    class: NEEDS_DECISION,
    decision: '{failed} failed attempts reached RAD_MAX_FAILED_ATTEMPTS={cap}; raise the cap, re-plan, or stop',
  }),
  'approval-changed': Object.freeze({
    class: NEEDS_DECISION,
    decision: 'the plan changed since approval (or approval no longer holds); re-approve before re-running',
  }),
  gate: Object.freeze({ class: NEEDS_DECISION, decision: 'plan not approved; run /rad-approve' }),
  // Prepare phase (#186 part 3b-i). A merge conflict needs a human to resolve it
  // on the branch; any other prepare failure (fetch, push, commit) is FAILED.
  // Absent `{base}`/`{branch}`/`{detail}` render as `unknown` (see render()).
  'merge-conflict': Object.freeze({
    class: NEEDS_DECISION,
    decision:
      'merging origin/{base} into {branch} conflicts ({detail}); resolve the conflict on the branch, commit, and re-run with --resume',
  }),
  'prepare-failed': Object.freeze({ class: FAILED, decision: 'prepare failed: {detail}' }),
});

/** Rendering of an absent optional field — keeps the sentence readable. */
const MISSING_FIELD = 'unknown';
const MISSING_WAVE = 'the wave';

/** Fill `{field}` placeholders from `result`. `{wave}` renders as `wave N`
 * (or `the wave` when absent); any other absent field renders as `unknown`. */
function render(template, result) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = result[key];
    const present = value !== undefined && value !== null && value !== '';
    if (key === 'wave') return present ? `wave ${value}` : MISSING_WAVE;
    return present ? String(value) : MISSING_FIELD;
  });
}

function classifyByAction(result, row) {
  const cls = Object.hasOwn(CLASS_BY_ACTION, result.action) ? CLASS_BY_ACTION[result.action] : null;
  if (!cls) {
    throw new Error(`classifyStop: unknown action ${JSON.stringify(result.action)} for stopped=${result.stopped}`);
  }
  if (typeof result.outcome !== 'string' || result.outcome === '') {
    throw new Error(`classifyStop: missing outcome for stopped=${result.stopped}`);
  }
  const decision = render(DECISION_BY_ACTION[result.action] + row.suffix, result);
  return { class: cls, reason: result.outcome, decision };
}

/**
 * Classify one spine terminal result.
 *
 * @param {Object} result - a structured spine terminal (`{ stopped, ... }`)
 * @returns {{ class: string, reason: string, decision: string }}
 * @throws {Error} on null/non-object input, unknown `stopped`, or an unknown
 *   action / missing outcome on a matrix or hook-veto terminal
 */
export function classifyStop(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`classifyStop: unknown result ${JSON.stringify(result)} (expected an object)`);
  }
  const row = Object.hasOwn(STOP_TABLE, result.stopped) ? STOP_TABLE[result.stopped] : null;
  if (!row) {
    throw new Error(`classifyStop: unknown stopped ${JSON.stringify(result.stopped)}`);
  }
  if (row.byAction) return classifyByAction(result, row);
  return { class: row.class, reason: result.stopped, decision: render(row.decision, result) };
}
