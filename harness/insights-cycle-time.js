/**
 * /rad-insights Step 4h — cycle time, human touches and tokens per delivered
 * feature over the per-feature event logs. Read-side only: the counting lives in
 * the pure folds exported by `harness/cycle-metrics.js`; this module only reads
 * the logs and shapes the result. Run directly (`node harness/insights-cycle-time.js`)
 * it prints the section as JSON, honoring `RAD_STATE_DIR` (default `.agents/state`).
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stageDurations, humanTouches, tokensPerDeliveredFeature } from './cycle-metrics.js';
import { DEFAULT_STATE_DIR, listFeatures, readHistory } from './insights-state.js';

const JSON_INDENT = 2;

/** @returns {{noEventLogs: boolean, perFeature: Object, tokens: Object}} key order is part of the contract. */
export function buildCycleTime(stateDir) {
  const features = listFeatures(stateDir);
  const histories = {};
  const perFeature = {};
  for (const feature of features) {
    histories[feature] = readHistory(stateDir, feature);
    perFeature[feature] = {
      durations: stageDurations(histories[feature]),
      touches: humanTouches(histories[feature]),
    };
  }
  return { noEventLogs: features.length === 0, perFeature, tokens: tokensPerDeliveredFeature(histories) };
}

/** The section text: the result as indented JSON. */
export function formatCycleTime(result) {
  return JSON.stringify(result, null, JSON_INDENT);
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  console.log(formatCycleTime(buildCycleTime(process.env.RAD_STATE_DIR || DEFAULT_STATE_DIR)));
}
