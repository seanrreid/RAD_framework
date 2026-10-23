# Plan: Provider-Tagged Wave Metrics
Created: 2026-10-23
Author: developer
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-23T14:54:11.518Z
Recorded-By: sean@torchcodelab.com
Branch: rad/provider-tagged-wave-metrics
Source-Author: none (no source issue)
Source-Comments: none

## Context
RAD runs waves through a configured agent adapter (`command`, `acp` or `sdk`), but no event records which adapter or model ran a wave, so `/rad-insights` cannot compare providers. `modelTierSpend` groups by the model *declared* on `wave-started`, which misses the construction-time default and carries no adapter. This plan tags every `wave-attempt` with the adapter and the model actually applied, and adds a provider breakdown to `/rad-insights`. It is steps 1–2 of the subagent topology update (Anthropic's fold-subagents article: the right subagent topology is model-dependent, so it must be measured per provider).

## Scope
| In scope | Out of scope |
|---|---|
| Optional data-only `agent: { adapter, model? }` key on `wave-attempt` data | Any gate, fold or transition reading the key |
| cli threads adapter kind + model-applies + default model into the spine | Changing adapter internals (`command.js`, `acp.js`, `sdk.js`) |
| New pure fold `providerSpend` beside `modelTierSpend` in `harness/events.js` | Changing `modelTierSpend`'s shape or the "Spend by model" section |
| New `/rad-insights` step + "Spend by provider" report subsection | The live-lane topology eval (step 3, a separate plan) |

## Acceptance Criteria
1. A `rad deliver` run appends `wave-attempt` events whose `data.agent.adapter` is the selected adapter kind (`command` | `acp` | `sdk`).
2. `data.agent.model` is the model actually applied to that wave: the wave's override when declared (`--wave-model` / plan `Model:`), else the run default. It is omitted (never null or empty) when no model applies: a `command` cmd with no `{model}` token, the `acp` adapter, or no model set.
3. When the spine is run without agent identity (injected `runWave`, tests), the appended `wave-attempt` event is byte-identical to today's — no `agent` key.
4. Every existing fold (`waveReliability`, `totalUsage`, `cacheUsage`, `modelTierSpend`, `retryCounts`, `reduce`/phase) returns identical results on a history with and without `agent` keys.
5. `providerSpend(history)` groups wave attempts by `adapter/model` and reports per group: `attempts`, `passed` (outcome `success`), `retries` (attempt > 1), `tokens`, `unknownUsage`, `features`. Attempts with no `agent` key fall in the `unknown` group; a tagged attempt with no model falls in `<adapter>/none`. It returns a zero shape on `[]`, `null` or a non-array, skips malformed events, and never throws.
6. `/rad-insights` renders a "Spend by provider" subsection from `providerSpend` (imported, never reimplemented), noting the `unknown` legacy bucket; a fold error omits the subsection without stopping the report.

## Agent Scope
Research ran inline via one research sub-agent (no RAD agents called). Relevant scope-map rows: `event-metrics-mapper` / `event-metrics-orchestrator` (events.js read side, spine record sites) and `findings-surface-mapper` (rad-insights skill). This plan also writes the spine's record site and the cli, which is beyond `event-metrics-orchestrator`'s read-only constraint — see Out-of-Scope Dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/cli.js | 2046-2065 | `resolveDeliverSettings`: derive `agent: { adapter, modelApplies }` from `selection` (`command` → `cmd` contains `{model}`; `sdk` → true; `acp` → false) |
| harness/cli.js | 2175-2215 | pass `agent` (+ default `model`) through the spine args / `buildSpineArgs` |
| harness/spine.js | 586-660 | resolve the per-wave applied model (`declaredModel(waveModels[n]) ?? declaredModel(wave.model) ?? default`) and spread `agent` into `attemptData` only when agent identity was given |
| harness/spine.js | 960-1000 | wave-attempt append site carries the new evidence |
| harness/spine.js | 1437-1486 | `runDeliver` accepts the optional `agent` arg into the `loop` object |
| harness/events.js | 117-140 | document `agent` on `WaveAttemptEvidence` (data-only, no fold reads it, omitted when absent) |
| harness/events.js | 915-1160 | add `PROVIDER_UNKNOWN`/`MODEL_NONE` sentinels and `export function providerSpend` beside `modelTierSpend`, reusing `waveTokens`-style helpers |
| harness/test/agent-tag.test.js | 1-160 | new: cli derivation + spine tagging tests (AC1–3) |
| harness/test/events.test.js | 1142-1270 | new `providerSpend` tests after the `modelTierSpend` block (AC4–5) |
| harness/test/fixtures/insights/provider/events.jsonl | 1-40 | new fixture: tagged command/sdk/acp attempts, a retry, a model-less tag, legacy untagged attempts |
| .rad/skills/rad-insights/SKILL.md | 628-702 | new Step 4f4 "Fold spend by provider", following Step 4f3 |
| .rad/skills/rad-insights/SKILL.md | 1131-1200 | "Spend by provider" report subsection + rules line |
| .claude/commands/shared/rad-insights.md | 620-710, 1125-1210 | regenerated by `rad generate` (never hand-edited) |
| .agents/skills/rad-insights/SKILL.md | 620-710, 1125-1210 | regenerated by `rad generate` (never hand-edited) |

## Program Design

Signatures:
```js
// harness/cli.js (internal)
function agentIdentity(selection) // → { adapter: 'command'|'acp'|'sdk', modelApplies: boolean }
// harness/spine.js
runDeliver({ ..., agent /* optional { adapter, modelApplies, model? } */ })
function appliedModel(agent, waveModels, wave) // → string | undefined
// harness/events.js
export function providerSpend(history) // → { groups: { [key]: { adapter, model, attempts, passed, retries, tokens, unknownUsage, features } }, features }
```

Control flow:
```
cli deliver → selectAgent → resolveDeliverSettings ─ agentIdentity(selection), parsed.model
           → buildSpineArgs({..., agent}) → runDeliver → wave loop
                → runWave(...) → attemptData(..., agent ? { agent: { adapter, ...(m ? { model: m } : {}) } } : {})
                → append wave-attempt
/rad-insights Step 4f4 → node -e import { providerSpend } → JSON → "Spend by provider"
```

File-tree diff:
```
+ harness/test/agent-tag.test.js
+ harness/test/fixtures/insights/provider/events.jsonl
```

## Execution Notes

### Do Not Touch
- harness/gates.js — gate fold; the tag is data-only
- harness/gates.yaml — no new event type or vocabulary
- harness/transitions.js — phases unaffected
- harness/adapters/agent/command.js, acp.js, sdk.js — model precedence is mirrored, not changed
- Existing folds in harness/events.js (`waveReliability`, `totalUsage`, `cacheUsage`, `modelTierSpend`, `retryCounts`, `reduce`) — legacy behaviour must not change
- harness/delivery-metrics.js, delivery-history.js, cycle-metrics.js — #285's read path, unrelated

### Key Files
- harness/spine.js — `attemptData` conditional-spread pattern and `declaredModel`
- harness/events.js — `modelTierSpend` and its helpers are the template for `providerSpend`
- harness/agent-select.js — `selectAgent` returns `{ kind, cmd, source }`; env overrides config
- harness/adapters/agent/command.js — `{model}` substitution rule (lines 143-165, 525-552)
- .rad/skills/rad-insights/SKILL.md — Step 4f3 is the step template

### Reminders
- Never write `agent.model` as null, undefined or empty string; omit the key.
- The `agent` spine arg is optional; injected `runWave` tests must keep producing byte-identical events.
- Edit only the SKILL.md source, then run `node harness/cli.js generate`; never hand-edit generated copies.
- Run `rad deliver` with `RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- The headless claude preset cannot write `.claude/`. If `rad generate` in Task 3.1 is refused, the run stops as a permission refusal; the architect runs `node harness/cli.js generate` by hand and reruns.

## Wave Plan

### Wave 1 — sequential
Record the provider on every wave attempt (writer side, end to end).

#### Task 1.1: Derive agent identity in the cli and thread it to the spine
File: harness/cli.js:2046-2065, 2175-2215
What: Add `agentIdentity(selection)` returning `{ adapter: selection.kind, modelApplies }` where `modelApplies` is `cmd.includes('{model}')` for `command`, `true` for `sdk`, `false` for `acp`. Pass `agent: { ...identity, model }` (model = the resolved run default, already undefined for acp without `--model`) through `buildSpineArgs` into `runDeliver`.
Validate: AC#1, AC#2 — agent-tag.test.js asserts the identity for each adapter kind, a command cmd with and without `{model}`, and the RAD_AGENT/RAD_AGENT_CMD env override path.

#### Task 1.2: Tag wave-attempt evidence in the spine
File: harness/spine.js:586-660, 960-1000, 1437-1486
What: Accept optional `agent` in `runDeliver` and the loop. Add `appliedModel(agent, waveModels, wave)` using the same precedence as `appendWaveStarted`, returning undefined when `!agent.modelApplies`. In `attemptData`, spread `{ agent: { adapter, ...(model ? { model } : {}) } }` only when `agent` was given.
Validate: AC#2, AC#3 — agent-tag.test.js: per-wave override recorded over the default; no `{model}` → no `model` key; acp → no `model` key; no agent arg → event deep-equals and serializes byte-identical to the untagged baseline.

### Wave 2 — sequential
Depends on: Wave 1 complete

#### Task 2.1: Document the key and add the providerSpend fold
File: harness/events.js:117-140, 915-1160
What: Add `agent` to the `WaveAttemptEvidence` typedef ("Data-only ... no fold reads it. Omitted when the spine had no agent identity"). Add sentinels `PROVIDER_UNKNOWN = 'unknown'` and `MODEL_NONE = 'none'` and `export function providerSpend(history)` grouping each `wave-attempt` by `adapter/model` (untagged → `unknown`, tagged without model → `<adapter>/none`), with `attempts`, `passed` (`outcome === 'success'`), `retries` (`attempt > 1`), `tokens`, `unknownUsage` and distinct `features`. Zero shape on `[]`/null/non-array; malformed events skipped. Attribution is per attempt, so a resumed run that switches provider is split correctly.
Validate: AC#4, AC#5 — events.test.js: hand-computed groups over the new `provider` fixture; zero shape on empty/null/non-array; malformed skipped; existing folds return identical results on the fixture with `agent` keys stripped vs present.

#### Task 2.2: Add the provider fixture
File: harness/test/fixtures/insights/provider/events.jsonl:1-40
What: A RAD_STATE_DIR-shaped fixture: command attempts with a model, sdk attempts with a model and one retry, an acp attempt with no model, legacy untagged attempts, one attempt missing usage, and one malformed line.
Validate: AC#5 — consumed by Task 2.1's tests; every group in the expected output is exercised.

### Wave 3 — sequential
Depends on: Wave 2 complete

#### Task 3.1: Add "Spend by provider" to /rad-insights
File: .rad/skills/rad-insights/SKILL.md:628-702, 1131-1200
What: Add Step 4f4 after Step 4f3: import `providerSpend` from harness/events.js via `node --input-type=module -e` over all `.agents/state/*/events.jsonl`, print JSON; on error omit the subsection and continue. Add a "Spend by provider" report subsection (table: adapter, model, attempts, pass rate, retries, tokens) with a note that `unknown` = attempts recorded before this change. Add a rule line that the subsection MUST come from `providerSpend`. Then run `node harness/cli.js generate` to refresh the generated copies.
Validate: AC#6 — skill-bodies.test.js passes; `node harness/cli.js generate --check` (or the generate-drift check in verify-all) reports no drift; the step's command run against the `provider` fixture prints the expected JSON.

Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] agentIdentity per adapter kind, `{model}` present/absent, env override — harness/test/agent-tag.test.js
- [ ] spine tags wave-attempt with adapter + applied model; override beats default; no model key when not applied — harness/test/agent-tag.test.js
- [ ] no agent arg → byte-identical wave-attempt event — harness/test/agent-tag.test.js
- [ ] providerSpend groups, unknown and `<adapter>/none` buckets, zero shapes, malformed skipped — harness/test/events.test.js
- [ ] existing folds unchanged with agent keys present — harness/test/events.test.js

## Non-Goals
- No gate, fold or transition reads `agent`; it never affects approval or delivery outcomes.
- `modelTierSpend` and "Spend by model" are not changed or superseded; consolidating them is a later decision once provider data exists.
- No backfill of historical events; legacy attempts stay in `unknown`.
- No provider-specific agent generation (step 7) and no topology eval (step 3).

## Out-of-Scope Dependencies
The plan touches self-protected paths (`harness/`, `.rad/`, `.claude/`) and the spine's wave-attempt record site, which the `event-metrics-orchestrator` scope ("read-side only — must not modify writer/fold code") excludes. Architect review is required.

## Risks
- `cmd.includes('{model}')` mirrors command.js's substitution rule; if that rule changes, the tag could misreport. Mitigation: a test pins both behaviours together.
- Attempts are attributed per attempt, so `passed` counts attempts, not waves; the report wording must say "attempts" to avoid being read as wave pass rate.
- Byte-identity for untagged runs depends on the conditional spread; a regression would change every event's bytes. Covered by AC#3's serialization test.
