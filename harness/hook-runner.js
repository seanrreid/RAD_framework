/**
 * Wave lifecycle hook runner (post-wave observation + veto).
 *
 * A pure, injectable factory. It discovers operator-supplied hook scripts under
 * `<hooksDir>/<point>/` and runs them — in lexical filename order — via an
 * injected `sh` helper (the same shape `scripts/check-tests.sh` is invoked
 * with: argv + exit code as pass/fail). Hooks NEVER touch child_process here;
 * the runner shells out only through the injected `sh`, which keeps tests
 * hermetic. This module never reads the wave prompt and never mutates flow on
 * its own — it returns a structured result the spine consumes.
 *
 * Two classes of lifecycle point:
 *
 *   veto-capable (pre-wave, post-wave):
 *     A hook MAY abort the wave. It is FAIL-CLOSED — a crash, a non-zero exit,
 *     empty stdout, or an out-of-vocabulary token is treated as a veto. The
 *     fixed aborting outcome is 'abort-user' (an existing matrix outcome that
 *     resolves to `abort`), chosen because a veto is a deliberate operator stop,
 *     not a test/scope/protocol failure of the wave's own work.
 *
 *   observe-only (on-outcome, on-retry, on-error, wave-complete):
 *     A hook may only watch. It is FAIL-OPEN — a non-zero exit or thrown error
 *     records a `hook-failed` signal in `failures[]` but NEVER vetoes and NEVER
 *     changes flow.
 *
 * First-veto-wins: at a veto-capable point, the first hook that vetoes stops the
 * remaining hooks at that point.
 *
 * Outcome vocabulary is frozen (matrix.yaml, AC#7) — a veto must name one of:
 *   success | fail-tests | fail-scope | fail-protocol | fail-timeout |
 *   no-changes | abort-user
 *
 * See docs/harness-state-store.md and the wave contract for context.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The fixed 7-outcome vocabulary (mirrors matrix.yaml; do NOT extend here). */
const OUTCOME_VOCAB = new Set([
  'success',
  'fail-tests',
  'fail-scope',
  'fail-protocol',
  'fail-timeout',
  'no-changes',
  'abort-user',
]);

/** Points where a hook may abort the wave. */
const VETO_POINTS = new Set(['pre-wave', 'post-wave']);

/** Points where a hook may only observe. */
const OBSERVE_POINTS = new Set([
  'on-outcome',
  'on-retry',
  'on-error',
  'wave-complete',
]);

/** The fixed aborting outcome a fail-closed veto resolves to (see header). */
const VETO_ABORT_OUTCOME = 'abort-user';

/** Default directory holding `<point>/` hook subdirectories. */
const DEFAULT_HOOKS_DIR = 'scripts/hooks';

/**
 * Default script discovery: list executable files directly under
 * `<hooksDir>/<point>/`, in lexical filename order. An absent directory yields
 * an empty list (→ no-op). Injectable so tests need not touch the real FS.
 *
 * @param {string} hooksDir
 * @param {string} point
 * @returns {string[]} absolute-ish script paths in lexical order
 */
function defaultDiscover(hooksDir, point) {
  const dir = join(hooksDir, point);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).sort(); // lexical filename order (AC#6)
  const scripts = [];
  for (const name of names) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // a racing unlink — skip rather than abort discovery
    }
    if (!st.isFile()) continue;
    // Executable bit for owner/group/other (0o111). Operator hooks are scripts.
    if ((st.mode & 0o111) === 0) continue;
    scripts.push(full);
  }
  return scripts;
}

/**
 * Pull a single outcome token from a hook's stdout: the first non-empty
 * whitespace-delimited token of the first non-empty line. Returns '' when there
 * is no usable token (which a veto point treats as a fail-closed veto).
 *
 * @param {string} stdout
 * @returns {string}
 */
function parseOutcomeToken(stdout) {
  if (typeof stdout !== 'string') return '';
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    return trimmed.split(/\s+/)[0];
  }
  return '';
}

/**
 * Create a hook runner.
 *
 * @param {Object} [opts]
 * @param {Function} opts.sh - injected shell-out helper, same contract as the
 *   StateStore's: `(file, args, opts) => { status, stdout, stderr }`. Required
 *   for any hook to actually run.
 * @param {Function} [opts.now] - injected clock returning a timestamp; reserved
 *   for the spine's event stamping (the runner itself stays time-agnostic).
 * @param {string} [opts.hooksDir] - root holding `<point>/` subdirs.
 * @param {Function} [opts.discover] - `(hooksDir, point) => string[]`; injectable
 *   discovery so tests avoid real-FS coupling. Defaults to {@link defaultDiscover}.
 * @returns {{ runHooks: (point: string, ctx: Object) => Object }}
 */
export function createHookRunner({
  sh,
  now,
  hooksDir = DEFAULT_HOOKS_DIR,
  discover = defaultDiscover,
} = {}) {
  /**
   * Run every hook registered at `point`, in lexical order.
   *
   * @param {string} point - one of the veto-capable or observe-only points.
   * @param {Object} [ctx]
   * @param {string} [ctx.feature]
   * @param {(number|string)} [ctx.wave]
   * @param {string} [ctx.outcome] - the wave's current outcome (passed as $4).
   * @returns {{ point: string, ran: Array, veto: (Object|null), failures: Array }}
   *   A neutral result (`ran: [], veto: null, failures: []`) when no hooks exist.
   */
  function runHooks(point, ctx = {}) {
    const isVeto = VETO_POINTS.has(point);
    const isObserve = OBSERVE_POINTS.has(point);

    const result = { point, ran: [], veto: null, failures: [] };

    // An unknown point and an absent hooks dir both fold to a clean no-op: the
    // runner observes, it does not police the spine's point vocabulary.
    if (!isVeto && !isObserve) return result;

    const scripts = discover(hooksDir, point);
    if (scripts.length === 0) return result;

    // Context passed to each hook as positional argv (mirrors check-tests.sh's
    // $1=feature) plus RAD_HOOK_* env for hooks that prefer named inputs.
    const feature = ctx.feature ?? '';
    const wave = ctx.wave ?? '';
    const current = ctx.outcome ?? '';
    const argv = [String(feature), String(wave), point, String(current)];
    const env = {
      RAD_HOOK_FEATURE: String(feature),
      RAD_HOOK_WAVE: String(wave),
      RAD_HOOK_POINT: point,
      RAD_HOOK_OUTCOME: String(current),
    };

    for (const hook of scripts) {
      let res;
      let threw = false;
      try {
        res = sh(hook, argv, { env });
      } catch (err) {
        threw = true;
        res = { status: 1, stdout: '', stderr: String(err && err.message) };
      }
      const status = res && typeof res.status === 'number' ? res.status : 1;
      const stdout = res && typeof res.stdout === 'string' ? res.stdout : '';

      if (isObserve) {
        // FAIL-OPEN: record a failure signal but never veto, never change flow.
        const ok = !threw && status === 0;
        result.ran.push({ hook, exit: status, vetoed: false, outcome: null });
        if (!ok) {
          result.failures.push({
            hook,
            reason: threw ? 'threw' : `exit ${status}`,
          });
        }
        continue;
      }

      // ── veto-capable point: FAIL-CLOSED ──────────────────────────────────
      // A crash, a non-zero exit, or unusable/out-of-vocabulary stdout all
      // become a veto with the fixed aborting outcome. A clean exit with a
      // valid in-vocabulary token vetoes with THAT operator-named outcome;
      // a clean exit whose token is 'success' is an explicit pass (no veto).
      if (threw || status !== 0) {
        const reason = threw ? 'threw' : `exit ${status}`;
        result.failures.push({ hook, reason });
        result.ran.push({
          hook,
          exit: status,
          vetoed: true,
          outcome: VETO_ABORT_OUTCOME,
        });
        result.veto = { hook, outcome: VETO_ABORT_OUTCOME };
        break; // first-veto-wins (AC short-circuit)
      }

      const token = parseOutcomeToken(stdout);
      if (token === '' || !OUTCOME_VOCAB.has(token)) {
        // Empty or out-of-vocabulary on a veto point → fail-closed veto.
        result.failures.push({
          hook,
          reason: token === '' ? 'empty-stdout' : `bad-token:${token}`,
        });
        result.ran.push({
          hook,
          exit: status,
          vetoed: true,
          outcome: VETO_ABORT_OUTCOME,
        });
        result.veto = { hook, outcome: VETO_ABORT_OUTCOME };
        break;
      }

      if (token === 'success') {
        // An explicit pass: the hook ran clean and approves the wave.
        result.ran.push({ hook, exit: status, vetoed: false, outcome: 'success' });
        continue;
      }

      // A valid, non-success outcome token is a deliberate operator veto.
      result.ran.push({ hook, exit: status, vetoed: true, outcome: token });
      result.veto = { hook, outcome: token };
      break; // first-veto-wins
    }

    return result;
  }

  return { runHooks };
}

export { OUTCOME_VOCAB, VETO_POINTS, OBSERVE_POINTS, VETO_ABORT_OUTCOME };
