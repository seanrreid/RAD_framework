/**
 * RAD config file (`.rad/config.yml`) — load, validate, query, migrate, serialize.
 *
 * Config DATA (platform, default branch, roles, agent scope map) lives here, not
 * in CLAUDE.md. Pure helpers never throw on bad input: they return errors /
 * `{ found: false }` and the CLI reports them. Validation is fail-closed —
 * an unknown key or a template placeholder identity is an error, never ignored.
 *
 * js-yaml is imported LAZILY inside loadConfig so importing this module never
 * eagerly loads it (same convention as adapters/git-state-store.js).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Repo-relative path of the config file. */
export const CONFIG_PATH = '.rad/config.yml';
/** Supported git platforms (mirrors scripts/detect-platform.sh). */
export const PLATFORMS = Object.freeze(['github', 'gitlab', 'bitbucket', 'forgejo', 'manual']);
/** The only schema version this reader understands. */
export const CONFIG_VERSION = 1;

const TOP_LEVEL_KEYS = Object.freeze(['version', 'platform', 'default_branch', 'roles', 'agent_scope_map']);
const ROLE_KEYS = Object.freeze(['architect', 'developers', 'designers']);
const SCOPE_ROW_KEYS = Object.freeze(['agent', 'type', 'reads', 'roles']);
/** A bracketed value (e.g. `[your GitHub username]`) is an unfilled template placeholder. */
const PLACEHOLDER_PREFIX = '[';
/** Required keys `migrateFromClaudeMd` must find, by dotted name. */
const REQUIRED_MIGRATE_KEYS = Object.freeze(['platform', 'default_branch', 'roles.architect']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/** A lone string becomes [string]; undefined stays undefined; anything else is left as-is. */
function toList(v) {
  return typeof v === 'string' ? [v] : v;
}

/** Return a copy of `doc` with role lists normalized (lone string → [string], absent optional → []). */
export function normalizeConfig(doc) {
  if (!isPlainObject(doc)) return doc;
  const out = { ...doc };
  if (isPlainObject(doc.roles)) {
    out.roles = { ...doc.roles };
    for (const key of ROLE_KEYS) {
      const listed = toList(doc.roles[key]);
      out.roles[key] = listed === undefined && key !== 'architect' ? [] : listed;
    }
  }
  if (Array.isArray(doc.agent_scope_map)) {
    out.agent_scope_map = doc.agent_scope_map.map((row) =>
      isPlainObject(row) ? { ...row, roles: toList(row.roles) } : row);
  }
  return out;
}

/** Errors for a list of identities/roles at `where`. */
function identityListErrors(list, where, { required }) {
  if (!Array.isArray(list)) return [`${where} must be a list`];
  if (required && list.length === 0) return [`${where} must name at least one identity`];
  const errors = [];
  list.forEach((id, i) => {
    if (!isNonEmptyString(id)) errors.push(`${where}[${i}] must be a non-empty string`);
    else if (id.trim().startsWith(PLACEHOLDER_PREFIX)) {
      errors.push(`${where}[${i}] is a template placeholder (${id}) — replace it with a real identity`);
    }
  });
  return errors;
}

function rolesErrors(roles) {
  if (roles === undefined) return ['roles is required'];
  if (!isPlainObject(roles)) return ['roles must be a mapping'];
  const errors = Object.keys(roles).filter((k) => !ROLE_KEYS.includes(k)).map((k) => `unknown key roles.${k}`);
  if (roles.architect === undefined) errors.push('roles.architect is required');
  for (const key of ROLE_KEYS) {
    if (roles[key] === undefined) continue;
    errors.push(...identityListErrors(roles[key], `roles.${key}`, { required: key === 'architect' }));
  }
  return errors;
}

function scopeRowErrors(row, i) {
  const where = `agent_scope_map[${i}]`;
  if (!isPlainObject(row)) return [`${where} must be a mapping`];
  const errors = Object.keys(row).filter((k) => !SCOPE_ROW_KEYS.includes(k)).map((k) => `unknown key ${where}.${k}`);
  for (const key of ['agent', 'type']) {
    if (!isNonEmptyString(row[key])) errors.push(`${where}.${key} must be a non-empty string`);
  }
  if (typeof row.reads !== 'string') errors.push(`${where}.reads must be a string`);
  errors.push(...identityListErrors(row.roles, `${where}.roles`, { required: true }));
  return errors;
}

function scalarErrors(doc) {
  const errors = [];
  if (doc.version === undefined) errors.push('version is required');
  else if (doc.version !== CONFIG_VERSION) errors.push(`version must be ${CONFIG_VERSION} (got ${JSON.stringify(doc.version)})`);
  if (doc.platform === undefined) errors.push('platform is required');
  else if (!PLATFORMS.includes(doc.platform)) {
    errors.push(`platform must be one of ${PLATFORMS.join(' | ')} (got ${JSON.stringify(doc.platform)})`);
  }
  if (doc.default_branch === undefined) errors.push('default_branch is required');
  else if (!isNonEmptyString(doc.default_branch)) errors.push('default_branch must be a non-empty string');
  return errors;
}

/**
 * Validate a config document. Role lists are normalized first, so a lone string
 * is accepted. Never throws.
 *
 * @param {unknown} doc
 * @returns {string[]} errors (empty when valid)
 */
export function validateConfig(doc) {
  if (!isPlainObject(doc)) return ['config must be a YAML mapping'];
  const norm = normalizeConfig(doc);
  const errors = Object.keys(norm).filter((k) => !TOP_LEVEL_KEYS.includes(k)).map((k) => `unknown top-level key '${k}'`);
  errors.push(...scalarErrors(norm), ...rolesErrors(norm.roles));
  if (norm.agent_scope_map !== undefined) {
    if (!Array.isArray(norm.agent_scope_map)) errors.push('agent_scope_map must be a list');
    else norm.agent_scope_map.forEach((row, i) => errors.push(...scopeRowErrors(row, i)));
  }
  return errors;
}

/**
 * Load, parse, normalize and validate `<root>/.rad/config.yml`. Never throws.
 *
 * @param {string} root
 * @returns {Promise<{ok: true, doc: Object} | {ok: false, missing: true} | {ok: false, errors: string[]}>}
 */
export async function loadConfig(root) {
  const path = join(root, CONFIG_PATH);
  if (!existsSync(path)) return { ok: false, missing: true };
  let doc;
  try {
    const { default: yaml } = await import('./vendor/js-yaml.mjs');
    doc = yaml.load(readFileSync(path, 'utf8'));
  } catch (err) {
    return { ok: false, errors: [`cannot parse ${CONFIG_PATH}: ${err.message.split('\n')[0]}`] };
  }
  const errors = validateConfig(doc);
  return errors.length ? { ok: false, errors } : { ok: true, doc: normalizeConfig(doc) };
}

/**
 * Look up a dotted key (e.g. `roles.architect`). Walks mappings only.
 *
 * @returns {{ found: boolean, value?: unknown }}
 */
export function getConfigValue(doc, dottedKey) {
  if (!isNonEmptyString(dottedKey)) return { found: false };
  let cur = doc;
  for (const part of dottedKey.split('.')) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, part)) return { found: false };
    cur = cur[part];
  }
  return { found: true, value: cur };
}

// ---------------------------------------------------------------------------
// Migration from CLAUDE.md
// ---------------------------------------------------------------------------

/** [start, end) line indexes of the `### <heading>` section (end = next heading). */
function sectionBounds(lines, heading) {
  const start = lines.findIndex((l) => l.trim() === `### ${heading}`);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^#{2,3} /.test(lines[end])) end += 1;
  return { start, end };
}

/** First fenced block inside a section: { start, end } inclusive fence line indexes. */
function firstFence(lines, bounds) {
  if (!bounds) return null;
  const open = lines.slice(bounds.start, bounds.end).findIndex((l) => l.trim().startsWith('```'));
  if (open === -1) return null;
  const start = bounds.start + open;
  for (let i = start + 1; i < bounds.end; i += 1) {
    if (lines[i].trim().startsWith('```')) return { start, end: i };
  }
  return null;
}

/** `key: value  # comment` lines in a fence → { key: value } (comment stripped). */
function fenceKeyValues(lines, fence) {
  const out = {};
  if (!fence) return out;
  for (const line of lines.slice(fence.start + 1, fence.end)) {
    const m = /^\s*([A-Za-z_]+):\s*(.*?)\s*(#.*)?$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** `a, b` → ['a','b']; `[]` or empty → []. */
function splitList(value) {
  const v = (value ?? '').trim();
  if (v === '' || v === '[]') return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Agent Scope Map table rows → scope rows, plus warnings and the table's line range. */
function parseScopeTable(lines, bounds) {
  const rows = [];
  const warnings = [];
  if (!bounds) return { rows, warnings: ['no "### Agent Scope Map" section — agent_scope_map left empty'], range: null };
  let first = -1;
  let last = -1;
  for (let i = bounds.start + 1; i < bounds.end; i += 1) {
    if (!lines[i].trim().startsWith('|')) continue;
    if (first === -1) first = i;
    last = i;
    const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells[0] === 'Agent' || cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (cells.length !== SCOPE_ROW_KEYS.length) {
      warnings.push(`line ${i + 1}: scope-map row has ${cells.length} cells (expected 4) — skipped`);
      continue;
    }
    rows.push({ agent: cells[0], type: cells[1], reads: cells[2], roles: splitList(cells[3]) });
  }
  return { rows, warnings, range: first === -1 ? null : { start: first, end: last } };
}

/** 1-based inclusive block ranges the operator should remove from CLAUDE.md. */
function blockRanges(named) {
  return named.filter(([, r]) => r).map(([name, r]) => ({ name, start: r.start + 1, end: r.end + 1 }));
}

/**
 * Build a config document from CLAUDE.md text. Never throws; never edits CLAUDE.md.
 *
 * @param {string} text
 * @returns {{ doc: Object, warnings: string[], missing: string[], blocks: {name: string, start: number, end: number}[] }}
 */
export function migrateFromClaudeMd(text) {
  const lines = String(text ?? '').split('\n');
  const gitFence = firstFence(lines, sectionBounds(lines, 'Git Platform'));
  const roleFence = firstFence(lines, sectionBounds(lines, 'Role Assignments'));
  const git = fenceKeyValues(lines, gitFence);
  const roleKv = fenceKeyValues(lines, roleFence);
  const table = parseScopeTable(lines, sectionBounds(lines, 'Agent Scope Map'));
  const roles = {};
  for (const key of ROLE_KEYS) roles[key] = splitList(roleKv[key]);
  const doc = { version: CONFIG_VERSION, platform: git.platform, default_branch: git.default_branch, roles, agent_scope_map: table.rows };
  const missing = REQUIRED_MIGRATE_KEYS.filter((k) => {
    const got = getConfigValue(doc, k);
    return !got.found || got.value === undefined || got.value === '' || (Array.isArray(got.value) && got.value.length === 0);
  });
  const blocks = blockRanges([['Git Platform', gitFence], ['Role Assignments', roleFence], ['Agent Scope Map', table.range]]);
  return { doc, warnings: table.warnings, missing, blocks };
}

// ---------------------------------------------------------------------------
// Serialization (hand-rolled: deterministic key order, no js-yaml needed)
// ---------------------------------------------------------------------------

const PLAIN_SCALAR = /^[A-Za-z_][A-Za-z0-9_.@/-]*$/;
const YAML_RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i;

/** A YAML scalar: plain when unambiguous, otherwise a JSON (= YAML double-quoted) string. */
function scalar(v) {
  if (typeof v === 'number') return String(v);
  const s = String(v);
  return PLAIN_SCALAR.test(s) && !YAML_RESERVED.test(s) ? s : JSON.stringify(s);
}

const flowList = (list) => `[${(list ?? []).map(scalar).join(', ')}]`;

function blockList(list, indent) {
  if (!list || list.length === 0) return ' []';
  return list.map((v) => `\n${indent}- ${scalar(v)}`).join('');
}

/**
 * Serialize a config document to YAML with a fixed key order. Round-trips
 * through loadConfig.
 *
 * @param {Object} doc
 * @returns {string}
 */
export function serializeConfig(doc) {
  const d = normalizeConfig(doc);
  const out = [
    '# RAD configuration — the single source of config data (platform, roles, scope map).',
    '# Validate with: rad config validate',
    `version: ${scalar(d.version)}`,
    `platform: ${scalar(d.platform)}        # ${PLATFORMS.join(' | ')}`,
    `default_branch: ${scalar(d.default_branch)}`,
    'roles:',
  ];
  for (const key of ROLE_KEYS) out.push(`  ${key}:${blockList(d.roles?.[key], '    ')}`);
  if (d.agent_scope_map !== undefined) {
    if (d.agent_scope_map.length === 0) out.push('agent_scope_map: []');
    else out.push('agent_scope_map:');
    for (const row of d.agent_scope_map) {
      out.push(`  - agent: ${scalar(row.agent)}`, `    type: ${scalar(row.type)}`,
        `    reads: ${scalar(row.reads)}`, `    roles: ${flowList(row.roles)}`);
    }
  }
  return out.join('\n') + '\n';
}

/** Platform `rad config init` writes when none is given (never calls a host CLI). */
export const INIT_DEFAULT_PLATFORM = 'manual';
/** Default branch `rad config init` writes when none is given. */
export const INIT_DEFAULT_BRANCH = 'main';

/**
 * Build a fresh config document for `rad config init`. Pure: it does not
 * validate — the caller must run validateConfig before writing.
 *
 * @param {{ platform?: string, defaultBranch?: string, architect: string }} opts
 * @returns {Object}
 */
export function buildInitConfig({ platform, defaultBranch, architect }) {
  return {
    version: CONFIG_VERSION,
    platform: platform ?? INIT_DEFAULT_PLATFORM,
    default_branch: defaultBranch ?? INIT_DEFAULT_BRANCH,
    roles: { architect: [architect], developers: [], designers: [] },
    agent_scope_map: [],
  };
}
