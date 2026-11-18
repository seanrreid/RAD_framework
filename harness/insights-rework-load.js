/**
 * /rad-insights Step 4i — post-merge rework rate and Gate-2 verification load per
 * delivered feature. Read-side only: git history comes from `readDeliveryHistory`
 * and the counting lives in the pure folds of `harness/delivery-metrics.js`; this
 * module only reads the event logs and shapes the result. Run directly
 * (`DEFAULT_BRANCH=<branch> node harness/insights-rework-load.js`) it prints the
 * section as JSON, honoring `RAD_STATE_DIR` (default `.agents/state`) and
 * `RAD_REWORK_WINDOW_DAYS`. The clock is a function argument, never an env var.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readDeliveryHistory } from './delivery-history.js';
import { verificationLoad, reworkRate, trend, resolveWindowDays } from './delivery-metrics.js';
import { DEFAULT_STATE_DIR, readHistories } from './insights-state.js';

const JSON_INDENT = 2;
const DEFAULT_BRANCH_ENV = 'DEFAULT_BRANCH';

function buildTrends(load, rework) {
  const merged = load.filter((r) => r.merged);
  return {
    reworkRate: trend(rework.filter((r) => r.windowComplete).map((r) => r.rate)),
    prSize: trend(merged.map((r) => r.linesChanged)),
    reviewLatency: trend(merged.map((r) => r.openedToMergeMs)),
  };
}

/**
 * @param {{ stateDir: string, root: string, defaultBranch: string,
 *   env: Object<string, string|undefined>, now: number }} opts - `now` in epoch ms
 * @returns {{noMerges: boolean, windowDays: number, unresolved: number, load: Object[],
 *   rework: Object[], trends: Object}} key order is part of the contract.
 */
export function buildReworkLoad({ stateDir, root, defaultBranch, env, now }) {
  if (!defaultBranch) throw new Error(`rework/load: ${DEFAULT_BRANCH_ENV} is not set`);
  const histories = readHistories(stateDir);
  const { merges, commits, unresolved } = readDeliveryHistory({ root, defaultBranch });
  const windowDays = resolveWindowDays(env);
  const load = verificationLoad(merges, histories);
  const rework = reworkRate(merges, commits, { windowDays, now });
  return { noMerges: merges.length === 0, windowDays, unresolved, load, rework, trends: buildTrends(load, rework) };
}

/** The section text: the result as indented JSON. */
export function formatReworkLoad(result) {
  return JSON.stringify(result, null, JSON_INDENT);
}

function main() {
  const result = buildReworkLoad({
    stateDir: process.env.RAD_STATE_DIR || DEFAULT_STATE_DIR,
    root: process.cwd(),
    defaultBranch: process.env[DEFAULT_BRANCH_ENV],
    env: process.env,
    now: Date.now(),
  });
  console.log(formatReworkLoad(result));
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
