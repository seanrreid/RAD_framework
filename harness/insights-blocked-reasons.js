/**
 * /rad-insights Step 4d — per-task blocked reasons over the per-feature event
 * logs. Read-side only: the counting lives in the pure fold `blockedReasonCounts`
 * exported by `harness/events.js`; this module only aggregates it across
 * features. Run directly (`node harness/insights-blocked-reasons.js`) it prints
 * the section as JSON, honoring `RAD_STATE_DIR` (default `.agents/state`).
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { blockedReasonCounts } from './events.js';
import { DEFAULT_STATE_DIR, listFeatures, readHistory } from './insights-state.js';

const JSON_INDENT = 2;

/** @returns {Object} noEnrichedData, the cross-feature `aggregate` and `perFeature` counts. */
export function buildBlockedReasons(stateDir) {
  const aggregate = blockedReasonCounts([]);
  const perFeature = {};
  for (const feature of listFeatures(stateDir)) {
    const counts = blockedReasonCounts(readHistory(stateDir, feature));
    perFeature[feature] = counts;
    for (const key of Object.keys(aggregate)) aggregate[key] += counts[key];
  }
  return { noEnrichedData: aggregate.enrichedAttempts === 0, aggregate, perFeature };
}

/** The section text: pretty-printed JSON, exactly as the inline snippet printed it. */
export function formatBlockedReasons(result) {
  return JSON.stringify(result, null, JSON_INDENT);
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  console.log(formatBlockedReasons(buildBlockedReasons(process.env.RAD_STATE_DIR || DEFAULT_STATE_DIR)));
}
