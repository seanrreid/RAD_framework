/**
 * Source provenance (#243): who wrote the issue a plan was opened from.
 *
 * `plan-open` stamps two display-only header lines, `Source-Author:` and
 * `Source-Comments:`, from `scripts/fetch-provenance.sh`; `rad provenance`
 * reads them back for the approval summary. The lines sit in the plan's header
 * block, which planFingerprint excludes, so stamping never changes the hash and
 * provenance never reaches the gate or the event log. Everything here is
 * advisory: nothing refuses approval.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isSafeFeature } from './adapters/git-state-store.js';

const SOURCE_AUTHOR_KEY = 'Source-Author';
const SOURCE_COMMENTS_KEY = 'Source-Comments';
const SOURCE_AUTHOR_PREFIX = `${SOURCE_AUTHOR_KEY}:`;
const SOURCE_COMMENTS_PREFIX = `${SOURCE_COMMENTS_KEY}:`;
const BODY_HEADING_PREFIX = '## ';
const TITLE_PREFIX = 'Issue-Title:';
const SOURCE_REF_PREFIXES = ['Adopted-From:', 'Issue:'];

export const TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const BOT_TYPE = 'Bot';
const BOT_LABEL = 'bot';
const MISSING_ASSOCIATION = 'NONE';
const TSV_FIELD_COUNT = 4;
const ISSUE_ROW = 'issue';
const COMMENT_ROW = 'comment';

const NONE_AUTHOR = 'none (no source issue)';
const NONE_COMMENTS = 'none';
const UNKNOWN_COMMENTS = 'unknown';
const AUTHOR_VALUE_PATTERN = /^(.+) \(([^(),]+)(?:, (bot))?\)$/;
const COMMENTS_VALUE_PATTERN = /^(\d+) total, (\d+) non-collaborator$/;
const UNKNOWN_AUTHOR_PATTERN = /^unknown(?: \((.*)\))?$/;
const NONE_AUTHOR_PATTERN = /^none(?: \(.*\))?$/;

export const PROVENANCE_USAGE = 'rad provenance <feature>';
const USAGE_EXIT_CODE = 2;

/**
 * Classify one author. A bot is untrusted whatever its association.
 *
 * @param {unknown} association - GitHub author_association (any value, or missing)
 * @param {unknown} userType - GitHub user.type
 * @returns {{ trusted: boolean, bot: boolean, label: string }} label is the normalized association
 */
export function classifyAssociation(association, userType) {
  const label = typeof association === 'string' && association.trim() !== '' ? association.trim() : MISSING_ASSOCIATION;
  const bot = userType === BOT_TYPE;
  return { trusted: !bot && TRUSTED_ASSOCIATIONS.includes(label), bot, label };
}

/** Parse one TSV row into an author record; throws on a malformed row. */
function parseRow(line, expectedKind) {
  const fields = line.split('\t');
  if (fields.length !== TSV_FIELD_COUNT || fields[0] !== expectedKind || fields[1].trim() === '') {
    throw new Error(`malformed provenance row: ${JSON.stringify(line)}`);
  }
  return { login: fields[1], type: fields[2], association: fields[3] };
}

/**
 * Parse fetch-provenance.sh stdout: one `issue` row, then zero or more `comment` rows.
 * Throws on any malformed or unexpected row, or a missing issue row, so the caller stamps `unknown`.
 *
 * @param {string} stdout
 * @returns {{ issue: {login: string, type: string, association: string}, comments: object[] }}
 */
export function parseProvenanceTsv(stdout) {
  const lines = String(stdout ?? '').split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new Error('empty provenance output');
  const issue = parseRow(lines[0], ISSUE_ROW);
  const comments = lines.slice(1).map((l) => parseRow(l, COMMENT_ROW));
  return { issue, comments };
}

/** `login (ASSOC)` or `login (ASSOC, bot)`. */
function authorValue(author) {
  const c = classifyAssociation(author.association, author.type);
  return `${author.login} (${c.label}${c.bot ? `, ${BOT_LABEL}` : ''})`;
}

/**
 * The two header lines for a parsed fetch.
 *
 * @param {{ issue: object, comments: object[] }} parsed
 * @returns {string[]}
 */
export function provenanceHeaderLines(parsed) {
  const untrusted = parsed.comments.filter((c) => !classifyAssociation(c.association, c.type).trusted).length;
  return [
    `${SOURCE_AUTHOR_PREFIX} ${authorValue(parsed.issue)}`,
    `${SOURCE_COMMENTS_PREFIX} ${parsed.comments.length} total, ${untrusted} non-collaborator`,
  ];
}

/** Header lines for a fetch that failed; never blocks plan-open. */
export function unknownHeaderLines(reason) {
  const why = String(reason ?? '').replace(/\s+/g, ' ').trim() || 'no reason given';
  return [`${SOURCE_AUTHOR_PREFIX} unknown (${why})`, `${SOURCE_COMMENTS_PREFIX} ${UNKNOWN_COMMENTS}`];
}

/** Header lines for a plan with no source issue. */
export function noneHeaderLines() {
  return [`${SOURCE_AUTHOR_PREFIX} ${NONE_AUTHOR}`, `${SOURCE_COMMENTS_PREFIX} ${NONE_COMMENTS}`];
}

/** Index of the last header line starting with any prefix, or -1. */
function lastIndexWithPrefix(lines, prefixes) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (prefixes.some((p) => lines[i].startsWith(p))) return i;
  }
  return -1;
}

/** Where the stamp goes: after Issue-Title, else the last source ref, else the last non-blank header line. */
function insertionIndex(header) {
  const title = lastIndexWithPrefix(header, [TITLE_PREFIX]);
  if (title !== -1) return title + 1;
  const ref = lastIndexWithPrefix(header, SOURCE_REF_PREFIXES);
  if (ref !== -1) return ref + 1;
  for (let i = header.length - 1; i >= 0; i--) if (header[i].trim() !== '') return i + 1;
  return 0;
}

/**
 * Set the two provenance lines in the header block (before the first `## `),
 * replacing any existing `Source-Author:` / `Source-Comments:` lines. Body
 * lines are never touched.
 *
 * @param {string} planText
 * @param {string[]} headerLines - from provenanceHeaderLines / unknownHeaderLines / noneHeaderLines
 * @returns {string}
 */
export function stampProvenance(planText, headerLines) {
  const lines = String(planText ?? '').split('\n');
  const end = lines.findIndex((l) => l.startsWith(BODY_HEADING_PREFIX));
  const bodyStart = end === -1 ? lines.length : end;
  const header = lines.slice(0, bodyStart)
    .filter((l) => !l.startsWith(SOURCE_AUTHOR_PREFIX) && !l.startsWith(SOURCE_COMMENTS_PREFIX));
  header.splice(insertionIndex(header), 0, ...headerLines);
  return [...header, ...lines.slice(bodyStart)].join('\n');
}

/** The trimmed value of the first `<prefix>` line in the header block, or null. */
function headerField(lines, prefix) {
  const line = lines.find((l) => l.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim();
}

/**
 * Read the stamped values back from the header block.
 *
 * @param {string} planText
 * @returns {{ author: string|null, comments: string|null }} null = not stamped
 */
export function readProvenance(planText) {
  const lines = String(planText ?? '').split('\n');
  const end = lines.findIndex((l) => l.startsWith(BODY_HEADING_PREFIX));
  const header = end === -1 ? lines : lines.slice(0, end);
  return {
    author: headerField(header, SOURCE_AUTHOR_PREFIX) || null,
    comments: headerField(header, SOURCE_COMMENTS_PREFIX) || null,
  };
}

/** The `provenance:` line for a stamped author value. */
function authorLine(author) {
  if (NONE_AUTHOR_PATTERN.test(author)) return 'provenance: none - the plan has no source issue';
  const unknown = UNKNOWN_AUTHOR_PATTERN.exec(author);
  if (unknown) return `provenance: unknown - author could not be determined${unknown[1] ? ` (${unknown[1]})` : ''}`;
  const m = AUTHOR_VALUE_PATTERN.exec(author);
  if (!m) return `provenance: unknown - unreadable ${SOURCE_AUTHOR_KEY} value ${JSON.stringify(author)}`;
  const [, login, association, bot] = m;
  const { trusted } = classifyAssociation(association, bot ? BOT_TYPE : '');
  if (trusted) return `provenance: trusted - ${login} (${association})`;
  return `provenance: UNTRUSTED - ${login} (${association}${bot ? `, ${BOT_LABEL}` : ''})`;
}

/** The second line when comments include non-collaborators, else null. */
function commentsLine(comments) {
  const m = COMMENTS_VALUE_PATTERN.exec(comments ?? '');
  if (!m || Number(m[2]) === 0) return null;
  return `provenance: ${m[2]} of ${m[1]} issue comments are from non-collaborators`;
}

/**
 * `rad provenance <feature>`: print the plan's stamped provenance. Read-only,
 * advisory: exit 0 for any provenance outcome, 2 for a bad feature name or a
 * missing plan.
 *
 * @param {string[]} argv - args after `provenance`
 * @param {{ repoRoot: string }} ctx
 * @returns {Promise<number>}
 */
export async function provenanceCommand(argv, ctx) {
  const feature = argv.length === 1 ? argv[0] : undefined;
  if (typeof feature !== 'string' || !isSafeFeature(feature)) {
    process.stderr.write(`rad provenance: a valid <feature> is required\nUsage: ${PROVENANCE_USAGE}\n`);
    return USAGE_EXIT_CODE;
  }
  const planRel = join('.agents', 'plans', `${feature}.md`);
  const planFile = join(ctx.repoRoot, planRel);
  if (!existsSync(planFile)) {
    process.stderr.write(`rad provenance: no plan doc at ${planRel}\n`);
    return USAGE_EXIT_CODE;
  }
  const { author, comments } = readProvenance(readFileSync(planFile, 'utf8'));
  if (author === null) {
    process.stdout.write('provenance: not recorded - the plan has no Source-Author stamp (opened before provenance stamping)\n');
    return 0;
  }
  process.stdout.write(`${authorLine(author)}\n`);
  const extra = commentsLine(comments);
  if (extra !== null) process.stdout.write(`${extra}\n`);
  return 0;
}
