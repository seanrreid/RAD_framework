# Plan: Insights Data Accuracy
Created: 2026-09-25
Author: architect
Status: complete
Completed-At: 2026-09-25T18:16:05Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-09-25T18:01:59.077Z
Recorded-By: sean@torchcodelab.com
Branch: rad/insights-data-accuracy
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/122
Issue-Title: outcomeCounts folds wave-complete.data.outcome, which the spine never writes: /rad-insights Reliability reports every outcome as unknown

## Context

Three reporting-accuracy fixes. This plan closes #122, #121 and #132.

- **#122.** `outcomeCounts` (`harness/events.js`) folds `wave-complete.data.outcome`. The spine writes `wave-complete` as `{ wave }` only (`spine.js:535`) and records outcomes on `wave-attempt`, so every real log lands in `unknown`, and the `/rad-insights` Reliability line reports zeros that look measured. Tests didn't catch it because the inline histories and the committed fixtures model a `wave-complete` event that carries an outcome, which the spine never emits.
- **#121.** `normalizeUsage` (`contract.js`) keeps `input` / `output` / `total` and drops the cache counts that both adapters already see: the SDK `message.usage` snake_case fields, and anything a `RAD_USAGE {json}` wrapper line reports. So nothing can show whether a retry prefix held (#112). The `RAD_USAGE` format is documented only in a `command.js` JSDoc.
- **#132.** `rad-status.sh` lists every plan twice. In `collect_plans`, passes 1 and 2 pipe into `emit_plan_row`, so the `SEEN_FEATURES` update is lost in a subshell. The research collector added in #131 already uses the fix (feed it through a redirect).

The spend-derived model-tier advisories moved onto #121 from #65 are **out of scope**. They consume this data and are better planned separately.

## Scope

| In scope | Out of scope |
|---|---|
| `outcomeCounts` counts each (feature, wave)'s **terminal** `wave-attempt` outcome; locked test values updated deliberately | Making the spine write an outcome on `wave-complete` (a writer change) |
| `normalizeUsage` passes through optional `cacheRead` / `cacheWrite` / `cost` only when present and valid | Changing `totalUsage`'s return shape or the budget breaker |
| A new pure `cacheUsage` fold: per-attempt cache-hit ratio plus totals | Spend-derived model-tier advisories (#65's half), and pricing tables |
| `/rad-insights`: corrected Reliability wording and a cache-hit readout | Editing the committed fixture files; #93's deficit naming (deferred to #93's own plan) |
| Document `usage` cache fields and the `RAD_USAGE` line in `rad-wave-contract.md` | The `rad-insights` Step 4b jq cost path |
| `rad-status.sh` lists each plan once | Other `rad-status.sh` output changes |

## Acceptance Criteria

1. `outcomeCounts(history)` groups `wave-attempt` events by (feature, wave) and counts each pair's **last** attempt outcome over the frozen vocabulary plus `unknown`, with `total` equal to the number of pairs. It ignores `wave-complete` entirely, keeps its zeroed shape on `[]` / null / non-array / attempt-free input, and never throws. The private pair collector gains a `lastOutcome` field additively, and `waveReliability` / `attemptOutcomeCounts` results are unchanged.
2. The `outcomeCounts` literals in `harness/test/events.test.js` (fixture regression fence, the parity baseline, and the old wave-complete-premise test) are updated to hand-computed terminal-attempt values, each with a comment giving the arithmetic. No other fold's locked value changes.
3. `normalizeUsage` passes through `cacheRead` (from `cacheRead` or `cache_read_input_tokens`), `cacheWrite` (from `cacheWrite` or `cache_creation_input_tokens`) and `cost`, **only** when each is a finite, non-negative number. Otherwise the key is absent (never coerced). Input with none of them returns an object deep-equal to today's `{ input, output, total }`. The SDK and `RAD_USAGE` paths carry the fields with no other adapter changes.
4. A new pure `cacheUsage(history)` fold returns per-attempt `{ feature, wave, attempt, cacheRead, input, ratio }` for attempts that report `cacheRead` (`ratio = cacheRead / (input + cacheRead)`, or `null` when the denominator is 0), plus totals and a count of attempts without cache data. It returns a zeroed shape on empty or invalid input and never throws. `totalUsage`'s result shape is unchanged.
5. `/rad-insights` makes three changes:
   - the Reliability wording and template describe terminal-attempt outcomes per (feature, wave), not wave-complete events;
   - a cache-hit readout shows the per-attempt ratio and flags any retry whose ratio dropped to 0 after a non-zero earlier attempt, rendering an explicit "no cache data reported" line when none exists;
   - the Model-tiering deferral note is updated so it no longer says it is blocked on #121 (spend advisories are still deferred, tracked in #65).
6. `docs/rad-wave-contract.md` documents the optional `cacheRead` / `cacheWrite` / `cost` usage fields and the `RAD_USAGE {json}` stdout line (accepted keys, and that invalid values are dropped). `docs/harness-and-framework.md` no longer describes `outcomeCounts` as counting wave-complete events.
7. `scripts/rad-status.sh` lists a plan present on several sources exactly once, credited to the highest-priority source (branch tip, then base, then local). `scripts/test-rad-status.sh` asserts a plan on base plus local renders once as `<base> (merged)`, under `bash` and `/bin/bash`. `npm test --prefix harness` and every `scripts/test-*.sh` pass.

## Agent Scope

No agents were called. Research was one Explore sub-agent (10 of 10 searches)
covering the `events.js` folds and consumers, the `normalizeUsage` callers and the
`RAD_USAGE` parse site, the `totalUsage` / `outcomeCounts` test literals,
`rad-insights.md` sections, `rad-status.sh`, and `docs/rad-wave-contract.md`.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/events.js | 286-614 | `outcomeCounts` on terminal attempts; `lastOutcome` on the pair collector; new `cacheUsage` fold |
| harness/test/events.test.js | 125-410 | Update `outcomeCounts` literals; `cacheUsage` tests |
| harness/adapters/agent/contract.js | 415-450 | `normalizeUsage` optional cache and cost passthrough |
| harness/adapters/agent/command.js | 300-320 | `RAD_USAGE` JSDoc lists the new optional keys |
| harness/test/agent-contract.test.js | 240-260 | `normalizeUsage` unit tests |
| .claude/commands/shared/rad-insights.md | 169-760 | Reliability wording; cache readout; deferral note |
| docs/rad-wave-contract.md | 60-90 | Usage cache fields and the `RAD_USAGE` line |
| docs/harness-and-framework.md | 225-232 | `outcomeCounts` wording |
| scripts/rad-status.sh | 64-96 | `collect_plans` feeds `emit_plan_row` by redirect |
| scripts/test-rad-status.sh | 86-160 | Plan-appears-once case |

## Execution Notes

### Do Not Touch
- `harness/spine.js`: the fix is the fold, not the recorder.
- `harness/test/fixtures/insights/*/events.jsonl`: other folds' locked values are hand-computed from them. Their wave-complete outcomes become harmless once `outcomeCounts` ignores wave-complete.
- The public result shapes of `waveReliability`, `attemptOutcomeCounts` and `totalUsage`.
- `harness/test/cost.test.js`: its `totalUsage` and normalized-usage literals must stay green unchanged. That's the proof the cache keys are optional.
- `harness/adapters/agent/sdk.js`: it already passes `message.usage` through, so no change is needed.
- `harness/gates.js`, `harness/transitions.js`, the events writer.

### Key Files
- `harness/events.js`: `totalUsage`, `outcomeCounts` (and its JSDoc noting the spine never writes an outcome), the private `collectWavePairs`, `waveReliability`, `attemptOutcomeCounts`, and the `OUTCOME_VOCAB` import.
- `harness/test/events.test.js`: the `outcomeCounts` inline test (~L127-148), the zeroed-shape contract (~L186), the parity baseline (~L241-292), the fixture fence (~L355-412), and the per-fixture attempt sequences in the comment near ~L653.
- `harness/adapters/agent/contract.js`: `normalizeUsage`. `command.js`: the `RAD_USAGE` regex and JSDoc (~L305-318).
- `.claude/commands/shared/rad-insights.md`: Step 4c (fold script plus "Reading the output"), Step 4f, the Reliability template (~L662-685), Model Tiering and its verbatim deferral note (~L731-757), and Rules.
- `scripts/rad-status.sh`: `emit_research_row`'s redirect pattern, to mirror in `collect_plans`.

### Reminders
- Folds stay pure, never throw, return zeroed shapes, and import `OUTCOME_VOCAB` rather than duplicating it.
- New usage keys are **absent**, never `undefined` or `0`, when unreported. Legacy logs keep byte-identical `usage`.
- Every changed locked value gets a comment with its hand-computed arithmetic. Never recompute expected values with the fold under test.
- `rad-insights` imports folds via its `node -e` script. The Rules section forbids reimplementing folds in jq.
- `rad-status.sh` stays bash-3.2-safe. Capture output before grepping (SIGPIPE under pipefail).
- `harness/`, `scripts/` and `.claude/` are self-protected.

## Wave Plan

### Wave 1 — parallel
Verify: npm test --prefix harness && bash scripts/test-rad-status.sh

Three independent fixes in disjoint files.

#### Task 1.1: outcomeCounts counts terminal attempts
File: harness/events.js:286-614, harness/test/events.test.js:125-410
What: Add `lastOutcome` (overwritten on each attempt) to the private pair collector, leaving `waveReliability` untouched. Rewrite `outcomeCounts` to count each (feature, wave) pair's `lastOutcome` over `OUTCOME_VOCAB` plus `unknown`, with `total` equal to the number of pairs, ignoring `wave-complete`, and update its JSDoc. Update the locked values: the fixture fence (legacy, enriched, mixed), the parity baseline `EXPECTED.outcomeCounts` with its rationale comment, and the inline test (~L127-148), whose premise flips (wave-complete is now ignored and wave-attempt counted). Hand-compute each value from the fixture lines and comment the arithmetic. Confirm the zeroed-shape test and every other fold's values pass unchanged.
Validate: AC#1, AC#2 — `npm test --prefix harness` passes; the diff to `events.test.js` touches only `outcomeCounts` expectations and their comments.

#### Task 1.2: normalizeUsage carries cache and cost
File: harness/adapters/agent/contract.js:415-450, harness/adapters/agent/command.js:300-320, harness/test/agent-contract.test.js
What: `normalizeUsage` adds `cacheRead` (from `cacheRead` or `cache_read_input_tokens`), `cacheWrite` (from `cacheWrite` or `cache_creation_input_tokens`) and `cost`, each only when it is a finite, non-negative number. Otherwise the key is omitted. Existing `input` / `output` / `total` behaviour, including returning `undefined` when none is usable, is unchanged. Update the `RAD_USAGE` JSDoc in `command.js` to list the new optional keys. Tests: `{input_tokens:10, output_tokens:5, cache_read_input_tokens:100}` gives `{input:10, output:5, total:15, cacheRead:100}` (no `cacheWrite` or `cost` key); `{input_tokens:10, output_tokens:5}` deep-equals today's result; string, negative, NaN and Infinity cache values are dropped; camelCase keys are accepted; `cost` passes through. `cost.test.js` must pass unmodified.
Validate: AC#3 — `npm test --prefix harness` passes, including the new cases, with `cost.test.js` unchanged.

#### Task 1.3: rad-status lists each plan once
File: scripts/rad-status.sh:64-96, scripts/test-rad-status.sh:86-160
What: In `collect_plans` passes 1 and 2, replace `git show … | emit_plan_row …` with the research collector's redirect form (`emit_plan_row "$feature" "$src" < <(git show … 2>/dev/null || true)`), so `SEEN_FEATURES` updates in the enclosing shell. Fix the misleading comment. Add a test asserting the fixture's `has-plan` (on base and in the local tree) renders exactly once, labelled `main (merged)`. Use a captured section and a count, not `printf | grep -q`.
Validate: AC#7 — `bash scripts/test-rad-status.sh` and `/bin/bash scripts/test-rad-status.sh` pass; a live `bash scripts/rad-status.sh` shows no duplicate plan rows.

### Wave 2 — sequential
Depends on: Wave 1 complete (`cacheUsage` edits `events.js` after Task 1.1; the docs describe Wave 1 behaviour)
Verify: npm test --prefix harness

#### Task 2.1: cacheUsage fold
File: harness/events.js:286-614, harness/test/events.test.js:125-410
What: Append a pure `cacheUsage(history)` fold that reads only `wave-attempt` `data.usage`. It returns `{ attempts: [{ feature, wave, attempt, cacheRead, input, ratio }], totals: { cacheRead, input }, withoutCache: n }`. `attempt` is the ordinal of that attempt within its (feature, wave). `ratio = cacheRead / (input + cacheRead)`, or `null` when the denominator is 0. Attempts without a valid `cacheRead` count toward `withoutCache`. It returns a zeroed shape on `[]` / null / non-array, never throws, and doesn't mutate its input (deepFreeze). Tests use inline histories: a retry whose ratio drops from positive to 0; legacy events with no usage; a zero denominator; mixed histories.
Validate: AC#4 — `npm test --prefix harness` passes; `totalUsage`'s result and every existing fold's values are unchanged.

#### Task 2.2: rad-insights, wave contract and harness doc updates
File: .claude/commands/shared/rad-insights.md, docs/rad-wave-contract.md, docs/harness-and-framework.md
What:
- **`rad-insights.md`:**
  - (a) Step 4c "Reading the output" and the Reliability template say outcomes are each (feature, wave)'s terminal attempt, and "total" counts waves, not wave-complete events.
  - (b) Add a step that invokes `cacheUsage` through the same `node -e` / `RAD_STATE_DIR` pattern, plus a cache-hit subsection near Model Tiering. It shows per-attempt ratios, flags any retry whose ratio dropped to 0 after a positive earlier attempt, and renders `no cache data reported` when `attempts` is empty.
  - (c) Amend the Model-tiering deferral note: cache fields are now carried (#121), but spend-derived advice is still deferred (tracked in #65).
- **`rad-wave-contract.md`:** extend the `usage` row with the optional `cacheRead` / `cacheWrite` / `cost` fields, and document the `RAD_USAGE {json}` stdout line (accepted keys, and that invalid values are dropped).
- **`harness-and-framework.md` (~L228):** update the `outcomeCounts` description.

Run the new `rad-insights` step's snippet against `RAD_STATE_DIR=harness/test/fixtures/insights` to confirm it renders the degradation line (the fixtures carry no cache data).
Validate: AC#5, AC#6 — each change is present; the snippet runs and prints the explicit no-cache line; `npm test --prefix harness` passes.

## Tests to Write
- [ ] outcomeCounts counts each wave's terminal attempt, ignores wave-complete, fixture literals updated with arithmetic comments — harness/test/events.test.js
- [ ] normalizeUsage passes valid cache and cost fields only when present; absent input stays deep-equal to today — harness/test/agent-contract.test.js
- [ ] cacheUsage per-attempt ratios, retry drop to zero, zero denominator, legacy events without usage — harness/test/events.test.js
- [ ] a plan on base and in the local tree renders once as main merged — scripts/test-rad-status.sh

## Non-Goals
- Spend-derived model-tier advisories (#65's half) and any pricing or cost computation.
- Writing an outcome onto `wave-complete` events (a spine or event-contract change).
- Changing `totalUsage`'s shape or `RAD_TOKEN_BUDGET` behaviour.
- Cleaning up the committed fixtures' unrealistic wave-complete outcomes.

## Out-of-Scope Dependencies
None. Every file is architect-writable.

## Risks
- **Changing locked values can hide a real regression.** The mitigation: only `outcomeCounts` values change, each with hand-computed arithmetic in a comment, and the diff is reviewable line by line. Every other fold's values must stay byte-identical.
- **`outcomeCounts.total` changes meaning** (wave-complete events become waves). Its only consumer is `rad-insights` Step 4c (`noWaveData`), updated in Task 2.2. Nothing in the harness runtime reads it.
- **Cache fields appear in newly recorded `wave-attempt` usage.** That's additive and absent when unreported, so legacy logs and existing literals are unaffected (proven by `cost.test.js` staying unchanged).
- **The `rad-status.sh` output changes** (duplicates vanish). There is no machine consumer of the text output.

## Issue Gaps

- **#121's `totalUsage` change is not adopted as written.** #121 proposed that `totalUsage` always return `cacheRead` / `cacheWrite`. That would break six locked values across `events.test.js` and `cost.test.js` for no consumer benefit, since the budget reads only `.total`. This plan keeps `totalUsage` unchanged and adds a separate `cacheUsage` fold. *Architect: agreed.*
- **#65's spend-derived advisories stay deferred; #65 reopened (architect decision, 2026-09-25).** This plan delivers the data (#121) but not the advice.
- **The terminal-attempt semantics for `outcomeCounts`.** This is #122's option 1. A wave that is still in progress (retrying) counts its latest attempt, which may flip on the next run. *Architect: acceptable.*
- **#93's remainder removed from this batch (architect decision, 2026-09-25).** Naming the three deficits is deferred until #93 gets its own focus. The per-file data can't tell the deficits apart, so it needs design, not a wording tweak.
- **#132 was folded into this batch.** It was filed today and matches the "reporting accuracy" theme. *Architect: agreed.*
