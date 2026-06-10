# Plan: Cost-Frugality Layer
Created: 2026-06-10
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-06-10T18:28:08.045Z
Branch: rad/cost-frugality-layer

## Context

Token spend is a first-class product constraint: RAD must be frugal without cutting
quality. The biggest frugality lever — wave-isolated context (main holds only the log,
not file contents) — already exists. This plan adds the missing instrumentation and
controls the Harness Engineering Guide review surfaced: (1) **cost is invisible** — no
token usage is recorded, so a deliver's spend can't be audited; (2) **every wave pays
frontier price** — there's no per-wave model tiering, so a docs wave costs the same as a
security wave; (3) **no ceiling** — a runaway deliver can drain an account with no
circuit breaker. It is the `cost-frugality-layer` follow-on named in
`model-agnostic-wave-adapters` and sequences **after** it (the adapters expose usage and
accept a per-wave model).

## Scope

| In scope | Out of scope |
|---|---|
| Record token usage (input/output/total) per `wave-attempt` event, backward-compatible | The agent-adapter interface itself (delivered by `model-agnostic-wave-adapters`) |
| Per-wave model tiering — wave descriptor may declare a `model`; adapter uses it, else the deliver default | Resume fold + per-wave test gate (the `resume-and-verify` plan) |
| Optional per-deliver token-budget circuit breaker (`RAD_TOKEN_BUDGET`) with graceful abort | A cost *pricing* model (dollar conversion) — record tokens, not prices |
| Cost surfacing in `/rad-insights` (cost-per-feature, cost-per-wave) from usage events | Changing `gates`, `transitions`, `fingerprint`, or the matrix decision policy |
| Strengthen `buildWavePrompt` frugality discipline (truncate-large-outputs reminder) | New matrix outcomes — the budget breaker is a spine-level terminal return |

## Acceptance Criteria
1. Each `wave-attempt` event records token usage `{input, output, total}` when the adapter
   exposes it (SDK `result.usage`; the command adapter parses usage where its CLI emits it);
   events without a usage field still fold correctly (backward compatibility preserved).
2. A wave descriptor may declare an optional `model`; the adapter uses the per-wave model
   when set and the deliver default otherwise — verified by a docs wave selecting a cheap
   model and a security wave selecting a frontier model.
3. When `RAD_TOKEN_BUDGET` is set, the spine accumulates total usage and, before starting a
   wave that would exceed the budget, returns a structured terminal result
   (`stopped: 'token-budget'`) — a graceful abort, never a throw.
4. `/rad-insights` surfaces cost-per-feature and cost-per-wave aggregated from the usage
   events (and tolerates older events that lack usage).
5. `buildWavePrompt` includes a "truncate large tool/command outputs" reminder, strengthening
   the existing no-speculative-reads / pre-load-only-listed-files discipline.
6. New tests cover usage recording (with and without an adapter-supplied usage field),
   per-wave model selection, and the budget circuit breaker; the existing suite stays green.

## Agent Scope
Reuses this session's Explore research (covered `events.js` usage-field placement,
`spine.js` budget hook, the adapter result shape, and `buildWavePrompt`). No per-role
agents; no out-of-scope agent dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/adapters/agent/contract.js | 1-280 | `buildWavePrompt` gains the truncate-outputs reminder; the result shape carries optional `usage`; pass a per-wave `model` through |
| harness/adapters/agent/command.js | 1-160 | Parse usage from the CLI output where available; accept and apply a per-wave model |
| harness/adapters/agent/sdk.js | 1-200 | Surface `result.usage`; accept and apply a per-wave model |
| harness/spine.js | 54-176 | Pass `wave.model` to `runWave`; record `usage` into the `wave-attempt` event; accumulate total usage and apply the `RAD_TOKEN_BUDGET` breaker (graceful `stopped: 'token-budget'`) |
| harness/events.js | 100-139 | Tolerate optional `usage` in `wave-attempt` data; expose a usage-aggregation helper for insights; old events fold unchanged |
| harness/cli.js | 151-172, 260-362 | Parse `RAD_TOKEN_BUDGET`; read optional per-wave `model` from the plan into `planCtx` |
| .claude/commands/shared/rad-insights.md | append | Add cost-per-feature / cost-per-wave aggregation from usage events |
| harness/test/cost.test.js | 170 | New — usage recording (with/without adapter usage), per-wave model selection, budget breaker |
| docs/rad-cli.md | append | Document `RAD_TOKEN_BUDGET` and per-wave `model:` in the plan schema |
| CLAUDE.md | 88-101 | Document `RAD_TOKEN_BUDGET` and the per-wave model tiering convention |

## Execution Notes

### Do Not Touch
- harness/gates.js, harness/transitions.js, harness/fingerprint.js, matrix.yaml / matrix.js — keep policy unchanged; the budget breaker is a spine terminal return, not a matrix outcome.

### Key Files
- harness/spine.js — the wave loop is where `wave.model` is passed, usage is recorded, and the budget breaker lives (mirror the existing `stopped: 'budget'` shape).
- harness/events.js — the `wave-attempt` event and `reduce` fold; usage is additive and must not break old-event folding.
- harness/adapters/agent/contract.js — the shared prompt builder + result shape (delivered by `model-agnostic-wave-adapters`).
- .claude/commands/shared/rad-insights.md — the consumer that surfaces aggregated cost.

### Reminders
- Sequence after `model-agnostic-wave-adapters`; `adapters/agent/*` do not exist on `main` yet (expect lint warnings for those paths until that plan lands).
- Usage is OPTIONAL everywhere — a command CLI that emits no usage must not break recording; old events without usage must fold unchanged (backward compatibility is an AC).
- The budget breaker aborts **before** starting a would-exceed wave and returns a structured result — never throws, never `process.exit`.
- Record tokens, not dollars — pricing varies by model/provider and is out of scope.

## Wave Plan

### Wave 1 — sequential
Tasks must run in sequence (1.2 records what 1.1 surfaces).

#### Task 1.1: Adapters surface token usage
File: harness/adapters/agent/sdk.js:1-200
What: Return `{..., usage: {input, output, total}}` from the SDK adapter (`result.usage`),
and have the command adapter parse usage where its CLI emits it (else omit the field).
Carry `usage` through the `contract.js` result shape.
Validate: AC#1 — sdk adapter test asserts usage is surfaced; command adapter omits it
cleanly when absent.

#### Task 1.2: Record usage in the wave-attempt event
File: harness/spine.js:54-176
What: Write `usage` into the `wave-attempt` event `data`; ensure `events.js` folds events
both with and without a usage field.
Validate: AC#1 — an event with usage and a legacy event without usage both fold without error.

### Wave 2 — sequential
Depends on: Wave 1 complete.

#### Task 2.1: Per-wave model tiering
File: harness/cli.js:260-362
What: Read an optional per-wave `model` from the plan into `planCtx`; `spine.js` passes
`wave.model` to `runWave`; the adapters apply the per-wave model when set, else the deliver
default.
Validate: AC#2 — a docs wave with `model: <cheap>` and a security wave with `model: <frontier>`
each invoke the adapter with the declared model.

### Wave 3 — sequential
Depends on: Wave 2 complete.

#### Task 3.1: Budget circuit breaker + prompt frugality
File: harness/spine.js:54-176
What: Accumulate total usage across waves; when `RAD_TOKEN_BUDGET` (parsed in `cli.js`) is
set and the next wave would exceed it, return `stopped: 'token-budget'` (graceful). Add the
truncate-large-outputs reminder to `buildWavePrompt` in `contract.js`.
Validate: AC#3, AC#5 — a deliver over budget stops gracefully before the next wave; the
prompt contains the truncate reminder.

### Wave 4 — sequential
Depends on: Wave 3 complete.

#### Task 4.1: Surface cost in rad-insights
File: .claude/commands/shared/rad-insights.md:1-40
What: Aggregate cost-per-feature and cost-per-wave from the usage events; tolerate older
events lacking usage.
Validate: AC#4 — insights reports per-feature and per-wave token totals from the log.

#### Task 4.2: Tests and docs
File: harness/test/cost.test.js:1-170
What: Cover usage recording (with/without adapter usage), per-wave model selection, and the
budget breaker. Update docs/rad-cli.md and CLAUDE.md (`RAD_TOKEN_BUDGET`, per-wave `model:`).
Validate: AC#6 — `npm test` green across the full suite; docs describe the new config.

## Tests to Write
- [ ] `wave-attempt` records usage when the adapter supplies it; legacy events without usage fold cleanly — harness/test/cost.test.js
- [ ] per-wave `model` flows to the adapter; deliver default applies when unset — harness/test/cost.test.js
- [ ] `RAD_TOKEN_BUDGET` exceeded → `stopped: 'token-budget'` before the next wave, no throw — harness/test/cost.test.js
- [ ] `buildWavePrompt` contains the truncate-outputs reminder — harness/test/cost.test.js

## Non-Goals
- A dollar/pricing model — record raw token usage only; pricing varies by provider.
- Resume and per-wave verification — those are the `resume-and-verify` plan.
- New matrix outcomes or changes to gate/transition policy — the breaker is a spine terminal return.

## Out-of-Scope Dependencies
Sequences after `model-agnostic-wave-adapters` (the adapters expose usage and accept a
per-wave model). No architect-only agents required.

## Risks
- Usage shapes differ across providers/CLIs; forcing a single schema could drop data.
  Mitigation: usage is optional and additive (AC#1) — a missing field never breaks recording
  or folding.
- A mis-placed budget check could abort mid-wave or after over-spending. Mitigation: the
  breaker checks **before** starting a wave and returns the existing structured-stop shape
  (AC#3), pinned by a test.
- Per-wave model strings are provider-specific; an invalid model surfaces as an adapter
  failure routed by the existing matrix, not a crash.
