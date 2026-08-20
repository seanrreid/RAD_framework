# Plan: Insights Read-Side Folds
Created: 2026-08-20
Author: architect
Status: pending-review
Branch: rad/insights-read-side-folds
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/63
Issue-Title: Mine traces, not counts: persist per-task WAVE_RESULT statuses, failed-wave transcripts, and contract-level usage

## Context

Four open insights issues (#63, #65, #66, #93) each add one pure fold to
`harness/events.js` and one section to `.claude/commands/shared/rad-insights.md`.
Planned separately, each would independently build the same fixture corpus and
re-prove the same invariant — that the five existing folds return identical
results on historical logs — and each would edit the same report-section list.
Batched, that substrate is built once.

`harness/events.js` already exports the read helpers `totalUsage`,
`outcomeCounts`, `failReasonCounts`, `retryCounts`, and `hookVetoCounts`; Step 4c
of `/rad-insights` imports them via `node --input-type=module -e` and honours
`RAD_STATE_DIR` so the same code is testable against a fixture directory. The
per-task `tasks[{title,status}]` pass-through this work consumes already ships
(`harness/spine.js:479`, `docs/rad-wave-contract.md:37-38`, delivered under #89).

Two things the issues did not know, both confirmed during research and both
narrowing this plan:

- **`harness/test/` contains no committed event-log fixtures.** Every existing
  `events.test.js` case builds its history as an inline array. The "regression
  fence against a committed fixture log" that #63 and #65 both assume does not
  exist yet, so this plan builds it first (Wave 1) rather than four times.
- **#63's failed-wave transcript snapshot has no data source and is excluded.**
  `toWaveResult` (`harness/adapters/agent/contract.js:369-380`) returns exactly
  `{ outcome, status, tasks?, usage? }`. The adapters hold `run.stdout`
  internally but discard it; the spine never receives agent transcript text —
  `capturePriorFailure` reads the *gate's* stdout, not the agent's. Delivering
  the snapshot would require adding a field to the wave contract, which
  contradicts this batch's read-side-only constraint. It stays in #63.

## Scope

| In scope | Out of scope |
|---|---|
| Committed fixture event logs + a regression fence over the five existing folds | The events writer and the gate fold (`harness/gates.js`) — never modified |
| `blockedReasonCounts` fold + `/rad-insights` subsection (#63) | #63's failed-wave transcript snapshot — no data source at the spine; stays in #63 |
| Per-file failure attribution fold + subsection (#93) | #63's cache-token `usage` extension — no adapter can supply it; belongs with #86 |
| Outcome-derived reliability advisories (#65, partial) | #65's spend-derived advisories — recorded spend is confounded by cache-hit rate |
| Outcome to prompt-surface mapping table + rendering (#66) | #64 (`--draft-plans`) — writes plans and cuts branches, crossing the read-only boundary |
| | #48 (findings corpus) and #60 (plan-time surface) — different corpus, different consumer |

**Why #65 is split.** `input_tokens` is the uncached remainder, not total input
(true prompt size is `input + cache_creation + cache_read`), and `normalizeUsage`
drops both cache fields. Recorded spend therefore tracks neither token volume nor
cost, and varies with cache-hit rate — so two waves running back-to-back inside
the 5-minute cache TTL look systematically cheaper than identical waves separated
by a longer gap. A "downgrade this wave to a cheaper model" advisory derived from
relative spend would be reading scheduling, not wave cost, and a sample-size floor
makes that bias *more* confident rather than less. #65's outcome-derived half
(first-attempt success rate, retry rate) has no such dependency and ships here.

## Acceptance Criteria

1. A committed fixture corpus under `harness/test/fixtures/insights/` covers legacy (no `tasks`), enriched (with `tasks`), and mixed old/new event logs, and is loadable via `RAD_STATE_DIR`.
2. All five pre-existing folds (`totalUsage`, `outcomeCounts`, `failReasonCounts`, `retryCounts`, `hookVetoCounts`) return byte-identical results on the committed fixture before and after every wave in this plan.
3. `blockedReasonCounts` buckets per-task `blocked_code` / `blocked_spec` / `blocked_intent` statuses and is surfaced in `/rad-insights`, degrading explicitly (not silently) on logs with no enriched events.
4. A per-file failure attribution fold keys failures by the plan's task `File:` path and surfaces files accumulating failures across multiple features, above a named sample floor.
5. `/rad-insights` reports first-attempt success rate and retry rate per wave position with explicit sample sizes, and renders no advisory below the sample floor.
6. `/rad-insights` renders prompt-surface proposals from a single mapping table when outcome recurrence crosses a named threshold, citing counts and affected features, and naming a concrete target file per proposal.
7. No file is edited by any insights output — every new section is suggestion-only prose.
8. `harness/gates.js` and the `harness/events.js` writer are unmodified by this plan.

## Agent Scope

No agents were called. Research was performed directly by the architect (6 tool
calls, under the 10-call cap). The mapper layer exists to keep file contents out
of the main context; this plan's research needed six greps over four files, which
is below the threshold where delegation pays for itself. Recorded here for
transparency rather than omitted — see #46 on separating the mapper layer's
authority rationale from its cost rationale.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/test/fixtures/insights/legacy/events.jsonl | new | Fixture: wave events with no `tasks` key (pre-#89 shape) |
| harness/test/fixtures/insights/enriched/events.jsonl | new | Fixture: wave events carrying `tasks[{title,status}]` |
| harness/test/fixtures/insights/mixed/events.jsonl | new | Fixture: both shapes interleaved in one feature log |
| harness/test/events.test.js | append | Regression fence over the five existing folds + tests for three new folds |
| harness/events.js | 250-400 | Three new pure folds appended to the insights read block |
| .claude/commands/shared/rad-insights.md | 169-350 | New fold-invocation steps and report subsections |
| docs/harness-and-framework.md | append | Document the outcome to prompt-surface mapping and its rationale |

## Execution Notes

### Do Not Touch
- `harness/gates.js` — the gate fold. Read-only reference; modifying it is a scope failure, not a judgement call.
- The writer half of `harness/events.js` (`append`, the StateStore class, event typedef construction). Only the insights read block below it is in scope.
- `harness/adapters/agent/contract.js` — `toWaveResult` and `normalizeUsage` are out of scope; the cache-field and transcript work belongs to #63/#86.
- `harness/spine.js` — no snapshot work in this plan.

### Key Files
- `harness/events.js` — the five existing folds (lines 255-398) are the pattern every new fold must match: pure, zero-shape on empty/non-array input, no throw.
- `harness/test/events.test.js:186` — the existing "insights helpers return zeroed shapes on empty, non-array, and wave-event-free histories" test states the contract every new fold must also satisfy.
- `.claude/commands/shared/rad-insights.md:169-266` — Step 4c shows the exact `node --input-type=module -e` invocation and `RAD_STATE_DIR` convention new steps must follow.
- `.claude/commands/shared/rad-insights.md:318-342` — the Reliability section's `noWaveData` zeros path is the required degradation convention for every new section.
- `docs/rad-wave-contract.md:37-38` — the shipped `tasks` / `usage` contract these folds read.

### Reminders
- Every wave runs `npm test --prefix harness` via its `Verify:` line — the fence is executed, not assumed.
- New folds append to the insights block; do not reorder or reformat existing folds, or the regression fence stops proving anything.
- `harness/` is a self-protected path: this plan cannot auto-clear under any `RAD_LOW_RISK_PATTERNS` and requires architect approval.
- Sections must omit entirely (or render the explicit zeros path) when data is absent — silence is a defect, per the existing Reliability convention.

## Program Design

### New signatures (all pure, all appended to the `harness/events.js` insights read block)

```js
/** @returns {{ blocked_code: number, blocked_spec: number, blocked_intent: number,
 *              enrichedAttempts: number }} */
export function blockedReasonCounts(history)

/** @param {Object<string,string[]>} taskFiles - task title -> declared File: paths,
 *                                               supplied by the CALLER (fold stays filesystem-free)
 *  @returns {{ files: Object<string,{ failures: number, features: string[] }>,
 *              belowFloor: number, minFeatures: number }} */
export function fileFailureCounts(history, taskFiles)

/** @returns {{ perPosition: Object<string,{ attempts: number, firstAttemptSuccess: number,
 *                                           retried: number, samples: number }>,
 *              features: number }} */
export function waveReliability(history)
```

Every one mirrors the existing helpers' contract: returns its zeroed shape on
`[]`, `null`, non-array, and wave-event-free input; never throws; reads only
`wave-attempt` / `wave-complete` / `wave-failed` events.

### Call-stack sketch

```
/rad-insights  (skill prose, no logic of its own)
  └─ Step 4c/4d/4e/4f: node --input-type=module -e
       └─ await import("./harness/events.js")
            ├─ blockedReasonCounts(history)          -> Blocked-reason subsection
            ├─ fileFailureCounts(history, taskFiles) -> Code-legibility subsection
            ├─ waveReliability(history)              -> Model-tiering subsection
            └─ outcomeCounts / failReasonCounts      -> Prompt-surface mapping table
                 (existing folds — read, never modified)

harness/test/events.test.js
  └─ RAD_STATE_DIR -> harness/test/fixtures/insights/{legacy,enriched,mixed}
       └─ regression fence: five existing folds vs committed literals
```

Thresholds and floors live in the SKILL prose (rendering decisions), never in the
folds — the folds count, the report decides what is worth saying.

### File-tree diff

```
 harness/
   events.js                        ~+120  three folds appended to the read block
   test/
     events.test.js                 ~+180  fence + per-fold cases
+    fixtures/
+      insights/
+        legacy/events.jsonl        new    pre-#89 shape, no `tasks`
+        enriched/events.jsonl      new    `tasks[{title,status}]` populated
+        mixed/events.jsonl         new    both shapes interleaved
 .claude/commands/shared/
   rad-insights.md                  ~+140  four steps + four report subsections
 docs/
   harness-and-framework.md         ~+25   prompt-surface mapping rationale
```

No file is renamed, moved, or deleted.

## Wave Plan

### Wave 1 — sequential
Verify: npm test --prefix harness

Build the shared substrate before any new fold exists.

#### Task 1.1: Commit the fixture corpus
File: harness/test/fixtures/insights/legacy/events.jsonl, harness/test/fixtures/insights/enriched/events.jsonl, harness/test/fixtures/insights/mixed/events.jsonl
What: Three hand-authored `events.jsonl` fixtures. `legacy/` carries `wave-attempt` / `wave-complete` / `wave-failed` events with no `tasks` key (the pre-#89 shape). `enriched/` carries the same events with `tasks[{title,status}]` populated across all three blocked statuses plus passing ones. `mixed/` interleaves both shapes within one feature. Each is valid JSONL, one event per line, using only the frozen 7-outcome vocabulary.
Validate: AC#1 — each file parses as JSONL and loads through the Step 4c `RAD_STATE_DIR` path without error.

#### Task 1.2: Regression fence over the five existing folds
File: harness/test/events.test.js
What: A test that runs `totalUsage`, `outcomeCounts`, `failReasonCounts`, `retryCounts`, and `hookVetoCounts` over all three fixtures and asserts their exact returned shapes as committed literals. This is the fence every later wave must leave green.
Validate: AC#2 — `npm test --prefix harness` passes; the assertions are literal expected values, not recomputed from the same fold under test.

### Wave 2 — sequential
Verify: npm test --prefix harness

#### Task 2.1: `blockedReasonCounts` fold
File: harness/events.js:250-400
What: A pure fold bucketing per-task `blocked_code` / `blocked_spec` / `blocked_intent` from `wave-attempt` `data.tasks`. Returns a zeroed shape on empty, non-array, and `tasks`-free histories, matching the existing helpers' contract. Reports how many attempts carried task data so callers can distinguish "no blocked tasks" from "no enriched events".
Validate: AC#3 — tested against all three fixtures: `legacy/` yields the zeroed shape with an enriched-attempt count of 0; `enriched/` yields the true distribution; `mixed/` counts only enriched attempts.

#### Task 2.2: Blocked-reason subsection in `/rad-insights`
File: .claude/commands/shared/rad-insights.md:169-350
What: A Step 4d invoking `blockedReasonCounts` through the same `node --input-type=module -e` / `RAD_STATE_DIR` pattern as Step 4c, and a report subsection rendering the distribution. When no enriched events exist, render an explicit line saying so — never omit silently and never render zeros as if measured.
Validate: AC#3, AC#7 — the section names its degradation case explicitly and edits nothing.

### Wave 3 — sequential
Verify: npm test --prefix harness

#### Task 3.1: Per-file failure attribution fold
File: harness/events.js:250-400
What: A pure fold keying failures by file. Intersects each failing task's status with the task's `File:` path as recorded in the plan, aggregating across features. Takes the plan-path association as an argument rather than reading plan files itself — the fold stays pure and filesystem-free. Applies a named minimum-features constant below which a file is not reported.
Validate: AC#4 — tested against the fixtures with a synthetic path mapping; a file appearing in only one feature falls below the floor and is not reported.

#### Task 3.2: Code-legibility subsection in `/rad-insights`
File: .claude/commands/shared/rad-insights.md:169-350
What: A step supplying the plan-path association to the fold and a report subsection listing files accumulating failures across features, framed per #93 as a legibility signal about that region rather than a verdict on the agent. Suggestion-only prose; names files, proposes nothing automatic.
Validate: AC#4, AC#7 — below-floor state renders an explicit "insufficient history" line; no file is edited.

### Wave 4 — sequential
Verify: npm test --prefix harness

#### Task 4.1: Outcome-derived reliability fold
File: harness/events.js:250-400
What: A pure fold computing first-attempt success rate and retry rate per wave position, with the sample count carried alongside every figure. Deterministic counting only — no thresholds encoded in the fold itself. Does not read `usage`; spend is deliberately absent from this fold.
Validate: AC#5 — sample counts accompany every rate; a single-feature history reports its true n rather than being suppressed inside the fold.

#### Task 4.2: Model-tiering advisory subsection
File: .claude/commands/shared/rad-insights.md:169-350
What: A report subsection rendering per-wave-position success and retry rates with explicit sample sizes and a "based on N features" caveat line, applying a named minimum-features floor below which no advisory renders. State in the section that spend-based tiering advice is deliberately absent and why, so its absence reads as a decision rather than an oversight.
Validate: AC#5, AC#7 — zero-advisory state renders a clear "insufficient history" line, not silence; no spend figure appears.

### Wave 5 — sequential
Verify: npm test --prefix harness

#### Task 5.1: Outcome to prompt-surface mapping table
File: .claude/commands/shared/rad-insights.md:169-350
What: A single mapping table — data, not scattered logic — routing `fail-protocol` recurrence to the WAVE_RESULT format instructions, `fail-scope` to the plan template's scope guidance, and `blocked_spec` / `blocked_intent` (from Wave 2's fold) to `/rad-plan`'s task-authoring guidance. Plus a rendering step emitting one proposal per threshold-crossing signal, each naming a concrete target file, the observed counts, and the affected features. A signal with no mapping renders an explicit "unmapped signal" line.
Validate: AC#6, AC#7 — below-threshold signals render nothing; an unmapped signal renders its explicit line rather than crashing or going silent; no file is edited.

#### Task 5.2: Document the mapping rationale
File: docs/harness-and-framework.md
What: Record why prompt surfaces are a feedback-loop target, and note that the wave-prompt template carries a prefix-ordering constraint (#112) that any `fail-protocol` proposal must preserve — so a future clarity edit does not silently undo it.
Validate: AC#6 — the constraint and its issue reference are stated in prose.

## Tests to Write
- [ ] Five existing folds return committed literal shapes on all three fixtures — harness/test/events.test.js
- [ ] `blockedReasonCounts` zeroed shape on empty / non-array / `tasks`-free histories — harness/test/events.test.js
- [ ] `blockedReasonCounts` distribution on enriched fixture; counts only enriched attempts on mixed — harness/test/events.test.js
- [ ] Per-file attribution respects the minimum-features floor; single-feature file not reported — harness/test/events.test.js
- [ ] Per-file attribution is pure — no filesystem access; path association is an argument — harness/test/events.test.js
- [ ] Outcome-derived fold carries sample counts on every rate — harness/test/events.test.js
- [ ] Outcome-derived fold reads no `usage` field — harness/test/events.test.js
- [ ] Regression fence still green after every wave — harness/test/events.test.js

## Non-Goals
- Modifying the events writer, the gate fold, or the wave contract in any way.
- Any spend-derived or cost-derived advisory — deferred until the `usage` shape carries cache-token fields (#63).
- Any automatic edit to CLAUDE.md, lint scripts, command prompts, or plan files — every output of this plan is suggestion-only prose.
- The failed-wave transcript snapshot (#63) — it needs a wave-contract field this plan is forbidden to add.
- `/rad-insights --draft-plans` (#64), findings-corpus calibration (#48), and the plan-time readout (#60).

## Out-of-Scope Dependencies
None. Every file is architect-writable and no agent outside the architect role is required.

## Risks
- **The regression fence is only as good as its fixtures.** Hand-authored fixtures could omit an event shape that exists in real logs, letting a fold change slip through. Mitigated by deriving fixture shapes from the committed contract (`docs/rad-wave-contract.md:37-38`) rather than from imagination, and by including a mixed-shape case.
- **`harness/events.js` grows to eight folds in one module.** Acceptable at this size; if the read block outgrows the file, extracting a read module is the documented escape hatch (#65 already names it) and should be a separate plan, not an in-flight refactor here.
- **Five waves all touch `.claude/commands/shared/rad-insights.md`.** Sequential wave ordering avoids concurrent edits, but each wave must append its section rather than restructure the report, or a later wave will conflict with an earlier one's output.
- **#93's framing is load-bearing.** Presenting per-file failure counts as an agent-performance metric rather than a code-legibility signal would invert the issue's intent. The wording is a correctness concern, not a style one.

## Issue Gaps

Assumptions this plan made where the source issues were silent — each one the architect should verify:

- **The transcript snapshot is dropped from the batch.** #63 lists it as spine work, but the spine has no access to agent transcript text (`toWaveResult` returns four fields; adapters discard `run.stdout`). This plan assumes delivering it requires a contract change and therefore belongs in #63, not here. *Verify: is a contract field acceptable later, or should adapters write snapshots themselves?*
- **#65 is split rather than deferred whole.** This plan assumes the outcome-derived half is worth shipping without the spend half. *Verify: or would a partial model-tiering section be worse than none until spend is trustworthy?*
- **The per-file attribution fold takes its plan-path association as an argument.** #93 does not say where the plan-to-path mapping comes from. This plan keeps the fold pure and pushes the lookup to the caller. *Verify: acceptable, or should a separate helper own the association?*
- **Sample-size floors are named constants, not env vars.** #65 says "a named constant (e.g. ≥3 features)"; #66 floats `RAD_OUTCOME_THRESHOLD`. This plan uses constants throughout for consistency. *Verify: should any floor be operator-tunable?*
- **#66's mapping rationale lands in `docs/harness-and-framework.md`.** The issue says only "`docs/`". *Verify: correct home?*
- **Wave count.** Five waves for four issues gives per-issue checkpointing at the cost of five gate cycles. *Verify: or collapse Waves 2-4 into one three-task wave?*
