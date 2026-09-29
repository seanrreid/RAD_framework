# Plan: Insights Arc — Legibility Deficits, Reviewer Calibration, Plan-Time Forecast, Drafted Plans
Created: 2026-09-29
Author: architect
Status: complete
Completed-At: 2026-09-29T18:01:50Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-09-29T17:46:25.682Z
Recorded-By: sean@torchcodelab.com
Branch: rad/insights-arc
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/93, https://github.com/seanrreid/RAD_framework/issues/48, https://github.com/seanrreid/RAD_framework/issues/60, https://github.com/seanrreid/RAD_framework/issues/64
Issue-Title: Agent-failure-as-code-smell (#93) + Findings→reviewer-calibration loop (#48) + Reliability metrics into /rad-plan (#60) + /rad-insights --draft-plans (#64)

## Context

This plan closes the four open issues in the insights arc in one delivery. All four are read-side, suggestion-only work over data RAD already records. The one exception is #64: it writes a plan and a branch, and only when you pass an explicit flag.

**What research found:**
- **#93 is partly shipped.** #123 delivered per-file attribution of blocked tasks: `fileFailureCounts` (`harness/events.js:504-543`, floor `FILE_FAILURE_MIN_FEATURES = 2` at `:472`) plus the "Code Legibility Signals" section (`rad-insights.md:856-883`). It explicitly **deferred naming the three deficits** ("the per-file data can't tell the deficits apart, so it needs design"; `.agents/plans/insights-read-side-folds.md:164`). What remains: design and derive the three deficits, cite evidence per file, and report unattributable failures.
- **The `File:` parser exists only as inline prose.** The task-title → `File:` paths mapping is built by a `node -e` snippet inside `rad-insights.md` Step 4e (`:340-360`), with no tests. #60 needs the same mapping, so this plan moves it into a module (`harness/plan-tasks.js`) that both callers import.
- **#48's labels are free text today.** `.agents/findings.jsonl` holds 56 findings, and 13 carry a ground-truth marker in the `issue` string ("Verified real; FIXED", "adversarially verified FALSE", category `false-alarm`). The only writer is `/rad-review` Step 7 (`.claude/commands/team/rad-review.md:228-256`), and its record template has no `verdict` field. Nothing validates finding records.
- **#60's attribution gap is already solved.** Per-task `File:` mapping joined to enriched `wave-attempt.data.tasks` (the #63 data) attributes outcomes to paths without a writer change. The plan's declared path set comes from `plan_scope_paths` (`scripts/lib/plan-paths.sh:82`), which is source-only. `rad forecast` calls it through the injected `sh` port instead of re-implementing it (the plan-paths one-source-of-truth pattern).
- **#64 has no script to reuse.** Branch-cut and commit live inline in `rad-plan.md:348-365` and `rad-adopt.md:211`. Step 3b's recurrence threshold (`RAD_FINDINGS_THRESHOLD`, default 5, `rad-insights.md:83-88`) and its category→suggestion mapping (`:95-100`: testing, code-clarity, security, error-handling, correctness) are the inputs the drafter must share.

## Scope

| In scope | Out of scope |
|---|---|
| #93: `fileDeficitSignals` fold (3 proxy deficits + unattributable count) and its insights rendering | Editing product code, tests, or comments from any insights route |
| #93: move the `File:` parser to `harness/plan-tasks.js`; Step 4e imports it | Changing the frozen 7-outcome vocabulary or the events writer |
| #48: `harness/findings.js` (`findingVerdict`, `reviewerCalibration`); insights "Reviewer Calibration" section | Rewriting existing `findings.jsonl` lines (no backfill) |
| #48: optional `verdict` field in `/rad-review`'s finding template | A later "verdict" record type for findings verified after persistence |
| #60: `rad forecast <plan>`, a read-only advisory; `/rad-plan` + `/rad-adopt` run it after lint | Wave-size or token-spend forecasting (path-level signals only in v1) |
| #64: `scripts/draft-insights-plan.sh` + fixture test; `/rad-insights --draft-plans` | Auto-approving, auto-pushing, or auto-applying any drafted plan |
| Docs: `daily-workflow.md`, `harness-and-framework.md` (#93 corrected premise), `rad-cli.md` (`rad forecast`) | #49 reviewer CI fixtures, #50 playbooks, #66 routes (already shipped) |

## Acceptance Criteria

1. `fileDeficitSignals(history, taskFiles, minFeatures)` in `harness/events.js` returns three deficits per file, each counted only when it recurs across at least `minFeatures` distinct features (default `FILE_FAILURE_MIN_FEATURES` = 2):
   - **`opaqueAbstraction`**: task status `blocked_code`.
   - **`missingDocumentation`**: a task that had a non-passing status on an earlier attempt of the same feature and wave, and later reached `complete` or `done_with_concerns`.
   - **`insufficientTesting`**: a `wave-attempt` with outcome `fail-tests`, attributed to every task listed in that attempt.
   Each deficit carries evidence: sorted distinct `features`, `waves` as `"<feature>#<wave>"`, and `attempts`. A file that qualifies on two deficits reports both, never a merged guess. The fold returns a zeroed shape on non-array or missing input and never throws.
2. `fileDeficitSignals` reports `unattributable`: the number of enriched blocked or failing task records whose title has no entry in `taskFiles`. Legacy attempts without `tasks` are counted separately as `unenriched`. Neither is ever dropped silently.
3. `harness/plan-tasks.js` exports `parseFileLine(line)` and `taskFilesFromPlanText(text)`. They parse `#### Task N.M: <title>` + `File:` lines with the Step 4e semantics: `,`/`;`/` + ` separators, `:lines` suffixes stripped, backticks and prose fragments dropped. `rad-insights` Step 4e imports this module; the inline parser is removed.
4. `harness/findings.js` exports the following:
   - **`findingVerdict(record)`** returns `'confirmed' | 'false-alarm' | 'unlabeled'`, applying these rules in order:
     1. An explicit `verdict` field, if it's one of the two values, wins.
     2. Otherwise, `category === 'false-alarm'`, or `issue` matching `/\bverified false\b|\bfalse[- ]alarm\b/i`, gives false-alarm.
     3. Otherwise, `issue` matching `/\bverified real\b/i` or `/\bFIXED\b/` (case-sensitive) gives confirmed.
     4. Anything else is unlabeled.
   - **`reviewerCalibration(records, minLabeled)`** returns, per reviewer, `{ confirmed, falseAlarm, unlabeled, labeled, precision, falseAlarmRate }`. The two rates are `null` while `labeled < minLabeled` (default `CALIBRATION_MIN_LABELED` = 5). Non-`finding` records are ignored, and malformed input returns a zeroed shape.
5. `/rad-review` Step 7's finding template gains `"verdict": "confirmed" | "false-alarm" | null`, set only when the cycle verified or refuted the finding, and `null` otherwise. Existing lines are never rewritten.
6. `/rad-insights` renders a **Reviewer Calibration** section from `reviewerCalibration` over `.agents/findings.jsonl`. It shows per-reviewer counts and, at or above the minimum, the precision and false-alarm rate. Below the minimum it says the labels are insufficient. It frames a rising false-alarm rate as a prompt-revision signal and is suggestion-only.
7. `/rad-insights` "Code Legibility Signals" renders each file × deficit from `fileDeficitSignals`. Each entry names the deficit, the evidence (features, waves, attempts) and the described remedy shape (boundary note, governing-constraint comment, or characterization test). It also renders an unattributable/unenriched line whenever either count is non-zero. The existing degradation lines and the #93 framing sentence are kept.
8. `rad forecast <plan>` behaves as follows:
   - **Paths:** it resolves the plan's declared path set via `plan_scope_paths` (sourced from `scripts/lib/plan-paths.sh` through the injected `sh`), builds `taskFiles` from `.agents/plans/*.md` via `plan-tasks.js`, and folds every `.agents/state/*/events.jsonl`.
   - **Output:** one advisory line per in-scope path with a qualifying deficit, then a summary line. When there are no signals it prints `forecast: no reliability signals for <n> path(s) (history: <k> feature(s))`.
   - **Exit codes:** it exits 0 whenever it produced a readout, signals or not. A missing or unreadable plan exits 2, and a `plan-paths.sh` failure exits 2 with the reason. A malformed event log exits 1 with the feature and the error. It writes nothing.
9. `/rad-plan` (Step 4b) and `/rad-adopt` (Step 6b) run `node harness/cli.js forecast <plan>` after lint and show its advisories to the author before committing. Its output never blocks planning.
10. `scripts/draft-insights-plan.sh` behaves as follows:
    - **Inputs:** it reads `.agents/findings.jsonl` (`RAD_FINDINGS_FILE` overrides the path, for fixtures) and applies the same threshold parse as Step 3b (`RAD_FINDINGS_THRESHOLD`; unset, 0, non-numeric or negative means 5).
    - **Output:** it renders ONE plan bundling every threshold-crossing category, at `.agents/plans/insights-proposals-<YYYY-MM-DD>.md`.
      - Mapped categories get a CLAUDE.md `## Coding Conventions` bullet task.
      - Unmapped categories get a described-lint task with a co-located `scripts/test-<name>.sh` fixture, never a silent skip.
      - Every rule-specific decision is a `[NEEDS CLARIFICATION: …]` marker.
    - **Git:** it cuts `rad/insights-proposals-<date>` from the default branch and commits only the plan. It never pushes.
    - **Flags:** `--dry-run` prints the plan to stdout and touches no git state.
    - **Exit codes:**

      | Condition | Result |
      |---|---|
      | no category at or above the threshold | exit 0 `nothing to draft`, no branch |
      | missing findings log | exit 2 |
      | dirty tracked worktree | exit 1 naming the problem, nothing written |
      | target branch exists locally or on origin | exit 1 naming the problem, nothing written |
      | success | exit 0 |

11. A drafted plan passes `scripts/lint-plan.sh` with zero errors, and `scripts/check-approval-blockers.sh` refuses it while any marker remains. Gate 1 therefore holds until a human finishes the plan.
12. `/rad-insights --draft-plans` runs the drafter after the Step 3b prose and reports the branch and plan path, plus the push/review next steps (it never pushes itself). Without the flag, the Step 3b output is unchanged.
13. The docs are updated:
    - `docs/daily-workflow.md` documents `--draft-plans`, Reviewer Calibration, the deficit readout and `rad forecast`.
    - `docs/harness-and-framework.md` records the corrected #93 premise: recurrent `blocked_code` is a legibility signal about the code, not "fix nothing".
    - `docs/rad-cli.md` documents `rad forecast`.

## Agent Scope

- An `Explore` agent (general, read-only) mapped:
  - the `events.js` insights folds and the `wave-attempt` evidence typedef
  - `rad-insights.md` step and section anchors
  - the findings writer in `rad-review.md`
  - the lint insertion points in `rad-plan.md` / `rad-adopt.md`
  - the `cli.js` `SUBCOMMANDS` table and the plan parsers
  - the `plan-paths.sh` function inventory and script/test conventions
  - the insights docs
- I ran direct greps to confirm: the #123 deferral note, the findings label counts, `plan_created_paths` (`New` change-column convention), and the `rad-review` Step 7 template.
- The `event-metrics-mapper` / `findings-surface-mapper` agents are developer-role, so this architect-authored plan didn't call them. No out-of-role dependency results.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/events.js | 470-476 | Export `DEFICITS` names next to `FILE_FAILURE_MIN_FEATURES` |
| harness/events.js | 617-700 | New `fileDeficitSignals` + `forecastForPaths` pure folds (after `attemptOutcomeCounts`) |
| harness/test/events.test.js | 1305-1335 | Tests for AC#1, AC#2, and `forecastForPaths` |
| harness/plan-tasks.js | 1-60 | New: `parseFileLine`, `taskFilesFromPlanText` |
| harness/test/plan-tasks.test.js | 1-80 | New: AC#3 parser cases |
| harness/findings.js | 1-100 | New: `findingVerdict`, `reviewerCalibration`, `CALIBRATION_MIN_LABELED` |
| harness/test/findings.test.js | 1-120 | New: AC#4 cases |
| harness/cli.js | 36-89 | `FORECAST_USAGE` + `SUBCOMMANDS` entry |
| harness/cli.js | 1880-1912 | New `forecastCommand` (thin: read plan, `sh` → `plan_scope_paths`, fold, print) |
| harness/test/cli.test.js | 940-984 | AC#8 cases with injected `sh` and fixture state |
| scripts/draft-insights-plan.sh | 1-180 | New: the drafter (AC#10) |
| scripts/test-draft-insights-plan.sh | 1-180 | New: fixture test (AC#10, AC#11) |
| .claude/commands/shared/rad-insights.md | 12-17 | Input: `--draft-plans` flag |
| .claude/commands/shared/rad-insights.md | 70-115 | Step 3b: `--draft-plans` invocation; new Step 3c: reviewer calibration |
| .claude/commands/shared/rad-insights.md | 325-409 | Step 4e: import `plan-tasks.js`; add `fileDeficitSignals` output |
| .claude/commands/shared/rad-insights.md | 782-788 | Output: Reviewer Calibration section after Findings Recurrence |
| .claude/commands/shared/rad-insights.md | 856-883 | Output: per-deficit Code Legibility rendering |
| .claude/commands/shared/rad-insights.md | 1000-1031 | Rules: calibration + drafter rules |
| .claude/commands/team/rad-review.md | 228-256 | Finding template: optional `verdict` |
| .claude/commands/team/rad-plan.md | 335-343 | Step 4b: run `rad forecast` after lint (advisory) |
| .claude/commands/team/rad-adopt.md | 194-203 | Step 6b: run `rad forecast` after lint (advisory) |
| docs/daily-workflow.md | 290-314 | Insights section: new flag, calibration, deficits, forecast |
| docs/harness-and-framework.md | 209-260 | Corrected #93 premise; three-deficit table |
| docs/rad-cli.md | 90-116 | `### rad forecast` subsection |

## Program Design

### 1. Deficit proxies (`fileDeficitSignals`, #93)

| Deficit | Proxy (per task record joined to `taskFiles[title]`) | Remedy shape (rendered, never applied) |
|---|---|---|
| `opaqueAbstraction` | task `status === 'blocked_code'` in any attempt | a described boundary/decomposition note |
| `missingDocumentation` | same `(feature, wave, title)` non-passing on an earlier attempt, then `complete`/`done_with_concerns` later | a described comment explaining the governing constraint |
| `insufficientTesting` | attempt `outcome === 'fail-tests'` → every task listed in that attempt | a described characterization test naming the uncovered behavior |

These are proxies, and the docs and rendering say so. Each deficit is floored independently at `minFeatures` distinct features. A task that declares two files is attributed to each file once per record (no double-counting within one file).

```js
// harness/events.js
export const DEFICITS = Object.freeze(['opaqueAbstraction', 'missingDocumentation', 'insufficientTesting']);
export function fileDeficitSignals(history, taskFiles, minFeatures = FILE_FAILURE_MIN_FEATURES)
/* → { files: { [path]: { [deficit]: { features: string[], waves: string[], attempts: number } } },
       unattributable: number, unenriched: number, belowFloor: number, minFeatures: number } */
export function forecastForPaths(signals, paths) /* → [{ path, deficits: {…} }] for paths ∩ signals.files */
```

### 2. Calibration (`harness/findings.js`, #48)

```js
export const VERDICTS = Object.freeze({ CONFIRMED: 'confirmed', FALSE_ALARM: 'false-alarm', UNLABELED: 'unlabeled' });
export const CALIBRATION_MIN_LABELED = 5;
export function findingVerdict(record)                 // explicit verdict > false-alarm rules > confirmed rules > unlabeled
export function reviewerCalibration(records, minLabeled = CALIBRATION_MIN_LABELED)
/* → { reviewers: { [name]: { confirmed, falseAlarm, unlabeled, labeled, precision|null, falseAlarmRate|null } }, minLabeled } */
```

`precision = confirmed / labeled` and `falseAlarmRate = falseAlarm / labeled`. Both stay `null` below `minLabeled`, never `0`.

### 3. `rad forecast <plan>` (#60)

```
forecastCommand(argv, { sh, repoRoot })
 ├─ plan readable?                         ─✗→ exit 2
 ├─ sh: bash -c '. scripts/lib/plan-paths.sh; plan_scope_paths "$1"' _ <plan>   ─✗→ exit 2 (reason)
 ├─ taskFiles = ∪ taskFilesFromPlanText(.agents/plans/*.md)
 ├─ history  = ∪ .agents/state/*/events.jsonl   (malformed → exit 1 naming the feature)
 ├─ signals  = fileDeficitSignals(history, taskFiles)
 └─ print forecastForPaths(signals, paths) lines + summary; exit 0
```

Output line: `forecast: <path> — <deficit> in <n> features (<features>); consider <remedy shape>`.

### 4. Drafted plan (#64)

`scripts/draft-insights-plan.sh [--dry-run]` follows the `check-approval-blockers.sh` conventions (header, `# Exit codes:` block, bash 3.2). Its category→task mapping mirrors Step 3b's list, and the script is the single source for drafting. The rendered plan carries every section `lint-plan.sh` requires:
- **Header:** `Author: insights-draft`.
- **Files in Scope:** a `CLAUDE.md` row for convention bullets, plus `New` rows for `scripts/lint-<category>.sh` and `scripts/test-lint-<category>.sh`.
- **Body sections:** ≥2 Non-Goals, `## Issue Gaps` naming the recurrence evidence, and one Validate per task citing an AC.
- **Markers:** a `[NEEDS CLARIFICATION: …]` marker for each rule's concrete wording or regex.

## Execution Notes

### Do Not Touch
- harness/gates.js, harness/stops.js, harness/spine.js, harness/transitions.js, harness/matrix.yaml, harness/gates.yaml
- The events writer paths in harness/events.js (typedefs, `PHASE_BY_TYPE`, append logic). Only the read-side insights block changes.
- .agents/findings.jsonl (read-only, no backfill)
- CLAUDE.md (drafted plans *propose* edits to it; this plan doesn't edit it)

### Key Files
- harness/events.js — `fileFailureCounts` (504-543), `collectFileFailures` (483), `BLOCKED_TASK_STATUSES` (437), `WaveAttemptEvidence` typedef (98-118)
- .claude/commands/shared/rad-insights.md — Step 3b (70-115), Step 4e (325-409), output sections (782-788, 856-883)
- scripts/lib/plan-paths.sh — `plan_scope_paths` (82)
- scripts/check-approval-blockers.sh + scripts/test-check-approval-blockers.sh — script/fixture conventions
- .claude/commands/team/rad-plan.md — branch-cut/commit conventions (348-365)

### Reminders
- **Suggestion-only everywhere.** Nothing in this plan edits product code, tests, comments, CLAUDE.md or lint scripts at runtime. The drafter writes one plan file plus a branch, and only under `--draft-plans` or a direct invocation.
- **Portability:** the drafter and its test must pass under both `bash` and `/bin/bash` 3.2. No associative arrays, no `mapfile`, BSD `grep -E`/`awk`/`sed`.
- **Success-line tests:** any test asserting lint's `✓ … plan is valid` line must run in the hermetic `GREPO` fixture (a local bare origin). Otherwise assert exit 0 and the absence of `Errors`.
- **Never swallow errors:** every `|| true` is justified inline, and a malformed log or findings line is reported with its feature and line.
- **Long final checks** exceed the 2-minute foreground timeout. Run them with `run_in_background`.

## Wave Plan

### Wave 1 — parallel
Tasks in this wave can run in parallel (disjoint files).

#### Task 1.1: Deficit + forecast folds
File: harness/events.js:470-476, 617-700, harness/test/events.test.js:1305-1335
What: Implement `DEFICITS`, `fileDeficitSignals` and `forecastForPaths` per Program Design §1. Reuse `declaredPaths` / `hasOwn`, and keep each function under ~40 lines with private helpers.
Tests:
- each proxy alone gives only its own deficit
- a file on two deficits reports both
- below the floor counts toward `belowFloor`
- a task declaring two files attributes to each once
- an unknown title increments `unattributable`
- a legacy attempt without `tasks` increments `unenriched`
- the `waves` evidence is sorted and deduplicated
- non-array input gives the zeroed shape
- `forecastForPaths` intersects paths and ignores paths with no signal
Validate: AC#1, AC#2 — `npm test --prefix harness`.

#### Task 1.2: Plan-task parser module
File: harness/plan-tasks.js:1-60, harness/test/plan-tasks.test.js:1-80
What: Move the Step 4e parser semantics into `parseFileLine(line)` and `taskFilesFromPlanText(text)`. The latter returns a title → deduplicated paths map; a later `File:` for the same title merges.
Tests:
- `,`, `;` and ` + ` separators
- `:10-20` and `:+5` suffixes are stripped
- backticks are stripped
- a parenthetical prose fragment is dropped
- a header without a `File:` line is ignored
- a `#` line resets the current title
- empty text gives `{}`
Validate: AC#3 — `npm test --prefix harness`.

#### Task 1.3: Reviewer calibration module
File: harness/findings.js:1-100, harness/test/findings.test.js:1-120
What: Implement Program Design §2.
Tests:
- an explicit `verdict` wins over contradicting text
- `category: false-alarm` gives false-alarm
- "adversarially verified FALSE" gives false-alarm
- "Verified real; FIXED" gives confirmed
- a lowercase "fixed" alone gives unlabeled
- both markers present gives false-alarm (false-alarm rules win)
- precision and falseAlarmRate are `null` below `minLabeled` and computed at or above it
- `cycle` records are ignored
- non-array input gives the zeroed shape
- run against a copy of the 13 real labeled lines, the fold matches a hand count (fixture inlined in the test)
Validate: AC#4 — `npm test --prefix harness`.

### Wave 2 — parallel
Tasks in this wave can run in parallel (disjoint files). 2.1 and 2.2 depend on Wave 1's modules; 2.3 is independent.

#### Task 2.1: rad forecast command
File: harness/cli.js:36-89, 1880-1912, harness/test/cli.test.js:940-984
What: Implement Program Design §3 as `forecastCommand`, with a `SUBCOMMANDS` entry and `FORECAST_USAGE`. Keep it thin: all folding lives in `events.js`, `plan-tasks.js` and `plan-paths.sh`.
Tests, using an injected `sh` stub and temp fixture dirs for plans and state:
- signals are printed for in-scope paths only
- no signals prints the summary line
- a missing plan exits 2
- a `plan_scope_paths` failure exits 2 with the reason
- a malformed log exits 1 naming the feature
- no state dir gives the history-0 summary
Validate: AC#8 — `npm test --prefix harness`.

#### Task 2.2: Insights, review and planning skill wiring
File: .claude/commands/shared/rad-insights.md:12-17, 70-115, 325-409, 782-788, 856-883, 1000-1031, .claude/commands/team/rad-review.md:228-256, .claude/commands/team/rad-plan.md:335-343, .claude/commands/team/rad-adopt.md:194-203
What:
- **`rad-insights.md`:**
  - Add the `--draft-plans` flag. In Step 3b, when the flag is set, run `scripts/draft-insights-plan.sh` after the prose and report its outcome and the push/review next steps.
  - Add Step 3c, which runs `reviewerCalibration` via `node --input-type=module`.
  - In Step 4e, import `taskFilesFromPlanText` from `harness/plan-tasks.js` (delete the inline parser) and also print the `fileDeficitSignals` output.
  - Output: add the Reviewer Calibration section and the per-deficit Code Legibility rendering, including the unattributable/unenriched line. Update the Rules.
  - Without `--draft-plans`, Step 3b is unchanged.
- **`rad-review.md`:** add `"verdict"` to the finding template, with the rule for when it's set.
- **`rad-plan.md` and `rad-adopt.md`:** after lint, run `node harness/cli.js forecast <plan>` and show the advisories; they never block.
Smoke-run the Step 3c and Step 4e snippets from the repo root against the real `.agents/`. Both must print JSON and exit 0. The prose itself has no automated test; it is reviewed by reading.
Validate: AC#3, AC#5, AC#6, AC#7, AC#9, AC#12 — smoke-run output pasted into the task commit body; `npm test --prefix harness` still green.

#### Task 2.3: Draft-plan script
File: scripts/draft-insights-plan.sh:1-180, scripts/test-draft-insights-plan.sh:1-180
What: Implement AC#10 per Program Design §4.
Fixture cases, in a hermetic `GREPO` fixture with a local bare origin:
- a below-threshold log gives `nothing to draft`, exit 0, no branch
- two crossing categories (one mapped, one unmapped) give one plan, one branch and one commit containing only the plan
- the drafted plan passes `lint-plan.sh` with no errors
- `check-approval-blockers.sh` exits non-zero on the drafted plan, because of its markers
- a re-run with the branch present exits 1 and writes nothing
- a dirty tracked file exits 1
- a missing findings log exits 2
- `--dry-run` prints the plan and leaves the branch list and status unchanged
- `RAD_FINDINGS_THRESHOLD=abc` falls back to 5
Run the test under both `bash` and `/bin/bash`.
Validate: AC#10, AC#11 — `bash scripts/test-draft-insights-plan.sh && /bin/bash scripts/test-draft-insights-plan.sh`.

### Wave 3 — sequential
Task 3.1 documents the finished surfaces.

#### Task 3.1: Docs
File: docs/daily-workflow.md:290-314, docs/harness-and-framework.md:209-260, docs/rad-cli.md:90-116
What:
- **`daily-workflow.md`:** in the insights section, cover `--draft-plans` (the Gate-1 handoff, markers block approval), Reviewer Calibration, deficit signals, and `rad forecast` in the planning flow.
- **`harness-and-framework.md`:** record the corrected #93 premise and the proxy table from Program Design §1.
- **`rad-cli.md`:** add a `### rad forecast` subsection after `rad stop-status`.
Validate: AC#13 — no testable surface (docs); `grep -n "forecast" docs/rad-cli.md docs/daily-workflow.md` and `grep -n "opaqueAbstraction\|blocked_code" docs/harness-and-framework.md` are non-empty.

## Tests to Write
- [ ] `fileDeficitSignals` / `forecastForPaths` — harness/test/events.test.js
- [ ] `parseFileLine` / `taskFilesFromPlanText` — harness/test/plan-tasks.test.js
- [ ] `findingVerdict` / `reviewerCalibration` — harness/test/findings.test.js
- [ ] `rad forecast` — harness/test/cli.test.js
- [ ] Drafter fixture cases under bash + /bin/bash — scripts/test-draft-insights-plan.sh

## Non-Goals
- Auto-approving, auto-pushing, or auto-applying a drafted plan. Gate 1 stays the only authority, and markers force a human pass.
- Backfilling `verdict` onto existing `findings.jsonl` lines, or adding a later verdict-record type.
- Forecasting wave size, task count, or token spend (#60's other examples). v1 reads path-level signals only.
- Any new routing on outcomes, or any matrix or gate change.
- Semantic or vector matching of paths or findings (RAD rejects that family).

## Out-of-Scope Dependencies
None. All paths are architect-owned, and the author is the architect.

## Risks
- **Proxy misreads.** `insufficientTesting` over-attributes a `fail-tests` attempt to every task in that attempt. This is mitigated by the cross-feature floor and by labelling it a proxy in every rendering.
- **Small corpus.** With 13 labeled findings, precision is computable for at most one reviewer. The `null`-below-minimum rule keeps it from looking authoritative.
- **Step 4e refactor.** Moving the parser could change `mappedTitles` on real plans. Task 2.2's smoke run compares the `mappedTitles` count before and after the change.
- **Drafted plans and lint drift.** If `lint-plan.sh` gains a required section later, drafted plans break. The fixture test runs lint on the draft, so that drift surfaces in CI.
- **Self-protected paths.** `harness/`, `scripts/` and `.claude/` trigger advisory lint warnings by design. They need architect review but no waiver.

## Issue Gaps
- **ASSUMPTION — #93 proxies.** The three deficits are derived by the proxies in Program Design §1, not by true regression detection. Architect decision, 2026-09-29.
- **ASSUMPTION — #48 labels.** An explicit `verdict` field plus keyword fallback, with no backfill. Architect decision, 2026-09-29. A finding verified *after* persistence has no append path in v1, so it stays `unlabeled` unless re-reviewed.
- **ASSUMPTION — #48 minimum.** `CALIBRATION_MIN_LABELED = 5`, deliberately below the checklist's "20+", so the readout isn't dark for months. The rendering names the minimum.
- **ASSUMPTION — #60 surface.** `rad forecast` is its own command, run by `/rad-plan` and `/rad-adopt`, not a `lint-plan.sh` section. Architect decision, 2026-09-29. v1 forecasts path-level signals only (see Non-Goals).
- **ASSUMPTION — #60 history source.** The working tree's `.agents/state/*/events.jsonl`, which includes merged logs from delivered features. Branch tips aren't fetched.
- **ASSUMPTION — #64 generation.** A deterministic script with markers for human-only specifics. Architect decision, 2026-09-29. The branch is named `rad/insights-proposals-<YYYY-MM-DD>`, and the script never pushes; the skill prints the push/review steps.
- **ASSUMPTION — #64 severity-routing note.** #64's Wave 3 mentions auto-clearing drafted plans under `RAD_LOW_RISK_PATTERNS`. That no longer applies: auto-approval was removed in #137, and every drafted plan waits for `/rad-approve`.
- **ASSUMPTION — `Author: insights-draft`.** `lint-plan.sh` only requires the field to be present. The value marks the plan as machine-drafted for the approving architect.
