/**
 * /rad-insights Step 4f4 — spend by provider over the per-feature event logs.
 * Read-side only: the counting lives in the pure fold `providerSpend` exported by
 * `harness/events.js`; this module only shapes it for presentation. Run directly
 * (`node harness/insights-provider-spend.js`) it prints the section as JSON,
 * honoring `RAD_STATE_DIR` (default `.agents/state`).
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { providerSpend } from './events.js';
import { DEFAULT_STATE_DIR, readAllHistory } from './insights-state.js';

const JSON_INDENT = 2;
const PERCENT = 100;

const pct = (n, d) => (d === 0 ? 0 : Math.round((PERCENT * n) / d));

/** @returns {Object} groups (keyed by adapter/model, each with passPct) and features. */
export function buildProviderSpend(stateDir) {
  // Groups key on the attempt tag, not on (feature, wave), so one concatenated history is safe.
  const stats = providerSpend(readAllHistory(stateDir));
  const groups = Object.fromEntries(
    Object.entries(stats.groups).map(([key, g]) => [key, { ...g, passPct: pct(g.passed, g.attempts) }]),
  );
  return { groups, features: stats.features };
}

/** The section text: pretty-printed JSON, exactly as the inline snippet printed it. */
export function formatProviderSpend(result) {
  return JSON.stringify(result, null, JSON_INDENT);
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  console.log(formatProviderSpend(buildProviderSpend(process.env.RAD_STATE_DIR || DEFAULT_STATE_DIR)));
}
