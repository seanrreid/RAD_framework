# Plan: Cycle-Time and Human-Touch Metrics in /rad-insights, and the Unset-Budget Warning (#247, #246)
Created: 2026-10-12
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-12T16:54:58.705Z
Recorded-By: sean@torchcodelab.com
Branch: rad/cycle-metrics-and-budget-warning
Issue: 247
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/247
Issue-Title: /rad-insights: stage durations and human-touch counts per feature (events-only)

## Context
Two small changes from the 2026-10-09 factory-checks audit (checks M1/M2 and C1/C2), both reading data RAD already records.

**#247.** RAD cannot show whether it reduces review burden. Every event has a timestamp, approvals record who approved, and stops and resumes are logged, but nothing counts or times them. This plan adds a pure, read-only fold in a new module, `harness/cycle-metrics.js` (architect decision 2026-10-12: a new module, not `events.js`, to keep the touch policy out of the anchor-dense event file), and a new `/rad-insights` section. It is reporting only: no gate, no threshold.

**#246.** `RAD_TOKEN_BUDGET` is opt-in, so an unset budget means no token cap and no notice. The same `/rad-insights` section gains tokens per delivered feature, summed from the existing `totalUsage` fold, and `rad deliver` prints a one-line warning at start when no budget is armed.

**Deviation from #247 found while researching.** The issue asks for plan-open → approved → delivered durations. The 25 real event logs in `.agents/state/` contain no `plan-created` or `research-created` events (types present: `approved`, `wave-attempt`, `wave-started`, `wave-complete`, `deliver-started`, `run-prepared`, `pr-opened`, `wave-failed`, `deliver-stopped`, `run-resumed`, `architecture-approved`), so the plan-open stage is not recoverable from events. The stages this plan reports are approved → deliver-started (wait to start), deliver-started → pr-opened (run time) and approved → pr-opened (total). Plan-open time lives in git and is left to the merge-latency revisit (#248).

## Scope
| In scope | Out of scope |
|---|---|
| New pure module `harness/cycle-metrics.js`: stage durations, human-touch counts, tokens per delivered feature | Plan-open and merge timing (git/host data; #248) |
| New `/rad-insights` step and report section (source skill, plus the two regenerated outputs) | Any gate, threshold or budget default |
| A warning line at `rad deliver` start when no valid token budget is armed | Changing the budget breaker, its default or what it covers |
| Docs for the new section and the warning | Writing or changing events (read-side only) |

## Acceptance Criteria
1. **Stage durations.** For one feature's event history, `stageDurations` returns `approvedToStartMs` (first `approved` → first `deliver-started`), `runMs` (first `deliver-started` → last `pr-opened`) and `totalMs` (first `approved` → last `pr-opened`). A stage whose endpoints are missing, or whose timestamps are invalid or run backwards, is `null`, never `NaN` or negative.
2. **Human touches.** `humanTouches` returns `approvals` (count of `approved` events), `reApprovals` (`approvals - 1`, minimum 0), `needsDecisionStops` (`deliver-stopped` events with `data.class === 'needs-decision'`), `resumes` (`run-resumed` events) and `total` (their sum, counting `approvals` once, not `reApprovals`).
3. **Tokens per delivered feature.** `tokensPerDeliveredFeature` takes a map of feature → history, counts only features whose history has a `pr-opened` event, sums each with `totalUsage`, and returns per-feature totals and their mean. A delivered feature with no recorded usage is listed as `null` and excluded from the mean.
4. **Pure and total.** None of the folds performs I/O or throws on empty, non-array, or malformed-event input; each returns the documented empty value instead.
5. **Insights section.** `/rad-insights` has a new step that imports the folds from `harness/cycle-metrics.js` (never re-implements them) and a new report section, "Cycle Time and Human Touches", showing per-feature durations and touches plus tokens per delivered feature. With no event logs, the section is omitted.
6. **Reporting only.** The section sets no target or threshold and no command reads these values to block, warn or gate anything.
7. **Budget warning.** When `RAD_TOKEN_BUDGET` is unset or does not parse to a positive integer, `rad deliver` writes exactly one line to stderr at start, before any wave runs, saying no token cap applies and naming the variable. When a valid budget is set, no warning is written. The breaker, its default and its stop behavior are unchanged.
8. **Generated outputs in step.** The two generated copies of the insights skill match the source: `node harness/cli.js generate --check` exits 0.
9. **Full suite passes.** `scripts/verify-all.sh` passes on the delivered branch.

## Agent Scope
No sub-agents were called. Research was inline (10 tool calls): event types and shapes in `events.js`, the real event-log sequence, the `/rad-insights` skill structure and generated outputs, the `RAD_TOKEN_BUDGET` read site and tests, docs mentions.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/cycle-metrics.js | 1-150 | New. `stageDurations`, `humanTouches`, `tokensPerDeliveredFeature`; imports `totalUsage` from `events.js` |
| harness/test/cycle-metrics.test.js | 1-200 | New. Fold unit tests including every edge case in the Validate fields |
| harness/cli.js | 270-300 | New helper `tokenBudgetWarning(env)` returning the warning line or null |
| harness/cli.js | 2036-2045 | Call the helper at the `RAD_TOKEN_BUDGET` read site and write the line to stderr |
| harness/test/cli.test.js | 540-620 | Add warning tests next to the existing deliver env-key tests |
| .rad/skills/rad-insights/SKILL.md | 828-912 | New Step 4h and the new report section in Step 5 |
| .agents/skills/rad-insights/SKILL.md | 828-912 | Regenerated copy (do not hand-edit) |
| .claude/commands/shared/rad-insights.md | 828-912 | Regenerated copy (do not hand-edit) |
| docs/rad-cli.md | 930-936 | Env-table row for `RAD_TOKEN_BUDGET`: note the unset warning |
| docs/configuration.md | 283-297 | `RAD_TOKEN_BUDGET` section: note the unset warning |

## Execution Notes

### Do Not Touch
- harness/events.js, harness/gates.js, harness/gates.yaml, harness/matrix.yaml (read-only: the new module imports `totalUsage` and nothing else)
- harness/spine.js (the breaker and its stop behavior are unchanged)
- scripts/ (no new script in this plan)

### Key Files
- harness/events.js — `totalUsage` (~310) and the event typedef (~16-30); import only
- harness/digest.js and harness/findings.js — the pattern for a small read-side module
- .rad/skills/rad-insights/SKILL.md — Steps 4c-4g show the exact `node --input-type=module -e` import pattern the new step must reuse
- harness/test/events.test.js — test style for pure folds

### Reminders
- harness/ and .rad/ are self-protected: this plan needs architect approval and the last-wave full-suite Verify. Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800` AND `RAD_VERIFY_TIMEOUT_SECONDS=1800` (the default 600 s wave limit timed out the last full-suite plan).
- Generated files are produced by `node harness/cli.js generate`; never edit them by hand. Run it after changing the source skill, then run `generate --check`.
- A touch is a policy decision; the module's header comment must say what counts and what does not (plan edits are not events, so only re-approvals approximate them).
- Keep functions under ~40 lines (AGENTS.md); one small function per metric.
- Per-feature output stays out of the module: it returns data, and the skill formats it.

## Program Design

Signatures (all pure; `history` is an in-memory array of events, as in `events.js`):

```js
// harness/cycle-metrics.js
export function stageDurations(history)
  // -> { approvedToStartMs: number|null, runMs: number|null, totalMs: number|null }
export function humanTouches(history)
  // -> { approvals, reApprovals, needsDecisionStops, resumes, total }  (all integers >= 0)
export function tokensPerDeliveredFeature(histories)
  // histories: Record<feature, Event[]>
  // -> { perFeature: Record<feature, number|null>, mean: number|null }

// harness/cli.js
const TOKEN_BUDGET_UNSET_WARNING = '...';          // named constant, one line
function tokenBudgetWarning(env)                    // -> string|null
```

Call stack:

```
/rad-insights Step 4h  -> reads .agents/state/*/events.jsonl
                       -> stageDurations / humanTouches / tokensPerDeliveredFeature
                          (cycle-metrics.js) -> totalUsage (events.js, import only)
rad deliver            -> deliverCommand -> tokenBudgetWarning(process.env) -> stderr
```

File tree diff:

```
harness/
  cycle-metrics.js              NEW
  cli.js                        + tokenBudgetWarning, one call site
  test/cycle-metrics.test.js    NEW
  test/cli.test.js              + warning tests
.rad/skills/rad-insights/SKILL.md          + Step 4h, report section
.agents/skills/rad-insights/SKILL.md       regenerated
.claude/commands/shared/rad-insights.md    regenerated
docs/rad-cli.md, docs/configuration.md     one note each
```

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (1.2 tests the module written in 1.1).
Verify: node --test harness/test/cycle-metrics.test.js

#### Task 1.1: The metrics module
File: harness/cycle-metrics.js
What: Create the module with `stageDurations(history)`, `humanTouches(history)` and `tokensPerDeliveredFeature(histories)` as specified in AC#1-AC#4. A header comment states what counts as a touch and that the module is read-side only. Named constants for the event type strings and the `needs-decision` class.
Validate: AC#1, AC#2, AC#3, AC#4 — each function returns its documented empty value for `[]`, `null`, a non-array and events missing `ts` or `data`.

#### Task 1.2: Tests for the module
File: harness/test/cycle-metrics.test.js
What: Unit tests covering: no `approved` event; approved but never delivered; a resumed run (two `deliver-started`, one `pr-opened`); several re-approvals; invalid, missing and backwards timestamps; empty history; non-array input; delivered feature with no usage; mixed delivered and undelivered features; `needs-decision` versus `failed` stops.
Validate: AC#1, AC#2, AC#3, AC#4 — every listed edge case has its own named test.

### Wave 2 — sequential
Tasks in this wave must run in sequence (2.2 and 2.3 use the helper from 2.1).
Verify: node --test harness/test/cli.test.js

#### Task 2.1: The warning helper
File: harness/cli.js:270-300
What: Add `tokenBudgetWarning(env)`: returns the one-line warning when `env.RAD_TOKEN_BUDGET` is unset or does not parse (the same `Number.parseInt` rule used at the read site) to a positive integer, else `null`. The message names `RAD_TOKEN_BUDGET` and says no token cap applies to this run. The message text is a named constant.
Validate: AC#7 — unit test over unset, empty string, `0`, `-5`, `abc`, whitespace, and a valid value.

#### Task 2.2: Wire it into rad deliver
File: harness/cli.js:2036-2045
What: At the `RAD_TOKEN_BUDGET` read site, write the helper's line to stderr when it is non-null. Use the same parse as today so the breaker is unchanged. The warning is written once, before the spine starts.
Validate: AC#7 — `tokenBudget` is still `null` for the same inputs; a delivery with a valid budget writes no warning.

#### Task 2.3: Tests and docs for the warning
File: harness/test/cli.test.js:540-620, docs/rad-cli.md:930-936, docs/configuration.md:283-297
What: Add tests next to the existing deliver env-key tests (`DELIVER_ENV_KEYS`): warning present for the unset and malformed cases and absent for a valid value. Update both docs to mention the notice.
Validate: AC#7 — tests pass; both docs state the unset warning.

### Wave 3 — sequential
Tasks in this wave must run in sequence (3.2 regenerates from 3.1).
Verify: exec bash scripts/verify-all.sh

#### Task 3.1: The insights step and report section
File: .rad/skills/rad-insights/SKILL.md:828-912
What: Add Step 4h, "Cycle time, human touches and tokens per delivered feature", following the 4c-4g import pattern: read each `.agents/state/*/events.jsonl`, call the folds from `harness/cycle-metrics.js`, omit the section when no logs exist. Add the "Cycle Time and Human Touches" section to the Step 5 report template. State in the step that the values are reporting only and set no target.
Validate: AC#5, AC#6 — the step imports from `cycle-metrics.js` and re-implements nothing; no wording sets a threshold or tells the reader to act on a value.

#### Task 3.2: Regenerate the outputs
File: .agents/skills/rad-insights/SKILL.md:828-912, .claude/commands/shared/rad-insights.md:828-912
What: Run `node harness/cli.js generate` and commit only the regenerated outputs of this skill. Do not edit them by hand.
Validate: AC#8 — `node harness/cli.js generate --check` exits 0.

#### Task 3.3: Full-suite check
File: .rad/skills/rad-insights/SKILL.md:828-912
What: No edit. The wave's Verify runs the full suite.
Validate: AC#9 — `scripts/verify-all.sh` passes.

## Tests to Write
- [ ] Stage durations, human touches and tokens per delivered feature, with all edge cases — harness/test/cycle-metrics.test.js
- [ ] Budget warning helper and its call in `rad deliver` — harness/test/cli.test.js

## Non-Goals
- Plan-open and merge-latency timing (#248)
- Any gate, threshold, target or automatic action based on these values
- Changing the token-budget breaker, its default, or its coverage (review, research and plan calls)
- A per-wave forecast stop

## Out-of-Scope Dependencies
None.

## Risks
- Metrics invite targets (the catalogue's warning about optimizing the measure). Mitigated by AC#6 and by the skill wording; no code path reads the values.
- A "touch" is approximated: plan edits after approval are not events, so only re-approvals are counted. The module header and the report state this.
- The insights skill is large (1,160 lines) and generated into two other files; a drift between source and outputs fails CI. Mitigated by AC#8 and the regenerate task.
- `harness/test/cli.test.js` is ~4,000 lines; a test added in the wrong place could break env isolation. New tests follow the existing `DELIVER_ENV_KEYS` handling.

## Issue Gaps
- ASSUMPTION: the plan-open stage in #247 is dropped because no `plan-created` event exists in any real log; the issue's own "events-only" decision takes precedence. #247 should be updated when this plan is delivered, and #248 (git/host timing) is the natural home for plan-open.
- ASSUMPTION: "tokens per delivered feature" counts a feature as delivered when its history has a `pr-opened` event (the same event the deliver spine appends last). A merged-but-never-`pr-opened` feature would not count.
- ASSUMPTION: the first `approved` and first `deliver-started` mark the start of each stage and the last `pr-opened` marks the end, so re-approvals and resumes do not restart the clock. Confirm this is the intended reading of "stage duration".
- ASSUMPTION: the warning covers a malformed budget as well as an unset one, because both leave the breaker disabled; #246 only mentions the unset case.
- ASSUMPTION: the new insights step is added after Step 4g and before Step 5, and the generated copies are regenerated, not hand-edited. Line ranges for the skill files are estimates (the source file is ~1,160 lines); the executor should confirm the insertion point and stay within the declared files.
