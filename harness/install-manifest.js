/**
 * install-manifest — the single definition of RAD's core (framework-owned) file
 * set, and the non-destructive install/upgrade planner over it (#71 part 1).
 *
 * The manifest (.rad/installed.json) records the sha256 of every core file as
 * installed. On upgrade that baseline tells an unmodified framework file (safe
 * to overwrite) from a local edit (never overwritten; the new version is staged
 * under .rad/upgrade-pending/ instead).
 *
 * Constraints:
 * - User data (CLAUDE.md, .claude/agents/, .claude/settings*.json, .agents/,
 *   .rad/) is never in the core set: only the CORE_* roots below are walked.
 *   Two narrow exceptions (#171 part 2): the .rad/skills and .rad/agents
 *   generator sources, and files under MARKED_ROOTS that carry the generated
 *   marker. Nothing else under .rad/ (config.yml, installed.json) ever ships.
 * - Under scripts/, only top-level *.sh and *.mjs files (plus the scripts/lib
 *   and scripts/hooks trees) are core; nested or other files never ship.
 * - Symlinks and non-regular files are skipped, never followed (#168).
 * - A malformed manifest fails closed: readManifest returns an error, never
 *   "missing", so a caller can never mistake it for a fresh install.
 * - A local edit is never destroyed: it is kept, or backed up before overwrite.
 * - Every install is planned and applied per LAYER: a layer only baselines,
 *   writes and stales its own entries; every other layer's entries are carried
 *   unchanged, and a path recorded under another layer is a conflict, never
 *   overwritten. Core is one layer; a preset overlay (#71 part 2b) is another.
 */

import { createHash } from 'node:crypto';
import {
  readFileSync, writeFileSync, readdirSync, lstatSync, mkdirSync, copyFileSync, chmodSync, renameSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { generatedSource } from './generated-marker.js';

/** Manifest location, relative to the target root. */
export const MANIFEST_PATH = '.rad/installed.json';
/** Where a newer core version is staged when the target copy was edited locally. */
export const PENDING_DIR = '.rad/upgrade-pending';
/** Where an unbaselined, differing target file is copied before it is overwritten. */
export const BACKUP_DIR = '.rad/upgrade-backup';

/** Manifest schema version this module reads and writes. */
const MANIFEST_VERSION = 1;
/** The layer the framework's own files (listCoreFiles) are recorded under. */
export const CORE_LAYER = 'core';
/** The layer a preset overlay's files are recorded under. */
export const PRESET_LAYER = 'preset';
/** A preset's installable files live in this subdirectory of the preset dir. */
export const PRESET_FILES_DIR = 'files';
/** Keys of the manifest's optional top-level `preset` block, each a string. */
const PRESET_META_KEYS = ['name', 'version', 'source'];
/** Recorded rad_version when the source revision cannot be determined. */
export const UNKNOWN_RAD_VERSION = 'unknown';
/** Permission bits copied from source to target (exec bits included). */
const PERMISSION_MASK = 0o777;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Directories whose whole subtree is core. */
const CORE_TREES = ['.claude/commands', '.claude/skills', 'ai', 'scripts/lib', 'scripts/hooks', 'harness'];
/** Directories where only top-level files with the given suffix are core. */
const CORE_FLAT = [{ dir: 'scripts', suffix: '.sh' }, { dir: 'scripts', suffix: '.mjs' }];
/** `rad generate` source trees: shipped whole, so a target can regenerate. */
const SOURCE_TREES = ['.rad/skills', '.rad/agents'];
/** User-data roots where only files carrying the generated marker are core. */
const MARKED_ROOTS = ['.claude/agents', '.agents/skills', '.codex/agents'];
/** Subtrees excluded from CORE_TREES (installed per-target, never copied). */
const EXCLUDED_TREES = ['harness/node_modules'];
/** OS litter never shipped. */
const IGNORED_NAMES = new Set(['.DS_Store']);

/** lstat that returns null for an absent path (any other error propagates). */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

/** Collect regular files under `rel` (posix relative to root), never following symlinks. */
function walkTree(root, rel, out) {
  if (EXCLUDED_TREES.includes(rel)) return;
  const st = lstatOrNull(join(root, rel));
  if (!st || !st.isDirectory()) return;
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (IGNORED_NAMES.has(entry.name)) continue;
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) walkTree(root, child, out);
    else if (entry.isFile()) out.add(child);
  }
}

/** Collect top-level regular files in `dir` ending in `suffix`. */
function walkFlat(root, { dir, suffix }, out) {
  const st = lstatOrNull(join(root, dir));
  if (!st || !st.isDirectory()) return;
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(suffix)) out.add(`${dir}/${entry.name}`);
  }
}

/** True when `source` lies under a shipped SOURCE_TREES entry (fail closed: null or anything else is not shipped). */
function isShippedSource(source) {
  return source !== null && SOURCE_TREES.some((tree) => source.startsWith(`${tree}/`));
}

/**
 * Collect regular files under `rel` whose generated marker names a shipped
 * source (symlinks never followed). Outputs of repo-internal sources, or
 * markers with no parseable source, stay out of core.
 */
function walkMarked(root, rel, out) {
  const found = new Set();
  walkTree(root, rel, found);
  for (const path of found) {
    if (isShippedSource(generatedSource(readFileSync(join(root, path), 'utf8')))) out.add(path);
  }
}

/**
 * The core file set of a RAD source tree: sorted posix paths relative to
 * `sourceRoot`. This is the ONLY definition of what RAD owns in a target.
 *
 * @param {string} sourceRoot
 * @returns {string[]}
 */
export function listCoreFiles(sourceRoot) {
  const out = new Set();
  for (const tree of CORE_TREES) walkTree(sourceRoot, tree, out);
  for (const flat of CORE_FLAT) walkFlat(sourceRoot, flat, out);
  for (const tree of SOURCE_TREES) walkTree(sourceRoot, tree, out);
  for (const root of MARKED_ROOTS) walkMarked(sourceRoot, root, out);
  return [...out].sort();
}

/** Hex sha256 of a file's bytes. */
export function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** True for a relative posix path with no '..', '.', or empty segment. */
export function isSafeRelPath(p) {
  if (typeof p !== 'string' || p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Shape error of the optional top-level `preset` block ('' when absent or valid). */
function presetMetaError(preset) {
  if (preset === undefined) return '';
  if (!isPlainObject(preset)) return "'preset' is not an object";
  const bad = PRESET_META_KEYS.find((k) => typeof preset[k] !== 'string');
  return bad ? `'preset.${bad}' is not a string` : '';
}

/** Shape errors of a parsed manifest (empty when valid). */
function manifestShapeError(m) {
  if (!isPlainObject(m)) return 'manifest is not a JSON object';
  if (m.version !== MANIFEST_VERSION) return `unsupported manifest version ${JSON.stringify(m.version)}`;
  const presetError = presetMetaError(m.preset);
  if (presetError) return presetError;
  const files = m.files;
  if (!isPlainObject(files)) return "'files' is not an object";
  for (const [path, entry] of Object.entries(files)) {
    if (!isSafeRelPath(path)) return `unsafe path ${JSON.stringify(path)}`;
    if (entry === null || typeof entry !== 'object') return `entry for ${path} is not an object`;
    if (typeof entry.layer !== 'string') return `entry for ${path} lacks a layer`;
    if (typeof entry.sha256 !== 'string' || !SHA256_HEX.test(entry.sha256)) return `entry for ${path} lacks a sha256`;
  }
  return '';
}

/**
 * Read and validate `<targetRoot>/.rad/installed.json`.
 *
 * @param {string} targetRoot
 * @returns {{ ok: true, manifest: object } | { ok: false, missing: true } | { ok: false, error: string }}
 */
export function readManifest(targetRoot) {
  const file = join(targetRoot, MANIFEST_PATH);
  const st = lstatOrNull(file);
  if (!st) return { ok: false, missing: true };
  if (!st.isFile()) return { ok: false, error: `${MANIFEST_PATH} is not a regular file` };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, error: `${MANIFEST_PATH} is not valid JSON: ${err.message}` };
  }
  const shape = manifestShapeError(parsed);
  if (shape) return { ok: false, error: `${MANIFEST_PATH} is malformed: ${shape}` };
  return { ok: true, manifest: parsed };
}

/**
 * Decide one core path's action. A non-regular target (symlink, directory) is
 * never written through: it is treated as a local edit and kept.
 */
function decideAction({ targetPath, sourceHash, baseline }) {
  const st = lstatOrNull(targetPath);
  if (!st) return baseline ? 'deleted' : 'write';
  if (!st.isFile()) return 'keep';
  const targetHash = hashFile(targetPath);
  if (targetHash === sourceHash) return 'write';
  if (baseline) return targetHash === baseline ? 'write' : 'keep';
  return 'backup-write';
}

/** Recorded entries split into `own` (entries of `layer`) and `carried` (every other layer). */
function splitRecorded(manifest, layer) {
  const own = {};
  const carried = {};
  for (const [path, entry] of Object.entries(manifest?.files ?? {})) {
    if (entry.layer === layer) own[path] = entry;
    else carried[path] = entry;
  }
  return { own, carried };
}

/** Throw unless every path is safe and names a regular file (never a followed symlink) under sourceRoot. */
function assertInstallableSources(sourceRoot, files) {
  for (const path of files) {
    if (!isSafeRelPath(path)) throw new Error(`refusing to plan: unsafe path ${JSON.stringify(path)}`);
    const st = lstatOrNull(join(sourceRoot, path));
    if (!st || !st.isFile()) throw new Error(`refusing to plan: ${path} is not a regular file in the source`);
  }
}

/**
 * Plan installing an explicit file list into `targetRoot` under `layer`. Read-only.
 * Throws (before anything is written) on an unsafe path or a source path that
 * is not a regular file; callers validate their list first (readPreset does).
 *
 * - baselines: only this layer's own recorded entries.
 * - `stale`: sorted recorded entries of this layer the list no longer ships
 *   (dropped from the new manifest; their files are left on disk).
 * - `conflicts`: sorted recorded paths of ANY other layer that the list ships.
 *   Actions are still computed for them, but callers MUST refuse to apply a
 *   plan whose `conflicts` is non-empty (applyLayerInstall throws as a backstop).
 * - `carried`: every other layer's entries, kept unchanged in the new manifest.
 * - `preset` / `radVersion`: the existing manifest's top-level values (or null),
 *   carried into the new manifest unless the apply call overrides them.
 *
 * @param {{ layer: string, files: string[], sourceRoot: string, targetRoot: string, manifest: object | null }} args
 * @returns {{ layer: string, actions: { path: string, action: string, sourceHash: string, baseline: string | null }[],
 *             stale: string[], conflicts: string[], carried: Object<string, { layer: string, sha256: string }>,
 *             preset: { name: string, version: string, source: string } | null, radVersion: string | null }}
 */
export function planLayerInstall({ layer, files, sourceRoot, targetRoot, manifest }) {
  assertInstallableSources(sourceRoot, files);
  const recorded = splitRecorded(manifest, layer);
  const actions = [...files].sort().map((path) => {
    const sourceHash = hashFile(join(sourceRoot, path));
    const baseline = Object.hasOwn(recorded.own, path) ? recorded.own[path].sha256 : null;
    const action = decideAction({ targetPath: join(targetRoot, path), sourceHash, baseline });
    return { path, action, sourceHash, baseline };
  });
  const shipped = new Set(files);
  const stale = Object.keys(recorded.own).filter((p) => !shipped.has(p)).sort();
  const conflicts = Object.keys(recorded.carried).filter((p) => shipped.has(p)).sort();
  const radVersion = typeof manifest?.rad_version === 'string' ? manifest.rad_version : null;
  return { layer, actions, stale, conflicts, carried: recorded.carried, preset: manifest?.preset ?? null, radVersion };
}

/**
 * Plan an install or upgrade of the core set into `targetRoot`: planLayerInstall
 * over listCoreFiles(sourceRoot) under the core layer. Read-only.
 *
 * @param {{ sourceRoot: string, targetRoot: string, manifest: object | null }} args
 * @returns {ReturnType<typeof planLayerInstall>}
 */
export function planInstall({ sourceRoot, targetRoot, manifest }) {
  return planLayerInstall({ layer: CORE_LAYER, files: listCoreFiles(sourceRoot), sourceRoot, targetRoot, manifest });
}

/** The directory a preset's installable files are read from. */
export function presetFilesRoot(presetDir) {
  return join(presetDir, PRESET_FILES_DIR);
}

/** Error returned by planPresetInstall when there is no manifest to install onto. */
export const PRESET_NEEDS_CORE_ERROR = `core is not installed (no ${MANIFEST_PATH}); run rad install-core first`;

/**
 * Plan a preset install: planLayerInstall under the preset layer, sourcing
 * `files` (posix paths relative to <presetDir>/files, as readPreset returns
 * them) from presetFilesRoot(presetDir). Read-only. A preset overlays an
 * installed core, so a null manifest is refused here, as a returned error,
 * rather than left to every caller.
 *
 * @param {{ presetDir: string, files: string[], targetRoot: string, manifest: object | null }} args
 * @returns {{ ok: true, plan: ReturnType<typeof planLayerInstall> } | { ok: false, error: string }}
 */
export function planPresetInstall({ presetDir, files, targetRoot, manifest }) {
  if (!manifest) return { ok: false, error: PRESET_NEEDS_CORE_ERROR };
  const plan = planLayerInstall({ layer: PRESET_LAYER, files, sourceRoot: presetFilesRoot(presetDir), targetRoot, manifest });
  return { ok: true, plan };
}

/** Filesystem-safe timestamp (no colons or dots) for a backup directory name. */
export function backupStamp(now) {
  return now.toISOString().replace(/[:.]/g, '-');
}

/** Copy `from` to `to`, creating parents and carrying the source permission bits. */
function copyWithMode(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  chmodSync(to, lstatSync(from).mode & PERMISSION_MASK);
}

/** The hash a path is recorded with in the new manifest, or null to omit it. */
function recordedHash({ action, sourceHash, baseline }) {
  if (action === 'write' || action === 'backup-write') return sourceHash;
  return baseline; // keep / deleted: the OLD baseline stays, so the next upgrade still sees the edit
}

/**
 * Build the manifest object with sorted file keys: the plan's layer entries
 * plus the carried ones. `installed_at` is the time of this write, whichever
 * layer made it. `preset` is written only when set, so a manifest that never
 * had a preset keeps its exact key order.
 */
function buildManifest(plan, { now, radVersion, preset }) {
  const unsorted = { ...(plan.carried ?? {}) };
  for (const a of plan.actions) {
    const sha256 = recordedHash(a);
    if (sha256) unsorted[a.path] = { layer: plan.layer ?? CORE_LAYER, sha256 };
  }
  const files = {};
  for (const path of Object.keys(unsorted).sort()) files[path] = unsorted[path];
  const head = { version: MANIFEST_VERSION, rad_version: radVersion, installed_at: now.toISOString() };
  return preset ? { ...head, preset, files } : { ...head, files };
}

/** Write the manifest atomically (temp file + rename) so a crash never leaves half a file. */
function writeManifest(targetRoot, manifest) {
  const file = join(targetRoot, MANIFEST_PATH);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/**
 * Execute a layer plan: copy writes, back up then overwrite backup-writes,
 * stage keeps under PENDING_DIR, leave deleted paths absent, and write the
 * manifest atomically. Stale paths are left on disk and dropped from the new
 * manifest; carried entries of other layers are kept unchanged. Throws, before
 * touching the filesystem, on a plan with conflicts: a layer must never
 * overwrite a file another layer owns.
 *
 * @param {{ sourceRoot: string, targetRoot: string, plan: ReturnType<typeof planLayerInstall>,
 *           now: Date, radVersion: string, preset?: object | null }} args
 *   `preset` replaces the plan's carried preset block when given (null removes it).
 * @returns {{ manifest: object, backupDir: string }} backupDir is relative to targetRoot
 */
export function applyLayerInstall({ sourceRoot, targetRoot, plan, now, radVersion, preset }) {
  if (plan.conflicts?.length) {
    throw new Error(`refusing to install: ${plan.layer ?? CORE_LAYER} ships paths another layer owns: ${plan.conflicts.join(', ')}`);
  }
  const backupDir = `${BACKUP_DIR}/${backupStamp(now)}`;
  for (const { path, action } of plan.actions) {
    const source = join(sourceRoot, path);
    const target = join(targetRoot, path);
    if (action === 'backup-write') copyWithMode(target, join(targetRoot, backupDir, path));
    if (action === 'write' || action === 'backup-write') copyWithMode(source, target);
    else if (action === 'keep') copyWithMode(source, join(targetRoot, PENDING_DIR, path));
  }
  const manifest = buildManifest(plan, { now, radVersion, preset: preset === undefined ? plan.preset : preset });
  writeManifest(targetRoot, manifest);
  return { manifest, backupDir };
}

/**
 * Execute a core plan (planInstall): applyLayerInstall with the plan's carried
 * preset block kept, so a core upgrade never drops preset metadata.
 *
 * @param {{ sourceRoot: string, targetRoot: string, plan: ReturnType<typeof planInstall>,
 *           now: Date, radVersion: string }} args
 * @returns {{ manifest: object, backupDir: string }}
 */
export function applyInstall({ sourceRoot, targetRoot, plan, now, radVersion }) {
  return applyLayerInstall({ sourceRoot, targetRoot, plan, now, radVersion });
}

/**
 * Execute a preset plan (planPresetInstall). The manifest's `rad_version` is
 * kept (a preset has no RAD source to read one from) and its `preset` block
 * becomes { name, version, source } with source the absolute preset dir.
 *
 * @param {{ presetDir: string, targetRoot: string, plan: ReturnType<typeof planLayerInstall>,
 *           now: Date, name: string, version: string }} args
 * @returns {{ manifest: object, backupDir: string }}
 */
export function applyPresetInstall({ presetDir, targetRoot, plan, now, name, version }) {
  if (plan.layer !== PRESET_LAYER) throw new Error(`refusing to install: plan is for layer ${plan.layer}, not ${PRESET_LAYER}`);
  const preset = { name, version, source: resolve(presetDir) };
  return applyLayerInstall({
    sourceRoot: presetFilesRoot(presetDir), targetRoot, plan, now, radVersion: plan.radVersion ?? UNKNOWN_RAD_VERSION, preset,
  });
}

/**
 * Compare a target to its manifest, every layer included. Read-only.
 *
 * @param {{ targetRoot: string, manifest: object }} args
 * @returns {{ modified: { path: string, layer: string }[], missing: { path: string, layer: string }[] }}
 *   each sorted by path
 */
export function installDrift({ targetRoot, manifest }) {
  const modified = [];
  const missing = [];
  for (const path of Object.keys(manifest.files).sort()) {
    const { layer, sha256 } = manifest.files[path];
    const target = join(targetRoot, path);
    const st = lstatOrNull(target);
    if (!st) missing.push({ path, layer });
    else if (!st.isFile() || hashFile(target) !== sha256) modified.push({ path, layer });
  }
  return { modified, missing };
}
