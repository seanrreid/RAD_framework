/**
 * createRunWave — SDK-backed wave runner for the rad-deliver spine.
 *
 * Exported as a factory so deliverSpine can receive a real or fake runWave
 * via injection, keeping the core deterministic and testable without touching
 * the SDK or spawning real processes.
 *
 * The provider-neutral protocol helpers (buildWavePrompt, extractWaveResultBlock,
 * parseWaveResult, syntheticFailure, sanitizeErrorMessage) live in
 * ./adapters/agent/contract.js — a PURE module with no SDK dependency — and are
 * imported here so this SDK adapter and any future provider adapter share one
 * WAVE_RESULT contract.
 *
 * Security: the apiKey value is never logged or emitted, even partially.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  buildWavePrompt,
  extractWaveResultBlock,
  parseWaveResult,
  syntheticFailure,
  sanitizeErrorMessage,
} from './adapters/agent/contract.js';

/**
 * Create a runWave function backed by the Claude Agent SDK.
 *
 * The ANTHROPIC_API_KEY check must be done by the caller (deliverCommand)
 * before calling createRunWave. This factory trusts that apiKey is present
 * and valid; it does not re-validate or log it.
 *
 * @param {Object} opts
 * @param {string} opts.apiKey - Anthropic API key (never logged)
 * @param {string} [opts.model] - Claude model identifier
 * @param {string} [opts.repoRoot] - absolute path to repo root (cwd for agent)
 * @returns {(wave: Object, planCtx: Object) => Promise<{ status: string, tasks: Array }>}
 */
export function createRunWave({ apiKey, model, repoRoot }) {
  /**
   * @param {Object} wave - wave descriptor ({ n, type, tasks, ... })
   * @param {Object} planCtx - orchestration context (feature, branch, executionNotes, ...)
   * @returns {Promise<{ status: string, tasks: Array }>}
   */
  return async function runWave(wave, planCtx) {
    const waveId = wave.n ?? wave.number ?? wave.id ?? '?';
    const prompt = buildWavePrompt(wave, planCtx);

    /** Collected text from assistant message blocks */
    let fullText = '';

    try {
      const sdkQuery = query({
        prompt,
        options: {
          // Pass the key via env so the subprocess picks it up without the SDK
          // object ever storing it in a field that could be serialized or logged.
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: apiKey,
          },
          ...(model ? { model } : {}),
          ...(repoRoot ? { cwd: repoRoot } : {}),
          // Allow the full Claude Code tool set so the sub-agent can edit files,
          // run bash commands, and commit — matching what wave sub-agents need.
          tools: { type: 'preset', preset: 'claude_code' },
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          // Non-interactive: do not block waiting for permission prompts.
          permissionMode: 'acceptEdits',
          // Each wave is a fresh session — no resume.
          persistSession: false,
        },
      });

      for await (const message of sdkQuery) {
        if (message.type === 'assistant') {
          // Collect text content blocks for WAVE_RESULT extraction
          if (Array.isArray(message.message?.content)) {
            for (const block of message.message.content) {
              if (block.type === 'text') {
                process.stdout.write(block.text);
                fullText += block.text;
              }
            }
          }
        } else if (message.type === 'result') {
          // SDKResultSuccess carries the final result text
          if (!message.is_error && typeof message.result === 'string') {
            process.stdout.write(message.result);
            fullText += message.result;
          } else if (message.is_error) {
            const errSummary = Array.isArray(message.errors)
              ? message.errors.join('; ')
              : 'SDK reported an error result';
            return syntheticFailure(waveId, sanitizeErrorMessage(errSummary));
          }
        }
      }
    } catch (err) {
      const safe = sanitizeErrorMessage(err?.message ?? String(err));
      return syntheticFailure(waveId, safe);
    }

    // Extract and parse the WAVE_RESULT block from the collected text
    const block = extractWaveResultBlock(fullText);
    if (!block) {
      return syntheticFailure(waveId, 'No WAVE_RESULT block found in agent response');
    }

    return parseWaveResult(block);
  };
}
