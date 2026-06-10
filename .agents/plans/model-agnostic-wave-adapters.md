# Plan: Model-Agnostic Wave Adapters
Created: 2026-06-10
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-06-10T13:12:36.487Z
Branch: rad/model-agnostic-wave-adapters

## Context

RAD's entire deterministic core (`deliverSpine`, `gates`, `matrix`, `events`,
`fingerprint`, `transitions`, the git stores, the bash guardrails) is already
model-neutral. The *only* coupling to Claude is `harness/runwave.js` — which
imports `@anthropic-ai/claude-agent-sdk` and requires `ANTHROPIC_API_KEY` — plus
the `createRunWave`/apiKey block in `cli.js:deliverCommand`. `deliverSpine`
already takes `runWave` as an injected port, so the abstraction boundary exists;
it just has exactly one Claude-shaped implementation behind it.

This plan generalizes that one seam so RAD drives **any** model or harness (Pi +
Minimax, aider, codex, a local Llama, or the Claude SDK), and folds in the three
adapter-internal hardening discoveries from the Harness Engineering Guide
(timeout/maxTurns, transport-layer error taxonomy, credential/env isolation). The
command/driven adapter is both the most portable path *and* the cheapest — it
rides the agent session the user already pays for, so RAD's own API spend is zero.

## Scope

| In scope | Out of scope |
|---|---|
| Extract SDK-specific logic out of `runwave.js` into a provider-neutral wave-contract module | The crash-resume fold (`resumeFrom(events)`) — follow-on plan `resume-and-verify` |
| A `command` agent adapter (shell out to `$RAD_AGENT_CMD`, parse WAVE_RESULT) as the default | The per-wave `check-tests` gate in the spine — follow-on plan `resume-and-verify` |
| The Claude SDK path demoted to one config-selected `sdk` adapter behind the same interface | Token-usage recording, per-wave model tiering, per-deliver budget breaker — follow-on plan `cost-frugality-layer` |
| Adapter-internal hardening: per-wave timeout + `maxTurns`, error taxonomy + backoff, one re-prompt on missing WAVE_RESULT, allow-listed env for the SDK path | Changing `gates`, `transitions`, `fingerprint`, or the matrix decision policy |
| Adapter selection config (env `RAD_AGENT` / `RAD_AGENT_CMD`) wired into `deliverCommand` | A CLAUDE.md config-file loader in the harness (env + flags only for now) |
| Reconcile the adapter result shape (`{status,tasks}`) with the matrix outcome vocabulary the spine consumes | `/rad-design` scope-map generation; Decision 2 (events.jsonl as sole approval authority) |
| Provider-neutral "RAD wave contract" doc + CLAUDE.md/rad-cli.md updates | Sandboxing/OS-isolation implementation (documented as a future seam only) |

## Acceptance Criteria
1. A provider-neutral wave-contract module builds the wave prompt and parses the
   `WAVE_RESULT` block with **no** vendor-SDK import; `runwave.js`'s SDK-specific
   logic no longer lives in a Claude-coupled top-level file.
2. A `command` agent adapter renders the wave prompt, invokes a user-configured
   command (`$RAD_AGENT_CMD`), and parses `WAVE_RESULT` from stdout — importing no
   vendor SDK and requiring no `ANTHROPIC_API_KEY`.
3. The Claude SDK path survives as an `sdk` adapter behind the same
   `runWave(wave, planCtx) -> result` interface, built on the shared contract module.
4. `cli.js:deliverCommand` selects the adapter via config (env `RAD_AGENT`,
   default `command`); the `command` path runs with no API key set, while the
   `sdk` path still requires `ANTHROPIC_API_KEY`.
5. Both adapters enforce a per-wave wall-clock timeout and the `sdk` adapter sets
   `maxTurns`; on trip they return a terminal failure the existing matrix routes
   (`fail-timeout`), never hanging the deliver.
6. Both adapters classify failures (transient / permanent / model / resource);
   transient failures retry with exponential backoff + jitter before producing a
   terminal outcome, and a missing `WAVE_RESULT` block triggers exactly one
   re-prompt before failing.
7. The `sdk` adapter passes an allow-listed env subset to the sub-agent (not the
   full `process.env`); the API key never appears in logs or error strings
   (existing sanitization preserved).
8. The adapter result maps deterministically to the matrix outcome vocabulary the
   spine consumes (reconcile `{status,tasks}` ↔ `outcome`); existing `spine` and
   `matrix` tests stay green.
9. A provider-neutral "RAD wave contract" doc exists, and CLAUDE.md + docs/rad-cli.md
   document adapter selection and per-path credential requirements.

## Agent Scope
Research delegated to one Explore sub-agent (no per-role agents — the RAD Agent
Scope Map is unpopulated; the framework is dogfooding itself). No out-of-scope
agent dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/runwave.js | 1-345 | Removed; logic split into `adapters/agent/contract.js` (pure) + `adapters/agent/sdk.js` (SDK adapter) |
| harness/adapters/agent/contract.js | 280 | New — `buildWavePrompt`, `extractWaveResultBlock`, `parseWaveResult`, `resultToOutcome` mapping, `sanitizeErrorMessage`, `syntheticFailure`, plus `classifyError`/`backoffWithJitter`/`withTimeout` helpers. No SDK import |
| harness/adapters/agent/command.js | 160 | New — `createCommandAdapter({ cmd, repoRoot, timeoutMs })`: spawn `$RAD_AGENT_CMD`, feed prompt, wall-clock timeout, parse stdout, classify non-zero exit, one re-prompt, no API key |
| harness/adapters/agent/sdk.js | 200 | New — current `runwave.js` refactored onto `contract.js`; adds `AbortController` timeout + `options.maxTurns`, allow-listed env, transient backoff, one re-prompt; keeps key sanitization |
| harness/cli.js | 151-172, 260-362 | Adapter selection via `RAD_AGENT`/`RAD_AGENT_CMD`; `command` path skips the apiKey check, `sdk` path keeps it; bind chosen `runWave` to `deliverSpine` |
| harness/test/agent-contract.test.js | 130 | New — `resultToOutcome` mapping, prompt build, WAVE_RESULT parse, `classifyError` taxonomy |
| harness/test/agent-adapters.test.js | 180 | New — command adapter (fake spawn: success / timeout / missing-block re-prompt / non-zero), sdk adapter (fake `query` injection), cli adapter-selection |
| docs/rad-wave-contract.md | 140 | New — provider-neutral wave contract: prompt shape, `WAVE_RESULT` spec, the `runWave` adapter interface, result→outcome mapping |
| docs/rad-cli.md | 157-170 | Document adapter selection (`RAD_AGENT`, `RAD_AGENT_CMD`) and per-path credential requirements |
| CLAUDE.md | 88-101 | Add agent-adapter config to the RAD Configuration section (`agent: command \| sdk`, `agent_cmd`, key requirements) |

## Execution Notes

### Do Not Touch
- harness/gates.js — pure gate evaluator; no model coupling. Keep model-neutral.
- harness/transitions.js — pure phase state machine. Do not alter transition rules.
- harness/fingerprint.js — doom-loop breaker; preserve hash stability.
- harness/spine.js — the deliver spine consumes the adapter; this plan keeps its
  `runWave` contract stable and does **not** change its wave loop. (The per-wave
  test gate is the follow-on `resume-and-verify` plan.)
- harness/events.js / matrix.yaml / matrix.js — reuse existing outcomes
  (`fail-timeout`, `fail-protocol`); do not add new outcomes or event types here.

### Key Files
- harness/runwave.js — the file being split; carries the prompt template, WAVE_RESULT parser, and current SDK call.
- harness/cli.js — `deliverCommand` is the construction/injection point for the chosen adapter.
- harness/spine.js — read to confirm the exact `runWave` result shape the spine consumes (`result.outcome`) so the contract module maps to it correctly.
- harness/adapters/git-state-store.js — the factory+injection adapter pattern to mirror for `adapters/agent/*`.
- harness/test/spine.test.js — shows how `runWave` is faked/injected; mirror for adapter tests.

### Reminders
- The spine reads `result.outcome`; the SDK runner currently returns
  `{status, tasks}`. The contract module's `resultToOutcome` MUST reconcile these
  (AC#8) — verify `spine.test.js` stays green after the change.
- The `command` adapter must never require or read `ANTHROPIC_API_KEY`; auth is the
  user's harness's responsibility on that path.
- Keep the `WAVE_RESULT` contract plain-text (no tool-calling / structured-output
  API) so weaker models driven via a CLI can satisfy it.
- Map adapter-terminal failures onto existing matrix outcomes (timeout/maxTurns →
  `fail-timeout`; unparseable-after-re-prompt → `fail-protocol`) to avoid touching
  the matrix in this plan.

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (Task 1.2 builds on 1.1's module).

#### Task 1.1: Extract the provider-neutral wave contract
File: harness/adapters/agent/contract.js:1-220
What: Move `buildWavePrompt`, `extractWaveResultBlock`, `parseWaveResult`,
`VALID_TASK_STATUSES`, `sanitizeErrorMessage`, and `syntheticFailure` out of
`runwave.js` into a new pure module with no `@anthropic-ai/claude-agent-sdk`
import. Add `resultToOutcome(parsed)` that maps a parsed `{status, tasks}` result
to the matrix outcome string the spine consumes (`success`/`fail-*`).
Validate: AC#1 — `node --test` passes new contract tests; `grep` confirms no SDK
import in `contract.js`. AC#8 — `resultToOutcome` round-trips the result shapes
`spine.js` expects.

#### Task 1.2: Add timeout / error-classification / backoff helpers
File: harness/adapters/agent/contract.js:220-280
What: Add `classifyError(err) -> 'transient'|'permanent'|'model'|'resource'`,
`backoffWithJitter(attempt)`, and `withTimeout(promise, ms, abortController)` so
both adapters share one hardening implementation.
Validate: AC#5 — `withTimeout` rejects/aborts past the deadline (unit test). AC#6 —
`classifyError` buckets rate-limit/network as transient and file-not-found/auth as
permanent (unit test).

### Wave 2 — parallel
Depends on: Wave 1 complete. Both adapters consume `contract.js`; no shared state.

#### Task 2.1: Command/driven adapter (the default)
File: harness/adapters/agent/command.js:1-160
What: `createCommandAdapter({ cmd, repoRoot, timeoutMs })` returning
`runWave(wave, planCtx)`: render the prompt via `contract.buildWavePrompt`, spawn
`$RAD_AGENT_CMD` (prompt via stdin or `{prompt}` placeholder), enforce `withTimeout`,
read stdout, parse via `contract`, classify a non-zero exit, and re-prompt exactly
once on a missing `WAVE_RESULT`. Imports no vendor SDK; never reads `ANTHROPIC_API_KEY`.
Validate: AC#2 — fake-spawn test drives a successful wave with no API key in env.
AC#5 — a hanging fake command trips the timeout → `fail-timeout`. AC#6 — a missing
block triggers one re-prompt, then `fail-protocol`.

#### Task 2.2: SDK adapter (hardened) — replaces runwave.js
File: harness/adapters/agent/sdk.js:1-200
What: Re-home the current SDK runner onto `contract.js`; add `options.maxTurns`,
an `AbortController` timeout via `withTimeout`, an allow-listed env subset (not the
full `process.env`), transient-error backoff via `contract`, and one re-prompt on a
missing block. Preserve API-key sanitization. Delete `harness/runwave.js`.
Validate: AC#3 — fake-`query` injection test exercises the adapter behind the
shared interface. AC#5 — `maxTurns`/timeout produce `fail-timeout`. AC#7 — the env
handed to `query` is the allow-list, and no test output contains the fake key.

### Wave 3 — sequential
Depends on: Wave 2 complete (the adapters must exist before the CLI selects them).

#### Task 3.1: Wire adapter selection into deliverCommand
File: harness/cli.js:151-172,260-362
What: Read `RAD_AGENT` (default `command`) and `RAD_AGENT_CMD`; construct the chosen
adapter; gate the `ANTHROPIC_API_KEY` check on the `sdk` path only; bind the chosen
`runWave` to `deliverSpine`. Keep `--model` flowing to the `sdk` adapter.
Validate: AC#4 — `rad deliver` with `RAD_AGENT=command` runs with no API key set;
with `RAD_AGENT=sdk` and no key it errors as before.

#### Task 3.2: Tests — contract, both adapters, selection
File: harness/test/agent-contract.test.js:1-130, harness/test/agent-adapters.test.js:1-180
What: Cover `resultToOutcome`, prompt build, parse, `classifyError`; command adapter
(success / timeout / re-prompt / non-zero exit); sdk adapter (fake `query`); and
`deliverCommand` adapter selection. Confirm `spine.test.js`/`matrix.test.js` still pass.
Validate: AC#2, AC#3, AC#4, AC#8 — `npm test` green across the full suite.

#### Task 3.3: Document the wave contract and adapter config
File: docs/rad-wave-contract.md:1-140
What: Write the provider-neutral wave contract (prompt shape, `WAVE_RESULT` spec,
the `runWave` interface, result→outcome mapping). Update docs/rad-cli.md (adapter
selection, credential requirements per path) and CLAUDE.md's RAD Configuration
section (`agent: command | sdk`, `agent_cmd`).
Validate: AC#9 — docs describe both adapters; CLAUDE.md lists the new config keys.

## Tests to Write
- [ ] `resultToOutcome` maps every `{status,tasks}` shape to a valid matrix outcome — harness/test/agent-contract.test.js
- [ ] `classifyError` taxonomy buckets transient vs permanent vs model vs resource — harness/test/agent-contract.test.js
- [ ] `withTimeout` aborts past the deadline — harness/test/agent-contract.test.js
- [ ] command adapter: success, timeout, missing-block re-prompt, non-zero exit; no API key required — harness/test/agent-adapters.test.js
- [ ] sdk adapter: fake-`query` success, `maxTurns`/timeout → `fail-timeout`, env allow-list, key never logged — harness/test/agent-adapters.test.js
- [ ] `deliverCommand` selects adapter by `RAD_AGENT` and gates the key check on the sdk path — harness/test/agent-adapters.test.js

## Non-Goals
- The crash-resume fold and the per-wave `check-tests` gate (discoveries #3 and #4) — deferred to the `resume-and-verify` follow-on plan.
- Token-usage recording, per-wave model tiering, and the per-deliver budget circuit breaker (the cost-frugality layer) — deferred to the `cost-frugality-layer` follow-on plan.
- A CLAUDE.md config-file loader in the harness — selection stays on env vars + CLI flags in this plan.
- Any change to the matrix decision policy, gates, transitions, or fingerprint.
- Implementing OS-level sandboxing — the env allow-list is the only isolation step here; full sandboxing is documented as a future seam.

## Out-of-Scope Dependencies
None requiring architect-only agents. Two **sequenced follow-on plans** carry the
remaining Harness Engineering discoveries (create after this plan delivers):
- `resume-and-verify` — discovery #3 (`resumeFrom(events)` crash-resume fold) and
  #4 (per-wave `check-tests` advance gate). Coordinates with Decision 2.
- `cost-frugality-layer` — token-usage events, per-wave model tiering, per-deliver
  token/cost budget breaker, and prompt frugality reminders.

## Risks
- The spine consumes `result.outcome` while the current SDK runner returns
  `{status, tasks}`; if `resultToOutcome` mis-maps, the matrix could mis-route a
  wave. Mitigation: AC#8 pins the mapping with tests and requires `spine.test.js`
  to stay green.
- Deleting `runwave.js` breaks any importer; only `cli.js` imports it — Task 3.1
  rewires that in the same plan.
- The `command` adapter's portability depends on the configured CLI emitting the
  `WAVE_RESULT` block; weaker models may need the one re-prompt (AC#6) and a clear
  contract doc (AC#9) to comply reliably.
