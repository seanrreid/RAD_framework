/**
 * SDK (Anthropic) wave adapter — hardened.
 *
 * Drives a wave through the Claude Agent SDK's `query` loop, behind the SAME
 * interface every adapter shares: runWave(wave, planCtx) -> result, where the
 * result includes `outcome` (the matrix string the spine reads), `status`, and
 * `tasks` (for logging). The plain-text WAVE_RESULT contract and all resilience
 * helpers come from ./contract.js — this module owns only the SDK wiring.
 *
 * Hardening over the original runwave.js:
 *   - Wall-clock timeout via AbortController + contract.withTimeout (maxTurns
 *     is also set so the SDK self-limits) — exhaustion maps to 'fail-timeout'.
 *   - ALLOW-LISTED env subset handed to the SDK (PATH, HOME, locale + the key)
 *     instead of spreading the full process.env and its secrets.
 *   - Classified-transient errors retried with contract.backoffWithJitter
 *     before a terminal outcome; permanent/model/resource errors fail closed.
 *   - One reprompt on a missing WAVE_RESULT block before failing 'fail-protocol'.
 *   - contract.sanitizeErrorMessage on every surfaced error so the API key
 *     never appears in logs/errors.
 *
 * The `query` dependency is injectable (opts.query) for hermetic testing — no
 * real network calls in tests.
 */

import { query as defaultQuery } from '@anthropic-ai/claude-agent-sdk';

import {
  buildWavePrompt,
  extractWaveResultBlock,
  parseWaveResult,
  resultToOutcome,
  syntheticFailure,
  sanitizeErrorMessage,
  classifyError,
  backoffWithJitter,
  withTimeout,
  normalizeUsage,
} from './contract.js';

/** Env keys forwarded to the SDK subprocess. The API key is added separately. */
const ENV_ALLOW_LIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'];

/** Build the allow-listed env handed to the SDK (key injected by caller). */
function buildSdkEnv(apiKey) {
  const env = {};
  for (const key of ENV_ALLOW_LIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.ANTHROPIC_API_KEY = apiKey;
  return env;
}

/** Max transient retries before producing a terminal outcome. */
const MAX_TRANSIENT_RETRIES = 3;

/** Default per-wave wall-clock deadline and SDK turn ceiling. */
const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_MAX_TURNS = 40;

/**
 * Create a runWave function backed by the Claude Agent SDK.
 *
 * Same signature as the historical runwave.js factory. The ANTHROPIC_API_KEY
 * presence check is the caller's responsibility; this factory trusts apiKey and
 * never logs it.
 *
 * @param {Object} opts
 * @param {string} opts.apiKey - Anthropic API key (never logged)
 * @param {string} [opts.model] - Claude model identifier
 * @param {string} [opts.repoRoot] - absolute path to repo root (cwd for agent)
 * @param {number} [opts.timeoutMs] - wall-clock deadline per wave
 * @param {number} [opts.maxTurns] - SDK turn ceiling
 * @param {Function} [opts.query] - injectable SDK query (defaults to the real one)
 * @param {Function} [opts.sleep] - injectable delay (defaults to setTimeout); for tests
 * @returns {(wave: Object, planCtx: Object) => Promise<{ outcome: string, status: string, tasks: Array }>}
 */
export function createRunWave({
  apiKey,
  model,
  repoRoot,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxTurns = DEFAULT_MAX_TURNS,
  query = defaultQuery,
  sleep,
} = {}) {
  const delay =
    sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  /**
   * Wrap a parsed `{ status, tasks }` into the full spine-facing result. When a
   * normalized usage object is supplied it is attached; otherwise the field is
   * OMITTED (usage is optional everywhere downstream).
   */
  function toResult(parsed, usage) {
    const result = {
      outcome: resultToOutcome(parsed),
      status: parsed.status,
      tasks: parsed.tasks,
    };
    // `usage` is either undefined or a fully-formed {input,output,total} object
    // (normalizeUsage never returns an empty/partial object), so a truthy check
    // is sufficient to decide whether to attach the optional field.
    if (usage) result.usage = usage;
    return result;
  }

  /**
   * Run a single SDK query to completion, collecting assistant text. Returns
   * `{ text }` on success. Throws on a thrown SDK error OR on an `is_error`
   * result (so the retry/classify layer above handles both uniformly). The
   * thrown error carries the (sanitized) summary.
   *
   * @param {string} prompt
   * @returns {Promise<{ text: string }>}
   */
  async function runQueryOnce(prompt, effectiveModel) {
    const abortController = new AbortController();
    let fullText = '';
    let usage;

    const drain = (async () => {
      const sdkQuery = query({
        prompt,
        options: {
          env: buildSdkEnv(apiKey),
          ...(effectiveModel ? { model: effectiveModel } : {}),
          ...(repoRoot ? { cwd: repoRoot } : {}),
          maxTurns,
          abortController,
          tools: { type: 'preset', preset: 'claude_code' },
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          permissionMode: 'acceptEdits',
          persistSession: false,
        },
      });

      for await (const message of sdkQuery) {
        if (message.type === 'assistant') {
          if (Array.isArray(message.message?.content)) {
            for (const block of message.message.content) {
              if (block.type === 'text') fullText += block.text;
            }
          }
        } else if (message.type === 'result') {
          // Token usage rides on the result message (message.usage, with
          // input_tokens/output_tokens). Normalize to { input, output, total };
          // absent/unusable usage leaves `usage` undefined (optional field).
          const normalized = normalizeUsage(message.usage);
          if (normalized) usage = normalized;
          if (!message.is_error && typeof message.result === 'string') {
            fullText += message.result;
          } else if (message.is_error) {
            // Sanitize at CONSTRUCTION so the key can never reach a thrown/
            // logged Error even if the SDK embeds it in message.errors.
            const errSummary = sanitizeErrorMessage(
              Array.isArray(message.errors)
                ? message.errors.join('; ')
                : 'SDK reported an error result',
            );
            throw new Error(errSummary);
          }
        }
      }
      return { text: fullText, usage };
    })();

    try {
      return await withTimeout(drain, timeoutMs, abortController);
    } catch (err) {
      // The drain closure may have already captured usage from a result message
      // before throwing (is_error) or being aborted (timeout). Attach it so the
      // retry layer can carry it into the terminal result and the budget counts
      // tokens spent on a failed wave (conservative — usage is often absent here).
      if (usage !== undefined && err && typeof err === 'object') err._usage = usage;
      throw err;
    }
  }

  /**
   * Run one query with transient-retry + backoff. Returns `{ text }` on success
   * or `{ terminal }` with a finished spine result when the run failed
   * terminally (timeout/exhausted-transient/permanent/model/resource).
   *
   * @param {string} prompt
   * @param {string|number} waveId
   * @param {string} [effectiveModel] - model id for this wave (per-wave override)
   */
  async function runWithRetry(prompt, waveId, effectiveModel) {
    let attempt = 0;
    // attempt 0 is the initial call; up to MAX_TRANSIENT_RETRIES retries follow.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const once = await runQueryOnce(prompt, effectiveModel);
        return { text: once.text, usage: once.usage };
      } catch (err) {
        const bucket = classifyError(err);
        const safe = sanitizeErrorMessage(err?.message ?? String(err));

        // A wall-clock timeout (sentinel-tagged by withTimeout) is terminal
        // 'fail-timeout' for this adapter — do not retry past the deadline.
        if (err && err._isRadTimeout) {
          return {
            terminal: {
              outcome: 'fail-timeout',
              status: 'failed',
              tasks: syntheticFailure(waveId, safe).tasks,
              ...(err._usage ? { usage: err._usage } : {}),
            },
          };
        }

        if (bucket === 'transient' && attempt < MAX_TRANSIENT_RETRIES) {
          attempt += 1;
          await delay(backoffWithJitter(attempt));
          continue;
        }

        // Transient exhausted, or permanent/model/resource — terminal failure.
        return { terminal: toResult(syntheticFailure(waveId, safe), err._usage) };
      }
    }
  }

  /**
   * @param {Object} wave
   * @param {Object} planCtx
   * @returns {Promise<{ outcome: string, status: string, tasks: Array }>}
   */
  return async function runWave(wave, planCtx) {
    const waveId = wave.n ?? wave.number ?? wave.id ?? '?';
    const prompt = buildWavePrompt(wave, planCtx);

    // Per-wave model tiering: a plan may declare `Model:` under `### Wave N`,
    // surfaced as planCtx.waveModels[n] (keyed by NUMBER). Coerce waveId to a
    // number for the lookup so a string wave id still matches; fall back to the
    // construction-time (deliver default) model when this wave declares none.
    const effectiveModel = planCtx?.waveModels?.[Number(waveId)] ?? model;

    const first = await runWithRetry(prompt, waveId, effectiveModel);
    if (first.terminal) return first.terminal;

    let block = extractWaveResultBlock(first.text);
    if (block) return toResult(parseWaveResult(block), first.usage);

    // Missing WAVE_RESULT — reprompt EXACTLY once for the protocol block.
    const reprompt =
      prompt +
      '\n\nYour previous response did not include the required WAVE_RESULT block. ' +
      'Re-run the wave and end your response with exactly one WAVE_RESULT ... ' +
      'END_WAVE_RESULT block, and nothing after it.';

    const second = await runWithRetry(reprompt, waveId, effectiveModel);
    if (second.terminal) return second.terminal;

    block = extractWaveResultBlock(second.text);
    if (block) return toResult(parseWaveResult(block), second.usage);

    return {
      outcome: 'fail-protocol',
      status: 'failed',
      tasks: syntheticFailure(waveId, 'No WAVE_RESULT block after one reprompt').tasks,
    };
  };
}
