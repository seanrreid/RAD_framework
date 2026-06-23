/**
 * Record-time transition validation (design Decision 4).
 *
 * `gate()` answers "may I proceed past this point?" (proceed-time). This module
 * answers "was this state change even legal?" (record-time). `append()` runs
 * `validateTransition(event, currentState)` BEFORE persisting and throws rather
 * than writes on an illegal move — making an invalid history unrepresentable
 * rather than merely discouraged.
 *
 * Pure: no filesystem, no git. It derives the current phase from the in-memory
 * history carried on `currentState`.
 *
 * See docs/harness-state-store.md, Decision 4, for the list of illegal moves.
 */

import { phaseOf } from './events.js';

/**
 * Thrown when an event would produce an illegal transition. Never written.
 */
export class TransitionError extends Error {
  /**
   * @param {string} message
   * @param {{ event?: import('./events.js').Event, rule?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'TransitionError';
    this.event = details.event;
    this.rule = details.rule;
  }
}

/** Terminal phases — no event may follow once a feature reaches one. */
const TERMINAL_PHASES = new Set(['delivered', 'done']);

/**
 * Event types that count as reviewer/verifier (evaluator) output — a
 * `revision-requested` is only legal once one of these has been recorded.
 */
const EVALUATOR_TYPES = new Set([
  'wave-attempt',
  'wave-complete',
  'wave-failed',
  'review',
  'evaluation',
]);

/**
 * @typedef {Object} CurrentState
 * @property {import('./events.js').Event[]} history - the feature's events so far
 */

/**
 * Validate that `event` is a legal next transition given `currentState`.
 * Returns normally (void) on a legal move; throws {@link TransitionError} on an
 * illegal one.
 *
 * @param {import('./events.js').Event} event - the event about to be appended
 * @param {CurrentState} currentState - state derived from the existing history
 * @returns {void}
 */
export function validateTransition(event, currentState) {
  const history = (currentState && currentState.history) || [];
  const phase = phaseOf(history);

  // (a) No event may follow a terminal done/delivered state.
  if (TERMINAL_PHASES.has(phase)) {
    throw new TransitionError(
      `Cannot append '${event.type}' after terminal phase '${phase}'`,
      { event, rule: 'after-terminal' },
    );
  }

  // (b) wave-complete is only legal while in-progress.
  if (event.type === 'wave-complete' && phase !== 'in-progress') {
    throw new TransitionError(
      `Cannot record 'wave-complete' when phase is '${phase}' (expected 'in-progress')`,
      { event, rule: 'wave-complete-not-in-progress' },
    );
  }

  // (c) revision-requested requires preceding reviewer/verifier output.
  if (event.type === 'revision-requested') {
    const hasEvaluatorOutput = history.some((e) => EVALUATOR_TYPES.has(e.type));
    if (!hasEvaluatorOutput) {
      throw new TransitionError(
        "Cannot request revision without preceding evaluator output",
        { event, rule: 'revision-without-evaluator' },
      );
    }
  }

  // (d) A duplicate approved would silently shadow an earlier authority — but a
  // RE-attestation after a plan edit is legitimate. Block a second `approved`
  // ONLY when its plan fingerprint EQUALS the most recent prior approved's
  // fingerprint (a true duplicate); ALLOW it when the fingerprints differ (the
  // approver is re-attesting a changed plan body). Fail-closed for the legacy
  // case: if EITHER fingerprint is absent/undefined, preserve today's behavior
  // and block — we cannot prove the bodies differ, so we treat it as a duplicate.
  if (event.type === 'approved') {
    const priorApproved = history.filter((e) => e.type === 'approved');
    if (priorApproved.length > 0) {
      const prior = priorApproved[priorApproved.length - 1];
      const priorFp = prior.data && prior.data.fingerprint;
      const nextFp = event.data && event.data.fingerprint;
      const differs =
        priorFp !== undefined && nextFp !== undefined && nextFp !== priorFp;
      if (!differs) {
        throw new TransitionError(
          'Cannot append a duplicate approved event — an approval already exists',
          { event, rule: 'duplicate-approved' },
        );
      }
    }
  }

  // (e) An approved or architecture-approved event must carry a frozen role —
  // recordApproval / recordArchitectureApproved are the canonical constructors and
  // always stamp role at write-time. A role-less such event means write-time
  // authority was bypassed (e.g. a direct append() call) — reject it as an illegal
  // transition.
  if (
    (event.type === 'approved' || event.type === 'architecture-approved') &&
    !event.role
  ) {
    throw new TransitionError(
      `Cannot append an ${event.type} event without a frozen role — use the record* constructor, which verifies and stamps the role at write-time`,
      { event, rule: 'approved-missing-role' },
    );
  }
}
