/**
 * /rad-insights Step 4g — route recurring failure signals to the prompt surface
 * that shaped them. Read-side only: the counting lives in the pure folds exported
 * by `harness/events.js` (`attemptOutcomeCounts`, `failReasonCounts`,
 * `blockedReasonCounts`); this module only compares them with the threshold and
 * looks up `PROMPT_SURFACE_MAP`. Run directly (`node harness/insights-prompt-surfaces.js`)
 * it prints the section as JSON, honoring `RAD_STATE_DIR` (default `.agents/state`).
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attemptOutcomeCounts, failReasonCounts, blockedReasonCounts } from './events.js';
import { DEFAULT_STATE_DIR, readHistories } from './insights-state.js';

const JSON_INDENT = 2;

// Minimum aggregate count before a signal renders a proposal. Below it, a
// signal describes one bad wave, not an instruction that keeps misleading.
export const PROMPT_SIGNAL_THRESHOLD = 3;

const RETURN_FORMAT_SURFACE = {
  target: 'harness/adapters/agent/contract.js',
  section: 'buildWavePrompt "## Return format" block (prose mirror: .claude/commands/team/rad-deliver.md "## Return format")',
  note: 'Preserve the #112 prefix-ordering constraint: order the template so a retry extends a prefix instead of rewriting one.',
};
const PLAN_SCOPE_SURFACE = {
  target: '.claude/commands/team/rad-plan.md',
  section: 'Step 3 plan template, "## Files in Scope" guidance comment',
  note: null,
};
const TASK_TEMPLATE_SURFACE = {
  target: '.claude/commands/team/rad-plan.md',
  section: 'Step 3 task template (What:/Validate:) and "Wave rules"',
  note: null,
};

/** THE mapping table: signal -> the prompt surface that shaped it. To route a new signal, add a row. */
export const PROMPT_SURFACE_MAP = {
  'outcome:fail-protocol': RETURN_FORMAT_SURFACE,
  'outcome:fail-scope': PLAN_SCOPE_SURFACE,
  'blocked:blocked_spec': TASK_TEMPLATE_SURFACE,
  'blocked:blocked_intent': TASK_TEMPLATE_SURFACE,
};

// Outcome keys that are not failure signals.
const NON_SIGNAL_OUTCOMES = new Set(['success', 'unknown', 'total']);
const BLOCKED_KEYS = ['blocked_code', 'blocked_spec', 'blocked_intent'];

/** signal -> { count, features: { feature: n } }; non-positive counts are ignored. */
function addSignal(signals, signal, feature, n) {
  if (n <= 0) return;
  const s = signals[signal] || (signals[signal] = { count: 0, features: {} });
  s.count += n;
  s.features[feature] = (s.features[feature] || 0) + n;
}

/** Fold one feature's history into `signals`; returns its wave-event and enriched-attempt counts. */
function foldFeature(signals, feature, history) {
  const attempts = attemptOutcomeCounts(history);
  const failReasons = failReasonCounts(history);
  const blocked = blockedReasonCounts(history);
  // Attribute each outcome to the features the fold saw record it (the event
  // `feature` field); fall back to the state-dir name if none was recorded.
  for (const [k, n] of Object.entries(attempts.counts)) {
    if (NON_SIGNAL_OUTCOMES.has(k)) continue;
    const named = attempts.features[k] || [];
    addSignal(signals, `outcome:${k}`, named.length === 1 ? named[0] : feature, n);
  }
  for (const [r, n] of Object.entries(failReasons.reasons)) addSignal(signals, `wave-failed:${r}`, feature, n);
  for (const k of BLOCKED_KEYS) addSignal(signals, `blocked:${k}`, feature, blocked[k]);
  return { waveEvents: attempts.counts.total + failReasons.total, enrichedAttempts: blocked.enrichedAttempts };
}

/**
 * @param {Object<string, Object[]>} histories feature name -> parsed event history
 * @returns {Object} threshold, the two degradation flags, `proposals` (mapped) and `unmapped` signals.
 */
export function buildPromptSurfaces(histories) {
  const signals = {};
  let waveEvents = 0;
  let enrichedAttempts = 0;
  for (const [feature, history] of Object.entries(histories)) {
    const folded = foldFeature(signals, feature, history);
    waveEvents += folded.waveEvents;
    enrichedAttempts += folded.enrichedAttempts;
  }
  const crossing = Object.entries(signals)
    .filter(([, s]) => s.count >= PROMPT_SIGNAL_THRESHOLD)
    .sort(([a, x], [b, y]) => y.count - x.count || a.localeCompare(b));
  const proposals = crossing.filter(([sig]) => PROMPT_SURFACE_MAP[sig])
    .map(([signal, s]) => ({ signal, ...s, ...PROMPT_SURFACE_MAP[signal] }));
  const unmapped = crossing.filter(([sig]) => !PROMPT_SURFACE_MAP[sig])
    .map(([signal, s]) => ({ signal, ...s }));
  return {
    threshold: PROMPT_SIGNAL_THRESHOLD,
    noWaveData: waveEvents === 0,
    noEnrichedData: enrichedAttempts === 0,
    proposals,
    unmapped,
  };
}

/** The section text: pretty-printed JSON, exactly as the inline snippet printed it. */
export function formatPromptSurfaces(result) {
  return JSON.stringify(result, null, JSON_INDENT);
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const stateDir = process.env.RAD_STATE_DIR || DEFAULT_STATE_DIR;
  console.log(formatPromptSurfaces(buildPromptSurfaces(readHistories(stateDir))));
}
