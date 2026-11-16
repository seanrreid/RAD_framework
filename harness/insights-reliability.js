/**
 * /rad-insights Step 4c — wave-reliability fold over the per-feature event
 * logs. Read-side only: the counting lives in the pure folds exported by
 * `harness/events.js`; this module only aggregates them across features and
 * adds per-wave token spend. Run directly (`node harness/insights-reliability.js`)
 * it prints the section as JSON, honoring `RAD_STATE_DIR` (default
 * `.agents/state`).
 */
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outcomeCounts, failReasonCounts, retryCounts, hookVetoCounts, totalUsage } from './events.js';

const DEFAULT_STATE_DIR = join('.agents', 'state');
const EVENT_LOG = 'events.jsonl';
const WAVE_ATTEMPT = 'wave-attempt';
const UNKNOWN_WAVE = '?';
const JSON_INDENT = 2;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Sorted names of the feature dirs under `stateDir` that hold an events.jsonl. */
export function listFeatures(stateDir) {
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((f) => existsSync(join(stateDir, f, EVENT_LOG)))
    .sort();
}

/** Parse one feature's events.jsonl; a malformed line throws (fail-closed). */
export function readHistory(stateDir, feature) {
  return readFileSync(join(stateDir, feature, EVENT_LOG), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Token spend of one wave-attempt usage block; missing or malformed -> 0. */
function attemptSpend(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  return Number.isFinite(usage.total) ? usage.total : num(usage.input) + num(usage.output);
}

/** Per-wave token spend from wave-attempt `data.usage` (missing usage -> 0). */
export function spendPerWave(history) {
  const spend = {};
  for (const e of history) {
    if (!e || e.type !== WAVE_ATTEMPT || !e.data) continue;
    const wave = typeof e.data.wave === 'number' && Number.isFinite(e.data.wave) ? String(e.data.wave) : UNKNOWN_WAVE;
    spend[wave] = (spend[wave] || 0) + attemptSpend(e.data.usage);
  }
  return spend;
}

/** All reliability folds for one feature's parsed history. */
function featureReliability(history) {
  return {
    outcomes: outcomeCounts(history),
    failReasons: failReasonCounts(history),
    retries: retryCounts(history),
    hookVetoes: hookVetoCounts(history),
    usage: totalUsage(history),
    spendPerWave: spendPerWave(history),
  };
}

function emptyAggregate() {
  return {
    outcomes: outcomeCounts([]),
    failReasons: failReasonCounts([]),
    retries: { total: 0, retriedWaves: 0 },
    hookVetoes: hookVetoCounts([]),
    usage: totalUsage([]),
  };
}

/** Add one feature's folds into the running aggregate (mutates `agg`). */
function accumulate(agg, f) {
  for (const k of Object.keys(agg.outcomes)) agg.outcomes[k] += f.outcomes[k];
  agg.failReasons.total += f.failReasons.total;
  for (const [r, n] of Object.entries(f.failReasons.reasons)) {
    agg.failReasons.reasons[r] = (agg.failReasons.reasons[r] || 0) + n;
  }
  agg.retries.total += f.retries.total;
  agg.retries.retriedWaves += f.retries.retriedWaves;
  agg.hookVetoes.vetoes += f.hookVetoes.vetoes;
  agg.hookVetoes.vetoedAttempts += f.hookVetoes.vetoedAttempts;
  agg.usage.input += f.usage.input;
  agg.usage.output += f.usage.output;
  agg.usage.total += f.usage.total;
}

const hasNoWaveData = (a) => a.outcomes.total === 0 && a.retries.total === 0 &&
  a.failReasons.total === 0 && a.hookVetoes.vetoes === 0 && a.hookVetoes.vetoedAttempts === 0;

/**
 * @param {Array<{feature: string, history: Object[]}>} features - sorted by feature
 * @returns {{noWaveData: boolean, aggregate: Object, perFeature: Object}}
 */
export function buildReliability(features) {
  const aggregate = emptyAggregate();
  const perFeature = {};
  for (const { feature, history } of features) {
    perFeature[feature] = featureReliability(history);
    accumulate(aggregate, perFeature[feature]);
  }
  return { noWaveData: hasNoWaveData(aggregate), aggregate, perFeature };
}

/** The section text: pretty-printed JSON, exactly as the inline snippet printed it. */
export function formatReliability(result) {
  return JSON.stringify(result, null, JSON_INDENT);
}

/** Read every feature log under `stateDir` and build the section. */
export function reliabilityForStateDir(stateDir) {
  const features = listFeatures(stateDir).map((feature) => ({ feature, history: readHistory(stateDir, feature) }));
  return buildReliability(features);
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const stateDir = process.env.RAD_STATE_DIR || DEFAULT_STATE_DIR;
  console.log(formatReliability(reliabilityForStateDir(stateDir)));
}
