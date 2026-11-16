/**
 * /rad-insights Step 4e — blocked-task → file attribution over the per-feature
 * event logs. Read-side only: the counting lives in the pure folds exported by
 * `harness/events.js` and the plan-doc parsing in `harness/plan-tasks.js`; this
 * module only joins them. Run directly (`node harness/insights-blocked-files.js`)
 * it prints the section as JSON, honoring `RAD_STATE_DIR` (default
 * `.agents/state`) and `RAD_PLANS_DIR` (default `.agents/plans`).
 */
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileFailureCounts, fileDeficitSignals } from './events.js';
import { taskFilesFromPlanText, mergeTaskFiles } from './plan-tasks.js';
import { DEFAULT_STATE_DIR, listFeatures, readHistory } from './insights-state.js';

const DEFAULT_PLANS_DIR = join('.agents', 'plans');
const PLAN_EXTENSION = '.md';
const JSON_INDENT = 2;

/** Title → paths mapping merged across every plan doc (sorted by file name). */
export function taskFilesFromPlansDir(plansDir) {
  const taskFiles = {};
  if (!existsSync(plansDir)) return taskFiles;
  const plans = readdirSync(plansDir).filter((f) => f.endsWith(PLAN_EXTENSION)).sort();
  for (const plan of plans) {
    mergeTaskFiles(taskFiles, taskFilesFromPlanText(readFileSync(join(plansDir, plan), 'utf8')));
  }
  return taskFiles;
}

/** One history across all features; feature is stamped from the dir only where an event omits it. */
export function combinedHistory(stateDir) {
  return listFeatures(stateDir).flatMap((feature) =>
    readHistory(stateDir, feature).map((e) => ({ ...e, feature: e.feature || feature })));
}

/** @returns {Object} mappedTitles, reportedFiles, the file-failure fold and `deficits`. */
export function buildBlockedFiles(history, taskFiles) {
  const result = fileFailureCounts(history, taskFiles);
  const deficits = fileDeficitSignals(history, taskFiles);
  const mappedTitles = Object.keys(taskFiles).length;
  const reportedFiles = Object.keys(result.files).length;
  return { mappedTitles, reportedFiles, ...result, deficits };
}

/** The section text: pretty-printed JSON, exactly as the inline snippet printed it. */
export function formatBlockedFiles(result) {
  return JSON.stringify(result, null, JSON_INDENT);
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const stateDir = process.env.RAD_STATE_DIR || DEFAULT_STATE_DIR;
  const plansDir = process.env.RAD_PLANS_DIR || DEFAULT_PLANS_DIR;
  console.log(formatBlockedFiles(buildBlockedFiles(combinedHistory(stateDir), taskFilesFromPlansDir(plansDir))));
}
