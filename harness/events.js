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
 *   'done'
 * @property {string}  actor        - WHO the event is attributed to (human identity)
 * @property {string}  ts           - ISO timestamp, passed in by the caller
 * @property {string} [recordedBy]  - WHO physically ran the command, if not `actor`
 * @property {string} [role]        - verified role token (present on `approved` events;
 *   frozen at write-time by recordApproval after check-role.sh confirms the actor
 *   holds the required role). `actor` is the human identity; `role` is the authority.
 * @property {Object} [data]        - event-specific payload
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
  'pr-opened': 'delivered',
  done: 'done',
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
    if (event && event.type === 'wave-complete' && event.data) {
      completed.add(event.data.wave);
    }
  }
  return completed;
}
