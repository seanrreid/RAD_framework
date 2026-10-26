# Plan: Opt-in Credential Sandbox for the Command Agent (#244)
Created: 2026-10-26
Author: developer
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-26T19:30:01.772Z
Recorded-By: sean@torchcodelab.com
Branch: rad/agent-credential-sandbox
Issue: 244
Source-Author: seanrreid (OWNER)
Source-Comments: 0 total, 0 non-collaborator

## Context
The command adapter spawns the delivery agent with an allow-listed env that includes `HOME` and `USER`, so the child can read `~/.ssh`, `~/.aws`, `~/.netrc` and `~/.config/gh`, and `gh` runs authenticated inside it (verified 2026-10-26). A `sandbox-exec` wrapper that denies those paths leaves the agent CLI working (`~/.claude` stays readable, local git works) while credentialed network git fails. #244 asks for a viable scoped-credential or wrapper path and an eval asserting HOME-held credentials are unreachable. This plan adds an opt-in macOS wrapper for the command adapter, with that eval. Default behavior is unchanged.

## Scope
| In scope | Out of scope |
|---|---|
| New `RAD_AGENT_SANDBOX` env switch (`macos`; unset, blank or `off` = today's behavior) | A `agent.sandbox` key in `.rad/config.yml` |
| `harness/adapters/agent/sandbox.js`: deny-path list, inline profile builder, support check, argv wrapper | Linux (`bwrap`) or container wrappers |
| Command adapter spawns (waves, preflight, review lane) wrapped when enabled | Sandboxing the `acp` and `sdk` adapters (refused, not wrapped) |
| Fail-closed refusals: unknown value, non-macOS host, missing `sandbox-exec`, non-command adapter | Network egress limits or filesystem allow-listing beyond the deny list |
| Delivery eval proving HOME credentials are unreachable, plus an invariant entry and docs | Making the sandbox the default |

## Acceptance Criteria
1. `RAD_AGENT_SANDBOX` unset, blank or `off` leaves the spawned argv and env exactly as today; `macos` prefixes the agent argv with `sandbox-exec -p <profile>`; any other value is refused.
2. The profile denies `file-read*` and `file-write*` for every path in the deny list under the real `HOME`, allows everything else, and is built only from an absolute `HOME` free of quote, backslash and newline characters; an unusable `HOME` is refused.
3. With the sandbox enabled, `rad deliver` exits 2 before any worktree or event when: the value is unknown, the host is not macOS, `sandbox-exec` is not on PATH, or the selected adapter is `acp` or `sdk`. Each message names the cause.
4. With the sandbox enabled, the wave agent, the startup preflight and the review lane all run through the wrapper (one spawn path).
5. On macOS with `RAD_AGENT_SANDBOX=macos`, an eval agent that reads a planted `~/.ssh` credential file in a temp `HOME` fails to read it, and without the switch it reads it; on other platforms the eval is skipped with a named reason.
6. `docs/configuration.md` documents the switch, the deny list, the macOS-only limit and the refusals; `docs/invariants.yaml` has an opt-in invariant tied to the eval.

## Agent Scope
Research done inline against `harness/adapters/agent/command.js`, `harness/cli.js` (`resolveAgent`), `harness/evals/delivery.eval.js`, `harness/evals/lib/fixture.js`, `docs/configuration.md`, `docs/invariants.yaml`. No sub-agents. No out-of-scope agent dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/adapters/agent/sandbox.js | 1-90 | new: `SANDBOX_DENY_PATHS`, `sandboxMode`, `sandboxProfile`, `sandboxSupport`, `wrapArgv` |
| harness/test/agent-sandbox.test.js | 1-160 | new: unit tests for every function and refusal |
| harness/adapters/agent/command.js | 205-225 | `startAgentProcess` wraps the argv when the sandbox is enabled |
| harness/cli.js | 1013-1045 | `resolveAgent` refuses unusable sandbox configurations with exit 2 |
| harness/test/agent-adapters.test.js | 1180-1227 | spawn path wraps argv when enabled and is unchanged when not |
| harness/test/agent-select.test.js | 40-79 | resolveAgent refusal cases (unknown value, acp, sdk) |
| harness/evals/lib/fixture.js | 60-80 | adversary `read-home-creds` writes whether the planted file was readable |
| harness/evals/delivery.eval.js | 150-200 | eval case: credentials reachable without the switch, unreachable with it |
| docs/configuration.md | 225-240 | document `RAD_AGENT_SANDBOX` beside the preflight variables |
| docs/invariants.yaml | 217-232 | add `adapter-home-credentials-denied` after `adapter-env-allow-listed` |

## Program Design
```
// sandbox.js
export const SANDBOX_ENV = 'RAD_AGENT_SANDBOX'
export const SANDBOX_DENY_PATHS: string[]            // HOME-relative: .ssh .aws .netrc .gnupg .config/gh .config/gcloud .azure .kube .docker/config.json
export function sandboxMode(env): 'off' | 'macos'    // throws SandboxError on any other value
export function sandboxProfile(home): string          // (version 1)(allow default)(deny file-read* file-write* (subpath|literal ...)); throws on an unusable home
export function sandboxSupport({ platform, which }): void   // throws SandboxError: not macOS / sandbox-exec missing
export function wrapArgv(argv, { env, home }): string[]     // identity when off; ['sandbox-exec','-p',profile,...argv] when macos
```
Flow: `resolveAgent` → `sandboxMode(process.env)`; when `macos`: adapter must be `command`, then `sandboxSupport()` → exit 2 with the message on any `SandboxError`. `startAgentProcess` → `wrapArgv(argv, …)` → `spawn`. Waves, the preflight probe and the review lane all go through `spawnOnce`, so one change covers them.
New files: harness/adapters/agent/sandbox.js, harness/test/agent-sandbox.test.js.

## Execution Notes

### Do Not Touch
- harness/adapters/agent/acp.js, harness/adapters/agent/sdk.js — refused when the sandbox is on, never wrapped
- `ENV_ALLOW_LIST` and `buildChildEnv` — the env allow-list is unchanged; the sandbox is additive
- harness/spine.js, scripts/ — the verify gate and harness pushes run outside the agent and stay unsandboxed

### Key Files
- harness/adapters/agent/command.js — `spawnOnce` and `startAgentProcess` are the single spawn path
- harness/evals/lib/fixture.js — how adversaries are scripted; `dump-env` is the model
- docs/invariants.yaml — `adapter-env-allow-listed` shows the entry shape and `enforced_by` rules

### Reminders
- Edge cases to test: unset, blank, `off`, `macos`, `MACOS`, `docker`; `HOME` empty, relative, containing a quote, backslash or newline; non-darwin platform; missing `sandbox-exec`; empty argv.
- The profile goes to `sandbox-exec -p` as one argv element, never through a shell; no temp file.
- `sandbox-exec` is deprecated by Apple but present; the doc must say so.
- Never swallow errors: every `SandboxError` reaches stderr with exit 2; the new invariant must pass `invariant-lint`.
- New code follows the surrounding style: named constants at the top, functions under ~40 lines, comments state constraints.

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence.

#### Task 1.1: The sandbox module
File: harness/adapters/agent/sandbox.js:1-90
What: Create the module per Program Design. `sandboxMode` reads `RAD_AGENT_SANDBOX` (trimmed): unset, blank or `off` returns `off`, `macos` returns `macos`, anything else throws `SandboxError` naming the value and the accepted ones. `sandboxProfile` builds the profile string with a `subpath` rule for directory entries and a `literal` rule for `.netrc` and `.docker/config.json`, and throws on a non-absolute `HOME` or one containing a double quote, backslash or newline. `sandboxSupport` throws unless the platform is `darwin` and `sandbox-exec` resolves on PATH. `wrapArgv` returns the argv untouched when off.
Validate: AC#1, AC#2 — module unit tests.

#### Task 1.2: Unit tests for the module
File: harness/test/agent-sandbox.test.js:1-160
What: Cover every edge case listed in Reminders, assert the exact profile text for a fixed `HOME`, and assert `wrapArgv` returns the same array contents when off and the exact `['sandbox-exec','-p',…]` prefix when on.
Validate: AC#1, AC#2 — `node --test harness/test/agent-sandbox.test.js` passes.

### Wave 2 — sequential
Depends on: Wave 1 complete

#### Task 2.1: Wrap the spawn path and refuse unusable setups
File: harness/adapters/agent/command.js:205-225, harness/cli.js:1013-1045
What: In `startAgentProcess`, spawn `wrapArgv(argv, { env: process.env, home: process.env.HOME })`. In `resolveAgent`, after the adapter kind is known, call `sandboxMode`; when `macos`, return exit code 2 with a stderr line naming the cause for an `acp` or `sdk` adapter, and for any `SandboxError` from `sandboxSupport`. The refusal runs before worktree creation and any event append.
Validate: AC#3, AC#4 — adapter and resolveAgent tests.

#### Task 2.2: Tests for wiring and refusals
File: harness/test/agent-adapters.test.js:1180-1227, harness/test/agent-select.test.js:40-79
What: Adapter tests assert the spawned file and argv with the switch on (via an injected platform and `which`) and unchanged argv/env with it off, for a wave, the preflight probe and the review lane. Resolve tests assert exit 2 and the message for an unknown value, an `acp` adapter, an `sdk` adapter, a non-darwin host and a missing `sandbox-exec`.
Validate: AC#3, AC#4 — `node --test harness/test/agent-adapters.test.js harness/test/agent-select.test.js` passes.

### Wave 3 — sequential
Depends on: Wave 2 complete

#### Task 3.1: The credential eval
File: harness/evals/lib/fixture.js:60-80, harness/evals/delivery.eval.js:150-200
What: Add a `read-home-creds` adversary that tries to read `$HOME/.ssh/id_eval` and writes `readable` or `denied` to `creds.json` in the agent dir. Add an eval case that plants the file in a temp `HOME`, runs `deliver` with that `HOME`, and asserts `readable` without the switch and `denied` with `RAD_AGENT_SANDBOX=macos`. The case is skipped with the reason `skipped: RAD_AGENT_SANDBOX needs macOS sandbox-exec` elsewhere. Its `mutate` removes `.ssh` from the deny list and must flip the result.
Validate: AC#5 — `node --test harness/evals/delivery.eval.js` passes (or skips with the named reason).

#### Task 3.2: Documentation and invariant
File: docs/configuration.md:225-240, docs/invariants.yaml:217-232
What: Document `RAD_AGENT_SANDBOX` (values, default off, deny list, macOS-only, `sandbox-exec` deprecation, the five refusals, and that credentialed network git inside the agent is blocked while the harness still pushes). Add invariant `adapter-home-credentials-denied` (opt-in, claim scoped to the command adapter when the switch is `macos`) with `evals: [harness/evals/delivery.eval.js]` and `enforced_by` entries for `SANDBOX_DENY_PATHS`, `wrapArgv` and the `startAgentProcess` call.
Validate: AC#6 — `invariant-lint` passes and the docs section exists.

Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] Mode parsing, profile text, support check and argv wrapping — harness/test/agent-sandbox.test.js
- [ ] Spawn path wraps the argv when enabled, unchanged when off — harness/test/agent-adapters.test.js
- [ ] resolveAgent refuses unknown value, acp, sdk, non-macOS and missing sandbox-exec — harness/test/agent-select.test.js
- [ ] HOME credentials readable without the switch, denied with it — harness/evals/delivery.eval.js

## Non-Goals
- Making the sandbox the default, or adding an `agent.sandbox` config key.
- Linux or container wrappers, and sandboxing `acp` or `sdk`.
- Restricting network egress or writes outside the deny list.

## Out-of-Scope Dependencies
None. The plan edits `harness/` and `docs/` (self-protected paths), so it is flagged for architect review.

## Risks
- `sandbox-exec` is deprecated by Apple; a future macOS could remove it. The support check fails closed, so a missing binary refuses the run instead of running unsandboxed.
- An agent that itself runs credentialed `git push` or `gh` will fail under the sandbox. The harness pushes outside the agent, but a task that tells the agent to push would break; the doc states this.
- The deny list is hand-picked, so a credential store outside it stays reachable. The doc names the list and says it is not a full isolation boundary.
- Nested sandboxing: an agent CLI that sandboxes its own tools may conflict with `sandbox-exec`. Verified once with `claude -p`; Codex is untested.
