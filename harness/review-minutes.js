/**
 * Review minutes per merged ticket — compares the human review time RAD-delivered
 * tickets cost against unmanaged-agent tickets. The event logs hold no active review
 * time (only wall-clock open→merge), so this is a self-timed ledger: `log` appends
 * one row per ticket you reviewed, `report` compares the two arms.
 *
 *   node harness/review-minutes.js log --ref <id> --arm rad|unmanaged --minutes <n>
 *        [--lines <n>] [--rounds <n>] [--note <text>]
 *   node harness/review-minutes.js report
 *
 * `RAD_REVIEW_MINUTES_FILE` (default `.agents/review-minutes.jsonl`) overrides the
 * ledger path. Read-only except for the one appended row; never touches other logs.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const ARMS = ['rad', 'unmanaged'];
/** Below this many tickets per arm a median is noise — report "insufficient", never a number. */
export const MIN_PER_ARM = 5;
const DEFAULT_LEDGER = join('.agents', 'review-minutes.jsonl');
const LINES_PER_UNIT = 100;
const EXIT_USAGE = 2;
const CAVEAT = 'Self-timed, small n, tickets differ in size — a signal, not proof.';

function positiveNumber(value, name) {
  const n = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(n) || n <= 0) {
    throw new Error(`--${name} must be a positive number, got: ${value}`);
  }
  return n;
}

function optionalCount(value, name) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value === '' || !Number.isInteger(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative integer, got: ${value}`);
  }
  return n;
}

/** Validates CLI input into a ledger row; throws with the reason on any bad field. */
export function buildEntry(input, date = new Date().toISOString().slice(0, 10)) {
  const ref = typeof input.ref === 'string' ? input.ref.trim() : '';
  if (!ref) throw new Error('--ref is required (PR number, ticket id or short label)');
  if (!ARMS.includes(input.arm)) throw new Error(`--arm must be one of ${ARMS.join(', ')}, got: ${input.arm}`);
  const entry = { date, ref, arm: input.arm, minutes: positiveNumber(input.minutes, 'minutes') };
  const lines = optionalCount(input.lines, 'lines');
  const rounds = optionalCount(input.rounds, 'rounds');
  if (lines !== undefined) entry.lines = lines;
  if (rounds !== undefined) entry.rounds = rounds;
  if (typeof input.note === 'string' && input.note.trim()) entry.note = input.note.trim();
  return entry;
}

/** Why a parsed ledger row is unusable, or null when it is a valid row. */
function rowProblem(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return 'not a JSON object';
  if (!ARMS.includes(row.arm)) return `unknown arm: ${row.arm}`;
  if (!Number.isFinite(row.minutes) || row.minutes <= 0) return `minutes must be a positive number: ${row.minutes}`;
  return null;
}

/** Valid rows; every unusable line goes to `onSkip(file, lineNumber, reason)`. Blank lines are ignored. */
export function readLedger(file, onSkip) {
  if (!existsSync(file)) return [];
  const rows = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const row = JSON.parse(line);
      const problem = rowProblem(row);
      if (problem) onSkip(file, i + 1, problem);
      else rows.push(row);
    } catch (err) {
      onSkip(file, i + 1, err.message);
    }
  });
  return rows;
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;

/** Per-arm stats; every statistic is null until the arm has MIN_PER_ARM tickets. */
export function summarizeArm(rows) {
  const n = rows.length;
  const enough = n >= MIN_PER_ARM;
  const sized = rows.filter((r) => Number.isFinite(r.lines) && r.lines > 0);
  const rounds = rows.map((r) => r.rounds).filter(Number.isFinite);
  return {
    n,
    enough,
    medianMinutes: enough ? median(rows.map((r) => r.minutes)) : null,
    meanMinutes: enough ? mean(rows.map((r) => r.minutes)) : null,
    medianMinutesPer100Lines: enough && sized.length ? median(sized.map((r) => (r.minutes / r.lines) * LINES_PER_UNIT)) : null,
    sizedN: sized.length,
    medianRounds: enough && rounds.length ? median(rounds) : null,
  };
}

export function buildReport(rows) {
  const arms = Object.fromEntries(ARMS.map((arm) => [arm, summarizeArm(rows.filter((r) => r.arm === arm))]));
  const bothEnough = arms.rad.enough && arms.unmanaged.enough;
  return { arms, medianRatio: bothEnough ? arms.rad.medianMinutes / arms.unmanaged.medianMinutes : null };
}

const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

function armLine(arm, s) {
  if (!s.enough) return `${arm.padEnd(10)} n=${s.n}  insufficient (need ${MIN_PER_ARM})`;
  const parts = [`median ${fmt(s.medianMinutes)} min`, `mean ${fmt(s.meanMinutes)} min`];
  if (s.medianMinutesPer100Lines !== null) parts.push(`${fmt(s.medianMinutesPer100Lines)} min/100 lines (n=${s.sizedN})`);
  if (s.medianRounds !== null) parts.push(`median ${fmt(s.medianRounds)} round(s)`);
  return `${arm.padEnd(10)} n=${s.n}  ${parts.join(', ')}`;
}

function comparisonLine(ratio) {
  if (ratio === null) return 'Comparison: not enough tickets in both arms yet.';
  const pct = Math.round(Math.abs(1 - ratio) * 100);
  if (pct === 0) return 'Comparison: RAD median review time equals unmanaged.';
  return `Comparison: RAD median review time is ${pct}% ${ratio < 1 ? 'lower' : 'higher'} than unmanaged.`;
}

export function formatReport(report, file) {
  const lines = [`Review minutes per merged ticket (ledger: ${file})`];
  for (const arm of ARMS) lines.push(armLine(arm, report.arms[arm]));
  lines.push(comparisonLine(report.medianRatio), CAVEAT);
  return lines.join('\n');
}

function runLog(argv, file) {
  const { values } = parseArgs({
    args: argv,
    options: { ref: { type: 'string' }, arm: { type: 'string' }, minutes: { type: 'string' },
      lines: { type: 'string' }, rounds: { type: 'string' }, note: { type: 'string' } },
  });
  const entry = buildEntry(values);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return `logged: ${JSON.stringify(entry)}`;
}

const reportSkip = (file, line, reason) => console.error(`skipping bad ledger row at ${file}:${line}: ${reason}`);

/** Dispatches a subcommand; returns the text to print. Throws on bad usage or input. */
export function main(argv, file) {
  const [command, ...rest] = argv;
  if (command === 'log') return runLog(rest, file);
  if (command === 'report') return formatReport(buildReport(readLedger(file, reportSkip)), file);
  throw new Error('usage: review-minutes.js log --ref <id> --arm rad|unmanaged --minutes <n> [--lines n] [--rounds n] [--note t] | report');
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    console.log(main(process.argv.slice(2), process.env.RAD_REVIEW_MINUTES_FILE || DEFAULT_LEDGER));
  } catch (err) {
    console.error(err.message);
    process.exit(EXIT_USAGE);
  }
}
