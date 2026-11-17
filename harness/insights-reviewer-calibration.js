/**
 * /rad-insights Step 3c — reviewer calibration. Read-side only: the verdict
 * classification and rate math live in `reviewerCalibration` (`harness/findings.js`);
 * this module only reads the findings file and shapes the result. Run directly
 * (`node harness/insights-reviewer-calibration.js`) it prints the JSON, honoring
 * `RAD_FINDINGS_FILE` (default `.agents/findings.jsonl`). A malformed line is
 * reported on stderr with file:line and skipped — never silently.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewerCalibration } from './findings.js';

const DEFAULT_FINDINGS_FILE = join('.agents', 'findings.jsonl');
const JSON_INDENT = 2;

/** Parsed records; each failing line goes to `onSkip(file, lineNumber, message)`. Blank lines are ignored. */
function readRecords(findingsFile, onSkip) {
  const records = [];
  readFileSync(findingsFile, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      onSkip(findingsFile, i + 1, err.message);
    }
  });
  return records;
}

/** @returns `{ findingsLog: false }` for a missing file, else `{ findingsLog: true, ...reviewerCalibration }`. */
export function buildReviewerCalibration({ findingsFile, onSkip }) {
  if (!existsSync(findingsFile)) return { findingsLog: false };
  return { findingsLog: true, ...reviewerCalibration(readRecords(findingsFile, onSkip)) };
}

export function formatReviewerCalibration(result) {
  return JSON.stringify(result, null, JSON_INDENT);
}

const reportSkip = (file, line, message) => console.error(`skipping malformed JSON at ${file}:${line}: ${message}`);

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const findingsFile = process.env.RAD_FINDINGS_FILE || DEFAULT_FINDINGS_FILE;
  console.log(formatReviewerCalibration(buildReviewerCalibration({ findingsFile, onSkip: reportSkip })));
}
