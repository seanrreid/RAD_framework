/**
 * Declarative gate rules loader + evaluator.
 *
 * Gates are the system's slop-prevention and automation seam (Decision 1): a
 * gate is a deterministic predicate over the event history. The rules live in
 * gates.yaml; this module LOADS and evaluates them and contains no gate policy
 * of its own beyond the structural conditions the YAML declares.
 *
 * Proxy approval: an `approved` event attributed to the architect (`actor`)
 * satisfies the gate even when physically run by someone else (`recordedBy`).
 * The decision rides on `actor`; `recordedBy` is preserved for the audit trail
 * and surfaced via `satisfiedBy` (see docs/harness-state-store.md, "Approval
 * without a bottleneck").
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Default location of the gate rules — gates.yaml next to this module. */
export const DEFAULT_GATES_PATH = join(HERE, 'gates.yaml');

/**
 * The result of evaluating a gate.
 *
 * @typedef {Object} GateResult
 * @property {boolean} passed       - whether the gate is satisfied
 * @property {string}  reason       - human-readable explanation
 * @property {string} [requiredRole] - the role the satisfying actor must hold
 * @property {Object} [satisfiedBy] - { actor, recordedBy? } of the satisfying event, or null
 */

/**
 * Load and parse the gate rules from YAML.
 *
 * @param {string} [path] - path to the gates YAML; defaults to gates.yaml here
 * @returns {Object<string, Object>} gate name → rule
 */
export function loadGates(path = DEFAULT_GATES_PATH) {
  const raw = readFileSync(path, 'utf8');
  const parsed = yaml.load(raw);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`Gates at ${path} did not parse to an object`);
  }
  return parsed;
}

/**
 * Does an actor represent the required role? The store records *asserted*
 * identity (the role trust boundary lives in check-role.sh, not here), so the
 * default resolver treats the `actor` string as carrying the role directly.
 * Callers with a real role map may pass `roleOf` to override.
 *
 * @param {string} actor
 * @param {string} requiredRole
 * @param {(actor: string) => string} [roleOf]
 * @returns {boolean}
 */
function actorHasRole(actor, requiredRole, roleOf) {
  if (typeof roleOf === 'function') return roleOf(actor) === requiredRole;
  return actor === requiredRole;
}

/**
 * Evaluate a named gate against an event history.
 *
 * @param {string} name - gate name declared in gates.yaml
 * @param {import('./events.js').Event[]} history - the feature's event trail
 * @param {Object} [gates] - pre-loaded gate rules; loaded from disk if omitted
 * @param {{ roleOf?: (actor: string) => string }} [opts] - optional role resolver
 * @returns {GateResult}
 */
export function evaluateGate(name, history, gates = loadGates(), opts = {}) {
  const rule = gates[name];
  if (rule === undefined) {
    throw new Error(`No gate rule declared for gate '${name}'`);
  }

  const { eventType, requiredRole, condition, reason } = rule;
  const events = Array.isArray(history) ? history : [];

  if (condition !== 'actor-has-role') {
    throw new Error(
      `Gate '${name}' declares unsupported condition '${condition}'`,
    );
  }

  const match = events.find(
    (e) =>
      e &&
      e.type === eventType &&
      actorHasRole(e.actor, requiredRole, opts.roleOf),
  );

  if (match) {
    return {
      passed: true,
      reason: `satisfied by ${eventType} event from role:${requiredRole}`,
      requiredRole,
      satisfiedBy: {
        actor: match.actor,
        ...(match.recordedBy !== undefined
          ? { recordedBy: match.recordedBy }
          : {}),
      },
    };
  }

  return {
    passed: false,
    reason,
    requiredRole,
    satisfiedBy: null,
  };
}
