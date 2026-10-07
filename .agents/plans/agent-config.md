# Plan: agent: in .rad/config.yml, Set at Install (#186 part 3a)
Created: 2026-10-07
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-07T17:48:28.708Z
Recorded-By: sean@torchcodelab.com
Branch: rad/agent-config
Issue: 186
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/186
Issue-Title: Codex parity for state-changing RAD workflow

## Context
Under the part 3 decisions recorded on #186 on 2026-10-07, both the Claude and Codex deliver skills will run `rad deliver`. Today `rad deliver` picks its wave agent only from `RAD_AGENT`/`RAD_AGENT_CMD`. The default adapter is `command` and needs `RAD_AGENT_CMD`, so a user who never set it can't deliver. This plan adds an `agent:` key to `.rad/config.yml`, which holds an adapter and a command. It has two presets: `claude` (`claude -p`) and `codex` (`codex exec`). The key is set at setup through `rad config init --agent`, `install.sh --agent`, or an interactive install prompt. `rad deliver` and `rad review` read it when the environment variables aren't set. With no agent configured anywhere, `rad deliver` refuses with exit 2 and a message saying how to set one.

## Scope
| In scope | Out of scope |
|---|---|
| `agent:` schema, validation and serialization in harness/config.js | The merge update, status commits, PR body and test wave (3b, 3c) |
| A pure agent-selection module (env over config), with presets | The deliver skill migration (3d) |
| `rad deliver` and `rad review` use the selection | Running real `claude`/`codex` agents in tests |
| `rad config init --agent <claude\|codex>` plus `--agent-cmd`/`--agent-adapter` | A `rad config set` command |
| `install.sh --agent` and an interactive prompt | Writing `agent:` into existing configs on upgrade |
| Docs: configuration.md, rad-cli.md, INSTALL.md, UPGRADE.md | |

## Acceptance Criteria
1. `.rad/config.yml` accepts an optional top-level `agent:` mapping. It may contain only these keys:
   - `adapter`: one of `command`, `sdk` or `acp`;
   - `command`: a single-line non-empty string, required for `command`/`acp` and forbidden for `sdk`.

   `validateConfig` reports unknown keys, a bad adapter, a missing or extra command, and a multi-line command. `serializeConfig` writes the block (omitted when unset), and `rad config get agent.adapter` and `agent.command` return the values.
2. A pure `selectAgent(env, config)` returns `{ kind, cmd?, source }` or `{ error }`:
   - **Environment wins.** If `RAD_AGENT` or `RAD_AGENT_CMD` is set, the selection comes entirely from the environment, exactly as today (`source: 'env'`).
   - **Config next.** Otherwise it comes from `config.agent` (`source: 'config'`).
   - **Neither.** Otherwise it returns `{ error }` naming both ways to set an agent.
   - It doesn't spawn anything, read files or write to stderr.
3. `rad deliver` uses `selectAgent`.
   - When nothing is configured, it exits 2, before any worktree or event, with `rad deliver: no agent configured — set agent: in .rad/config.yml (rad config init --agent claude|codex) or RAD_AGENT/RAD_AGENT_CMD`.
   - When the environment is set, behavior and messages are unchanged.
   - The config-driven path reaches the same adapter construction as the environment path, and `sdk` still requires `ANTHROPIC_API_KEY`.
4. `rad review` resolves its command as `RAD_REVIEW_AGENT_CMD`, then `RAD_AGENT_CMD`, then `agent.command` when `agent.adapter` is `command`. Its "no review agent configured" message mentions the config key.
5. `rad config init` accepts:
   - `--agent claude|codex` (preset);
   - or `--agent-cmd "<cmd>"` with an optional `--agent-adapter command|acp` (default `command`);
   - or `--agent-adapter sdk` with no command.

   Combining `--agent` with `--agent-cmd`, or giving an unknown preset, is a usage error (exit 2). Without any agent flag, the written config has no `agent:` key, and the existing summary line is unchanged. With one, the summary line adds `, agent=<adapter>:<command|sdk>`.
6. `install.sh` accepts `--agent <claude|codex>` and passes it to `config init` on a fresh install.
   - **Interactive (no `--yes`, no `--agent`, fresh install):** it asks for `claude`, `codex` or `skip` (default `claude`).
   - **`--yes` without `--agent`:** writes no agent.
   - **Upgrades:** never prompt and never change an existing config.
   - **Validation:** an invalid `--agent` value fails before anything is written.
7. Docs: `docs/configuration.md` documents the `agent:` schema and the precedence, `docs/rad-cli.md`'s deliver and review sections mention it, `INSTALL.md` documents `--agent`, and `UPGRADE.md` says existing projects can add `agent:` by hand, while the environment variables keep working.
8. Tests cover the schema, the selection, deliver's exit 2 and config path, review's fallback, config init's flags, and the install flag and prompt behavior, and all existing tests pass. Where an existing test asserted the old "RAD_AGENT_CMD is required" exit 1 for an unset command with no config, it's updated to the new exit 2, and nothing else changes.

## Agent Scope
Research was done directly in this session, with a read-only sub-agent survey for part 3 overall. Files read: harness/config.js, `resolveAgent`/`agentKindFromEnv`/`deliverCommand` agent selection in harness/cli.js, `resolveReviewAgent`, `config init`, install.sh's argument parsing, prompt and config_init, the command adapter's stdin contract, configuration.md's agent section, and the test anchors. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/config.js | 18-60 | `TOP_LEVEL_KEYS` gains `agent`; `AGENT_ADAPTERS` and `AGENT_PRESETS` constants |
| harness/config.js | 140-185 | `agentErrors(agent)`, called from `validateConfig` |
| harness/config.js | 336-395 | `serializeConfig` writes the `agent:` block; `buildInitConfig` takes an optional `agent` |
| harness/agent-select.js | 1-1 | New: pure `selectAgent(env, config)` and `presetAgent(name)` |
| harness/cli.js | 220-232 | `agentKindFromEnv` kept for env; selection moves to `selectAgent` |
| harness/cli.js | 815-845 | `resolveAgent` takes the selection (kind, cmd) instead of reading env directly |
| harness/cli.js | 1000-1010 | Pass the selection through (main-run path) |
| harness/cli.js | 1195-1205 | Pass the selection through (worktree path) |
| harness/cli.js | 1538-1560 | `deliverCommand`: load config, call `selectAgent`, exit 2 on error |
| harness/cli.js | 2785-2840 | Review: `resolveReviewAgent` falls back to the config agent; message update |
| harness/cli.js | 2870-2880 | The review "no agent" message |
| harness/cli.js | 94-98 | `CONFIG_USAGE` adds the agent flags |
| harness/cli.js | 3185-3265 | `parseInitArgs`/`configInit`: agent flags, preset expansion, summary suffix |
| harness/test/config.test.js | 277-340 | Extend: schema, serialize and init-flag tests |
| harness/test/agent-select.test.js | 1-1 | New: selection precedence and error tests |
| harness/test/cli.test.js | 1690-1700 | Update `resolveAgent` call shape if its signature changes |
| harness/test/cli.test.js | 2700-2735 | Update the missing-command case to the new exit-2 path; add a config-driven case |
| install.sh | 1-45 | Usage line and comment; parse and validate `--agent` |
| install.sh | 150-165 | The interactive agent prompt (fresh install only, after the target prompt) |
| install.sh | 405-420 | `config_init` passes `--agent` |
| scripts/test-install-harness.sh | 1-20 | Header comment |
| scripts/test-install-harness.sh | 110-130 | `--agent codex` fresh-install case; `--yes` without agent writes none; an invalid value fails |
| docs/configuration.md | 19-72 | Schema table rows for `agent` |
| docs/configuration.md | 160-215 | Agent Adapter section: config key, precedence, presets |
| docs/rad-cli.md | 340-360 | deliver: the agent comes from config or env; the exit-2 case |
| docs/rad-cli.md | 460-480 | review: the config fallback |
| INSTALL.md | 245-265 | `--agent` flag and the prompt |
| UPGRADE.md | 438-445 | Note: add `agent:` by hand; env still works |

## Execution Notes

### Do Not Touch
- harness/adapters/agent/* — adapters are constructed exactly as today
- harness/spine.js, harness/gates.js, harness/events.js
- `.rad/skills/*` and generated command bodies — the skill migration is 3d

### Key Files
- harness/config.js — `TOP_LEVEL_KEYS`, `settingsErrors` (the style for a nested validator), `serializeConfig`/`settingsLines`, `buildInitConfig`
- harness/cli.js `agentKindFromEnv` (~229), `resolveAgent` (~821), its two call sites (~1007, ~1201), `deliverCommand` agent selection (~1543), `resolveReviewAgent` (~2824), `parseInitArgs`/`configInit` (~3189-3265)
- install.sh — `--architect` parsing and validation (the pattern for `--agent`), `prompt_target` (~150), `config_init` (~414)
- harness/test/config.test.js:277-340 — the config init test style

### Reminders
- Environment precedence is all-or-nothing. If either `RAD_AGENT` or `RAD_AGENT_CMD` is set, config is ignored entirely, so every existing environment setup behaves byte-for-byte as today.
- The config load in `deliverCommand` must happen before any worktree setup or event append, so the exit-2 refusal leaves no trace.
- Presets: `claude` = `{ adapter: command, command: "claude -p" }`; `codex` = `{ adapter: command, command: "codex exec" }`. Keep them as a named constant in one place (`AGENT_PRESETS` in config.js), and import them everywhere else.
- `install.sh` passes `--agent` to node as one argv element, never interpolated, and validates it against `claude|codex` before running anything.
- Keep the existing `config init` summary line byte-identical when no agent flag is given; config.test.js asserts it exactly.

## Program Design

**Signatures**
```js
// harness/config.js
export const AGENT_ADAPTERS = Object.freeze(['command', 'sdk', 'acp']);
export const AGENT_PRESETS = Object.freeze({ claude: { adapter: 'command', command: 'claude -p' },
                                            codex:  { adapter: 'command', command: 'codex exec' } });
function agentErrors(agent)                         // → string[]
export function buildInitConfig({ platform, defaultBranch, architect, agent })  // agent optional
// harness/agent-select.js
export function selectAgent(env, config)  // → { kind, cmd?, source: 'env'|'config' } | { error }
// harness/cli.js
export function resolveAgent(ctx, selection) // selection = { kind, cmd? } (was agentKind + env read)
```

**Call stack: `rad deliver <f>`**
```
deliverCommand
  loadConfig(repoRoot)                 (already used for deny list; reuse the result)
  sel = selectAgent(process.env, config)
  sel.error → stderr, exit 2           (before worktree/events)
  AGENT_KINDS.includes(sel.kind) else exit 1 (unchanged message for env)
  … setup … resolveAgent(ctx, sel) → { kind, cmd } | { kind:'sdk', apiKey } | { code }
```

**File tree diff**
```
harness/agent-select.js            + new
harness/config.js                  ~ agent schema, presets, serialize, init
harness/cli.js                     ~ deliver/review selection, config init flags
harness/test/agent-select.test.js  + new
harness/test/config.test.js        ~
harness/test/cli.test.js           ~
install.sh                         ~ --agent, prompt, config_init
scripts/test-install-harness.sh    ~
docs/configuration.md, docs/rad-cli.md, INSTALL.md, UPGRADE.md ~
```

## Wave Plan

### Wave 1 — parallel
The config schema and the pure selection don't depend on each other's code. The selection reads the `agent` shape described here.

#### Task 1.1: agent schema, presets and init config
File: harness/config.js:18-60, 140-185, 336-395, harness/test/config.test.js:277-340
What: Add `agent` to `TOP_LEVEL_KEYS`. Add `AGENT_ADAPTERS` and `AGENT_PRESETS` (exported). Add `agentErrors`, called from `validateConfig` when `agent` is present. It requires a mapping with only `adapter`/`command`; `adapter` must be in `AGENT_ADAPTERS`; `command` is required, single-line and non-empty for `command`/`acp`, and must be absent for `sdk`. Extend `serializeConfig` to write
```
agent:
  adapter: <a>
  command: <quoted if needed>
```
after `default_branch`/`roles` (choose the spot consistently and say where), and omit it when unset. `buildInitConfig` takes an optional `agent` mapping. Add tests for valid command, acp and sdk; unknown key; bad adapter; a missing command; sdk with a command; a multi-line command; a serialize round-trip; and `getConfigValue(doc, 'agent.command')`.
Validate: AC#1 — `node --test harness/test/config.test.js` passes

#### Task 1.2: selectAgent
File: harness/agent-select.js:1-1, harness/test/agent-select.test.js:1-1
What: `selectAgent(env, config)`:
- If `env.RAD_AGENT` or `env.RAD_AGENT_CMD` is non-blank, return `{ kind: RAD_AGENT trimmed or 'command', cmd: RAD_AGENT_CMD trimmed or undefined, source: 'env' }`. This mirrors today's `agentKindFromEnv` plus `RAD_AGENT_CMD`. Leave the validity of `kind` and the presence of `cmd` to the existing deliver checks, so environment messages stay identical.
- Else, if `config?.agent` is present, return `{ kind: adapter, cmd: command, source: 'config' }`.
- Else return `{ error: 'no agent configured — set agent: in .rad/config.yml (rad config init --agent claude|codex) or RAD_AGENT/RAD_AGENT_CMD' }`.

It's pure: no I/O and no `process.env` default. Tests cover environment-only, `RAD_AGENT_CMD`-only, environment beating config, config-only command/acp/sdk, neither → error, blank environment values treated as unset, and a null config.
Validate: AC#2 — `node --test harness/test/agent-select.test.js` passes

### Wave 2 — sequential
Wire deliver, review and config init to the new pieces.

#### Task 2.1: deliver and review use the selection
File: harness/cli.js:220-232, 815-845, 1000-1010, 1195-1205, 1538-1560, 2785-2840, 2870-2880, harness/test/cli.test.js:1690-1700, 2700-2735
What: In `deliverCommand`, load the config once before setup. If there's no config file, the selection sees `null`, so the environment path behaves as today. Call `selectAgent(process.env, config)`:
- `{ error }` → write `rad deliver: <error>` and exit 2 before any setup.
- Otherwise keep the existing unknown-kind check (exit 1, same message) using `sel.kind`.

Change `resolveAgent(ctx, agentKind)` to `resolveAgent(ctx, selection)`, using `selection.cmd` instead of reading `process.env.RAD_AGENT_CMD`. The "RAD_AGENT_CMD is required when RAD_AGENT=<kind>" message stays for the environment source; the config source can't reach it because validation guarantees a command. Pass the selection through both call sites. Keep `ctx.runWave` injection first.

Review: `resolveReviewAgent(env, config)` falls back to `config.agent.command` when `config.agent.adapter === 'command'`. The no-agent message becomes `rad review: no review agent configured — set RAD_REVIEW_AGENT_CMD, RAD_AGENT_CMD, or agent: in .rad/config.yml`.

Update cli.test.js where the `resolveAgent` signature or the missing-command exit code changed. Add one deliver case with `agent:` in a temp config and no environment, reaching an injected or stubbed adapter construction, and one case with nothing configured → exit 2 with no worktree and no events.
Validate: AC#3, AC#4, AC#8 — `node --test harness/test/cli.test.js` passes; the full `node --test harness/test/*.test.js` passes

#### Task 2.2: config init agent flags
File: harness/cli.js:94-98, 3185-3265, harness/test/config.test.js:277-340
What: `parseInitArgs` accepts `--agent <name>`, `--agent-cmd <cmd>` and `--agent-adapter <a>`. Resolve them in a small helper:
- `--agent` → `AGENT_PRESETS[name]`; an unknown name is a usage error listing the presets.
- `--agent` together with `--agent-cmd` or `--agent-adapter` is a usage error.
- `--agent-cmd` alone → adapter `command`; with `--agent-adapter acp` → acp.
- `--agent-adapter sdk` with no command → sdk; sdk with a command is a usage error.
- `--agent-adapter command|acp` without `--agent-cmd` is a usage error.

Usage errors exit 2 through `configUsage`. Pass the result to `buildInitConfig`. The summary line appends `, agent=<adapter>:<command or sdk>` only when an agent was set. Update `CONFIG_USAGE`. Add tests for each preset, a custom command, acp, sdk, each usage error, the summary unchanged without flags, and that the written file validates.
Validate: AC#5 — `node --test harness/test/config.test.js` passes

### Wave 3 — parallel
The installer and the docs.

#### Task 3.1: install.sh --agent and the prompt
File: install.sh:1-45, 150-165, 405-420, scripts/test-install-harness.sh:1-20, 110-130
What:
- **Parsing:** parse `--agent <value>` (value required, not a flag) and validate it is `claude` or `codex` before any work, with an error naming the allowed values. Update `USAGE` and the header comment.
- **Prompt:** on a fresh install without `--yes` and without `--agent`, after the target-directory prompt, ask "Which coding agent runs deliveries? [claude/codex/skip] (default: claude)" and set `AGENT` from the answer, re-asking on an invalid answer. `skip` leaves it empty. Only prompt when a fresh config will be written, never on upgrade or when a config already exists; check how `config_init` is gated and prompt under the same condition.
- **`config_init`:** append `--agent "$AGENT"` when it's set, and log `info "Agent: …"`.
- **Tests:** in test-install-harness.sh, add a fresh `--yes --agent codex` install, asserting `config get agent.command` = `codex exec`; check that `--yes` with no `--agent` leaves no agent key (`config get agent.adapter` fails or is empty, whichever the CLI does; assert that); check that `--agent bogus` exits non-zero before installing anything; and check that an upgrade with `--agent` doesn't change an existing config. Use the file's existing helpers and isolation.
Validate: AC#6 — `bash scripts/test-install-harness.sh` and `/bin/bash scripts/test-install-harness.sh` pass

#### Task 3.2: Docs
File: docs/configuration.md:19-72, 160-215, docs/rad-cli.md:340-360, 460-480, INSTALL.md:245-265, UPGRADE.md:438-445
What:
- **configuration.md:** add schema table rows for `agent`, `agent.adapter` and `agent.command`, plus a short YAML example. Rewrite the Agent Adapter section to cover the config key, the presets, the all-or-nothing environment precedence, and the exit-2 refusal when nothing is configured.
- **rad-cli.md:** the deliver and review sections say where the agent comes from.
- **INSTALL.md:** `--agent claude|codex` and the interactive prompt (fresh install only; `--yes` writes none).
- **UPGRADE.md:** a short "Agent setting (#186 part 3a)" section. Existing configs have no `agent:`; add it by hand (show the YAML) or keep using `RAD_AGENT`/`RAD_AGENT_CMD`, which still win.
Validate: AC#7 — `grep -n 'agent:' docs/configuration.md` and `grep -n -- '--agent' INSTALL.md` match; `scripts/lint-claude-md.sh` exits 0

## Tests to Write
- [ ] agent schema, serialize, and config init flag tests — harness/test/config.test.js
- [ ] selectAgent precedence and error tests — harness/test/agent-select.test.js
- [ ] deliver config path and exit-2 refusal; review fallback — harness/test/cli.test.js
- [ ] install --agent, --yes with no agent, an invalid value, upgrade unchanged — scripts/test-install-harness.sh

## Non-Goals
- Any change to deliver's git steps, PR body or test wave (3b/3c).
- Migrating the deliver skill (3d).
- A `rad config set` command, or rewriting existing configs on upgrade.
- Verifying real `claude -p` or `codex exec` runs in CI.

## Out-of-Scope Dependencies
None

## Risks
- **The exit code for an unset command changes.** `RAD_AGENT=command` without `RAD_AGENT_CMD` used to exit 1. With environment precedence it still reaches the same message and exit 1. Only the case with nothing set in the environment and no config becomes the new exit 2. Mitigation: AC#3 and the cli.test.js updates assert both.
- **Install prompt in automation.** CI or scripted installs that pass neither `--yes` nor `--agent` would now block on a prompt. Mitigation: the prompt only appears when the existing target-directory prompt already does (no `--yes`), so automation already passes `--yes`.
- **The `codex exec` preset is unverified for deliver** (rad-cli.md marks it verified only for `rad review`). This plan only records the setting; 3d's smoke test exercises it.
- **Self-protected paths** (`harness/`, `scripts/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — all-or-nothing precedence:** if either environment variable is set, config is ignored entirely. This keeps existing setups identical and avoids mixed environment/config selections.
- **Assumption — interactive default `claude`, `--yes` writes none:** an unattended install shouldn't guess a tool, so deliver's clear refusal is the safer default there.
- **Assumption — presets:** `claude -p` and `codex exec`, both fed the prompt on stdin, which the command adapter already does.
- **Assumption — review also reads the config agent:** only for the `command` adapter, since the review lane runs a single command.
- **Assumption — no upgrade migration:** existing configs get no `agent:` automatically; UPGRADE.md documents adding it by hand.
