/**
 * plan-commit.js — pure helpers behind `rad plan-open`: the plan's issue
 * number, its derived commit message, trailer validation, and the work branch.
 *
 * Also the approve/review commit messages and the header `Status:` rewrite
 * behind `rad approve` and `rad plan-status`.
 *
 * No I/O. The only ambient read is RAD_BRANCH_PREFIX in conventionWorkBranch,
 * and callers may pass their own env instead.
 */
import process from 'node:process';

/**
 * Default work-branch prefix. RAD_BRANCH_PREFIX (non-empty) overrides it, the
 * same convention scripts/checkout-plan.sh and git-sync.sh follow.
 */
export const DEFAULT_BRANCH_PREFIX = 'rad/';

/** Header-block terminator: the first level-2 heading. */
const SECTION_HEADING_PATTERN = /^## /;
/** A well-formed `Issue:` value — must agree with scripts/lint-plan.sh. */
const ISSUE_VALUE_PATTERN = /^[1-9][0-9]*$/;
/** GitHub `/issues/N` and GitLab `/-/issues/N` URLs (the latter contains the former). */
const ADOPTED_ISSUE_PATTERN = /\/issues\/(\d+)/;
const PLAN_TITLE_PATTERN = /^# Plan:\s*(.+)$/;
const WAVE_HEADING_PATTERN = /^### Wave\b/;
const TASK_HEADING_PATTERN = /^#### Task\b/;
const FENCE_PATTERN = /^\s*(```|~~~)/;
const OUT_OF_SCOPE_HEADING = '## Out-of-Scope Dependencies';
/** Body that means "no out-of-scope deps" once surrounding punctuation is stripped. */
const NONE_VALUE = 'none';
const EDGE_PUNCTUATION_PATTERN = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;
const TRAILER_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;
const UNKNOWN_AUTHOR = 'unknown';

/** True when a string is present and not whitespace-only. */
function isNonEmpty(s) {
  return typeof s === 'string' && s.trim() !== '';
}

/** The plan's header block: every line before the first `## ` heading. */
function headerLines(text) {
  const lines = text.split('\n');
  const end = lines.findIndex((l) => SECTION_HEADING_PATTERN.test(l));
  return end === -1 ? lines : lines.slice(0, end);
}

/**
 * The trimmed value of the first `<key>:` line in the header block, or null
 * when absent or empty (an empty value is treated as absent, as lint-plan.sh's
 * header_field does).
 */
function headerValue(text, key) {
  const prefix = `${key}:`;
  const line = headerLines(text).find((l) => l.startsWith(prefix));
  if (line === undefined) return null;
  const value = line.slice(prefix.length).trim();
  return value === '' ? null : value;
}

/**
 * The plan's issue number: the `Issue:` header when present (a malformed value
 * yields null — lint-plan.sh reports it), else the number in an `Adopted-From:`
 * issue URL, else null. Only the header block is read.
 *
 * @param {string} text - full plan doc text
 * @returns {number|null}
 */
export function planIssueNumber(text) {
  const issue = headerValue(text, 'Issue');
  if (issue !== null) return ISSUE_VALUE_PATTERN.test(issue) ? Number(issue) : null;
  const adopted = headerValue(text, 'Adopted-From');
  if (adopted === null) return null;
  const m = ADOPTED_ISSUE_PATTERN.exec(adopted);
  if (!m || !ISSUE_VALUE_PATTERN.test(m[1])) return null;
  return Number(m[1]);
}

/**
 * Count `### Wave` and `#### Task` headings, skipping fenced code blocks so an
 * example plan inside a fence never inflates the counts.
 *
 * @param {string} text - full plan doc text
 * @returns {{ waves: number, tasks: number }}
 */
export function countWavesTasks(text) {
  let waves = 0;
  let tasks = 0;
  let inFence = false;
  for (const line of text.split('\n')) {
    if (FENCE_PATTERN.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (WAVE_HEADING_PATTERN.test(line)) waves += 1;
    else if (TASK_HEADING_PATTERN.test(line)) tasks += 1;
  }
  return { waves, tasks };
}

/**
 * The first `# Plan: <heading>` value, or null when the plan has none. Unlike
 * planTitle it never throws on a missing heading — callers pick a fallback.
 *
 * @param {string} text - full plan doc text
 * @returns {string|null}
 */
export function planHeading(text) {
  if (typeof text !== 'string') throw new TypeError('planHeading: text must be a string');
  for (const line of text.split('\n')) {
    const m = PLAN_TITLE_PATTERN.exec(line.trim());
    if (m) return m[1].trim();
  }
  return null;
}

/** The `# Plan: <title>` value. A plan without one cannot name its commit. */
function planTitle(text) {
  const heading = planHeading(text);
  if (heading === null) throw new Error('plan has no "# Plan: <title>" line');
  return heading;
}

/**
 * True when `## Out-of-Scope Dependencies` has real content: an absent section,
 * an empty body, or exactly "None" (any case, edge punctuation ignored) is no.
 */
function hasOutOfScopeDeps(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === OUT_OF_SCOPE_HEADING);
  if (start === -1) return false;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => SECTION_HEADING_PATTERN.test(l));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n');
  const normalized = body.replace(EDGE_PUNCTUATION_PATTERN, '').toLowerCase();
  return normalized !== '' && normalized !== NONE_VALUE;
}

/**
 * Validate one commit trailer: a single `Key: Value` line, key
 * /^[A-Za-z][A-Za-z0-9-]*$/, non-empty value.
 *
 * @param {string} s
 * @returns {string|null} null when valid, else the reason
 */
export function validateTrailer(s) {
  if (typeof s !== 'string') return 'trailer must be a string';
  if (/[\r\n]/.test(s)) return `trailer must be a single line: ${JSON.stringify(s)}`;
  const colon = s.indexOf(':');
  if (colon === -1) return `trailer must be "Key: Value": ${JSON.stringify(s)}`;
  const key = s.slice(0, colon);
  if (!TRAILER_KEY_PATTERN.test(key)) {
    return `trailer key must match ${TRAILER_KEY_PATTERN}: ${JSON.stringify(key)}`;
  }
  if (s.slice(colon + 1).trim() === '') return `trailer value is empty: ${JSON.stringify(s)}`;
  return null;
}

/**
 * The plan's commit message, fully derived from the plan text. Subject
 * `adopt: <title>` when `Adopted-From:` is present, else `plan: <title>`; then
 * the derived body lines; then the caller's trailers. An invalid trailer
 * throws — it is never dropped.
 *
 * @param {string} text - full plan doc text
 * @param {string[]} [trailers]
 * @returns {string}
 */
export function planCommitMessage(text, trailers = []) {
  requireValidTrailers(trailers);
  const adoptedFrom = headerValue(text, 'Adopted-From');
  const issue = planIssueNumber(text);
  const { waves, tasks } = countWavesTasks(text);
  const subject = `${adoptedFrom === null ? 'plan' : 'adopt'}: ${planTitle(text)}`;
  const body = [
    ...(adoptedFrom === null ? [] : [`Adopted-From: ${adoptedFrom}`]),
    ...(issue === null ? [] : [`Issue: ${issue}`]),
    `Author: ${headerValue(text, 'Author') ?? UNKNOWN_AUTHOR}`,
    `Waves: ${waves}`,
    `Tasks: ${tasks}`,
    `Out-of-scope deps: ${hasOutOfScopeDeps(text) ? 'yes' : 'no'}`,
  ];
  return joinMessage(subject, body, trailers);
}

/** Throw on the first invalid trailer — trailers are never dropped. */
function requireValidTrailers(trailers) {
  for (const t of trailers) {
    const err = validateTrailer(t);
    if (err !== null) throw new Error(err);
  }
}

/** Subject, body lines, then trailers — the same section layout as planCommitMessage. */
function joinMessage(subject, body, trailers) {
  const sections = [subject, body.join('\n')];
  if (trailers.length > 0) sections.push(trailers.join('\n'));
  return sections.join('\n\n');
}

/** The `Plan:` and optional `Issue:` body lines shared by approve/review messages. */
function planRefLines(text, feature) {
  if (!isNonEmpty(feature)) throw new Error('feature is required');
  const issue = planIssueNumber(text);
  return [`Plan: .agents/plans/${feature}.md`, ...(issue === null ? [] : [`Issue: ${issue}`])];
}

/**
 * The approval commit message. Subject `approve: <feature>` (suffixed
 * ` (re-approval)` when reapproval); body Plan, Issue (omitted when null),
 * Approved-By, and in proxy mode Recorded-By + Approval-Evidence; then trailers.
 *
 * @param {string} text - full plan doc text
 * @param {{ feature: string, reapproval?: boolean, approvedBy: string,
 *           recordedBy?: string, evidence?: string, proxy?: boolean }} opts
 * @param {string[]} [trailers]
 * @returns {string}
 */
export function approveCommitMessage(text, { feature, reapproval, approvedBy, recordedBy, evidence, proxy }, trailers = []) {
  requireValidTrailers(trailers);
  const body = [
    ...planRefLines(text, feature),
    `Approved-By: ${approvedBy}`,
    ...(proxy ? [`Recorded-By: ${recordedBy}`, `Approval-Evidence: ${evidence}`] : []),
  ];
  const subject = `approve: ${feature}${reapproval ? ' (re-approval)' : ''}`;
  return joinMessage(subject, body, trailers);
}

/**
 * The review commit message: subject `review: <feature> <status>`; body Plan,
 * Issue (omitted when null), Reviewed-By; then trailers.
 *
 * @param {string} text - full plan doc text
 * @param {{ feature: string, status: string, reviewedBy: string }} opts
 * @param {string[]} [trailers]
 * @returns {string}
 */
export function reviewCommitMessage(text, { feature, status, reviewedBy }, trailers = []) {
  requireValidTrailers(trailers);
  const body = [...planRefLines(text, feature), `Reviewed-By: ${reviewedBy}`];
  return joinMessage(`review: ${feature} ${status}`, body, trailers);
}

/**
 * Set the plan's header `Status:`. Replaces the first `Status:` line in the
 * header block; when absent, inserts one after `Author:` (else after the
 * `# Plan:` title). Lines after the first `## ` heading are never touched.
 *
 * @param {string} text - full plan doc text
 * @param {string} status
 * @returns {string} the new text
 */
export function setPlanStatus(text, status) {
  if (!isNonEmpty(status)) throw new Error('status must be non-empty');
  if (/[\r\n]/.test(status)) throw new Error(`status must be a single line: ${JSON.stringify(status)}`);
  const lines = text.split('\n');
  const headerEnd = headerLines(text).length;
  const statusLine = `Status: ${status.trim()}`;
  const header = lines.slice(0, headerEnd);
  const existing = header.findIndex((l) => l.startsWith('Status:'));
  if (existing !== -1) {
    lines[existing] = statusLine;
    return lines.join('\n');
  }
  let anchor = header.findIndex((l) => l.startsWith('Author:'));
  if (anchor === -1) anchor = header.findIndex((l) => PLAN_TITLE_PATTERN.test(l.trim()));
  if (anchor === -1) throw new Error('plan header has no "Author:" or "# Plan:" line to anchor Status:');
  lines.splice(anchor + 1, 0, statusLine);
  return lines.join('\n');
}

/**
 * The trimmed value of the plan's header `<key>:` line, or null when absent or
 * empty. Only the header block (before the first `## `) is read.
 *
 * @param {string} text - full plan doc text
 * @param {string} key
 * @returns {string|null}
 */
export function planHeaderValue(text, key) {
  if (typeof text !== 'string' || typeof key !== 'string') throw new TypeError('planHeaderValue: text and key must be strings');
  return headerValue(text, key);
}

/**
 * Set a header `<key>: <value>` line. Replaces the first `<key>:` line in the
 * header block; when absent, inserts it right after the `after` key's line
 * (else after the `# Plan:` title). Lines after the first `## ` heading are
 * never touched.
 *
 * @param {string} text - full plan doc text
 * @param {string} key
 * @param {string} value - a single line
 * @param {{ after?: string }} [opts]
 * @returns {string} the new text
 */
export function upsertPlanHeader(text, key, value, { after = 'Status' } = {}) {
  for (const [name, v] of [['text', text], ['key', key], ['value', value], ['after', after]]) {
    if (typeof v !== 'string') throw new TypeError(`upsertPlanHeader: ${name} must be a string`);
  }
  if (!TRAILER_KEY_PATTERN.test(key)) throw new TypeError(`upsertPlanHeader: invalid key ${JSON.stringify(key)}`);
  if (/[\r\n]/.test(value)) throw new Error(`value must be a single line: ${JSON.stringify(value)}`);
  const lines = text.split('\n');
  const header = lines.slice(0, headerLines(text).length);
  const line = `${key}: ${value.trim()}`;
  const existing = header.findIndex((l) => l.startsWith(`${key}:`));
  if (existing !== -1) {
    lines[existing] = line;
    return lines.join('\n');
  }
  let anchor = header.findIndex((l) => l.startsWith(`${after}:`));
  if (anchor === -1) anchor = header.findIndex((l) => PLAN_TITLE_PATTERN.test(l.trim()));
  if (anchor === -1) throw new Error(`plan header has no "${after}:" or "# Plan:" line to anchor ${key}:`);
  lines.splice(anchor + 1, 0, line);
  return lines.join('\n');
}

/**
 * The work branch by convention: RAD_BRANCH_PREFIX (default rad/) + feature.
 *
 * @param {string} feature
 * @param {Record<string, string|undefined>} [env]
 */
export function conventionWorkBranch(feature, env = process.env) {
  const prefix = isNonEmpty(env.RAD_BRANCH_PREFIX) ? env.RAD_BRANCH_PREFIX : DEFAULT_BRANCH_PREFIX;
  return `${prefix}${feature}`;
}

/**
 * The plan's work branch: its `Branch:` header (authoritative) when non-empty,
 * else the RAD_BRANCH_PREFIX convention.
 *
 * @param {string|null|undefined} headerBranch
 * @param {string} feature
 * @param {Record<string, string|undefined>} [env]
 */
export function planWorkBranch(headerBranch, feature, env = process.env) {
  return isNonEmpty(headerBranch) ? headerBranch.trim() : conventionWorkBranch(feature, env);
}
