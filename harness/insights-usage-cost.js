/**
 * /rad-insights Step 4b — token cost from `wave-attempt` usage over the
 * per-feature event logs. Read-side only: `totalUsage` (imported from
 * `harness/events.js`) supplies the input/output-inferred total; this module adds
 * the explicit-total per-feature and per-wave sums. Run directly
 * (`node harness/insights-usage-cost.js`) it prints the section as JSON, honoring
 * `RAD_STATE_DIR` (default `.agents/state`).
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { totalUsage } from './events.js';
import { DEFAULT_STATE_DIR, UNKNOWN_WAVE, WAVE_ATTEMPT, listFeatures, readHistory } from './insights-state.js';

const JSON_INDENT = 2;

const hasUsage = (e) => Boolean(e.data && e.data.usage && typeof e.data.usage === 'object');
const attemptTotal = (e) => {
  const t = e.data && e.data.usage ? e.data.usage.total : 0;
  return typeof t === 'number' && Number.isFinite(t) ? t : 0;
};

function waveKey(event) {
  const wave = (event.data && event.data.wave) ?? event.wave;
  return wave === undefined || wave === null ? UNKNOWN_WAVE : String(wave);
}

/** Unknown-wave bucket first, then waves ascending (matches the old `sort -n`). */
function compareWaves(a, b) {
  if (a === UNKNOWN_WAVE || b === UNKNOWN_WAVE) return a === b ? 0 : a === UNKNOWN_WAVE ? -1 : 1;
  return Number(a) - Number(b);
}

/**
 * @returns {Object[]} `{ wave, total }` per wave number; missing usage adds 0. Explicit
 * `usage.total` only (jq parity); `insights-reliability.js` `spendPerWave` infers
 * input + output instead, so the two can differ on legacy events.
 */
export function perWaveTotals(history) {
  const sums = new Map();
  const attempts = history.filter((e) => e.type === WAVE_ATTEMPT);
  for (const event of attempts) {
    const wave = waveKey(event);
    sums.set(wave, (sums.get(wave) ?? 0) + attemptTotal(event));
  }
  return [...sums.keys()].sort(compareWaves).map((wave) => ({ wave, total: sums.get(wave) }));
}

/**
 * `total` is the sum of explicit `usage.total` (numerically equal to the old jq
 * snippet, missing -> 0). `inferredTotal` is `totalUsage`'s figure, which also
 * infers input + output for an event without an explicit total, so it can be
 * larger; Step 5 reads `total` and treats the gap as informational.
 */
function featureCost(history) {
  const attempts = history.filter((e) => e.type === WAVE_ATTEMPT);
  const withUsage = attempts.filter(hasUsage).length;
  const perWave = perWaveTotals(history);
  return {
    total: perWave.reduce((sum, w) => sum + w.total, 0),
    inferredTotal: totalUsage(history).total,
    attempts: attempts.length,
    usageRecorded: withUsage,
    usageUnknown: withUsage === 0,
    perWave,
  };
}

/** @returns {Object} noData (no event logs at all) and `perFeature` cost, keyed by feature. */
export function buildTokenCost(stateDir) {
  const perFeature = {};
  for (const feature of listFeatures(stateDir)) {
    perFeature[feature] = featureCost(readHistory(stateDir, feature));
  }
  return { noData: Object.keys(perFeature).length === 0, perFeature };
}

/** The section text: pretty-printed JSON. */
export function formatTokenCost(result) {
  return JSON.stringify(result, null, JSON_INDENT);
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  console.log(formatTokenCost(buildTokenCost(process.env.RAD_STATE_DIR || DEFAULT_STATE_DIR)));
}
