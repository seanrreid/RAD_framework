import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The marker worktree-lifecycle.sh writes at a worktree's root. */
export const MARKER_NAME = '.rad-worktree.json';
export const STATUS_ACTIVE = 'active';
export const STATUS_PRESERVED = 'preserved';

/**
 * Worktree lifecycle adapter — an injectable port over scripts/worktree-lifecycle.sh.
 *
 * This is pure wiring: every side effect goes through the INJECTED `sh` boundary
 * (the same Bash port the spine/cli use), so the adapter is unit-testable with a
 * fake `sh` and never touches child_process directly. Worktrees are invisible to
 * the spine and the agent adapters — this module just translates lifecycle intents
 * into script invocations.
 *
 * `sh` signature mirrors the other adapters:
 *   sh(file, args, { cwd }) -> { status, stdout, stderr }
 *   (non-zero status = failure)
 *
 * @param {Object} ports
 * @param {(file: string, args?: string[], opts?: { cwd?: string }) => { status: number, stdout: string, stderr: string }} ports.sh - Bash boundary
 * @param {() => string} ports.now - injected clock (ISO timestamp); reserved for timestamp needs
 * reactivate/readMarker are plain JS file I/O on the marker (not via `sh`): the
 * script has no reactivate subcommand, and it stays unchanged.
 *
 * @returns {{ create(feature: string, branch: string): string, complete(feature: string, dir?: string): void, preserve(feature: string, dir?: string): void, reactivate(dir: string): string, readMarker(dir: string): Object|null }}
 */
export function makeWorktreeLifecycle({ sh, now }) {
  const SCRIPT = 'scripts/worktree-lifecycle.sh';

  // The injected clock is part of the port contract for any timestamp need; the
  // script stamps its own marker, so we don't pass `now` through today.
  void now;

  function run(args) {
    const result = sh(SCRIPT, args);
    if (result.status !== 0) {
      throw new Error(
        `worktree-lifecycle ${args[0]} failed (status ${result.status}): ` +
          `${result.stderr || result.stdout || 'no output'}`,
      );
    }
    return result;
  }

  return {
    /** Create an isolated worktree for `feature` on `branch`; returns its path. */
    create(feature, branch) {
      const result = run(['create', feature, branch]);
      // The script prints the resolved dir as the last line of stdout.
      const lines = String(result.stdout).trim().split('\n');
      return lines[lines.length - 1];
    },

    /** Tear down the feature's worktree (refused by the script unless marked). */
    complete(feature, dir) {
      run(withDir(['remove', feature], dir));
    },

    /** Keep the worktree in place, marking it preserved. */
    preserve(feature, dir) {
      run(withDir(['preserve', feature], dir));
    },

    /** Flip a preserved worktree's marker back to active; returns `dir`. */
    reactivate(dir) {
      const marker = readMarker(dir);
      if (!marker) throw new Error(`cannot reactivate '${dir}' — no ${MARKER_NAME}`);
      if (marker.status !== STATUS_PRESERVED) {
        throw new Error(
          `cannot reactivate '${dir}' — marker status is '${marker.status}', not '${STATUS_PRESERVED}'`,
        );
      }
      const next = { ...marker, status: STATUS_ACTIVE };
      writeFileSync(join(dir, MARKER_NAME), `${JSON.stringify(next, null, 2)}\n`);
      return dir;
    },

    readMarker,
  };
}

/** Append the optional explicit worktree dir the script accepts as its last arg. */
function withDir(args, dir) {
  return dir ? [...args, dir] : args;
}

/**
 * The parsed marker at `<dir>/.rad-worktree.json`, or null when there is none.
 * A malformed marker throws — fail closed rather than treat it as absent.
 */
export function readMarker(dir) {
  const path = join(dir, MARKER_NAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`malformed ${MARKER_NAME} at '${dir}': ${err.message}`);
  }
}
