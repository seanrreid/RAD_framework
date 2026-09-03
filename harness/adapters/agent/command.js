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
 * where result includes `outcome` (matrix string the spine reads) and `status`,
 * plus the OPTIONAL `tasks` (per-task records, for logging) and `usage`
 * (normalized token counts) — both omitted when there is nothing to report.
 * The result is assembled by contract.toWaveResult so the shape is defined once.
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
  toWaveResult,
  syntheticFailure,
  sanitizeErrorMessage,
  withTimeout,
  normalizeUsage,
} from './contract.js';

/**
 * Env vars that are safe to forward to the child. This set carries process
 * identity needed for credential lookup — `USER` resolves the OS keychain
 * entry some CLIs (e.g. git credential helpers) depend on — plus locale/temp
 * plumbing. Secrets are NOT in this set: `USER` is a username, not a secret.
 */
const ENV_ALLOW_LIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'USER'];

/** Hard cap on captured child output. A runaway agent that floods stdout is
 * killed rather than buffered into an OOM before the wall-clock timeout fires. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB

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
 * Per-wave model tiering: when the `cmd` template references a `{model}` token,
 * it is substituted with `effectiveModel` (the per-wave override, falling back to
 * any construction-time default). When the template references no `{model}` token
 * the model is simply unused here — driven-CLI model selection is otherwise the
 * configured command's own concern, so behavior is unchanged for fixed CLIs.
 *
 * @param {string} cmd
 * @param {string} prompt
 * @param {string} [effectiveModel]
 * @returns {{ argv: string[], usedPlaceholder: boolean }}
 */
function tokenizeCommand(cmd, prompt, effectiveModel) {
  const parts = String(cmd).trim().split(/\s+/).filter(Boolean);
  let usedPlaceholder = false;
  const argv = parts.map((part) => {
    let out = part;
    if (out.includes('{model}') && effectiveModel) {
      out = out.split('{model}').join(effectiveModel);
    }
    if (out.includes('{prompt}')) {
      usedPlaceholder = true;
      out = out.split('{prompt}').join(prompt);
    }
    return out;
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
 * @param {string} [effectiveModel]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string }>}
 */
function spawnOnce(cmd, prompt, repoRoot, effectiveModel) {
  return new Promise((resolve, reject) => {
    const { argv, usedPlaceholder } = tokenizeCommand(cmd, prompt, effectiveModel);
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
    let total = 0;
    let truncated = false;
    // Cap combined output: a misbehaving agent must not OOM the orchestrator
    // while we wait for the wall-clock timeout. On overflow, kill the child and
    // surface `truncated` so the caller routes a terminal protocol failure.
    const capture = (chunk, append) => {
      if (truncated) return;
      const s = chunk.toString();
      total += Buffer.byteLength(s);
      if (total > MAX_OUTPUT_BYTES) {
        truncated = true;
        child.kill('SIGKILL');
        return;
      }
      append(s);
    };
    child.stdout.on('data', (d) => capture(d, (s) => { stdout += s; }));
    child.stderr.on('data', (d) => capture(d, (s) => { stderr += s; }));
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve({ code, stdout, stderr, truncated }));

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
 * @param {string} [opts.model] - construction-time default model; only used when
 *   a `{model}` token appears in `cmd` and a wave declares no override
 * @param {number} [opts.timeoutMs] - wall-clock deadline per wave (default 10m)
 * @returns {(wave: Object, planCtx: Object) => Promise<{ outcome: string, status: string, tasks?: Array, usage?: Object }>}
 */
export function createCommandAdapter({ cmd, repoRoot, model, timeoutMs = 600000 } = {}) {
  if (!cmd) throw new Error('createCommandAdapter: cmd is required');

  /**
   * Best-effort usage extraction from a CLI's stdout. Most agent CLIs emit NO
   * machine-readable usage, in which case this returns undefined and the field
   * is omitted. A wrapper that DOES know its token counts can emit a single
   * `RAD_USAGE {json}` line (e.g. `RAD_USAGE {"input_tokens":10,"output_tokens":5}`)
   * which is normalized to `{ input, output, total }`.
   *
   * @param {string} stdout
   * @returns {{ input: number, output: number, total: number } | undefined}
   */
  function extractUsage(stdout) {
    const match = /^RAD_USAGE\s+(\{.*\})\s*$/m.exec(stdout || '');
    if (!match) return undefined;
    try {
      return normalizeUsage(JSON.parse(match[1]));
    } catch {
      // Malformed usage line is non-fatal: usage stays optional, omit it.
      return undefined;
    }
  }

  /**
   * Run the command once and return { stdout, terminal } where `terminal` is a
   * non-null result when the run itself failed (timeout / spawn error /
   * non-zero exit) and should short-circuit. A successful run returns stdout
   * with terminal === null.
   */
  async function runCommand(prompt, waveId, effectiveModel) {
    let run;
    try {
      run = await withTimeout(spawnOnce(cmd, prompt, repoRoot, effectiveModel), timeoutMs);
    } catch (err) {
      const message = sanitizeErrorMessage(err?.message ?? String(err));
      // A wall-clock timeout (sentinel-tagged by withTimeout) is terminal
      // 'fail-timeout' for this driven adapter — never misread a spawn-level
      // ETIMEDOUT as our deadline by parsing the message string.
      if (err && err._isRadTimeout) {
        return { stdout: '', terminal: { outcome: 'fail-timeout', status: 'failed', tasks: syntheticFailure(waveId, message).tasks } };
      }
      // Spawn-level failure (ENOENT, etc.) — classify and surface terminally.
      const parsed = syntheticFailure(waveId, message);
      return { stdout: '', terminal: toWaveResult(parsed) };
    }

    // A runaway agent that blew the output cap was killed — terminal protocol fail.
    if (run.truncated) {
      const message = `command output exceeded ${MAX_OUTPUT_BYTES} bytes — process killed`;
      return { stdout: run.stdout, terminal: { outcome: 'fail-protocol', status: 'failed', tasks: syntheticFailure(waveId, message).tasks } };
    }

    if (run.code !== 0) {
      const stderrSummary = sanitizeErrorMessage((run.stderr || '').slice(0, 500));
      const message = `command exited with code ${run.code}: ${stderrSummary}`.trim();
      const parsed = syntheticFailure(waveId, message);
      return { stdout: run.stdout, terminal: toWaveResult(parsed) };
    }

    return { stdout: run.stdout, terminal: null };
  }

  /**
   * @param {Object} wave
   * @param {Object} planCtx
   * @returns {Promise<{ outcome: string, status: string, tasks?: Array, usage?: Object }>}
   */
  return async function runWave(wave, planCtx) {
    const waveId = wave.n ?? wave.number ?? wave.id ?? '?';
    const prompt = buildWavePrompt(wave, planCtx);

    // Per-wave model tiering: a plan may declare `Model:` under `### Wave N`
    // (planCtx.waveModels[n]); fall back to the construction-time default. Only
    // meaningful when `cmd` contains a `{model}` token — otherwise model
    // selection is the configured CLI's own concern and this is a no-op.
    const effectiveModel = planCtx?.waveModels?.[Number(waveId)] ?? model;

    // First attempt.
    const first = await runCommand(prompt, waveId, effectiveModel);
    if (first.terminal) return first.terminal;

    let block = extractWaveResultBlock(first.stdout);
    if (block) return toWaveResult(parseWaveResult(block), extractUsage(first.stdout));

    // Missing WAVE_RESULT — re-prompt EXACTLY once, asking specifically for it.
    const reprompt =
      prompt +
      '\n\nYour previous response did not include the required WAVE_RESULT block. ' +
      'Re-run the wave and end your response with exactly one WAVE_RESULT ... ' +
      'END_WAVE_RESULT block, and nothing after it.';

    const second = await runCommand(reprompt, waveId, effectiveModel);
    if (second.terminal) return second.terminal;

    block = extractWaveResultBlock(second.stdout);
    if (block) return toWaveResult(parseWaveResult(block), extractUsage(second.stdout));

    // Still no protocol block after one reprompt — terminal protocol failure.
    return {
      outcome: 'fail-protocol',
      status: 'failed',
      tasks: syntheticFailure(waveId, 'No WAVE_RESULT block after one reprompt').tasks,
    };
  };
}
