/**
 * Command (driven) wave adapter — the DEFAULT, vendor-neutral runner.
 *
 * It shells out to an operator-configured CLI agent (e.g. "claude -p",
 * "codex exec", "aider") and drives a wave through the same plain-text
 * WAVE_RESULT contract every adapter shares (./contract.js). It imports NO
 * vendor SDK and never reads or requires ANTHROPIC_API_KEY: credentials are the
 * configured command's concern, not this adapter's.
 *
 * Interface (identical to the SDK adapter): runWave(wave, planCtx) -> result,
 * where result includes `outcome` (matrix string the spine reads),
 * `status`, and `tasks` (for logging).
 *
 * Security:
 *   - The child is spawned with a controlled, ALLOW-LISTED env subset (PATH,
 *     HOME, plus a few innocuous locale/temp vars) — the full process.env (and
 *     any secrets in it) is NOT forwarded.
 *   - The prompt is fed on stdin (or substituted for a `{prompt}` token). The
 *     prompt's full contents are never logged at error time; only sanitized,
 *     truncated error summaries surface.
 */

import { spawn } from 'node:child_process';

import {
  buildWavePrompt,
  extractWaveResultBlock,
  parseWaveResult,
  resultToOutcome,
  syntheticFailure,
  sanitizeErrorMessage,
  classifyError,
  withTimeout,
} from './contract.js';

/** Env vars that are safe to forward to the child. Secrets are NOT in this set. */
const ENV_ALLOW_LIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'];

/** Build the allow-listed env handed to the spawned child. */
function buildChildEnv() {
  const env = {};
  for (const key of ENV_ALLOW_LIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/**
 * Tokenize a command string into [file, ...args], substituting a literal
 * `{prompt}` placeholder token with the prompt when present. Whitespace-split is
 * sufficient for the simple commands this adapter targets ("claude -p",
 * "codex exec", "aider"); operators needing shell features can wrap their own
 * script and configure that as `cmd`.
 *
 * @param {string} cmd
 * @param {string} prompt
 * @returns {{ argv: string[], usedPlaceholder: boolean }}
 */
function tokenizeCommand(cmd, prompt) {
  const parts = String(cmd).trim().split(/\s+/).filter(Boolean);
  let usedPlaceholder = false;
  const argv = parts.map((part) => {
    if (part.includes('{prompt}')) {
      usedPlaceholder = true;
      return part.replace('{prompt}', prompt);
    }
    return part;
  });
  return { argv, usedPlaceholder };
}

/**
 * Run the configured command once, feeding the prompt on stdin (unless a
 * `{prompt}` placeholder already injected it). Resolves with the captured
 * stdout/stderr/exit code; rejects only on spawn-level failure (e.g. ENOENT).
 *
 * @param {string} cmd
 * @param {string} prompt
 * @param {string} [repoRoot]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string }>}
 */
function spawnOnce(cmd, prompt, repoRoot) {
  return new Promise((resolve, reject) => {
    const { argv, usedPlaceholder } = tokenizeCommand(cmd, prompt);
    if (argv.length === 0) {
      reject(new Error('command adapter: empty cmd'));
      return;
    }
    const [file, ...args] = argv;

    let child;
    try {
      child = spawn(file, args, {
        cwd: repoRoot,
        env: buildChildEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve({ code, stdout, stderr }));

    // Feed the prompt on stdin unless it was already substituted into argv.
    if (!usedPlaceholder) {
      child.stdin.write(prompt);
    }
    child.stdin.end();
  });
}

/**
 * Create a command-backed runWave.
 *
 * @param {Object} opts
 * @param {string} opts.cmd - the agent CLI to spawn (e.g. "claude -p")
 * @param {string} [opts.repoRoot] - cwd for the child
 * @param {number} [opts.timeoutMs] - wall-clock deadline per wave (default 10m)
 * @returns {(wave: Object, planCtx: Object) => Promise<{ outcome: string, status: string, tasks: Array }>}
 */
export function createCommandAdapter({ cmd, repoRoot, timeoutMs = 600000 } = {}) {
  if (!cmd) throw new Error('createCommandAdapter: cmd is required');

  /** Wrap a parsed `{ status, tasks }` into the full spine-facing result. */
  function toResult(parsed) {
    return {
      outcome: resultToOutcome(parsed),
      status: parsed.status,
      tasks: parsed.tasks,
    };
  }

  /**
   * Run the command once and return { stdout, terminal } where `terminal` is a
   * non-null result when the run itself failed (timeout / spawn error /
   * non-zero exit) and should short-circuit. A successful run returns stdout
   * with terminal === null.
   */
  async function runCommand(prompt, waveId) {
    let run;
    try {
      run = await withTimeout(spawnOnce(cmd, prompt, repoRoot), timeoutMs);
    } catch (err) {
      const message = sanitizeErrorMessage(err?.message ?? String(err));
      // withTimeout rejects with a message classifyError buckets 'transient';
      // for this driven adapter a wall-clock timeout is terminal 'fail-timeout'.
      if (classifyError(err) === 'transient' && /timed out/.test(message)) {
        return { stdout: '', terminal: { outcome: 'fail-timeout', status: 'failed', tasks: syntheticFailure(waveId, message).tasks } };
      }
      // Spawn-level failure (ENOENT, etc.) — classify and surface terminally.
      const parsed = syntheticFailure(waveId, message);
      return { stdout: '', terminal: toResult(parsed) };
    }

    if (run.code !== 0) {
      const stderrSummary = sanitizeErrorMessage((run.stderr || '').slice(0, 500));
      const message = `command exited with code ${run.code}: ${stderrSummary}`.trim();
      const parsed = syntheticFailure(waveId, message);
      return { stdout: run.stdout, terminal: toResult(parsed) };
    }

    return { stdout: run.stdout, terminal: null };
  }

  /**
   * @param {Object} wave
   * @param {Object} planCtx
   * @returns {Promise<{ outcome: string, status: string, tasks: Array }>}
   */
  return async function runWave(wave, planCtx) {
    const waveId = wave.n ?? wave.number ?? wave.id ?? '?';
    const prompt = buildWavePrompt(wave, planCtx);

    // First attempt.
    const first = await runCommand(prompt, waveId);
    if (first.terminal) return first.terminal;

    let block = extractWaveResultBlock(first.stdout);
    if (block) return toResult(parseWaveResult(block));

    // Missing WAVE_RESULT — re-prompt EXACTLY once, asking specifically for it.
    const reprompt =
      prompt +
      '\n\nYour previous response did not include the required WAVE_RESULT block. ' +
      'Re-run the wave and end your response with exactly one WAVE_RESULT ... ' +
      'END_WAVE_RESULT block, and nothing after it.';

    const second = await runCommand(reprompt, waveId);
    if (second.terminal) return second.terminal;

    block = extractWaveResultBlock(second.stdout);
    if (block) return toResult(parseWaveResult(block));

    // Still no protocol block after one reprompt — terminal protocol failure.
    return {
      outcome: 'fail-protocol',
      status: 'failed',
      tasks: syntheticFailure(waveId, 'No WAVE_RESULT block after one reprompt').tasks,
    };
  };
}
