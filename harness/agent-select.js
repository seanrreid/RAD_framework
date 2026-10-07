/**
 * agent-select.js — pure selection of the wave agent for `rad deliver`.
 *
 * Precedence is all-or-nothing: if EITHER RAD_AGENT or RAD_AGENT_CMD is set
 * (non-blank), the environment wins outright and the config's `agent:` block is
 * ignored entirely — the two sources are never mixed field by field. That keeps
 * every existing environment setup behaving byte-for-byte as before: the kind
 * still defaults to 'command' when RAD_AGENT is blank, and deliver's own checks
 * (unknown kind, missing RAD_AGENT_CMD) still fire with their existing messages.
 * Only when the environment says nothing does `agent:` in .rad/config.yml apply.
 *
 * No I/O, no ambient process.env read, no stderr: callers pass env and config.
 * The config is validated elsewhere (harness/config.js); it is not re-checked.
 */

/** The selection error when neither the environment nor the config names an agent. */
export const NO_AGENT_CONFIGURED =
  'no agent configured — set agent: in .rad/config.yml (rad config init --agent claude|codex) or RAD_AGENT/RAD_AGENT_CMD';

/** RAD_AGENT's default when only RAD_AGENT_CMD is set — mirrors agentKindFromEnv. */
const DEFAULT_ENV_KIND = 'command';

/** The trimmed value when present and not whitespace-only, else undefined. */
function trimmedOrUndefined(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** True for a plain mapping (not null, not an array). */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Select the wave agent from the environment, else the config's `agent:` block.
 *
 * @param {Record<string, string|undefined>} env - required; e.g. process.env
 * @param {{ agent?: { adapter: string, command?: string } } | null | undefined} config
 * @returns {{ kind: string, cmd: string|undefined, source: 'env'|'config' } | { error: string }}
 * @throws {TypeError} when env is missing or not an object
 */
export function selectAgent(env, config) {
  if (!isMapping(env)) {
    throw new TypeError('selectAgent: env must be an object');
  }
  const envKind = trimmedOrUndefined(env.RAD_AGENT);
  const envCmd = trimmedOrUndefined(env.RAD_AGENT_CMD);
  if (envKind !== undefined || envCmd !== undefined) {
    return { kind: envKind ?? DEFAULT_ENV_KIND, cmd: envCmd, source: 'env' };
  }
  if (isMapping(config?.agent)) {
    return { kind: config.agent.adapter, cmd: config.agent.command, source: 'config' };
  }
  return { error: NO_AGENT_CONFIGURED };
}
