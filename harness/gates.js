/**
 * Declarative gate rules loader + evaluator.
 *
 * Gates are the system's slop-prevention and automation seam (Decision 1): a
 * gate is a deterministic predicate over the event history. The rules live in
 * gates.yaml; this module LOADS and evaluates them and contains no gate policy
 * of its own beyond the structural conditions the YAML declares.
 *
 * Proxy approval: an `approved` event whose `role` field equals the required
 * role satisfies the gate even when physically run by someone else
 * (`recordedBy`). The decision rides on `role` (frozen at write-time by
 * `recordApproval`); `actor` and `recordedBy` are preserved for the audit
 * trail and surfaced via `satisfiedBy` (see docs/harness-state-store.md,
 * "Approval without a bottleneck").
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from './vendor/js-yaml.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Default location of the gate rules — gates.yaml next to this module. */
export const DEFAULT_GATES_PATH = join(HERE, 'gates.yaml');

/**
 * The result of evaluating a gate.
 *
 * @typedef {Object} GateResult
 * @property {boolean} passed       - whether the gate is satisfied
 * @property {string}  reason       - human-readable explanation
 * @property {string} [requiredRole] - the role the satisfying event must carry
 * @property {Object} [satisfiedBy] - { actor, role, recordedBy? } of the satisfying event, or null
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
 * Does an event's frozen `role` field satisfy the required role? The `role`
 * is written once by `recordApproval` (write-time authority) and never
 * re-derived here. Callers with a real role map may pass `roleOf` to override
 * for legacy/testing purposes.
 *
 * @param {string} role         - the role frozen into the event
 * @param {string} requiredRole
 * @param {(role: string) => string} [roleOf] - optional override (maps role → canonical role)
 * @returns {boolean}
 */
function eventHasRole(role, requiredRole, roleOf) {
  if (typeof roleOf === 'function') return roleOf(role) === requiredRole;
  return role === requiredRole;
}

/** Look up the declared rule for `name`; an undeclared gate is an error. */
function requireRule(gates, name) {
  const rule = gates[name];
  if (rule === undefined) {
    throw new Error(`No gate rule declared for gate '${name}'`);
  }
  return rule;
}

/** Only the `role-equals` condition is supported; anything else is an error. */
function requireSupportedCondition(name, condition) {
  if (condition !== 'role-equals') {
    throw new Error(
      `Gate '${name}' declares unsupported condition '${condition}'`,
    );
  }
}

/**
 * First event of `eventType` whose frozen `role` field satisfies the required
 * role. `actor` identifies the human; `role` carries authority.
 */
function findSatisfyingEvent(events, eventType, requiredRole, roleOf) {
  return events.find(
    (e) =>
      e &&
      e.type === eventType &&
      eventHasRole(e.role, requiredRole, roleOf),
  );
}

/** GateResult for a satisfied gate; `recordedBy` is surfaced only when present. */
function satisfiedResult(match, eventType, requiredRole) {
  return {
    passed: true,
    reason: `satisfied by ${eventType} event from role:${requiredRole}`,
    requiredRole,
    satisfiedBy: {
      actor: match.actor,
      role: match.role,
      ...(match.recordedBy !== undefined
        ? { recordedBy: match.recordedBy }
        : {}),
    },
  };
}

/** GateResult for an unsatisfied gate. */
function unsatisfiedResult(reason, requiredRole) {
  return {
    passed: false,
    reason,
    requiredRole,
    satisfiedBy: null,
  };
}

/**
 * Evaluate a named gate against an event history.
 *
 * @param {string} name - gate name declared in gates.yaml
 * @param {import('./events.js').Event[]} history - the feature's event trail
 * @param {Object} [gates] - pre-loaded gate rules; loaded from disk if omitted
 * @param {{ roleOf?: (role: string) => string }} [opts] - optional role resolver
 * @returns {GateResult}
 */
export function evaluateGate(name, history, gates = loadGates(), opts = {}) {
  const rule = requireRule(gates, name);
  const { eventType, requiredRole, condition, reason } = rule;
  const events = Array.isArray(history) ? history : [];
  requireSupportedCondition(name, condition);

  const match = findSatisfyingEvent(events, eventType, requiredRole, opts.roleOf);
  if (match) return satisfiedResult(match, eventType, requiredRole);
  return unsatisfiedResult(reason, requiredRole);
}
