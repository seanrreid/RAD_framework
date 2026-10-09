/**
 * playbook.js — pure parsing and validation of pinned playbooks and refs.
 *
 * A playbook is `.agents/playbooks/<kind>--<slug>.md`: a `---` fenced JSON
 * frontmatter block, a body, and a final `## Upgrade Guide` section of
 * `### Version N — YYYY-MM-DD` entries. A plan pins one with the header line
 * `Playbook: <kind>/<slug>@<version>`.
 *
 * No I/O: file contents arrive through injected arguments (`text`,
 * `readPlaybook`). Non-string input throws TypeError; a malformed file throws
 * PlaybookError from parsePlaybook and is reported as strings by
 * validatePlaybook.
 */

const KEBAB = '[a-z][a-z0-9-]*';
const REF_PATTERN = new RegExp(`^(${KEBAB})/(${KEBAB})@([1-9][0-9]*)$`);
const FILE_NAME_PATTERN = new RegExp(`^(${KEBAB})--(${KEBAB})\\.md$`);
const FRONTMATTER_FENCE = '---';
const FRONTMATTER_KEYS = ['kind', 'slug', 'version', 'summary', 'primary_file'];
const UPGRADE_GUIDE_HEADING = '## Upgrade Guide';
const SECTION_PREFIX = '## ';
const VERSION_PREFIX = '### Version';
const VERSION_ENTRY_PATTERN = /^### Version ([1-9][0-9]*) — (\d{4})-(\d{2})-(\d{2})$/;
const CODE_FENCE = '```';

export class PlaybookError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlaybookError';
  }
}

function requireString(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
}

const isPositiveInt = (n) => Number.isInteger(n) && n > 0;

/** `kind/slug@version` → `{ kind, slug, version }`, or null when it does not match the grammar. */
export function parsePlaybookRef(text) {
  requireString(text, 'ref');
  const m = REF_PATTERN.exec(text);
  return m ? { kind: m[1], slug: m[2], version: Number(m[3]) } : null;
}

export function playbookFileName({ kind, slug }) {
  requireString(kind, 'kind');
  requireString(slug, 'slug');
  return `${kind}--${slug}.md`;
}

/** Split `---`, a JSON object, `---` from the body; anything else throws PlaybookError. */
export function parsePlaybook(text) {
  requireString(text, 'text');
  const lines = text.split('\n');
  if (lines[0] !== FRONTMATTER_FENCE) throw new PlaybookError('missing frontmatter: the file must start with ---');
  const close = lines.indexOf(FRONTMATTER_FENCE, 1);
  if (close === -1) throw new PlaybookError('unterminated frontmatter: no closing ---');
  let meta;
  try {
    meta = JSON.parse(lines.slice(1, close).join('\n'));
  } catch (err) {
    throw new PlaybookError(`frontmatter is not valid JSON: ${err.message}`);
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new PlaybookError('frontmatter must be a JSON object');
  }
  return { meta, body: lines.slice(close + 1).join('\n') };
}

function validDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** `## ` headings outside code fences, as { heading, index } in order. */
function sectionHeadings(lines) {
  const found = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (line.startsWith(CODE_FENCE)) fenced = !fenced;
    else if (!fenced && line.startsWith(SECTION_PREFIX)) found.push({ heading: line.trimEnd(), index });
  });
  return found;
}

function upgradeGuideLines(body) {
  const lines = body.split('\n');
  const sections = sectionHeadings(lines);
  const guide = sections.find((s) => s.heading === UPGRADE_GUIDE_HEADING);
  if (!guide) return { errors: [`missing "${UPGRADE_GUIDE_HEADING}" section`] };
  if (sections[sections.length - 1] !== guide) {
    return { errors: [`"${UPGRADE_GUIDE_HEADING}" must be the last "## " section`] };
  }
  return { lines: lines.slice(guide.index + 1) };
}

function versionEntryErrors(guideLines, version) {
  const errors = [];
  const numbers = [];
  for (const line of guideLines.filter((l) => l.startsWith(VERSION_PREFIX))) {
    const m = VERSION_ENTRY_PATTERN.exec(line);
    if (!m) errors.push(`malformed version entry "${line}" (want "### Version N — YYYY-MM-DD")`);
    else if (!validDate(Number(m[2]), Number(m[3]), Number(m[4]))) errors.push(`invalid date in "${line}"`);
    else numbers.push(Number(m[1]));
  }
  if (errors.length === 0 && numbers.length === 0) errors.push('Upgrade Guide has no "### Version N — YYYY-MM-DD" entries');
  numbers.forEach((n, i) => {
    if (n !== i + 1) errors.push(`version entries must run consecutively from 1; found ${n} at position ${i + 1}`);
  });
  const last = numbers[numbers.length - 1];
  if (isPositiveInt(version) && numbers.length > 0 && last !== version) {
    errors.push(`last Upgrade Guide version ${last} does not equal frontmatter version ${version}`);
  }
  return errors;
}

function frontmatterErrors(meta, nameParts, kinds) {
  const errors = [];
  for (const key of Object.keys(meta)) {
    if (!FRONTMATTER_KEYS.includes(key)) errors.push(`unknown frontmatter key "${key}"`);
  }
  if (nameParts) {
    if (!kinds.includes(nameParts.kind)) errors.push(`kind "${nameParts.kind}" is not an allowed playbook kind`);
    if ('kind' in meta && meta.kind !== nameParts.kind) errors.push(`frontmatter kind "${meta.kind}" does not match the file name`);
    if ('slug' in meta && meta.slug !== nameParts.slug) errors.push(`frontmatter slug "${meta.slug}" does not match the file name`);
  }
  if (!isPositiveInt(meta.version)) errors.push('frontmatter version must be a positive integer');
  return errors;
}

/** Every rule violation in a playbook file, or an empty array when it is valid. */
export function validatePlaybook({ fileName, text, kinds }) {
  requireString(fileName, 'fileName');
  requireString(text, 'text');
  if (!Array.isArray(kinds)) throw new TypeError('kinds must be an array');
  const errors = [];
  const m = FILE_NAME_PATTERN.exec(fileName);
  if (!m) errors.push(`file name "${fileName}" must match <kind>--<slug>.md`);
  let parsed;
  try {
    parsed = parsePlaybook(text);
  } catch (err) {
    if (!(err instanceof PlaybookError)) throw err;
    return [...errors, err.message];
  }
  errors.push(...frontmatterErrors(parsed.meta, m && { kind: m[1], slug: m[2] }, kinds));
  const guide = upgradeGuideLines(parsed.body);
  errors.push(...(guide.errors ?? versionEntryErrors(guide.lines, parsed.meta.version)));
  return errors;
}

/** Resolve a pinned ref against the playbook on disk (via `readPlaybook`); older pins are ok but stale. */
export function checkPlaybookRef({ ref, kinds, readPlaybook }) {
  requireString(ref, 'ref');
  if (!Array.isArray(kinds)) throw new TypeError('kinds must be an array');
  if (typeof readPlaybook !== 'function') throw new TypeError('readPlaybook must be a function');
  const parsed = parsePlaybookRef(ref);
  if (!parsed) return { ok: false, reason: `"${ref}" is not a valid playbook ref (want <kind>/<slug>@<version>)` };
  if (!kinds.includes(parsed.kind)) return { ok: false, reason: `kind "${parsed.kind}" is not an allowed playbook kind` };
  const fileName = playbookFileName(parsed);
  const text = readPlaybook(fileName);
  if (text === null) return { ok: false, reason: `playbook ${fileName} not found` };
  const errors = validatePlaybook({ fileName, text, kinds });
  if (errors.length > 0) return { ok: false, reason: `playbook ${fileName} is invalid: ${errors[0]}` };
  const current = parsePlaybook(text).meta.version;
  if (parsed.version > current) {
    return { ok: false, reason: `ref version ${parsed.version} is ahead of ${fileName} current version ${current}` };
  }
  return { ok: true, current, stale: parsed.version < current };
}
