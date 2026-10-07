/**
 * claude-settings — merge RAD's deliver-gate PreToolUse hook registration into
 * a project's `.claude/settings.json` text (#186 part 1).
 *
 * Constraints:
 * - Pure: takes the file text (or null when absent) and returns the new text.
 *   No filesystem access; the caller owns reading and writing.
 * - Fail closed: any input whose shape this module cannot merge safely (empty,
 *   invalid JSON, wrong types) returns { error } and never a rewritten text.
 * - Idempotent: a registration is "present" when any PreToolUse hook command
 *   mentions DELIVER_GATE_HOOK_MARKER, whatever its matcher; present text is
 *   returned byte-for-byte unchanged.
 * - An added registration keeps every other key, entry and their order; the
 *   output is 2-space JSON with a trailing newline.
 * - The hook constants live only here; the command string must match the one
 *   this repo's own .claude/settings.json registers.
 */

/** The PreToolUse matcher the deliver-gate hook is registered under. */
export const DELIVER_GATE_HOOK_MATCHER = 'Skill';
/** The command Claude Code runs for the hook, relative to the project root. */
export const DELIVER_GATE_HOOK_COMMAND = 'node scripts/deliver-gate-hook.mjs';
/** Substring that identifies an existing registration, whatever its matcher or command prefix. */
export const DELIVER_GATE_HOOK_MARKER = 'deliver-gate-hook.mjs';

const JSON_INDENT = 2;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A fresh registration entry for hooks.PreToolUse. */
function deliverGateEntry() {
  return {
    matcher: DELIVER_GATE_HOOK_MATCHER,
    hooks: [{ type: 'command', command: DELIVER_GATE_HOOK_COMMAND }],
  };
}

/** Serialize settings the way Claude Code's own settings files are laid out. */
function serialize(settings) {
  return `${JSON.stringify(settings, null, JSON_INDENT)}\n`;
}

/**
 * Parse settings text and check the shapes the merge touches.
 *
 * @param {string} text
 * @returns {{ settings: object } | { error: string }}
 */
function parseSettings(text) {
  if (typeof text !== 'string' || text.trim() === '') return { error: 'settings text is empty' };
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (err) {
    return { error: `settings is not valid JSON: ${err.message}` };
  }
  if (!isPlainObject(settings)) return { error: 'settings top level is not a JSON object' };
  if (settings.hooks !== undefined && !isPlainObject(settings.hooks)) {
    return { error: "settings 'hooks' is not an object" };
  }
  if (settings.hooks?.PreToolUse !== undefined && !Array.isArray(settings.hooks.PreToolUse)) {
    return { error: "settings 'hooks.PreToolUse' is not an array" };
  }
  return { settings };
}

/** True when any PreToolUse hook command already names the deliver-gate hook. */
function hasDeliverGateHook(settings) {
  const entries = settings.hooks?.PreToolUse ?? [];
  return entries.some((entry) => Array.isArray(entry?.hooks) && entry.hooks.some(
    (hook) => typeof hook?.command === 'string' && hook.command.includes(DELIVER_GATE_HOOK_MARKER),
  ));
}

/**
 * Merge the deliver-gate hook registration into settings text.
 *
 * @param {string | null} text  the current .claude/settings.json text, or null when the file is absent
 * @returns {{ status: 'created' | 'present' | 'added', text: string } | { error: string }}
 */
export function mergeDeliverGateHook(text) {
  if (text === null) return { status: 'created', text: serialize({ hooks: { PreToolUse: [deliverGateEntry()] } }) };
  const parsed = parseSettings(text);
  if (parsed.error) return { error: parsed.error };
  const { settings } = parsed;
  if (hasDeliverGateHook(settings)) return { status: 'present', text };
  const hooks = settings.hooks ?? {};
  const merged = { ...settings, hooks: { ...hooks, PreToolUse: [...(hooks.PreToolUse ?? []), deliverGateEntry()] } };
  return { status: 'added', text: serialize(merged) };
}
