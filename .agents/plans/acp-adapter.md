# Plan: ACP Agent Adapter (#86 part 1)
Created: 2026-10-06
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-06T16:39:07.202Z
Recorded-By: sean@torchcodelab.com
Branch: rad/acp-adapter
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/86
Issue-Title: Give the provider seam a protocol, not two bespoke adapters: evaluate ACP + a _rad/ extension namespace

## Context

RAD's provider seam has two adapters, both implementing `runWave(wave, planCtx) → {outcome, status, tasks?, usage?}`:
- **`sdk.js`** (Claude Agent SDK).
- **`command.js`**: spawn any CLI, buffer stdout, scrape `WAVE_RESULT`.

Both share the provider-neutral `contract.js` (`buildWavePrompt`, `extractWaveResultBlock`, `parseWaveResult`, `resultToOutcome`, `toWaveResult`, `normalizeUsage`).

The command path can't express four things:
- streaming;
- a permission round-trip (so it refuses capability-constrained waves);
- usage, unless a wrapper prints `RAD_USAGE`;
- cancel, other than by killing the process.

**What research found about ACP (2026-10-06)** (sources are cited in the decision doc in part 2):
- **Governance and versioning.** The Agent Client Protocol is active and run jointly by Zed and JetBrains. Wire `protocolVersion` is `1`, and a breaking v2 is in draft with no date.
- **Transport.** Newline-delimited JSON-RPC 2.0 over stdio.
- **Who speaks it.** Gemini CLI, Copilot, Cursor, Goose, OpenCode, Kiro and Junie speak it natively. Claude and Codex go through maintained official adapters: `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp`.
- **What it adds.** Streamed `session/update` (including `usage_update`), `session/request_permission`, `session/cancel`, and a `stopReason` on each turn.
- **Extensions.** Custom methods go under a `_`-prefixed namespace and custom fields go in `_meta`. Adding fields at the root of a spec type is forbidden.

Decisions (2026-10-06, recorded on #86):
- **Deliverable:** a working ACP adapter plus a decision doc and a conformance fixture.
- **Spec version:** pin ACP v1 with a hand-written, zero-dependency client, and track v2 as a documented migration.
- **`_rad/` namespace:** sketched, not normative.

**Split:**
- **Part 1 (this plan):** the adapter, `RAD_AGENT=acp`, and tests against a fake ACP agent.
- **Part 2:** `docs/acp-evaluation.md` (go/no-go, spec risk, the `_rad/` sketch), the conformance runner a third-party agent can run, the adapter docs (`rad-wave-contract.md`, `rad-cli.md` cookbook), `.env.example`, invariants.

## Scope

| In scope | Out of scope |
|---|---|
| `harness/adapters/agent/acp.js`: zero-dep ACP v1 client + `createAcpAdapter` (`runWave`) + `probeAcp` | ACP v2, remote transports (HTTP/WebSocket) |
| `RAD_AGENT=acp` selection, preflight handshake, capability refusal | Replacing `sdk` or `command` (ACP is a third adapter) |
| A fake ACP agent fixture driving every adapter path in tests | The decision doc, conformance runner, docs, invariants (part 2) |
| Exporting `buildChildEnv`/`tokenizeCommand` from `command.js` for reuse | Defining `_rad/` methods normatively; serving fs/terminal client methods |
| `commandRefusal` naming the adapter | The `rad review` lane (stays on the command path) |

## Acceptance Criteria

1. **ACP v1 client (`harness/adapters/agent/acp.js`).** Spawns `RAD_AGENT_CMD` (tokenized with the exported `tokenizeCommand`; `{prompt}` placeholders are rejected, because the prompt travels over the protocol), with the exported `buildChildEnv` allow-list and `cwd` = repo root.
   - **Wire format:** newline-delimited JSON-RPC 2.0 on stdin and stdout. Outgoing messages are `JSON.stringify` output (never containing a raw newline). Incoming lines are parsed one at a time. Requests are correlated by `id`, and notifications are dispatched by `method`.
   - **Malformed input:** a line that is not JSON-RPC, or a response to an unknown `id`, is a protocol error that ends the session with outcome `fail-protocol`, never a silent skip. stderr is captured, capped, for the failure message.
   - **Handshake:**
     - `initialize` sends `{ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'rad', version } }`.
     - A response `protocolVersion` other than `1` ends the session with `fail-protocol`, and the message names both versions (fail closed, no negotiation down or up).
     - If the agent returns non-empty `authMethods`, the session is not refused. The agent is expected to be already authenticated, and a later auth error surfaces as a failure.
     - `session/new` sends `{ cwd: <absolute repo root>, mcpServers: [] }`.
   - **Requests from the agent:**
     - **`session/request_permission`** is answered by AC#3.
     - **Any other request** (including `fs/*` and `terminal/*`, which RAD never advertises) is answered with JSON-RPC error `-32601`.
     - **Unknown notifications** are ignored, as the spec requires.
2. **Turns and outcomes (`createAcpAdapter({ cmd, repoRoot, timeoutMs, killGraceMs })` → `{ runWave }`).** Each `runWave` attempt is one fresh agent process and session.
   - **Sending the wave:** `session/prompt` sends `buildWavePrompt(wave, planCtx)` as a single text content block.
   - **Collecting output:** the `text` of every `agent_message_chunk` (text content only) is concatenated into the turn text.
   - **Usage:** `usage_update` notifications are reduced through `normalizeUsage` when their fields map (input and output token counts, optional cache and cost). Otherwise usage is omitted, never guessed. Field names follow the ACP schema the delivering agent verifies; any it can't verify are documented as unmapped.
   - **Mapping `stopReason` to an outcome:**
     - **`end_turn`, `max_tokens`, `max_turn_requests`:** parse the turn text with `extractWaveResultBlock`, `parseWaveResult` and `toWaveResult` (the same path as the command adapter, so outcomes are identical for identical text).
       - **Missing block:** the adapter sends exactly one follow-up `session/prompt` in the same session asking only for the `WAVE_RESULT` block, then gives `fail-protocol`. This matches the command adapter's single reprompt.
     - **`refusal`:** `fail-scope`, with the message `agent refused the wave (ACP stopReason refusal)`.
     - **`cancelled`:** only happens after RAD's own timeout, and gives `fail-timeout`.
     - **Unknown `stopReason`:** `fail-protocol`.
   - **Timeout:** the adapter sends `session/cancel`, waits up to `killGraceMs` for the prompt response, then terminates the process with the existing SIGTERM-then-SIGKILL sequence. The result is `fail-timeout`.
   - **The process exits or crashes before the turn ends:** `fail-protocol`, with an excerpt of the process's stderr.
   - **The process can't be spawned** (ENOENT): `fail-protocol` after a single attempt.
   - **Shutdown:** after every attempt the adapter closes stdin and waits for the process to exit, then kills it after `killGraceMs`. No process outlives `runWave`.
3. **Permission policy.** Each `session/request_permission` is answered from the wave's effective capability classes (`planCtx.waveEffective[wave]`, defaulting to `fs_read`, `fs_write` and `shell`).
   - **Mapping ACP tool-call `kind` to a class:**
     - `read`, `search`, `think` → `fs_read`;
     - `edit`, `delete`, `move` → `fs_write`;
     - `execute` → `shell`;
     - `fetch` → `net`;
     - `other` or a missing kind → refused.
   - **Granted class:** the adapter picks the option whose `kind` is `allow_once`.
   - **Not granted:** it picks `reject_once`.
   - **Neither option offered:** it answers `{ outcome: 'cancelled' }`. It never picks an `allow_always` option.
   - **Logging:** every decision is recorded on the result as `permissions: [{ kind, decision }]` for the event log. If the result shape cannot carry it without a contract change, it is logged to stderr instead and the delivering agent says so.
   - **Constrained waves are still refused before launch** (AC#4). An ACP agent may act without asking, so the permission answers are defence in depth, not enforcement.
4. **Selection (`harness/cli.js`).**
   - **Selection:** `RAD_AGENT=acp` is accepted, the unknown-value message lists `command | sdk | acp`, and `resolveAgent` returns `{ kind: 'acp', cmd }`. `RAD_AGENT_CMD` is required, with the message naming `RAD_AGENT=acp`.
   - **Preflight:** `RAD_AGENT_PREFLIGHT`, unless off, runs `probeAcp`. That is the `initialize` + `session/new` handshake with no prompt and no model cost, under the same timeout env. Exit 1 names the failure.
   - **Capabilities:** `capabilityRefusal` applies `commandRefusal(byWave, 'acp')`, and the refusal text names the adapter.
   - **Model:** a plan or wave model declaration is passed to neither the agent nor the protocol (ACP v1 has no stable model selector). The adapter prints one warning per run when a model was requested and is ignored.
5. **Reuse without behaviour change.**
   - **`command.js`:** exports `buildChildEnv` and `tokenizeCommand` unchanged. `ENV_ALLOW_LIST` and every command-adapter test stay untouched and pass.
   - **`capabilities.js`:** `commandRefusal(byWave, adapter = 'command')` keeps its current message for `'command'`.
   - **Regression:** existing WAVE_RESULT regression fixtures (`agent-contract.test.js`, `replay-regression.test.js`) still pass unedited.
6. **Suites stay green:**
   - `npm test --prefix harness`;
   - `node --test harness/evals/*.eval.js`;
   - every `scripts/test-*.sh` under both shells;
   - `scripts/lint-shell-safety.sh`, `scripts/lint-invariants.sh`;
   - `scripts/lint-plan.sh` on this plan.

## Agent Scope

Two research agents ran:
- **Explore (read-only):** mapped the provider seam (`contract.js`, `sdk.js`, `command.js`, adapter selection, capability refusal, outcome routing, the docs, the regression tests).
- **General-purpose (web, read-only):** summarized the ACP spec, its governance, adopters and SDKs, with citations.

The anchors were spot-checked directly. There are no out-of-scope dependencies.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/adapters/agent/acp.js | 1-420 | New: ACP v1 client, `createAcpAdapter`, `probeAcp`, permission policy |
| harness/adapters/agent/command.js | 84-92 | Export `buildChildEnv` |
| harness/adapters/agent/command.js | 160-190 | Export `tokenizeCommand` |
| harness/capabilities.js | 120-139 | `commandRefusal(byWave, adapter)` |
| harness/cli.js | 655-680 | Preflight dispatch for acp |
| harness/cli.js | 738-770 | `resolveAgent` acp branch |
| harness/cli.js | 822-845 | `capabilityRefusal` acp branch |
| harness/cli.js | 862-885 | Construct the acp adapter |
| harness/cli.js | 1433-1445 | `RAD_AGENT` accepts `acp` |
| harness/test/fixtures/acp/fake-agent.mjs | 1-200 | New: scripted ACP agent (scenario via env) |
| harness/test/acp-adapter.test.js | 1-420 | New: client, turn, permission, timeout, crash cases |
| harness/test/capabilities.test.js | 155-200 | `commandRefusal` adapter label (append) |
| harness/test/cli.test.js | 2680-2780 | `RAD_AGENT=acp` selection, preflight, refusal (append) |

## Execution Notes

### Do Not Touch
- `ENV_ALLOW_LIST`, `spawnOnce`, `describeExitFailure`, `createCommandAdapter` behaviour in `command.js`.
- `contract.js`: reuse only, with no edits. If a contract change looks necessary, stop and report `blocked_intent`.
- `sdk.js`, `harness/spine.js`, `harness/matrix.yaml`, `harness/gates.js`, `harness/events.js`.
- `docs/` and `.env.example` (part 2).

### Key Files
- `harness/adapters/agent/contract.js`: the result path to reuse.
- `harness/adapters/agent/command.js`: the kill sequence (`killOnAbort`, `KILL_GRACE_MS`), the env allow-list, `probeCommand` as the model for `probeAcp`, `createCommandAdapter`'s reprompt-once rule.
- `harness/capabilities.js`: `CAPABILITY_CLASSES`, `commandRefusal`.
- `harness/cli.js`: `resolveAgent`, `preflightExitCode`, `capabilityRefusal`, adapter construction (two setup paths, main and worktree, both call `resolveAgent`).
- ACP v1 spec: https://agentclientprotocol.com/protocol/overview, `/initialization`, `/prompt-turn`, `/tool-calls` (permission option kinds), `/extensibility`. Verify field names against the spec or the published schema before coding. Record anything you couldn't verify in a code comment and the WAVE_RESULT concern.

### Reminders
- **No new dependencies.** Node built-ins only (`child_process`, `readline`); never `@agentclientprotocol/sdk`.
- **Fail closed.** Every unexpected protocol state ends the attempt with a named outcome. Nothing hangs: every await has a timeout.
- **One process per attempt.** Kill on every exit path, including thrown errors.
- **The fake agent must be deterministic.** Scenarios are selected through an env var passed via `RAD_AGENT_CMD`, for example `node <fixture> <scenario>`.
- Functions under about 40 lines, named constants, no en dashes.

## Wave Plan

### Wave 1 — parallel
These tasks touch disjoint files.

#### Task 1.1: ACP client and adapter
File: harness/adapters/agent/acp.js:1-420, harness/adapters/agent/command.js:84-92, harness/adapters/agent/command.js:160-190, harness/test/fixtures/acp/fake-agent.mjs:1-200, harness/test/acp-adapter.test.js:1-420
What: Implement AC#1, AC#2, AC#3 and the `command.js` part of AC#5.
Validate: AC#1, AC#2, AC#3, AC#5. Edge cases (fake-agent scenarios):
- **Normal and recoverable turns:**
  - a complete wave;
  - a missing block followed by a good reprompt;
  - a missing block twice (`fail-protocol`);
  - `usage_update` present, absent and malformed.
- **Protocol failures:**
  - a wrong `protocolVersion`;
  - a non-JSON line;
  - a response to an unknown id.
- **Agent stop reasons:**
  - `refusal` (`fail-scope`);
  - an unknown `stopReason`.
- **Process failures:**
  - a hang (`session/cancel` sent, then `fail-timeout`, and the process is dead);
  - an ignored cancel (SIGKILL after the grace period);
  - a crash mid-turn;
  - ENOENT.
- **Requests from the agent:**
  - an `fs/read_text_file` request (answered `-32601`, turn continues);
  - permission requests for `edit` (allowed), `fetch` (rejected), `other` (rejected), and options with no `allow_once` (cancelled).
- **Command parsing:** a `{prompt}` placeholder in the command is rejected.

Command: `npm test --prefix harness`.

#### Task 1.2: Adapter-named capability refusal
File: harness/capabilities.js:120-139, harness/test/capabilities.test.js:155-200
What: Implement the `capabilities.js` part of AC#5. The existing `commandRefusal` tests pass unedited, and new tests cover the `'acp'` label.
Validate: AC#5. Edge cases: the default label is unchanged; the `acp` label; an unconstrained wave gives `null` for both.
Command: `npm test --prefix harness`.

### Wave 2 — sequential
This wave depends on both Wave 1 tasks.

#### Task 2.1: RAD_AGENT=acp wiring
File: harness/cli.js:655-680, harness/cli.js:738-770, harness/cli.js:822-845, harness/cli.js:862-885, harness/cli.js:1433-1445, harness/test/cli.test.js:2680-2780
What: Implement AC#4. Both setup paths (main and worktree) construct the acp adapter.
Validate: AC#4, AC#6. Edge cases:
- `RAD_AGENT=acp` without `RAD_AGENT_CMD` (exit 1, named);
- an unknown `RAD_AGENT` lists all three;
- preflight passes against the fake agent;
- preflight fails on a wrong version (exit 1);
- `RAD_AGENT_PREFLIGHT=off` skips the probe;
- a constrained wave is refused, naming acp, before any event is written;
- a declared model prints one warning;
- an end-to-end `rad deliver` of a one-wave fixture plan through the fake agent reaches `success`.

Commands:
- `npm test --prefix harness`;
- `node --test harness/evals/*.eval.js`;
- every `scripts/test-*.sh` under both shells;
- `scripts/lint-shell-safety.sh`, `scripts/lint-invariants.sh`.

## Tests to Write
- [ ] ACP client, turn, permission, timeout and crash cases — harness/test/acp-adapter.test.js
- [ ] commandRefusal adapter label — harness/test/capabilities.test.js
- [ ] RAD_AGENT=acp selection, preflight, refusal, end-to-end deliver — harness/test/cli.test.js

## Non-Goals
- Replacing the `sdk` or `command` adapter, or changing their behaviour.
- ACP v2, the HTTP or WebSocket transports, `session/load`, session modes, model selection over ACP.
- Serving `fs/*` or `terminal/*` client methods (RAD advertises neither capability).
- A normative `_rad/` namespace, the conformance runner, and the docs (part 2).
- A live CI run against a real ACP agent. It needs credentials, so a manual smoke recipe goes in the part 2 docs.

## Out-of-Scope Dependencies
None. Real ACP agents (`claude-agent-acp`, `codex-acp`, Gemini CLI) are operator-installed, like any `RAD_AGENT_CMD`. RAD adds no package.

## Risks
- **Spec drift.** v1 is pinned, and a v2 agent fails closed at `initialize` with a clear message. Unknown `session/update` kinds are ignored, so additive v1 changes don't break the client.
- **The permission policy is best-effort.** Agents decide when to ask. This is why constrained waves are still refused rather than trusted to the permission round-trip.
- **Usage field names are unverified** (`usage_update`). The adapter omits usage rather than guessing, and the delivering agent verifies the names against the schema.
- **Model declarations are ignored** on acp, with a warning. Operators choose the model in the agent's own config.

## Issue Gaps
- **Assumption:** ACP is added as a **third adapter**, not a replacement for `sdk` or `command`. The issue's "adapters become transports" is a direction for the decision doc (part 2), not something this plan does.
- **Assumption:** `RAD_AGENT_CMD` is reused for the ACP agent command. No new `RAD_ACP_CMD` is added.
- **Assumption:** the permission policy maps ACP tool kinds to RAD capability classes. It never answers `allow_always`, and it refuses `other` and missing kinds.
- **Assumption:** `refusal` maps to `fail-scope` (not retried), and `max_tokens` and `max_turn_requests` go through the normal block parse (a complete block still counts).
- **Assumption:** `authMethods` from the agent is not acted on. RAD expects a pre-authenticated agent, as on the command path.
- **Assumption:** each attempt is a fresh process and session. There's no `session/load` and no reuse across attempts, so a resumed run behaves like the command path.
