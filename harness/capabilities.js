/**
 * Capability classes (#85) — the per-wave vocabulary of what an agent may do.
 *
 * Pure: no I/O, never throws. Every function returns `{ ok, ... }` or a plain
 * value so callers report errors themselves.
 *
 * Constraints:
 * - Absent declaration = DEFAULT_CAPABILITIES; an unconstrained wave must behave
 *   byte-identically to today (the backward-compatibility contract).
 * - Deny wins over any request. An EXPLICIT request (plan or wave line) for a
 *   denied class is a refusal, never silently dropped. An IMPLICIT default
 *   narrowed by deny is not a refusal; the wave is just constrained.
 * - Results are always in vocabulary order so output is deterministic.
 */

/** The full capability vocabulary, in canonical order. */
export const CAPABILITY_CLASSES = Object.freeze(['fs_read', 'fs_write', 'shell', 'net', 'mcp']);
/** What a wave gets when nothing is declared (today's behavior). */
export const DEFAULT_CAPABILITIES = Object.freeze(['fs_read', 'fs_write', 'shell']);
/** Today's literal SDK allowedTools list; unconstrained waves keep using exactly this. */
export const DEFAULT_SDK_TOOLS = Object.freeze(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']);

/** SDK tool names granted by each class. `mcp` is absent: the sdk adapter configures no MCP servers. */
const SDK_TOOLS_BY_CLASS = Object.freeze({
  fs_read: Object.freeze(['Read', 'Glob', 'Grep']),
  fs_write: Object.freeze(['Write', 'Edit']),
  shell: Object.freeze(['Bash']),
  net: Object.freeze(['WebFetch', 'WebSearch']),
});
const CONFIG_FILE = '.rad/config.yml';
/** Tokens in a Capabilities: line are separated by commas and/or whitespace. */
const TOKEN_SEPARATOR = /[\s,]+/;

/** Members of `set` in vocabulary order, without duplicates. */
const inVocabularyOrder = (set) => CAPABILITY_CLASSES.filter((c) => set.includes(c));

/**
 * Parse the value of a `Capabilities:` line.
 *
 * @param {unknown} value e.g. "fs_read, shell" or "FS_READ net"
 * @returns {{ ok: true, classes: string[] } | { ok: false, error: string }}
 */
export function parseCapabilityLine(value) {
  const text = typeof value === 'string' ? value : '';
  const tokens = text.split(TOKEN_SEPARATOR).map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) {
    return { ok: false, error: `Capabilities: value is empty; name at least one of ${CAPABILITY_CLASSES.join(', ')}` };
  }
  const unknown = tokens.find((t) => !CAPABILITY_CLASSES.includes(t));
  if (unknown !== undefined) {
    return { ok: false, error: `Capabilities: unknown class '${unknown}'; expected one of ${CAPABILITY_CLASSES.join(', ')}` };
  }
  return { ok: true, classes: inVocabularyOrder(tokens) };
}

/** First member of `list` that is not a known class, or undefined. */
const firstUnknown = (list) => list.find((c) => !CAPABILITY_CLASSES.includes(c));

/** Resolve one wave. Returns the byWave entry, or `{ error }` when an explicit request is denied. */
function resolveOne(wave, { planCapabilities, waveCapabilities, deny }) {
  const waveLine = waveCapabilities[wave];
  const source = waveLine !== undefined ? 'wave' : planCapabilities !== undefined ? 'plan' : 'default';
  const requested = inVocabularyOrder(waveLine ?? planCapabilities ?? DEFAULT_CAPABILITIES);
  const implicit = source === 'default';
  const denied = requested.filter((c) => deny.includes(c));
  if (!implicit && denied.length > 0) {
    return {
      error: `Wave ${wave} explicitly requests capability '${denied[0]}', which is denied by capabilities.deny in ${CONFIG_FILE}; `
        + `remove it from the ${source}-level Capabilities: line or from the deny list`,
    };
  }
  const effective = requested.filter((c) => !deny.includes(c));
  return { requested, effective, implicit, constrained: !implicit || denied.length > 0, source, denied };
}

/** Shape errors in the resolver inputs (fail closed on anything malformed). */
function inputError({ waves, planCapabilities, waveCapabilities, deny }) {
  if (!Array.isArray(waves)) return 'waves must be an array of wave numbers';
  if (!Array.isArray(deny)) return 'deny must be an array of capability classes';
  if (planCapabilities !== undefined && !Array.isArray(planCapabilities)) return 'planCapabilities must be an array or undefined';
  if (waveCapabilities === null || typeof waveCapabilities !== 'object') return 'waveCapabilities must be an object';
  const lists = [deny, planCapabilities ?? [], ...Object.values(waveCapabilities)];
  if (lists.some((l) => !Array.isArray(l))) return 'every wave-level capability set must be an array';
  const bad = lists.map(firstUnknown).find((c) => c !== undefined);
  return bad === undefined ? null : `unknown capability class '${bad}'`;
}

/**
 * Resolve the effective capability set of every wave.
 *
 * @param {{ waves: number[], planCapabilities?: string[], waveCapabilities?: Object<number, string[]>, deny?: string[] }} input
 * @returns {{ ok: true, byWave: Object<number, Object> } | { ok: false, error: string }}
 */
export function resolveWaveCapabilities({ waves, planCapabilities, waveCapabilities = {}, deny = [] }) {
  const input = { waves, planCapabilities, waveCapabilities, deny };
  const shapeError = inputError(input);
  if (shapeError) return { ok: false, error: shapeError };
  const byWave = {};
  for (const wave of [...waves].sort((a, b) => a - b)) {
    const entry = resolveOne(wave, input);
    if (entry.error) return { ok: false, error: entry.error };
    byWave[wave] = entry;
  }
  return { ok: true, byWave };
}

/**
 * Map an effective capability set to the SDK adapter's allowedTools.
 *
 * @param {string[]} effective
 * @returns {{ ok: true, tools: string[] } | { ok: false, error: string }}
 */
export function sdkAllowedTools(effective) {
  if (!Array.isArray(effective)) return { ok: false, error: 'effective capabilities must be an array' };
  if (effective.includes('mcp')) {
    return { ok: false, error: "capability 'mcp' cannot be granted: the sdk adapter configures no MCP servers" };
  }
  const unknown = firstUnknown(effective);
  if (unknown !== undefined) return { ok: false, error: `unknown capability class '${unknown}'` };
  return { ok: true, tools: inVocabularyOrder(effective).flatMap((c) => SDK_TOOLS_BY_CLASS[c]) };
}

/**
 * The command and acp adapters cannot narrow an agent's tools, so they must
 * refuse any constrained wave whose effective set is narrower than the full
 * vocabulary. (ACP permission answers are defence in depth, not enforcement:
 * an ACP agent may act without asking.)
 *
 * @param {Object<number, {constrained: boolean, effective: string[]}>} byWave
 * @param {string} [adapter] - the adapter named in the refusal; 'command' keeps today's message
 * @returns {string | null} refusal message, or null when the adapter may run
 */
export function commandRefusal(byWave, adapter = 'command') {
  const waves = Object.keys(byWave ?? {}).map(Number).sort((a, b) => a - b);
  for (const wave of waves) {
    const { constrained, effective } = byWave[wave];
    if (!constrained || CAPABILITY_CLASSES.every((c) => effective.includes(c))) continue;
    return `Wave ${wave} is capability-constrained (effective: [${effective.join(', ')}]) but the ${adapter} adapter `
      + 'cannot narrow agent tools; run with RAD_AGENT=sdk or remove the Capabilities declaration';
  }
  return null;
}
