/**
 * /rad-insights Step 4f2 — per-attempt cache-hit ratios (cache-hit readout) over
 * the per-feature event logs. Read-side only: the counting lives in the pure fold
 * `cacheUsage` exported by `harness/events.js`; this module only shapes it for
 * presentation. Run directly (`node harness/insights-cache-hit.js`) it prints the
 * section, honoring `RAD_STATE_DIR` (default `.agents/state`).
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cacheUsage } from './events.js';
import { DEFAULT_STATE_DIR, readAllHistory } from './insights-state.js';

const JSON_INDENT = 2;
const PERCENT = 100;
export const NO_CACHE_LINE = 'no cache data reported';

const pct = (r) => (r === null ? null : Math.round(PERCENT * r));

// Flag a retry whose ratio is 0 after an EARLIER positive attempt in the same (feature, wave).
function findDroppedToZero(attempts) {
  const peak = new Map();
  const dropped = [];
  for (const a of attempts) {
    const key = JSON.stringify([a.feature, a.wave]);
    const earlier = peak.get(key) || 0;
    if (a.ratio === 0 && earlier > 0) dropped.push({ ...a, earlierPeakPct: pct(earlier) });
    if (a.ratio !== null && a.ratio > earlier) peak.set(key, a.ratio);
  }
  return dropped;
}

/** @returns {Object} noCacheData, withoutCache, overallRatioPct, totals, attempts and droppedToZero. */
export function buildCacheHit(stateDir) {
  // Attempts are ordered and keyed by (feature, wave), so one concatenated history is safe.
  const result = cacheUsage(readAllHistory(stateDir));
  const denominator = result.totals.input + result.totals.cacheRead;
  return {
    noCacheData: result.attempts.length === 0,
    withoutCache: result.withoutCache,
    overallRatioPct: denominator === 0 ? null : pct(result.totals.cacheRead / denominator),
    totals: result.totals,
    attempts: result.attempts.map((a) => ({ ...a, ratioPct: pct(a.ratio) })),
    droppedToZero: findDroppedToZero(result.attempts),
  };
}

/** The section text: the plain-text degradation line (only when no cache data), then the JSON. */
export function formatCacheHit(result) {
  const json = JSON.stringify(result, null, JSON_INDENT);
  return result.noCacheData ? `${NO_CACHE_LINE}\n${json}` : json;
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  console.log(formatCacheHit(buildCacheHit(process.env.RAD_STATE_DIR || DEFAULT_STATE_DIR)));
}
