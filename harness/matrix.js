/**
 * Declarative stop-condition matrix loader + resolver.
 *
 * This module holds NO policy. Every (phase, outcome) → action decision lives in
 * matrix.yaml; the JS only loads that table and looks entries up. There is no
 * default fallthrough — an unknown applicable pair throws, so the exhaustiveness
 * test can rely on a missing entry being fatal rather than silently defaulted.
 *
 * See docs/harness-state-store.md, "The stop-condition matrix" (Decision 5).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from './vendor/js-yaml.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Default location of the policy file — matrix.yaml next to this module. */
export const DEFAULT_MATRIX_PATH = join(HERE, 'matrix.yaml');

/**
 * A resolved stop-condition entry.
 *
 * @typedef {Object} OutcomeResolution
 * @property {('advance'|'retry'|'revision'|'abort'|'skip-to'|'surface')} action
 * @property {string} [to] - target phase for `advance` / `skip-to`
 */

/**
 * Load and parse the stop-condition matrix from YAML.
 *
 * @param {string} [path] - path to the matrix YAML; defaults to matrix.yaml here
 * @returns {Object<string, Object<string, OutcomeResolution>>} phase → outcome → entry
 */
export function loadMatrix(path = DEFAULT_MATRIX_PATH) {
  const raw = readFileSync(path, 'utf8');
  const parsed = yaml.load(raw);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`Matrix at ${path} did not parse to an object`);
  }
  return parsed;
}

/**
 * Resolve a (phase, outcome) pair to its declared action via the YAML matrix.
 * Throws — never returns a default — when the pair has no declared entry.
 *
 * @param {string} phase
 * @param {string} outcome
 * @param {Object} [matrix] - a pre-loaded matrix; loaded from disk if omitted
 * @returns {OutcomeResolution} the YAML-declared `{ action, to? }`
 */
export function resolveOutcome(phase, outcome, matrix = loadMatrix()) {
  const phaseRow = matrix[phase];
  if (phaseRow === undefined) {
    throw new Error(
      `No stop-condition entry for phase '${phase}' (no default fallthrough)`,
    );
  }
  const entry = phaseRow[outcome];
  if (entry === undefined) {
    throw new Error(
      `No stop-condition entry for (phase '${phase}', outcome '${outcome}') ` +
        `(no default fallthrough)`,
    );
  }
  return entry;
}
