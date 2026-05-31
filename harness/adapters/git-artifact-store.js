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
import { join, dirname } from 'node:path';

/**
 * Resolve a document name to its on-disk path under repoRoot. Names map to the
 * repo's existing layout:
 *   - 'plan'     → .agents/plans/<feature>.md
 *   - 'research' → .agents/research/<feature>.md
 *   - 'log'      → .agents/logs/<feature>.md
 * A name containing a path separator or '.' (e.g. an explicit relative path or a
 * dated log filename) is treated as a repo-relative path verbatim.
 *
 * @param {string} repoRoot
 * @param {string} feature
 * @param {string} name
 * @returns {string} absolute path
 */
function resolvePath(repoRoot, feature, name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('artifact name is required');
  }

  // An explicit path or a filename with an extension is used as-is (repo-relative).
  if (name.includes('/') || name.includes('.')) {
    return join(repoRoot, name);
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
