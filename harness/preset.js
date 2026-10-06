/**
 * preset — read and validate a RAD preset directory (#71 part 2b).
 *
 * A preset is a directory holding `preset.yml` (name, version, optional
 * `settings:`) and an optional `files/` tree mirroring the target layout.
 *
 * Constraints:
 * - readPreset never throws: every problem is returned as an error naming the
 *   path or key, and a preset with any error is never partially usable.
 * - Nothing in a preset tree is followed: preset.yml, files/ and every entry
 *   under it are lstat'ed; a symlink or other non-regular entry is an error.
 * - Preset files may only land under PRESET_ROOTS; what core owns is decided
 *   by install-manifest (a core-recorded path is a conflict at plan time).
 *
 * js-yaml is imported lazily (same convention as config.js loadConfig).
 */

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { settingsErrors } from './config.js';
import { isSafeRelPath, presetFilesRoot } from './install-manifest.js';

/** The preset descriptor file, relative to the preset directory. */
export const PRESET_FILE = 'preset.yml';
/** The only target directories a preset file may land under. */
export const PRESET_ROOTS = Object.freeze(['scripts/hooks/', 'ai/extensions/', '.claude/agents/', 'docs/']);
/** Keys allowed at the top level of preset.yml. */
const PRESET_KEYS = Object.freeze(['name', 'version', 'settings']);
/** A preset name: kebab-case, starting with a letter or digit. */
const PRESET_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** OS litter skipped when walking files/ (same rule as core's IGNORED_NAMES). */
const IGNORED_NAMES = new Set(['.DS_Store']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** lstat that returns null for an absent path (any other error propagates). */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

/** Parse preset.yml: { doc } or { error }. Never follows a symlinked preset.yml. */
async function loadPresetDoc(dir) {
  const st = lstatOrNull(join(dir, PRESET_FILE));
  if (!st) return { error: `${PRESET_FILE} is missing in ${dir}` };
  if (!st.isFile()) return { error: `${PRESET_FILE} in ${dir} is not a regular file` };
  try {
    const { default: yaml } = await import('./vendor/js-yaml.mjs');
    return { doc: yaml.load(readFileSync(join(dir, PRESET_FILE), 'utf8')) };
  } catch (err) {
    return { error: `cannot parse ${PRESET_FILE}: ${err.message.split('\n')[0]}` };
  }
}

/** Errors in a parsed preset.yml document (empty when valid). */
function presetDocErrors(doc) {
  if (!isPlainObject(doc)) return [`${PRESET_FILE} must be a YAML mapping`];
  const errors = Object.keys(doc).filter((k) => !PRESET_KEYS.includes(k)).map((k) => `unknown key '${k}' in ${PRESET_FILE}`);
  if (typeof doc.name !== 'string' || !PRESET_NAME.test(doc.name)) {
    errors.push(`name must be kebab-case matching ${PRESET_NAME} (got ${JSON.stringify(doc.name)})`);
  }
  if (typeof doc.version !== 'string' || doc.version.trim() === '') {
    errors.push(`version must be a non-empty string (got ${JSON.stringify(doc.version)})`);
  }
  errors.push(...settingsErrors(doc.settings));
  return errors;
}

/** Errors for one regular file at `rel` (posix, relative to files/). */
function filePathErrors(rel) {
  if (!isSafeRelPath(rel)) return [`files/${rel}: unsafe path`];
  if (!PRESET_ROOTS.some((root) => rel.startsWith(root))) {
    return [`files/${rel}: outside the allowed preset roots (${PRESET_ROOTS.join(', ')})`];
  }
  return [];
}

/** Walk files/ under `abs` (posix `rel` prefix), collecting regular files and errors; never follows a symlink. */
function walkFiles(abs, rel, out) {
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (IGNORED_NAMES.has(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkFiles(join(abs, entry.name), childRel, out);
    else if (!entry.isFile()) out.errors.push(`files/${childRel}: not a regular file (symlinks and special files are refused)`);
    else {
      const errors = filePathErrors(childRel);
      if (errors.length) out.errors.push(...errors);
      else out.files.push(childRel);
    }
  }
}

/** The preset's files: { files, errors }. An absent files/ is an empty list. */
function listPresetFiles(dir) {
  const out = { files: [], errors: [] };
  const root = presetFilesRoot(dir);
  const st = lstatOrNull(root);
  if (!st) return out;
  if (!st.isDirectory()) return { files: [], errors: ['files/ is not a directory (symlinks are refused)'] };
  walkFiles(root, '', out);
  out.files.sort();
  return out;
}

/** True when a validated settings value sets at least one key. */
const hasSettings = (settings) => isPlainObject(settings) && Object.keys(settings).length > 0;

/**
 * Read and validate a preset directory. Never throws.
 *
 * @param {string} dir - the preset directory
 * @returns {Promise<{ ok: true, preset: { name: string, version: string, settings: Object | undefined, files: string[] } }
 *                   | { ok: false, errors: string[] }>}
 *   `files` is sorted posix paths relative to <dir>/files (= target paths).
 */
export async function readPreset(dir) {
  try {
    const loaded = await loadPresetDoc(dir);
    if (loaded.error) return { ok: false, errors: [loaded.error] };
    const { doc } = loaded;
    const errors = presetDocErrors(doc);
    const listed = listPresetFiles(dir);
    errors.push(...listed.errors);
    if (!errors.length && !hasSettings(doc.settings) && listed.files.length === 0) {
      errors.push('preset is empty: it has neither settings nor files');
    }
    if (errors.length) return { ok: false, errors };
    return { ok: true, preset: { name: doc.name, version: doc.version, settings: doc.settings, files: listed.files } };
  } catch (err) {
    return { ok: false, errors: [`cannot read preset ${dir}: ${err.message}`] };
  }
}

/**
 * Absolute source path of a preset file. Throws on an unsafe `rel`, so a
 * caller can never be steered outside <dir>/files.
 *
 * @param {string} dir - the preset directory
 * @param {string} rel - a path from readPreset's `files`
 * @returns {string}
 */
export function presetFilePath(dir, rel) {
  if (!isSafeRelPath(rel)) throw new Error(`unsafe preset file path ${JSON.stringify(rel)}`);
  return resolve(presetFilesRoot(dir), rel);
}
