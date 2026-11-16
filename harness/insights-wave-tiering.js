/**
 * /rad-insights Step 4f — per-wave-position reliability (model-tiering advisory)
 * over the per-feature event logs. Read-side only: the counting lives in the
 * pure fold `waveReliability` exported by `harness/events.js`; this module only
 * shapes it for presentation. Run directly (`node harness/insights-wave-tiering.js`)
 * it prints the section as JSON, honoring `RAD_STATE_DIR` (default `.agents/state`).
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { waveReliability } from './events.js';
import { DEFAULT_STATE_DIR, readAllHistory } from './insights-state.js';

const JSON_INDENT = 2;
const PERCENT = 100;
// Minimum DISTINCT features with wave history before any tiering advisory
// renders. Below it, a rate describes one or two plans, not a wave position.
export const TIERING_MIN_FEATURES = 3;

const pct = (n, d) => (d === 0 ? 0 : Math.round((PERCENT * n) / d));

function toPosition([wave, s]) {
  return {
    wave: Number(wave),
    n: s.samples,
    attempts: s.attempts,
    firstAttemptSuccessPct: pct(s.firstAttemptSuccess, s.samples),
    retryPct: pct(s.retried, s.samples),
  };
}

/** @returns {Object} noWaveData, advisory, minFeatures, features and per-wave `positions`. */
export function buildWaveTiering(stateDir) {
  // Pairs are keyed by (feature, wave), so one concatenated history is safe.
  const result = waveReliability(readAllHistory(stateDir));
  return {
    noWaveData: result.features === 0,
    advisory: result.features >= TIERING_MIN_FEATURES,
    minFeatures: TIERING_MIN_FEATURES,
    features: result.features,
    positions: Object.entries(result.perPosition).map(toPosition),
  };
}

/** The section text: pretty-printed JSON, exactly as the inline snippet printed it. */
export function formatWaveTiering(result) {
  return JSON.stringify(result, null, JSON_INDENT);
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  console.log(formatWaveTiering(buildWaveTiering(process.env.RAD_STATE_DIR || DEFAULT_STATE_DIR)));
}
