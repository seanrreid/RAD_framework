/**
 * /rad-insights Step 4f3 — spend by model over the per-feature event logs.
 * Read-side only: the counting lives in the pure folds `modelTierSpend` and
 * `modelTierAdvisories` exported by `harness/events.js`; this module only shapes
 * them for presentation. Run directly (`node harness/insights-model-spend.js`)
 * it prints the section as JSON, honoring `RAD_STATE_DIR` (default `.agents/state`).
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { modelTierSpend, modelTierAdvisories } from './events.js';
import { DEFAULT_STATE_DIR, readAllHistory } from './insights-state.js';
import { TIERING_MIN_FEATURES } from './insights-wave-tiering.js';

const JSON_INDENT = 2;
const PERCENT = 100;

const pct = (n, d) => (d === 0 ? 0 : Math.round((PERCENT * n) / d));

// meanTokens is over known-usage waves only; null (render `unknown`) when none.
function toGroup(g) {
  const known = g.waves - g.unknownUsage;
  return {
    ...g,
    firstAttemptSuccessPct: pct(g.firstAttemptSuccess, g.waves),
    retriedPct: pct(g.retried, g.waves),
    meanTokens: known > 0 ? Math.round(g.tokens / known) : null,
  };
}

/** @returns {Object} groups (keyed by model), features, advisories and minFeatures. */
export function buildModelSpend(stateDir) {
  // Waves are joined on (feature, wave), so one concatenated history is safe.
  const stats = modelTierSpend(readAllHistory(stateDir));
  const advisories = modelTierAdvisories(stats, { minFeatures: TIERING_MIN_FEATURES });
  const groups = Object.fromEntries(
    Object.entries(stats.groups).map(([model, g]) => [model, toGroup(g)]),
  );
  return { groups, features: stats.features, advisories, minFeatures: TIERING_MIN_FEATURES };
}

/** The section text: pretty-printed JSON, exactly as the inline snippet printed it. */
export function formatModelSpend(result) {
  return JSON.stringify(result, null, JSON_INDENT);
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  console.log(formatModelSpend(buildModelSpend(process.env.RAD_STATE_DIR || DEFAULT_STATE_DIR)));
}
