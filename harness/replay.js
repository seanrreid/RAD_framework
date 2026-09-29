/**
 * Matrix/gates replay — re-derive every recorded decision in an event history
 * under a given (matrix, gates) table pair, and diff two such replays.
 *
 * Pure: no I/O, never throws. A lookup that throws (unknown outcome, removed
 * gate) is captured as a `'throws: <message>'` value so a divergence caused by a
 * table edit surfaces in the diff instead of aborting the replay.
 *
 * matrix.js and gates.js are consumed read-only — this module adds no policy.
 */

import { resolveOutcome } from './matrix.js';
import { evaluateGate } from './gates.js';

/** The only phase the spine drives; wave-attempt outcomes resolve against it. */
const REPLAY_PHASE = 'implement';
const WAVE_ATTEMPT_EVENT = 'wave-attempt';
const DELIVER_STARTED_EVENT = 'deliver-started';
const THROWS_PREFIX = 'throws: ';
const ABSENT = 'absent';

function captureThrow(fn) {
  try {
    return fn();
  } catch (err) {
    return `${THROWS_PREFIX}${err && err.message ? err.message : String(err)}`;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Sorted unique gate names across two gate tables (either may be absent).
 *
 * @param {Object} [gatesA]
 * @param {Object} [gatesB]
 * @returns {string[]}
 */
export function gateNameUnion(gatesA, gatesB) {
  const names = new Set([
    ...Object.keys(isObject(gatesA) ? gatesA : {}),
    ...Object.keys(isObject(gatesB) ? gatesB : {}),
  ]);
  return [...names].sort();
}

function matrixDecision(event, index, matrix) {
  const data = event.data;
  const outcome = data.outcome;
  const action = captureThrow(
    () => resolveOutcome(REPLAY_PHASE, outcome, matrix).action,
  );
  return {
    kind: 'matrix',
    feature: event.feature ?? null,
    index,
    wave: data.wave ?? null,
    attempt: data.attempt ?? null,
    outcome,
    action,
  };
}

function gateDecisions(event, index, history, gates, names) {
  const prior = history.slice(0, index);
  return names.map((gate) => ({
    kind: 'gate',
    feature: event.feature ?? null,
    index,
    gate,
    passed: captureThrow(() => evaluateGate(gate, prior, gates, {}).passed),
  }));
}

function isWaveAttemptWithOutcome(event) {
  return (
    event.type === WAVE_ATTEMPT_EVENT &&
    isObject(event.data) &&
    typeof event.data.outcome === 'string'
  );
}

/**
 * Replay every matrix and gate decision recorded in `history`.
 *
 * @param {Object[]} history - a feature's event trail
 * @param {{ matrix?: Object, gates?: Object, gateNames?: string[] }} [tables]
 *   `gateNames` forces the evaluated gate set (e.g. a union across two tables);
 *   it defaults to the keys of `gates`.
 * @returns {Object[]} Decision[]
 */
export function replayDecisions(history, tables = {}) {
  if (!Array.isArray(history)) return [];
  const { matrix, gates, gateNames } = isObject(tables) ? tables : {};
  const matrixTable = isObject(matrix) ? matrix : {};
  const gateTable = isObject(gates) ? gates : {};
  const names = Array.isArray(gateNames) ? gateNames : Object.keys(gateTable);
  const decisions = [];
  history.forEach((event, index) => {
    if (!isObject(event)) return;
    if (isWaveAttemptWithOutcome(event)) {
      decisions.push(matrixDecision(event, index, matrixTable));
    } else if (event.type === DELIVER_STARTED_EVENT) {
      decisions.push(...gateDecisions(event, index, history, gateTable, names));
    }
  });
  return decisions;
}

function decisionKey(d) {
  return `${d.feature}|${d.kind}|${d.index}|${d.gate ?? ''}`;
}

function decisionValue(d) {
  return d.kind === 'matrix' ? d.action : d.passed;
}

function decisionDetail(d) {
  return d.kind === 'matrix'
    ? `wave ${d.wave} attempt ${d.attempt} outcome ${d.outcome}`
    : `gate ${d.gate}`;
}

function indexByKey(decisions) {
  const map = new Map();
  for (const d of Array.isArray(decisions) ? decisions : []) {
    if (isObject(d)) map.set(decisionKey(d), d);
  }
  return map;
}

function compareEntries(a, b) {
  const fa = String(a.feature ?? '');
  const fb = String(b.feature ?? '');
  if (fa !== fb) return fa < fb ? -1 : 1;
  if (a.index !== b.index) return a.index - b.index;
  const ga = a.gate ?? '';
  const gb = b.gate ?? '';
  if (ga !== gb) return ga < gb ? -1 : 1;
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
}

/**
 * Diff two replays: entries whose matrix action or gate `passed` differ.
 * A decision present on only one side reports the other side as 'absent'.
 *
 * @param {Object[]} base
 * @param {Object[]} proposed
 * @returns {Object[]} sorted by feature, index, gate
 */
export function diffDecisions(base, proposed) {
  const baseMap = indexByKey(base);
  const proposedMap = indexByKey(proposed);
  const keys = new Set([...baseMap.keys(), ...proposedMap.keys()]);
  const entries = [];
  for (const key of keys) {
    const b = baseMap.get(key);
    const p = proposedMap.get(key);
    const bv = b ? decisionValue(b) : ABSENT;
    const pv = p ? decisionValue(p) : ABSENT;
    if (bv === pv) continue;
    const ref = b ?? p;
    entries.push({
      key,
      feature: ref.feature,
      kind: ref.kind,
      index: ref.index,
      ...(ref.kind === 'gate' ? { gate: ref.gate } : {}),
      detail: decisionDetail(ref),
      base: bv,
      proposed: pv,
    });
  }
  return entries.sort(compareEntries);
}
