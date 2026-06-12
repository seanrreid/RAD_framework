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
 * @returns {{ create(feature: string, branch: string): string, complete(feature: string): void, preserve(feature: string): void }}
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
    complete(feature) {
      run(['remove', feature]);
    },

    /** Keep the worktree in place, marking it preserved. */
    preserve(feature) {
      run(['preserve', feature]);
    },
  };
}
