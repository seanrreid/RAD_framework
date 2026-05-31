/**
 * Git ArtifactStore adapter (design Decision 3 — the document half of the seam).
 *
 * Git's actual job: storing the *content* of the narrative documents (plan,
 * research, execution log). This store reads and writes those documents on the
 * work branch; it knows nothing about state.
 *
 * Decision 2 — status NEVER lives in the doc. The plan doc's `Status:` is a
 * rendered PROJECTION of the StateStore log, not a stored field. This store
 * therefore exposes NO method that mutates a document's Status field: `write()`
 * persists whatever content the caller supplies verbatim, and any status the
 * caller wants to display must be read from the StateStore projection and
 * rendered around the document — never written into the artifact here.
 *
 * See docs/harness-state-store.md for the authoritative spec.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';

/** A safe feature slug (see git-state-store.js): no path separators, no '..'. */
function isSafeFeature(feature) {
  return typeof feature === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(feature);
}

/**
 * Assert that an absolute path stays within repoRoot. Both `feature` and `name`
 * arrive from callers handling untrusted input; without this an explicit `name`
 * like '../../etc/passwd' would escape the repo via path.join. Throws otherwise.
 */
function assertWithinRepo(repoRoot, abs) {
  const rel = relative(repoRoot, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`artifact path escapes repoRoot: ${JSON.stringify(abs)}`);
  }
}

/**
 * Resolve a document name to its on-disk path under repoRoot. Two modes:
 *
 *   - NAMED (no '/' or '.'): maps to the repo's layout, namespaced by feature —
 *       'plan'     → .agents/plans/<feature>.md
 *       'research' → .agents/research/<feature>.md
 *       'log'      → .agents/logs/<feature>.md
 *     Requires a safe `feature` slug.
 *
 *   - EXPLICIT (contains '/' or '.', e.g. a dated log filename or a relative
 *     path): treated as a repo-relative path VERBATIM. `feature` is intentionally
 *     ignored in this mode — the caller owns the full path. The resolved path is
 *     bounds-checked to remain within repoRoot (no '..' escape).
 *
 * @param {string} repoRoot
 * @param {string} feature
 * @param {string} name
 * @returns {string} absolute path (guaranteed within repoRoot)
 */
function resolvePath(repoRoot, feature, name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('artifact name is required');
  }

  // EXPLICIT mode: repo-relative path used as-is, but bounds-checked. `feature`
  // is deliberately not applied here — the caller supplies the full path.
  if (name.includes('/') || name.includes('.')) {
    const abs = resolve(repoRoot, name);
    assertWithinRepo(repoRoot, abs);
    return abs;
  }

  // NAMED mode: namespaced by feature, which must be a safe slug.
  if (!isSafeFeature(feature)) {
    throw new Error(
      `invalid feature slug ${JSON.stringify(feature)} ` +
        `(expected /^[a-z0-9][a-z0-9-]*$/ for a named artifact)`,
    );
  }
  switch (name) {
    case 'plan':
      return join(repoRoot, '.agents', 'plans', `${feature}.md`);
    case 'research':
      return join(repoRoot, '.agents', 'research', `${feature}.md`);
    case 'log':
      return join(repoRoot, '.agents', 'logs', `${feature}.md`);
    default:
      throw new Error(
        `unknown artifact name '${name}' ` +
          `(expected 'plan' | 'research' | 'log', or an explicit repo-relative path)`,
      );
  }
}

/**
 * Create a Git ArtifactStore.
 *
 * @param {{ repoRoot: string }} opts - repoRoot: absolute path to the working tree
 * @returns {import('../events.js').ArtifactStore}
 */
export function createGitArtifactStore({ repoRoot } = {}) {
  if (!repoRoot) throw new Error('createGitArtifactStore: repoRoot is required');

  /**
   * Read a document's content, or null if it does not exist on the work branch.
   *
   * @param {string} feature
   * @param {string} name
   * @returns {string|null}
   */
  function read(feature, name) {
    const file = resolvePath(repoRoot, feature, name);
    if (!existsSync(file)) return null;
    return readFileSync(file, 'utf8');
  }

  /**
   * Write a document's content verbatim. Git holds the document; this is the
   * only mutation the artifact store performs, and it does NOT interpret or
   * inject a Status field (Decision 2 — status is a projection of the log, never
   * written into the artifact).
   *
   * @param {string} feature
   * @param {string} name
   * @param {string} content
   * @returns {void}
   */
  function write(feature, name, content) {
    if (typeof content !== 'string') {
      throw new TypeError('write(feature, name, content): content must be a string');
    }
    const file = resolvePath(repoRoot, feature, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
  }

  return { read, write };
}
