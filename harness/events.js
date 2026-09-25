/**
 * Event model and the pure state fold for the RAD harness.
 *
 * State is a *projection* of an append-only event log (design Decision 2):
 * `reduce(history)` is a pure function of an in-memory event array — no
 * filesystem, no git, no I/O. Everything else (phase, gates, status headers)
 * is a view of the log.
 *
 * See docs/harness-state-store.md for the authoritative spec.
 */

/**
 * A single lifecycle event for one feature. The store never calls Date.now();
 * `ts` is always supplied by the caller.
 *
 * @typedef {Object} Event
 * @property {string}  feature      - feature slug the event belongs to
 * @property {string}  type         - event type, e.g. 'deliver-started' |
 *   'wave-attempt' | 'wave-complete' | 'wave-failed' | 'approved' |
 *   'pr-opened' | 'revision-requested' | 'research-created' | 'plan-created' |
 *   'hook-observed' | 'hook-veto' | 'hook-failed' | 'done' |
 *   'owner-claimed' | 'owner-released' | 'architecture-approved' |
 *   'capture-failed'.
 *   `owner-claimed` / `owner-released` are DATA-ONLY ownership events: they
 *   establish NO phase (absent from PHASE_BY_TYPE) and carry no outcome (never
 *   routed through resolveOutcome). Their provenance (who claimed/released) is
 *   carried in `event.data` by later waves; the model only recognizes the types.
 *   `architecture-approved` is an AUDIT-ONLY event with the same shape: it
 *   establishes NO phase (absent from PHASE_BY_TYPE) and carries no outcome — it
 *   records that an architecture review signed off, with no effect on the fold.
 *   It is NOT the deliver gate (that remains the `approved` event); it is a
 *   separate audit signal and has no rule in gates.yaml.
 *   `capture-failed` is the third AUDIT-ONLY event of that family: the deliver
 *   spine appends it when FAIL-OPEN prompt enrichment degraded — capturing the
 *   previous attempt's failure into the next attempt's `priorFailure` threw, so
 *   the retry proceeded with the enrichment-absent prompt. It establishes NO
 *   phase (absent from PHASE_BY_TYPE), carries no outcome, and leaves the fold
 *   unaffected; its `data` records `{ wave, attempt, outcome, what, reason }` so
 *   the degradation is legible rather than swallowed. Because the capture is
 *   prompt input only, it decides nothing and gates nothing.
 *
 *   The `approved` event's `data` MAY carry an optional `fingerprint` field (a
 *   string hash of the plan body, from harness/plan-fingerprint.js) attesting to
 *   WHICH plan body was approved. The fold does not read it; it is data-only.
 *
 *   The `wave-attempt` event's `data` MAY carry two OPTIONAL, data-only keys that
 *   record what the wave agent claimed it did (see WaveAttemptEvidence below).
 *   Both are ADDITIVE and ABSENT-BY-DEFAULT: when the wave result carries neither,
 *   the appended event is byte-identical to a pre-existing one, and every fold in
 *   this module returns identical results on a history that lacks them. No fold
 *   reads either key.
 * @property {string}  actor        - WHO the event is attributed to (human identity)
 * @property {string}  ts           - ISO timestamp, passed in by the caller
 * @property {string} [recordedBy]  - WHO physically ran the command, if not `actor`
 * @property {string} [role]        - verified role token (present on `approved` events;
 *   frozen at write-time by recordApproval after check-role.sh confirms the actor
 *   holds the required role). `actor` is the human identity; `role` is the authority.
 * @property {Object} [data]        - event-specific payload
 */

/**
 * Provenance payload carried by the three hook lifecycle events
 * (`hook-observed` | `hook-veto` | `hook-failed`). Recorded on `event.data`, it
 * names WHERE the signal came from so the audit trail distinguishes an
 * operator-hook outcome from the wave agent's own outcome.
 *
 * @typedef {Object} HookEventData
 * @property {string} point    - lifecycle point that fired (e.g. 'post-wave')
 * @property {string} hook     - the hook script path that produced the signal
 * @property {string} outcome  - the outcome token (one of the fixed vocabulary)
 * @property {'hook'} source   - provenance tag; always the literal 'hook'
 */

/**
 * OPTIONAL evidence payload a `wave-attempt` event's `data` MAY carry alongside
 * the existing `{ wave, outcome, usage }` keys. Both fields are DATA-ONLY: no
 * fold in this module reads them, and a wave result that carries neither appends
 * an event byte-identical to today's (the keys are omitted entirely, never
 * written as null or as an empty collection).
 *
 * `tasks` mirrors the per-task self-classification the wave agent reported in its
 * WAVE_RESULT block. `verify` records the verification command a wave ran and
 * whether it passed — a claim ABOUT verification, recorded for audit; it is NOT
 * itself a gate, and nothing in this module treats it as one.
 *
 * @typedef {Object} WaveAttemptEvidence
 * @property {Array<{title: string, status: string}>} [tasks]  - per-task titles +
 *   self-classified statuses, as reported by the wave agent. Omitted when empty.
 * @property {{command: string, status: number, passed: boolean}} [verify] - the
 *   verification command run for the wave, its exit status, and whether it passed.
 *   Omitted when the wave ran no verification command.
 */

/**
 * Derived lifecycle phase. Ordered from earliest to terminal.
 *
 * @typedef {('researched'|'planned'|'approved'|'in-progress'|'delivered'|'done')} Phase
 */

/**
 * StateStore — the state machine's persistence. Append-only; `append()` is the
 * only mutation in the system. Reads are pure folds over the event log.
 *
 * @typedef {Object} StateStore
 * @property {(feature: string) => Phase}        phase   - derived current phase
 * @property {(feature: string) => (Object|null)} plan   - structured plan, or null
 * @property {(feature: string) => Event[]}      history - full who/when/why trail
 * @property {(event: Event) => void}            append  - validate + persist one event
 * @property {(feature: string, name: string) => Object} gate - deterministic gate predicate
 * @property {(filter?: Object) => Object[]}     list    - feature states, no per-branch fan-out
 */

/**
 * ArtifactStore — the documents (plan.md, research.md, execution log). Git's job.
 *
 * @typedef {Object} ArtifactStore
 * @property {(feature: string, name: string) => (string|null)} read  - read a document
 * @property {(feature: string, name: string, content: string) => void} write - write a document
 */

/**
 * Maps the event type that *establishes* a phase to that phase. The fold takes
 * the latest (highest-ranked) phase any event in the history implies.
 */
const PHASE_BY_TYPE = {
  'research-created': 'researched',
  'plan-created': 'planned',
  approved: 'approved',
  'deliver-started': 'in-progress',
  'wave-attempt': 'in-progress',
  'wave-complete': 'in-progress',
  'wave-failed': 'in-progress',
  'revision-requested': 'in-progress',
  // Hook lifecycle events observe a wave in flight — same phase as the wave
  // events they sit beside (consistent with wave-attempt / wave-complete).
  'hook-observed': 'in-progress',
  'hook-veto': 'in-progress',
  'hook-failed': 'in-progress',
  'pr-opened': 'delivered',
  done: 'done',
  // `architecture-approved` and `capture-failed` are audit-only: like
  // owner-claimed/owner-released they are DELIBERATELY ABSENT from PHASE_BY_TYPE
  // so they establish no phase and the fold is unaffected. (Listed here in a
  // comment, not as keys, on purpose.) `capture-failed` in particular records a
  // fail-open degradation of prompt enrichment — adding it as a key would let a
  // non-decision move a feature's phase.
};

/** Phase ordering — earliest first; later phases dominate in the fold. */
const PHASE_ORDER = [
  'researched',
  'planned',
  'approved',
  'in-progress',
  'delivered',
  'done',
];

const rank = (phase) => PHASE_ORDER.indexOf(phase);

/**
 * Compute just the derived phase from an event history. Pure.
 *
 * @param {Event[]} history
 * @returns {(Phase|null)} the highest-ranked phase any event implies, or null when empty
 */
export function phaseOf(history) {
  let phase = null;
  for (const event of history) {
    const candidate = PHASE_BY_TYPE[event.type];
    if (candidate === undefined) continue;
    if (phase === null || rank(candidate) > rank(phase)) {
      phase = candidate;
    }
  }
  return phase;
}

/**
 * Pure fold over an array of events → derived state.
 *
 * @param {Event[]} history - in-memory event array (no I/O performed)
 * @returns {{ phase: (Phase|null), markers: string[], approvals: Array<{actor: string, ts: string, role?: string, recordedBy?: string}> }}
 */
export function reduce(history) {
  if (!Array.isArray(history)) {
    throw new TypeError('reduce(history): history must be an array of events');
  }

  const markers = new Set();
  const approvals = [];

  for (const event of history) {
    // A marker per event type observed — the set of facts the log implies.
    markers.add(event.type);

    if (event.type === 'approved') {
      // Only include optional fields when present, so a direct approval carries no
      // undefined-valued keys — the public shape is the *absence* of the key.
      const approval = { actor: event.actor, ts: event.ts };
      if (event.role !== undefined) approval.role = event.role;
      if (event.recordedBy !== undefined) approval.recordedBy = event.recordedBy;
      approvals.push(approval);
    }
  }

  return {
    phase: phaseOf(history),
    markers: [...markers],
    approvals,
  };
}

/**
 * Pure fold over an event history → the set of wave numbers that have already
 * advanced (have a `wave-complete` event). Used by the deliver spine to resume
 * after a crash: an already-completed wave is skipped, never re-run.
 *
 * Keys STRICTLY off `wave-complete` — a wave that only logged `wave-attempt`
 * but never advanced is NOT included, so a mid-wave crash resumes that wave.
 * Tolerates empty/partial/missing history; never throws on null/undefined.
 *
 * @param {Event[]} history - in-memory event array (no I/O performed)
 * @returns {Set<number>} wave numbers (data.wave) of completed waves
 */
export function resumeFrom(history) {
  const completed = new Set();
  if (!Array.isArray(history)) return completed;
  for (const event of history) {
    // Only a numeric data.wave counts — the spine stores wave.n as a number, so
    // a missing or string-typed wave id (corrupted event) must NOT enter the set
    // (a string '3' would never match the numeric wave.n and would mis-skip).
    if (
      event &&
      event.type === 'wave-complete' &&
      event.data &&
      typeof event.data.wave === 'number'
    ) {
      completed.add(event.data.wave);
    }
  }
  return completed;
}

/**
 * Pure fold over an event history → the summed token usage across all
 * `wave-attempt` events that carry a `data.usage` object. Usage is OPTIONAL and
 * ADDITIVE: legacy attempts (and adapters that emit no usage) simply contribute
 * nothing, so a history with no usage folds to all-zeros without error. Intended
 * for the insights layer to report per-feature cost.
 *
 * @param {Event[]} history - in-memory event array (no I/O performed)
 * @returns {{ input: number, output: number, total: number }}
 */
export function totalUsage(history) {
  const sum = { input: 0, output: 0, total: 0 };
  if (!Array.isArray(history)) return sum;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  for (const event of history) {
    if (
      event &&
      event.type === 'wave-attempt' &&
      event.data &&
      event.data.usage &&
      typeof event.data.usage === 'object'
    ) {
      const u = event.data.usage;
      sum.input += num(u.input);
      sum.output += num(u.output);
      // Prefer an explicit total; fall back to input + output for the event.
      sum.total += Number.isFinite(u.total) ? u.total : num(u.input) + num(u.output);
    }
  }
  return sum;
}

// ── Insights read helpers (appended; pure folds, no I/O) ─────────────────────
// The outcome vocabulary is the frozen 7-outcome set owned by matrix.yaml and
// mirrored by hook-runner.js. We IMPORT hook-runner's exported set rather than
// duplicating it, so the vocabulary has exactly two declarations repo-wide
// (matrix.yaml + hook-runner.js) and this module can never drift from them.
// hook-runner.js has no module-scope side effects, so the import stays pure.
import { OUTCOME_VOCAB } from './hook-runner.js';

/**
 * Pure fold over an event history → counts of `wave-complete` events keyed by
 * `data.outcome` across the frozen 7-outcome vocabulary (success | fail-tests |
 * fail-scope | fail-protocol | fail-timeout | no-changes | abort-user), plus an
 * `unknown` bucket and a `total`. Outcome is OPTIONAL on the wire: the current
 * spine records `wave-complete` with `data: { wave }` only, so a missing or
 * out-of-vocabulary outcome is BUCKETED AS `unknown` (never skipped, never
 * thrown) — the total always equals the number of wave-complete events seen.
 * Intended for the insights layer to report per-feature reliability.
 *
 * @param {Event[]} history - in-memory event array (no I/O performed)
 * @returns {{ success: number, 'fail-tests': number, 'fail-scope': number,
 *   'fail-protocol': number, 'fail-timeout': number, 'no-changes': number,
 *   'abort-user': number, unknown: number, total: number }}
 */
export function outcomeCounts(history) {
  const counts = {};
  for (const outcome of OUTCOME_VOCAB) counts[outcome] = 0;
  counts.unknown = 0;
  counts.total = 0;
  if (!Array.isArray(history)) return counts;
  for (const event of history) {
    if (!event || event.type !== 'wave-complete') continue;
    counts.total += 1;
    const outcome = event.data && typeof event.data.outcome === 'string' ? event.data.outcome : null;
    if (outcome !== null && OUTCOME_VOCAB.has(outcome)) {
      counts[outcome] += 1;
    } else {
      counts.unknown += 1;
    }
  }
  return counts;
}

/**
 * Pure fold over an event history → counts of `wave-failed` events keyed by
 * `data.reason`, plus a `total`. Reasons are FREE-FORM keys as recorded by the
 * spine (`token-budget`, `doom-loop`, `budget-exhausted`, hook reasons, …) —
 * this fold does not validate them against any vocabulary. Reason is OPTIONAL
 * on the wire: the matrix abort/surface terminal records `data: { wave, action }`
 * with no reason, so a missing or non-string reason is BUCKETED AS `unknown` —
 * the total always equals the number of wave-failed events seen.
 *
 * @param {Event[]} history - in-memory event array (no I/O performed)
 * @returns {{ total: number, reasons: Object<string, number> }}
 */
export function failReasonCounts(history) {
  const counts = { total: 0, reasons: {} };
  if (!Array.isArray(history)) return counts;
  for (const event of history) {
    if (!event || event.type !== 'wave-failed') continue;
    counts.total += 1;
    const reason =
      event.data && typeof event.data.reason === 'string' && event.data.reason !== ''
        ? event.data.reason
        : 'unknown';
    counts.reasons[reason] = (counts.reasons[reason] || 0) + 1;
  }
  return counts;
}

/**
 * Pure fold over an event history → per-wave `wave-attempt` counts. `perWave`
 * is keyed by `String(data.wave)`; `total` counts EVERY wave-attempt event
 * (legacy attempts with a missing or non-numeric `data.wave` still count toward
 * the total but establish no per-wave key); `retriedWaves` is the number of
 * waves observed with more than one attempt. A history with no attempts folds
 * to the zeroed shape without error.
 *
 * @param {Event[]} history - in-memory event array (no I/O performed)
 * @returns {{ total: number, retriedWaves: number, perWave: Object<string, number> }}
 */
export function retryCounts(history) {
  const out = { total: 0, retriedWaves: 0, perWave: {} };
  if (!Array.isArray(history)) return out;
  for (const event of history) {
    if (!event || event.type !== 'wave-attempt') continue;
    out.total += 1;
    const wave = event.data ? event.data.wave : undefined;
    if (typeof wave === 'number' && Number.isFinite(wave)) {
      const key = String(wave);
      out.perWave[key] = (out.perWave[key] || 0) + 1;
    }
  }
  out.retriedWaves = Object.values(out.perWave).filter((n) => n > 1).length;
  return out;
}

/**
 * Pure fold over an event history → hook-veto activity. `vetoes` counts
 * `hook-veto` events (the runner's dedicated veto record). `vetoedAttempts`
 * SEPARATELY counts `wave-attempt` events carrying hook-veto provenance
 * (`data.source === 'hook'`, per the spine's post-wave veto tagging with
 * source/point/hook) — they are NOT folded into `vetoes`, because a post-wave
 * veto emits BOTH a hook-veto event and a provenance-tagged attempt, and
 * folding them together would double-count. Provenance fields are OPTIONAL:
 * untagged attempts contribute nothing.
 *
 * @param {Event[]} history - in-memory event array (no I/O performed)
 * @returns {{ vetoes: number, vetoedAttempts: number }}
 */
export function hookVetoCounts(history) {
  const out = { vetoes: 0, vetoedAttempts: 0 };
  if (!Array.isArray(history)) return out;
  for (const event of history) {
    if (!event) continue;
    if (event.type === 'hook-veto') {
      out.vetoes += 1;
    } else if (event.type === 'wave-attempt' && event.data && event.data.source === 'hook') {
      out.vetoedAttempts += 1;
    }
  }
  return out;
}

// The per-task blocked statuses a wave agent may self-classify with (the
// WAVE_RESULT task `status` vocabulary, docs/rad-wave-contract.md). Only these
// three are bucketed; complete / done_with_concerns / anything else is ignored.
const BLOCKED_TASK_STATUSES = ['blocked_code', 'blocked_spec', 'blocked_intent'];

/**
 * Pure fold over an event history → per-task blocked-reason distribution read
 * from `wave-attempt` events' OPTIONAL `data.tasks` array. Each task whose
 * `status` is one of BLOCKED_TASK_STATUSES increments its bucket.
 * `enrichedAttempts` counts attempts that carried a non-empty `tasks` array, so
 * callers can tell "no blocked tasks" (enrichedAttempts > 0, zero buckets) from
 * "no enriched events at all" (enrichedAttempts === 0). Legacy attempts (no
 * `tasks`), malformed task entries, and non-array input contribute nothing.
 *
 * @param {Event[]} history - in-memory event array (no I/O performed)
 * @returns {{ blocked_code: number, blocked_spec: number, blocked_intent: number,
 *   enrichedAttempts: number }}
 */
export function blockedReasonCounts(history) {
  const out = { enrichedAttempts: 0 };
  for (const status of BLOCKED_TASK_STATUSES) out[status] = 0;
  if (!Array.isArray(history)) return out;
  for (const event of history) {
    if (!event || event.type !== 'wave-attempt' || !event.data) continue;
    const tasks = event.data.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) continue;
    out.enrichedAttempts += 1;
    for (const task of tasks) {
      const status = task && typeof task.status === 'string' ? task.status : null;
      if (status !== null && BLOCKED_TASK_STATUSES.includes(status)) out[status] += 1;
    }
  }
  return out;
}

// Default floor for fileFailureCounts: a file must accumulate blocked tasks in
// at least this many DISTINCT features before it is reported. One feature's
// failures say more about that plan than about the region of code it touched.
export const FILE_FAILURE_MIN_FEATURES = 2;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Distinct string paths declared for a task title, or [] if none/malformed. */
function declaredPaths(taskFiles, title) {
  if (!hasOwn(taskFiles, title) || !Array.isArray(taskFiles[title])) return [];
  return [...new Set(taskFiles[title].filter((p) => typeof p === 'string' && p !== ''))];
}

/** Accumulate path -> { failures, features:Set } from blocked tasks in history. */
function collectFileFailures(history, taskFiles) {
  const byFile = new Map();
  for (const event of history) {
    if (!event || event.type !== 'wave-attempt' || !event.data) continue;
    if (typeof event.feature !== 'string' || event.feature === '') continue;
    const tasks = event.data.tasks;
    if (!Array.isArray(tasks)) continue;
    for (const task of tasks) {
      if (!task || !BLOCKED_TASK_STATUSES.includes(task.status) || typeof task.title !== 'string') continue;
      for (const path of declaredPaths(taskFiles, task.title)) {
        const entry = byFile.get(path) || { failures: 0, features: new Set() };
        entry.failures += 1;
        entry.features.add(event.feature);
        byFile.set(path, entry);
      }
    }
  }
  return byFile;
}

/**
 * Pure fold over an event history → per-FILE blocked-task counts, aggregated
 * across features. A "failure" is one task in a `wave-attempt`'s OPTIONAL
 * `data.tasks` whose status is in BLOCKED_TASK_STATUSES; it is attributed to
 * every path the CALLER's `taskFiles` mapping declares for that task title (the
 * fold never reads plan docs — it stays filesystem-free). Attempts with no
 * `tasks` (legacy/unenriched) cannot be attributed to a file and contribute
 * nothing; neither do tasks whose title is absent from `taskFiles`, nor events
 * lacking a string `feature` (a failure that cannot be placed in a feature
 * cannot count toward the cross-feature floor). `features` is the sorted list
 * of distinct feature names. Files seen in fewer than `minFeatures` features
 * are excluded from `files` and counted in `belowFloor`. Zeroed shape on
 * non-array history or missing/non-object taskFiles; never throws.
 *
 * Per-file counts are a CODE-LEGIBILITY signal about that region of the code,
 * not a verdict on agent performance (#93).
 *
 * @param {Event[]} history - in-memory event array (no I/O performed)
 * @param {Object<string,string[]>} taskFiles - task title -> declared File: paths
 * @param {number} [minFeatures] - positive-integer floor; anything else → FILE_FAILURE_MIN_FEATURES
 * @returns {{ files: Object<string,{ failures: number, features: string[] }>,
 *   belowFloor: number, minFeatures: number }}
 */
export function fileFailureCounts(history, taskFiles, minFeatures = FILE_FAILURE_MIN_FEATURES) {
  const floor = Number.isInteger(minFeatures) && minFeatures > 0 ? minFeatures : FILE_FAILURE_MIN_FEATURES;
  const out = { files: {}, belowFloor: 0, minFeatures: floor };
  if (!Array.isArray(history) || !taskFiles || typeof taskFiles !== 'object' || Array.isArray(taskFiles)) {
    return out;
  }
  const byFile = collectFileFailures(history, taskFiles);
  for (const path of [...byFile.keys()].sort()) {
    const { failures, features } = byFile.get(path);
    if (features.size < floor) {
      out.belowFloor += 1;
    } else {
      out.files[path] = { failures, features: [...features].sort() };
    }
  }
  return out;
}

/**
 * Group `wave-attempt` events into (feature, wave) pairs, in history order.
 * Reads ONLY `type`, `feature`, `data.wave`, and `data.outcome` — never `usage`.
 * @returns {Map<string,{ wave: string, feature: string, attempts: number, firstOutcome: string|null }>}
 */
function collectWavePairs(history) {
  const pairs = new Map();
  for (const event of history) {
    if (!event || event.type !== 'wave-attempt' || !event.data) continue;
    if (typeof event.feature !== 'string' || event.feature === '') continue;
    const wave = event.data.wave;
    if (typeof wave !== 'number' || !Number.isFinite(wave)) continue;
    const key = JSON.stringify([event.feature, wave]);
    let pair = pairs.get(key);
    if (!pair) {
      const outcome = typeof event.data.outcome === 'string' ? event.data.outcome : null;
      pair = { wave: String(wave), feature: event.feature, attempts: 0, firstOutcome: outcome };
      pairs.set(key, pair);
    }
    pair.attempts += 1;
  }
  return pairs;
}

/**
 * Pure fold over an event history → per-WAVE-POSITION reliability counts, the
 * raw material for first-attempt success rate and retry rate. Counting is
 * deterministic and carries its sample size alongside every figure; NO
 * threshold or minimum-history floor is applied here (a single-feature history
 * reports its true n — suppression is the caller's presentation decision).
 *
 * A "pair" is one (feature, wave) combination observed in `wave-attempt`
 * events, spanning every deliver run of that feature (a resumed wave's later
 * attempts extend the same pair). Hook-vetoed attempts are attempts too.
 * `perPosition` is keyed by `String(data.wave)`; for each position:
 *   - `samples`             — number of (feature, wave) pairs observed there
 *   - `attempts`            — total `wave-attempt` events at that position
 *   - `firstAttemptSuccess` — pairs whose FIRST attempt (history order) had
 *                             `data.outcome === 'success'`
 *   - `retried`             — pairs with more than one attempt
 * `features` is the number of distinct features contributing at least one pair.
 * Attempts lacking a string `feature` or a finite numeric `data.wave` cannot be
 * placed in a pair and contribute nothing. The fold deliberately never reads
 * `data.usage`: recorded input tokens are the uncached remainder, so spend is not
 * comparable across waves (#63/#121). Zeroed shape on [] / null / non-array /
 * wave-attempt-free input; never throws.
 *
 * @param {Event[]} history - in-memory event array (no I/O performed)
 * @returns {{ perPosition: Object<string,{ attempts: number, firstAttemptSuccess: number,
 *   retried: number, samples: number }>, features: number }}
 */
export function waveReliability(history) {
  const out = { perPosition: {}, features: 0 };
  if (!Array.isArray(history)) return out;
  const features = new Set();
  for (const pair of collectWavePairs(history).values()) {
    features.add(pair.feature);
    const slot = out.perPosition[pair.wave] || { attempts: 0, firstAttemptSuccess: 0, retried: 0, samples: 0 };
    slot.samples += 1;
    slot.attempts += pair.attempts;
    if (pair.firstOutcome === 'success') slot.firstAttemptSuccess += 1;
    if (pair.attempts > 1) slot.retried += 1;
    out.perPosition[pair.wave] = slot;
  }
  out.features = features.size;
  return out;
}
