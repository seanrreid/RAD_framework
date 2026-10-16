#!/usr/bin/env node
// claude-usage.mjs — run `claude -p --output-format json [args]` and re-emit its
// answer as plain text, preceded by one `RAD_USAGE {json}` line so the command
// adapter can record token usage. Prompt arrives on stdin; extra arguments are
// forwarded to the CLI. Self-contained: installed into consumer projects, so it
// imports nothing from harness/ or scripts/vendor/.
//
// Usage: command: node scripts/claude-usage.mjs [claude args...]

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CLAUDE_BIN = 'claude';
const BASE_ARGS = ['-p', '--output-format', 'json'];
const PERMISSION_MODE_FLAG = '--permission-mode';
/** Matches the SDK adapter: edits are auto-approved, shell commands are not. */
const DEFAULT_PERMISSION_MODE = 'acceptEdits';
const RESULT_TYPE = 'result';
const USAGE_PREFIX = 'RAD_USAGE ';
const DENIALS_PREFIX = 'RAD_DENIALS ';
/** Most denials the RAD_DENIALS line carries; the rest are dropped. */
const MAX_DENIALS = 10;
/** Cap on each denied tool name or path (agent-influenced strings). */
const MAX_DENIAL_FIELD_CHARS = 200;
// eslint-disable-next-line no-control-regex -- control chars are exactly what is stripped
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
/** Largest CLI output the wrapper will buffer (the prompt may be large; answers rarely are). */
const MAX_BUFFER_BYTES = 512 * 1024 * 1024;
/** Exit status when the CLI could not be spawned or died without a status. */
const FAILURE_EXIT = 1;
/** The token fields summed into `total`, in the order they appear in the line. */
const TOKEN_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
];

function isUsableNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * The usage object for the RAD_USAGE line, or null when no token field is usable.
 * Unusable fields are omitted; `total` is the sum of the usable token fields.
 */
export function buildUsage(parsed) {
  const raw = parsed?.usage;
  const usage = {};
  let total = 0;
  for (const key of TOKEN_FIELDS) {
    if (!isUsableNumber(raw?.[key])) continue;
    usage[key] = raw[key];
    total += raw[key];
  }
  if (Object.keys(usage).length === 0) return null;
  usage.total = total;
  if (isUsableNumber(parsed.total_cost_usd)) usage.cost = parsed.total_cost_usd;
  return usage;
}

/** A string with control characters (newlines included) replaced, capped; else undefined. */
function cleanDenialField(v) {
  if (typeof v !== 'string') return undefined;
  const cleaned = v.replace(CONTROL_CHARS, ' ').trim().slice(0, MAX_DENIAL_FIELD_CHARS);
  return cleaned === '' ? undefined : cleaned;
}

/** One `{tool, path}` entry from a CLI permission denial, or null when it names neither. */
function denialEntry(denial) {
  const input = denial?.tool_input;
  const path = cleanDenialField(input?.file_path) ?? cleanDenialField(input?.path) ?? cleanDenialField(input?.command);
  const tool = cleanDenialField(denial?.tool_name);
  if (!tool && !path) return null;
  const entry = {};
  if (tool) entry.tool = tool;
  if (path) entry.path = path;
  return entry;
}

/**
 * The entries for the RAD_DENIALS line (at most MAX_DENIALS), or null when
 * `permission_denials` is absent, not an array, or yields no usable entry.
 */
export function buildDenials(parsed) {
  const raw = parsed?.permission_denials;
  if (!Array.isArray(raw)) return null;
  const entries = [];
  for (const denial of raw) {
    const entry = denialEntry(denial);
    if (entry) entries.push(entry);
    if (entries.length === MAX_DENIALS) break;
  }
  return entries.length > 0 ? entries : null;
}

/**
 * Parse the CLI's stdout. Returns the parsed result object when it is a JSON
 * object of type `result` with a string `result`, otherwise null (pass through).
 */
export function parseCliResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Not JSON: the caller passes the raw output through untouched.
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.type !== RESULT_TYPE || typeof parsed.result !== 'string') return null;
  return parsed;
}

/**
 * The wrapper's stdout: the usage line FIRST (the adapter takes the first
 * RAD_USAGE line, so agent text after it cannot spoof usage), then the
 * RAD_DENIALS line when the CLI refused any tool call (same first-line rule),
 * then the text.
 */
export function renderOutput(parsed) {
  const usage = buildUsage(parsed);
  const denials = buildDenials(parsed);
  const usageLine = usage ? `${USAGE_PREFIX}${JSON.stringify(usage)}\n` : '';
  const denialsLine = denials ? `${DENIALS_PREFIX}${JSON.stringify(denials)}\n` : '';
  const head = usageLine + denialsLine;
  const text = parsed.result;
  return head + text + (text.endsWith('\n') ? '' : '\n');
}

/** The default permission-mode args, or none when the caller already chose a mode. */
export function defaultPermissionArgs(argv) {
  const callerSet = argv.some(
    (a) => a === PERMISSION_MODE_FLAG || a.startsWith(`${PERMISSION_MODE_FLAG}=`),
  );
  return callerSet ? [] : [PERMISSION_MODE_FLAG, DEFAULT_PERMISSION_MODE];
}

/** Run the CLI with the prompt on stdin; no shell, argument array only. */
function runCli(args, prompt) {
  return spawnSync(CLAUDE_BIN, [...BASE_ARGS, ...defaultPermissionArgs(args), ...args], {
    input: prompt,
    maxBuffer: MAX_BUFFER_BYTES,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Spawn failure or signal death: no usable output, say why on stderr. */
function reportNoStatus(run) {
  const why = run.error
    ? `could not run ${CLAUDE_BIN}: ${run.error.message}`
    : `${CLAUDE_BIN} was killed by signal ${run.signal}`;
  process.stderr.write(`claude-usage: ${why}\n`);
  return FAILURE_EXIT;
}

/** Convert or pass through the CLI output; returns the exit status. */
function emit(run) {
  const parsed = parseCliResult(run.stdout.toString('utf8'));
  if (run.stderr.length > 0) process.stderr.write(run.stderr);
  if (!parsed) {
    if (run.stdout.length > 0) process.stdout.write(run.stdout);
    return run.status;
  }
  process.stdout.write(renderOutput(parsed));
  return run.status === 0 && parsed.is_error === true ? FAILURE_EXIT : run.status;
}

export function main(argv) {
  const run = runCli(argv, readFileSync(0));
  if (run.error || run.status === null) return reportNoStatus(run);
  return emit(run);
}

function isEntryPoint() {
  return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url));
}

// Set exitCode rather than exit(): lets a large write to a pipe drain first.
if (isEntryPoint()) process.exitCode = main(process.argv.slice(2));
