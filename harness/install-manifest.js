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
 * - Symlinks and non-regular files are skipped, never followed (#168).
 * - A malformed manifest fails closed: readManifest returns an error, never
 *   "missing", so a caller can never mistake it for a fresh install.
 * - A local edit is never destroyed: it is kept, or backed up before overwrite.
 */

import { createHash } from 'node:crypto';
import {
  readFileSync, writeFileSync, readdirSync, lstatSync, mkdirSync, copyFileSync, chmodSync, renameSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

/** Manifest location, relative to the target root. */
export const MANIFEST_PATH = '.rad/installed.json';
/** Where a newer core version is staged when the target copy was edited locally. */
export const PENDING_DIR = '.rad/upgrade-pending';
/** Where an unbaselined, differing target file is copied before it is overwritten. */
export const BACKUP_DIR = '.rad/upgrade-backup';

/** Manifest schema version this module reads and writes. */
const MANIFEST_VERSION = 1;
/** The only layer this module WRITES: entries it installs are recorded as core. */
const CORE_LAYER = 'core';
/**
 * The layer a preset overlay records. This module never writes it; it only
 * carries recorded non-core entries (this one or any other layer string) over
 * unchanged, and never overwrites the files they name.
 */
export const PRESET_LAYER = 'preset';
/** Recorded rad_version when the source revision cannot be determined. */
export const UNKNOWN_RAD_VERSION = 'unknown';
/** Permission bits copied from source to target (exec bits included). */
const PERMISSION_MASK = 0o777;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Directories whose whole subtree is core. */
const CORE_TREES = ['.claude/commands', '.claude/skills', 'ai', 'scripts/lib', 'scripts/hooks', 'harness'];
/** Directories where only top-level files with the given suffix are core. */
const CORE_FLAT = [{ dir: 'scripts', suffix: '.sh' }];
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
  return [...out].sort();
}

/** Hex sha256 of a file's bytes. */
export function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** True for a relative posix path with no '..', '.', or empty segment. */
function isSafeRelPath(p) {
  if (typeof p !== 'string' || p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Shape errors of a parsed manifest (empty when valid). */
function manifestShapeError(m) {
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return 'manifest is not a JSON object';
  if (m.version !== MANIFEST_VERSION) return `unsupported manifest version ${JSON.stringify(m.version)}`;
  const files = m.files;
  if (files === null || typeof files !== 'object' || Array.isArray(files)) return "'files' is not an object";
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

/** Recorded entries split by layer: `core` (this module's) and `carried` (every other layer). */
function splitRecorded(manifest) {
  const core = {};
  const carried = {};
  for (const [path, entry] of Object.entries(manifest?.files ?? {})) {
    if (entry.layer === CORE_LAYER) core[path] = entry;
    else carried[path] = entry;
  }
  return { core, carried };
}

/**
 * Plan an install or upgrade of the core set into `targetRoot`. Read-only.
 *
 * - `stale`: recorded core-layer paths core no longer ships.
 * - `conflicts`: sorted recorded non-core paths that core now ships. Actions are
 *   still computed for them, but callers MUST refuse to apply a plan whose
 *   `conflicts` is non-empty (applyInstall throws on one as a backstop).
 * - `carried`: every recorded non-core entry (any layer string but core), which
 *   the new manifest keeps unchanged.
 *
 * @param {{ sourceRoot: string, targetRoot: string, manifest: object | null }} args
 * @returns {{ actions: { path: string, action: string, sourceHash: string, baseline: string | null }[],
 *             stale: string[], conflicts: string[], carried: Object<string, { layer: string, sha256: string }> }}
 */
export function planInstall({ sourceRoot, targetRoot, manifest }) {
  const recorded = splitRecorded(manifest);
  const core = listCoreFiles(sourceRoot);
  const actions = core.map((path) => {
    const sourceHash = hashFile(join(sourceRoot, path));
    const baseline = Object.hasOwn(recorded.core, path) ? recorded.core[path].sha256 : null;
    const action = decideAction({ targetPath: join(targetRoot, path), sourceHash, baseline });
    return { path, action, sourceHash, baseline };
  });
  const coreSet = new Set(core);
  const stale = Object.keys(recorded.core).filter((p) => !coreSet.has(p)).sort();
  const conflicts = Object.keys(recorded.carried).filter((p) => coreSet.has(p)).sort();
  return { actions, stale, conflicts, carried: recorded.carried };
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

/** Build the manifest object with sorted file keys: core entries plus the carried non-core ones. */
function buildManifest(plan, { now, radVersion }) {
  const unsorted = { ...(plan.carried ?? {}) };
  for (const a of plan.actions) {
    const sha256 = recordedHash(a);
    if (sha256) unsorted[a.path] = { layer: CORE_LAYER, sha256 };
  }
  const files = {};
  for (const path of Object.keys(unsorted).sort()) files[path] = unsorted[path];
  return { version: MANIFEST_VERSION, rad_version: radVersion, installed_at: now.toISOString(), files };
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
 * Execute a plan: copy writes, back up then overwrite backup-writes, stage
 * keeps under PENDING_DIR, leave deleted paths absent, and write the manifest.
 * Stale manifest paths are left on disk and dropped from the new manifest;
 * carried non-core entries are kept unchanged. Throws, before touching the
 * filesystem, on a plan with conflicts: core must never overwrite a file
 * another layer owns.
 *
 * @param {{ sourceRoot: string, targetRoot: string, plan: ReturnType<typeof planInstall>,
 *           now: Date, radVersion: string }} args
 * @returns {{ manifest: object, backupDir: string }} backupDir is relative to targetRoot
 */
export function applyInstall({ sourceRoot, targetRoot, plan, now, radVersion }) {
  if (plan.conflicts?.length) {
    throw new Error(`refusing to install: core now ships paths another layer owns: ${plan.conflicts.join(', ')}`);
  }
  const backupDir = `${BACKUP_DIR}/${backupStamp(now)}`;
  for (const { path, action } of plan.actions) {
    const source = join(sourceRoot, path);
    const target = join(targetRoot, path);
    if (action === 'backup-write') copyWithMode(target, join(targetRoot, backupDir, path));
    if (action === 'write' || action === 'backup-write') copyWithMode(source, target);
    else if (action === 'keep') copyWithMode(source, join(targetRoot, PENDING_DIR, path));
  }
  const manifest = buildManifest(plan, { now, radVersion });
  writeManifest(targetRoot, manifest);
  return { manifest, backupDir };
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
