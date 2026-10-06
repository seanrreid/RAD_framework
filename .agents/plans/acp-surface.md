# Plan: ACP Decision Doc, Conformance Check and Docs (#86 part 2)
Created: 2026-10-06
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-06T17:18:55.746Z
Recorded-By: sean@torchcodelab.com
Branch: rad/acp-surface
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/86
Issue-Title: Give the provider seam a protocol, not two bespoke adapters: evaluate ACP + a _rad/ extension namespace

## Context

Part 1 (#184) shipped `RAD_AGENT=acp`. `harness/adapters/agent/acp.js` (577 lines) is a zero-dependency ACP v1 client.
- **Exports:** `createAcpAdapter`, `probeAcp`, `decidePermission`, `ACP_PROTOCOL_VERSION`, `METHOD_NOT_FOUND`.
- **Internals:** the turn machinery (`newSession`, `handshake`, `runTurn`, `closeSession`) is private.
- **Capabilities:** `cli.js` refuses constrained waves for acp with `commandRefusal(resolved.byWave, 'acp')`.
- **Tests:** a scripted fake agent (`harness/test/fixtures/acp/fake-agent.mjs`) drives the adapter tests.

Three things are still missing for #86:
1. **The written evaluation the issue asks for.** It needs a go/no-go with reasons, the spec-risk stance, and the `_rad/` sketch.
2. **A conformance check** a third-party agent can run.
3. **Docs for the acp adapter.** `docs/rad-wave-contract.md` and `docs/rad-cli.md` describe only `command` and `sdk`, and `.env.example` and `docs/configuration.md:169` list `command | sdk`.

One gap from part 1 is also closed here. `acp` returns `permissions: [{ kind, decision }]` on the wave result, but `spine.js:446` (`attemptData`) only copies `usage` into the `wave-attempt` event, so permission decisions never reach the event log.

Decisions (2026-10-06, recorded on #86):
- **Permission decisions are persisted in this plan.** They are an additive, absent-by-default `wave-attempt` key, like the evidence keys documented at `harness/events.js:75-110`.
- **`rad acp-check --cmd "<agent>"`** is the conformance runner.
- **Provider recipes are documented as unverified,** with a manual smoke recipe.

## Scope

| In scope | Out of scope |
|---|---|
| `docs/acp-evaluation.md`: evaluation, go (third adapter), spec risk, `_rad/` sketch (non-normative) | A normative `_rad/` namespace or any `_rad/` method on the wire |
| `checkAcpAgent` in `acp.js`; `rad acp-check --cmd <agent> [--timeout <s>]` | Running acp-check against a real agent in CI |
| `wave-attempt` carries `permissions` when present (spine.js + events.js doc) | Any fold reading `permissions` |
| `rad-wave-contract.md`, `rad-cli.md` (adapter selection, cookbook, acp-check), `.env.example`, `configuration.md` | ACP v2, remote transports, model selection over ACP |
| Invariants: env allow-list and capability refusal cover acp; `acp-protocol-pinned` | Changing acp turn/permission behaviour |

## Acceptance Criteria

1. **`docs/acp-evaluation.md`** (about 200 to 300 lines). It follows the layout of `docs/flue-vs-rad.md`: intro with sources and a captured date, then "What ACP Is", "The Comparison", "Verdict", "Filed". It covers:
   - **What ACP is:** governance (Zed and JetBrains, interim, not yet a foundation), wire `protocolVersion` 1, stdio JSON-RPC, adopters, the official Claude and Codex adapters. It notes the name clash with IBM's Agent Communication Protocol, which merged into A2A. Sources are cited with URLs.
   - **A comparison table:** each need of the seam (prompt, result, usage, abort, capabilities, permission, streaming, model selection) as `command`, `sdk` and `acp` provide it today.
   - **What `runWave` gives up on acp:** model selection and token-count usage (stable v1 reports only context size and cost).
   - **Verdict: go, as a third adapter, not a replacement.** The issue's "adapters become transports" stays a direction, with an explicit trigger: retire `command` for an agent only once that agent passes `rad acp-check`.
   - **Spec risk:** pin v1 with a hand-written client; a v2 agent fails closed at `initialize`. The migration trigger is v2 being marked stable upstream.
   - **Transport and session mobility:** stdio only; Kiro's standalone server process is declined, with the reasoning from the issue.
   - **A non-normative `_rad/` sketch,** clearly marked draft, listing candidate extensions and where each would sit under the spec's extensibility rules (`_`-prefixed methods, `_meta`, never new root fields):
     - wave boundaries;
     - a structured WAVE_RESULT;
     - capability declarations from #85;
     - a gate-state notification.
   - **Filed:** links to `rad acp-check`, the adapter docs, and any follow-up issues created during delivery.
2. **`checkAcpAgent({ cmd, repoRoot, timeoutMs })` in `acp.js`.** Exported; returns `{ ok, checks: [{ name, ok, detail }] }` and never throws for an agent failure. It runs one agent process through these ordered checks and stops at the first failure, which is recorded:
   1. **`spawn`:** the command parses and starts.
   2. **`initialize`:** the response `protocolVersion` is `1`.
   3. **`session/new`:** returns a `sessionId`.
   4. **`prompt`:** one `session/prompt` with a fixed conformance prompt asking for a specific one-task `WAVE_RESULT` block returns a `stopReason` in the parse set (`end_turn`, `max_tokens`, `max_turn_requests`).
   5. **`wave-result`:** the collected text parses with `extractWaveResultBlock` and `parseWaveResult`, and `resultToOutcome` gives `success`.
   6. **`shutdown`:** the process exits within the grace period after stdin closes, without SIGKILL.

   It reuses the existing private turn machinery; the turn logic is not duplicated. Permission requests during the check are answered with the default policy.
3. **`rad acp-check --cmd "<agent>" [--timeout <seconds>]`** (`harness/cli.js`).
   - **Output:** one `PASS <name>` or `FAIL <name>: <detail>` line per check run, then a summary line.
   - **Exit codes:**
     - 0: all checks pass;
     - 1: any check failed;
     - 2: bad argv (missing `--cmd`, unknown flag, a non-positive or malformed `--timeout`).
   - **Defaults:** `--timeout` defaults to the wave timeout.
   - **Registration:** added to the command registry and usage, with no other side effects. It writes no events or files.
   - **Tests:**
     - the fake agent's `complete` scenario passes every check;
     - `wrong-version` fails at `initialize`;
     - a scenario that never emits a block fails at `wave-result`;
     - `ignore-cancel` (or a hang) fails or times out with a named check;
     - each argv error.

     If a needed fake-agent scenario is missing, add it to the fixture (in scope).
4. **Permission decisions in the event log.**
   - **`attemptData`** (`spine.js`) spreads `permissions` into the `wave-attempt` data only when `result.permissions` is a non-empty array. Otherwise the event is byte-identical to today.
   - **`events.js`** documents `permissions` alongside the other optional, data-only `wave-attempt` keys. No fold reads it.
   - **Tests:**
     - a `wave-attempt` with permissions;
     - without them (byte-identical);
     - an empty array (omitted).
   - **Unchanged:** `events-append-only` checks and the replay fixtures still pass.
5. **Docs.** Each provider recipe states which project's docs it comes from.
   - **`docs/rad-wave-contract.md`:**
     - "The adapter interface" names three adapters.
     - A new "### The `acp` adapter" section covers the handshake, turn, `stopReason` mapping, the permission policy table, usage limits, and the model warning.
     - "Writing a new adapter" adds the option "speak ACP v1 and pass `rad acp-check`" as the preferred route for a new provider.
     - "`command` vs `sdk`" becomes a three-way comparison.
   - **`docs/rad-cli.md`:**
     - The "Adapter selection" table and credential rules include `acp`, and the preflight text covers the acp handshake.
     - A deliver-side ACP recipe table lists `claude-agent-acp`, `codex-acp` and Gemini CLI's ACP mode, each marked `not yet run against rad acp-check`.
     - A manual smoke recipe explains how to mark a recipe verified.
     - A new "### rad acp-check" subcommand section.
   - **`.env.example`:** documents `RAD_AGENT=acp`.
   - **`docs/configuration.md`:** the `RAD_AGENT` row lists `command | sdk | acp`.
6. **Invariants** (`docs/invariants.yaml`).
   - **`adapter-env-allow-listed`:** the claim and anchors also cover the acp adapter (its spawn uses `buildChildEnv`).
   - **`capabilities-enforced-or-refused`:** gains an anchor for the acp refusal line in `cli.js`.
   - **New `acp-protocol-pinned`:** "an ACP agent that answers `initialize` with any `protocolVersion` other than 1 is refused before any prompt is sent".
     - Its `not_evalable` reason: protocol handshake with no agent-reachable bypass; covered by `harness/test/acp-adapter.test.js` and `rad acp-check`.
     - It is anchored in `acp.js`.
   - `scripts/lint-invariants.sh` and `scripts/test-lint-invariants.sh` pass.
7. **Suites stay green:**
   - `npm test --prefix harness`;
   - `node --test harness/evals/*.eval.js`;
   - every `scripts/test-*.sh` under both shells;
   - `scripts/lint-shell-safety.sh`, `scripts/lint-invariants.sh`;
   - `scripts/lint-plan.sh` on this plan.

## Agent Scope

No mapper agents were used this session. Same-day research covered the ACP spec (with citations) and the seam map. The part 2 anchors were checked directly against main at `ace04b3`: `acp.js` exports and internals, `spine.js` `attemptData`, the `events.js` optional-key docs, the invariant ids, the doc headings, the `cli.js` registry and acp lines, and the `.env.example` and `configuration.md` rows. There are no out-of-scope dependencies.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| docs/acp-evaluation.md | 1-300 | New: evaluation and decision doc |
| harness/adapters/agent/acp.js | 40-80 | Constants for the conformance prompt and check names |
| harness/adapters/agent/acp.js | 555-680 | `checkAcpAgent` over the existing session machinery (append after `probeAcp`) |
| harness/test/fixtures/acp/fake-agent.mjs | 90-200 | Scenarios for acp-check if missing |
| harness/test/acp-adapter.test.js | 290-390 | `checkAcpAgent` cases (append) |
| harness/cli.js | 55-80 | `ACP_CHECK_USAGE` |
| harness/cli.js | 115-150 | Registry entry `acp-check` |
| harness/cli.js | 3540-3600 | `acpCheckCommand` (insert before `isMainModule`) |
| harness/test/cli.test.js | 2815-2900 | `rad acp-check` cases (append) |
| harness/spine.js | 438-450 | `attemptData` carries `permissions` |
| harness/events.js | 105-125 | Document the optional `permissions` key |
| harness/test/spine.test.js | 2355-2420 | Permissions in `wave-attempt` (append) |
| docs/rad-wave-contract.md | 56-88 | Adapter interface names three adapters |
| docs/rad-wave-contract.md | 357-397 | Writing a new adapter; three-way comparison; acp section |
| docs/rad-cli.md | 302-345 | Adapter selection, credentials, preflight, ACP recipes |
| docs/rad-cli.md | 610-640 | `rad acp-check` section (before Smoke testing) |
| .env.example | 8-30 | `RAD_AGENT=acp` |
| docs/configuration.md | 165-172 | `RAD_AGENT` values |
| docs/invariants.yaml | 189-201 | `adapter-env-allow-listed` covers acp |
| docs/invariants.yaml | 225-235, 256-280 | Capabilities anchor; `acp-protocol-pinned` (append) |

## Execution Notes

### Do Not Touch
- The behaviour of `createAcpAdapter`, `probeAcp` and `decidePermission`, and the turn and permission semantics in `acp.js`. Only add `checkAcpAgent` and the constants it needs.
- `contract.js`, `command.js`, `sdk.js`, `capabilities.js`.
- In `spine.js`, everything except `attemptData`. In `events.js`, every fold; doc comments only.
- `harness/matrix.yaml`, `harness/gates.js`.

### Key Files
- `harness/adapters/agent/acp.js`: `newSession`, `handshake`, `runTurn`, `closeSession`, `blockForStop`, `PARSE_STOP_REASONS`, `AcpFailure`.
- `harness/test/fixtures/acp/fake-agent.mjs`: the scenario switch.
- `harness/spine.js`: `attemptData`.
- `harness/events.js`: the optional `wave-attempt` key docs (lines 75-125).
- `docs/flue-vs-rad.md`: the decision-doc layout.
- `docs/rad-cli.md`: the review-lane provider cookbook (274-289), which is the table style to copy.
- The ACP spec pages cited in part 1's plan, for the evaluation's sources.

### Reminders
- **The `_rad/` sketch is explicitly non-normative.** No code may send a `_rad/` method.
- **Recipes come from each project's own docs** and are marked unverified. Never mark one verified without running it.
- **`rad acp-check` writes nothing:** no events, no files.
- No en dashes. Functions under about 40 lines. Never swallow errors.

## Wave Plan

### Wave 1 — parallel
These tasks touch disjoint files.

#### Task 1.1: Conformance check
File: harness/adapters/agent/acp.js:40-80, harness/adapters/agent/acp.js:555-680, harness/test/fixtures/acp/fake-agent.mjs:90-200, harness/test/acp-adapter.test.js:290-390, harness/cli.js:55-80, harness/cli.js:115-150, harness/cli.js:3540-3600, harness/test/cli.test.js:2815-2900
What: Implement AC#2 and AC#3.
Validate: AC#2, AC#3. Edge cases:
- `complete` passes all six checks;
- `wrong-version` fails at `initialize`, and later checks are not run;
- a missing block fails at `wave-result`;
- a crash mid-turn fails at `prompt`;
- `ignore-cancel` fails at `shutdown` (or times out with a named check);
- ENOENT fails at `spawn`;
- argv: missing `--cmd`, an unknown flag, `--timeout 0`, `--timeout abc`;
- the target tree is unchanged after a run (no files written).

Command: `npm test --prefix harness`.

#### Task 1.2: Permissions in the event log
File: harness/spine.js:438-450, harness/events.js:105-125, harness/test/spine.test.js:2355-2420
What: Implement AC#4.
Validate: AC#4. Edge cases:
- permissions present (recorded);
- absent (byte-identical event);
- an empty array (omitted);
- a veto-sourced attempt keeps its shape plus permissions;
- the replay-regression and events tests pass unedited.

Commands: `npm test --prefix harness`, `node --test harness/evals/*.eval.js`.

### Wave 2 — sequential
This wave documents the shipped behaviour, including `rad acp-check`.

#### Task 2.1: Evaluation, adapter docs and invariants
File: docs/acp-evaluation.md:1-300, docs/rad-wave-contract.md:56-88, docs/rad-wave-contract.md:357-397, docs/rad-cli.md:302-345, docs/rad-cli.md:610-640, .env.example:8-30, docs/configuration.md:165-172, docs/invariants.yaml:189-201, docs/invariants.yaml:225-235, 256-280
What: Implement AC#1, AC#5 and AC#6.
Validate: AC#1, AC#5, AC#6, AC#7.
Commands:
- `scripts/lint-invariants.sh`;
- `bash scripts/test-lint-invariants.sh`;
- the full suite list from AC#7.

There is no testable surface beyond the invariant lint.

## Tests to Write
- [ ] checkAcpAgent checks and failure points — harness/test/acp-adapter.test.js
- [ ] rad acp-check output, exit codes, argv errors — harness/test/cli.test.js
- [ ] wave-attempt permissions present/absent/empty — harness/test/spine.test.js

## Non-Goals
- Defining or sending any `_rad/` extension on the wire.
- Running `rad acp-check` against a real ACP agent in CI. Credentials are needed, so it is a manual recipe.
- Changing the acp adapter's turn, permission, usage or model behaviour.
- Retiring the `command` or `sdk` adapters.

## Out-of-Scope Dependencies
None.

## Risks
- **The `wave-attempt` event shape grows.** The key is additive and absent by default, no fold reads it, and the events-append-only check validates shape. Any CI schema validation that rejects unknown keys would surface in tests.
- **Recipes may be wrong.** They come from upstream docs and are marked unverified, and the smoke recipe gives the way to verify one.
- **The evaluation dates quickly.** It records a captured date and the v2 trigger.

## Issue Gaps
- **Assumption:** the issue's "both existing adapters passing it unchanged" doesn't apply literally. `command` and `sdk` don't speak ACP. The conformance check targets ACP agents, and existing WAVE_RESULT behaviour is pinned by the unchanged regression tests instead.
- **Assumption:** `rad acp-check` uses one fixed conformance prompt and does not exercise permissions. Agents decide when to ask, so a permission check couldn't be deterministic.
- **Assumption:** the verdict is "go as a third adapter". "Adapters become transports" is recorded as a direction, with the trigger being an agent passing `rad acp-check`.
- **Assumption:** follow-up issues found during delivery are filed and linked from the doc's "Filed" section, not fixed here.
