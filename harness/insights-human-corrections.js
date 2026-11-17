/**
 * /rad-insights Step 4j — human corrections (re-approvals, resume answers,
 * confirmed review findings, post-deliver fix commits). Read-side only: the rows,
 * counts and text come from `harness/human-corrections.js`; this module only reads
 * the event logs and the findings file and shapes the result. Run directly
 * (`SINCE=YYYY-MM-DD node harness/insights-human-corrections.js`) it prints the
 * section text, honoring `SINCE` (empty = no filter), `RAD_STATE_DIR` (default
 * `.agents/state`) and `RAD_FINDINGS_FILE` (default `.agents/findings.jsonl`).
 * Run it from the repo root: post-deliver fixes are read with `git log` there.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEventLog, postDeliverFixRows, buildCorrections, formatCorrections } from './human-corrections.js';
import { DEFAULT_STATE_DIR, EVENT_LOG } from './insights-state.js';

const DEFAULT_FINDINGS_FILE = join('.agents', 'findings.jsonl');

/** Feature -> events for every feature dir holding an events.jsonl; throws on a bad line. */
function readHistories(stateDir) {
  const histories = {};
  if (!existsSync(stateDir)) return histories;
  for (const d of readdirSync(stateDir, { withFileTypes: true })) {
    const log = join(stateDir, d.name, EVENT_LOG);
    if (!d.isDirectory() || !existsSync(log)) continue;
    histories[d.name] = parseEventLog(readFileSync(log, 'utf8'), log);
  }
  return histories;
}

/** Findings records; a malformed line is reported on stderr with file:line and skipped. */
function readFindings(findingsFile) {
  const findings = [];
  if (!existsSync(findingsFile)) return findings;
  readFileSync(findingsFile, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      findings.push(JSON.parse(line));
    } catch (err) {
      console.error(`skipping malformed JSON at ${findingsFile}:${i + 1}: ${err.message}`);
    }
  });
  return findings;
}

/** @returns the `buildCorrections` result; `since` is applied by the fold. */
export function buildHumanCorrections({ stateDir, findingsFile, since, root = process.cwd() }) {
  const histories = readHistories(stateDir);
  const findings = readFindings(findingsFile);
  const postDeliver = {};
  for (const [feature, events] of Object.entries(histories)) {
    postDeliver[feature] = postDeliverFixRows(feature, events, { root });
  }
  return buildCorrections({ histories, findings, postDeliver, since });
}

/** The section text, printed as-is (not JSON). */
export function formatHumanCorrections(result) {
  return formatCorrections(result);
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  console.log(formatHumanCorrections(buildHumanCorrections({
    stateDir: process.env.RAD_STATE_DIR || DEFAULT_STATE_DIR,
    findingsFile: process.env.RAD_FINDINGS_FILE || DEFAULT_FINDINGS_FILE,
    since: process.env.SINCE || undefined,
  })));
}
