# Plan: Vertical-Slice Waves + Mockup-First Artifacts
Created: 2026-09-28
Author: architect
Status: pending-review
Branch: rad/vertical-slices-and-mockups
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/80, https://github.com/seanrreid/RAD_framework/issues/82
Issue-Title: Steer waves toward vertical slices, not stack-ordered layers (#80) + Optional mockup-first artifact for UI-bearing features (#82)

## Context

Both issues come from the WSFF arc (Dex Horthy, *Why Software Factories Fail*). Both are advisory planning conventions, and neither adds a gate.

- **#80, vertical slices.** Nothing in `/rad-plan` discourages stack-ordered waves: all schema, then all service, then all UI. That order pushes every integration risk into the last wave, which is exactly where per-wave retries and `Validate: AC#N` help least. This plan adds a "prefer vertical slices" wave rule to `/rad-plan` (a *should*) and a best-effort `lint-plan.sh` advisory. The advisory fires only when **every** wave is made of a single, recognizable stack layer and the waves cover at least two different layers. Anything else stays silent. That includes RAD's own harness work, whose paths (`harness/*.js`, `scripts/*.sh`) fit no layer, so the advisory never fires on it.
- **#82, mockup-first.** `/rad-research` and `/rad-design` are prose-only. For a feature with a user-visible surface they will now offer an optional HTML mockup at `.agents/mockups/<feature>.html`, which the plan references in its Context. If a plan references a mockup that doesn't exist on disk, lint gives an advisory. #82 marks itself lowest priority because RAD has no UI of its own; it's cheap here because it shares the lint surface with #80.

Research findings:
- Task `File:` paths are collected for the whole plan today, not grouped by wave (`plan_task_files`, `plan-paths.sh:59-70`). A per-wave helper is needed, reusing the `### Wave` / `#### Task` detection in `lint-plan.sh:113-139`.
- A mockup mentioned in prose without a `:NNN` anchor isn't picked up by the premise-freshness scan (`plan_cited_anchors` needs `path:NNN`), so a new mockup on the work branch isn't reported as stale.
- The on-disk existence checks cover only Files-in-Scope and task `File:` paths, never prose. That's why the mockup advisory is new logic.
- Mockup references almost always appear in backticks. So the mockup scan skips ```` ``` ```` fences, using the shared `RAD_FENCE_LINE_RE` from PR #141, but does **not** skip inline spans. That's the opposite of the marker scan.
- `/rad-review` Step 2b already includes the full `lint-plan.sh` output, so both advisories appear in review without changing it.
- `.agents/mockups/` isn't gitignored.

## Scope

| In scope | Out of scope |
|---|---|
| `plan_wave_task_files`, `path_layer`, `plan_mockup_refs` helpers in `scripts/lib/plan-paths.sh` | Any blocker, error or exit-code change (both advisories are `⚠` warnings only) |
| Stack-order and missing-mockup advisories in `lint-plan.sh` | Operator-configurable layer patterns (the built-in constants only) |
| Vertical-slice wave rule + mockup reference guidance in `/rad-plan` | Rendering, validating or linting mockup HTML contents |
| Mockup prompts in `/rad-research` and `/rad-design`; a short `docs/daily-workflow.md` note | `/rad-review` changes (Step 2b already shows lint output); #81 tiered planning |

## Acceptance Criteria

1. `plan_wave_task_files <plan>` prints one `<wave>\t<path>` line per task `File:` path, where `<wave>` is the number of the enclosing `### Wave N` heading. It splits multi-file `File:` lines exactly as `plan_task_files` does, via `split_task_file_value`, prints nothing for a plan with no waves, and returns non-zero with a stderr message for a missing or unreadable plan.
2. `path_layer <path>` prints exactly one of `schema | api | ui | service | test | unknown`. It uses named built-in pattern constants in a fixed precedence (test, schema, api, ui, service), so each path gets one layer deterministically. `harness/*.js`, `scripts/*.sh` and `*.md` paths are `unknown`.
3. `lint-plan.sh` emits one `⚠` stack-order advisory naming each wave's layer, e.g. `waves look stack-ordered (Wave 1: schema, Wave 2: service, Wave 3: ui) …`, only when all of these hold:
   - the plan has at least 2 waves
   - every wave has at least one non-`test` path and no `unknown` path
   - each wave's non-`test` paths share one layer
   - the waves cover at least 2 distinct layers

   Otherwise it emits nothing. Specifically it stays silent on:
   - a mixed-layer wave
   - a single-wave plan
   - a plan with any `unknown` path, such as all of RAD's own plans
   - repeated same-layer waves (a horizontal refactor)
   The advisory never changes the exit code and is never an approval blocker.
4. `plan_mockup_refs <plan>` prints each distinct `.agents/mockups/<name>.html` (or `.htm`) path referenced anywhere in the plan outside ```` ``` ```` fences. Backtick-quoted references count. `lint-plan.sh` emits a `⚠ mockup referenced but missing: <path>` advisory for each one not present on disk, and nothing when it exists or when there are no references. The exit code is unchanged.
5. `/rad-plan`'s Wave rules include the vertical-slice rule, stated as a preference: refactors and harness-internal work may be horizontal. When a mockup exists for the feature, `/rad-plan` references it in Context. `/rad-research` and `/rad-design` offer, but never require, a mockup at `.agents/mockups/<feature>.html` when the spec has a user-visible surface, and record it in their artifact. `docs/daily-workflow.md` mentions both conventions in one short paragraph.
6. For every existing plan under `.agents/plans/`, `lint-plan.sh` output is unchanged apart from any new advisory. The implementer re-lints every existing plan, reports any plan that gains an advisory, and justifies each one as a true positive; otherwise it tightens the patterns. Every `scripts/test-*.sh` passes under `bash` and `/bin/bash` 3.2, and `npm test --prefix harness` passes.

## Agent Scope

- `lint-surface-mapper` (architect):
  - task-file extraction (`plan-paths.sh:26-42, 59-70`) and wave detection (`lint-plan.sh:113-139`)
  - the advisory pattern (Program Design `:202-210`, rename `:225-268`)
  - premise-freshness and create-exemption (`plan_cited_anchors :172-213`, `plan_created_paths :215-239`), and `RAD_ANCHOR_EXT` including `html`
  - the reusable fence constant (`RAD_FENCE_LINE_RE :276`)
  - the `write_plan` fixture signature (`test-lint-plan.sh:58-125`) and bash 3.2 constraints
- Prose anchors, confirmed by direct grep: `/rad-plan` Wave rules (`rad-plan.md:200`), `/rad-research` Steps 3/5, `/rad-design` Steps 1-3, `docs/daily-workflow.md` planning section, `/rad-review` Step 2b.
- Out-of-scope dependencies: none. The author is the architect, and `scripts/` and `.claude/` are self-protected.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| scripts/lib/plan-paths.sh | 400-418 | Append `plan_wave_task_files`, `path_layer` (+ layer constants), `plan_mockup_refs` |
| scripts/test-plan-paths.sh | 440-465 | Append cases for the three helpers |
| scripts/lint-plan.sh | 200-275 | Stack-order advisory and missing-mockup advisory |
| scripts/test-lint-plan.sh | 715-742 | Append advisory cases |
| .claude/commands/team/rad-plan.md | 100-215 | Vertical-slice wave rule; Context mockup reference |
| .claude/commands/team/rad-research.md | 100-200 | Offer a mockup for user-visible features; record it in the artifact |
| .claude/commands/architect/rad-design.md | 46-131 | Accept/reference a mockup in the architecture artifact |
| docs/daily-workflow.md | 86-133 | One paragraph: vertical slices + mockup-first |

## Program Design

### 1. Signatures introduced

```bash
# scripts/lib/plan-paths.sh — new, sourced by lint-plan.sh
plan_wave_task_files <plan>   # stdout: "<wave>\t<path>" per task File: path (split like plan_task_files)
path_layer <path>             # stdout: schema | api | ui | service | test | unknown
plan_mockup_refs <plan>       # stdout: each distinct .agents/mockups/<name>.html(.htm) outside ``` fences

# built-in constants (not env-configurable), precedence test > schema > api > ui > service
RAD_LAYER_TEST_RE     RAD_LAYER_SCHEMA_RE   RAD_LAYER_API_RE
RAD_LAYER_UI_RE       RAD_LAYER_SERVICE_RE  RAD_MOCKUP_REF_RE
```

### 2. Control-flow sketch

```
lint-plan.sh
 ├─ … existing checks …
 ├─ stack-order advisory                                  ← NEW
 │    plan_wave_task_files → per wave: path_layer each path
 │    skip wave-local 'test'; any 'unknown' ⇒ silent
 │    every wave single-layer AND ≥2 waves AND ≥2 distinct layers ⇒ WARNINGS+=
 ├─ missing-mockup advisory                               ← NEW
 │    plan_mockup_refs → [ -f path ] || WARNINGS+=
 └─ output + exit (ERRORS only)                           [unchanged]
```

### 3. File-tree diff

```
scripts/lib/plan-paths.sh                  M  +3 helpers, +6 constants
scripts/lint-plan.sh                       M  +2 advisories
scripts/test-plan-paths.sh, test-lint-plan.sh  M  new cases
.claude/commands/team/{rad-plan,rad-research}.md, architect/rad-design.md  M
docs/daily-workflow.md                     M
```

## Execution Notes

### Do Not Touch
- harness/**
- scripts/check-approval-blockers.sh, and the blocker/waiver helpers and `RAD_SELF_PROTECTED_PATTERN` in scripts/lib/plan-paths.sh
- `plan_task_files` / `split_task_file_value` behavior (reuse them, don't change them)
- .claude/commands/team/rad-review.md, .claude/commands/architect/rad-approve.md

### Key Files
- scripts/lib/plan-paths.sh — `split_task_file_value`, `plan_task_files`, `RAD_FENCE_LINE_RE`, and the helper conventions (`require_readable_plan`, exit 2 on unreadable)
- scripts/lint-plan.sh — wave detection (:113-139), the `WARNINGS` pattern (Program Design :202-210, rename :225-268)
- scripts/test-lint-plan.sh — `write_plan` (wave_count / program_design / tail args), `run_lint`, and the hermetic `GREPO` fixture for anything that must print the success line

### Reminders
- Bash 3.2 / BSD awk: no associative arrays and no `mapfile`. Use a leading `(` on `case` patterns inside `$( … )`.
- **False positives are the main risk.** When in doubt the advisory stays silent: an `unknown` path in any wave silences it. Re-lint every existing plan (AC#6) and report the result.
- The mockup scan skips fences but **not** inline spans. The marker scan does both; don't reuse `strip_spans` here.
- Any test that asserts the "✓ plan is valid" line runs in the hermetic `GREPO` fixture (see the PR #141 CI fix).
- Prose examples of a mockup path go in fenced blocks, so they never trigger the missing-mockup advisory on this plan.

## Wave Plan

### Wave 1 — sequential
Verify: bash scripts/test-plan-paths.sh && /bin/bash scripts/test-plan-paths.sh
Tasks in this wave must run in sequence.

#### Task 1.1: Wave, layer and mockup helpers
File: scripts/lib/plan-paths.sh:400-418, scripts/test-plan-paths.sh:440-465
What: Append three helpers, each with a header comment that states its constraints:
- `plan_wave_task_files`: an awk/loop pass that tracks the current `### Wave N` number, feeds each `File:` value through `split_task_file_value`, and emits `N\tpath`.
- `path_layer`, with named extended-regex constants checked in the precedence test, schema, api, ui, service:
  - **test:** `(^|/)(tests?|__tests__|spec)/` or `\.(test|spec)\.`
  - **schema:** `(^|/)(migrations?|schema|db)/`, `\.sql$`, `\.prisma$`
  - **api:** `(^|/)(api|routes?|controllers?|handlers?|graphql)/`, `\.graphql$`, `openapi\.(ya?ml|json)$`
  - **ui:** `\.(tsx|jsx|vue|svelte|css|scss|sass|html?)$`, `(^|/)(components?|pages|views|ui|frontend|styles)/`
  - **service:** `(^|/)(services?|domain|models?|server|backend)/`
  - anything else is `unknown`
- `plan_mockup_refs`: skip `RAD_FENCE_LINE_RE`-toggled fences, then grep `\.agents/mockups/[A-Za-z0-9._-]+\.html?` and de-duplicate.

`plan_wave_task_files` and `plan_mockup_refs` use `require_readable_plan`. Tests:
- waves: multi-file lines, no waves, a missing plan
- layers: one path per layer, a precedence case (`src/components/api/Button.tsx` classifies as `api` because api beats ui), `harness/cli.js`, `scripts/x.sh` and `docs/a.md` giving `unknown`
- mockup refs: a backtick-quoted ref counted, a fenced ref ignored, duplicates collapsed, none
Validate: AC#1, AC#2, AC#4 (helper part) — `bash scripts/test-plan-paths.sh` and `/bin/bash scripts/test-plan-paths.sh` pass.

### Wave 2 — sequential
Verify: bash scripts/test-lint-plan.sh && /bin/bash scripts/test-lint-plan.sh && for t in scripts/test-*.sh; do bash "$t" >/dev/null || exit 1; done
Tasks in this wave must run in sequence.

#### Task 2.1: Stack-order and missing-mockup advisories in lint-plan.sh
File: scripts/lint-plan.sh:200-275, scripts/test-lint-plan.sh:715-742
What: Add the two advisories using the Wave 1 helpers, as `WARNINGS+=` entries that never touch `ERRORS` or `BLOCKERS`. Keep each block under ~40 lines, extracting a function if needed.
- **Stack-order:** build per-wave layer sets with strings, not associative arrays. Apply AC#3's conditions exactly, and word the advisory with the per-wave layers plus a "dismiss if this is a refactor" note.
- **Mockup:** `[ -f "$ref" ]` checked relative to the repo root the lint already uses.

Tests, using `write_plan`'s wave_count/tail args or a small custom fixture:
- schema/service/ui across 3 waves: advisory naming all three
- a mixed wave: none
- a single wave: none
- one `unknown` path in any wave: none
- the same layer repeated: none
- a test file alongside a schema wave: still counts as schema
- missing mockup: advisory; present mockup: none; fenced mockup ref: none
- exit code 0 in every case
Then re-lint every `.agents/plans/*.md` before and after the change (diff with the new advisories filtered out gives no other change) and list any plan that gained an advisory.
Validate: AC#3, AC#4, AC#6 — `bash scripts/test-lint-plan.sh`, `/bin/bash scripts/test-lint-plan.sh`, every `scripts/test-*.sh`, and the re-lint report.

### Wave 3 — parallel
Verify: for t in scripts/test-*.sh; do bash "$t" >/dev/null || exit 1; done && npm test --prefix harness
Tasks in this wave can run in parallel (disjoint prose files).

#### Task 3.1: Vertical-slice rule and mockup reference in /rad-plan
File: .claude/commands/team/rad-plan.md:100-215
What:
- Add to **Wave rules**: prefer waves that each land a testable end-to-end increment (one workflow's schema, service, API and UI together) over stack-ordered waves. This is a preference; pure refactors and harness-internal work may be horizontal. `lint-plan.sh` gives advisory warnings about stack-ordered plans.
- In the Context guidance: if `.agents/mockups/<feature>.html` exists, reference it (fenced example).
This task has no unit-testable surface (prompt prose).
Validate: AC#5 — read-through. `scripts/lint-plan.sh .agents/plans/vertical-slices-and-mockups.md` shows no new warnings from this prose.

#### Task 3.2: Mockup prompts in /rad-research and /rad-design; workflow doc
File: .claude/commands/team/rad-research.md:100-200, .claude/commands/architect/rad-design.md:46-131, docs/daily-workflow.md:86-133
What:
- In `/rad-research` Step 3 (clarifying questions): when the spec has a user-visible surface, offer an optional HTML mockup. If accepted, write `.agents/mockups/<slug>.html` and list it in the Step 5 artifact.
- In `/rad-design` Steps 1-3: read any listed mockup and reference it in the architecture artifact's Notes.
- In `docs/daily-workflow.md`: one short paragraph covering vertical-slice waves and mockup-first, both optional and advisory.
Examples go in fenced blocks. This task has no unit-testable surface (prompt prose and docs).
Validate: AC#5 — read-through, and the script and harness suites stay green.

## Tests to Write
- [ ] plan_wave_task_files: multi-file, no waves, missing plan — scripts/test-plan-paths.sh
- [ ] path_layer: each layer, precedence, unknown for harness/scripts/docs — scripts/test-plan-paths.sh
- [ ] plan_mockup_refs: backticked counted, fenced ignored, de-dupe, none — scripts/test-plan-paths.sh
- [ ] stack-order advisory: fires on layered waves; silent on mixed / single / unknown / repeated-layer; test files neutral — scripts/test-lint-plan.sh
- [ ] missing-mockup advisory: missing warns, present silent, fenced silent; exit 0 throughout — scripts/test-lint-plan.sh

## Non-Goals
- Making either advisory an error or an approval blocker.
- Operator-configurable layer patterns (`RAD_LAYER_*` env vars). Built-in constants only in v1.
- Validating, rendering or linting mockup HTML.
- Changing `/rad-review` or `/rad-approve` (lint output already reaches review).
- Tiered planning (#81).

## Out-of-Scope Dependencies
None

## Risks
- **False-positive advisories** are the failure mode the issue warns about. Mitigations:
  - any `unknown` path silences the advisory
  - test files are neutral
  - the advisory requires *every* wave to be single-layer
  - AC#6 re-lints every existing plan
  - if the heuristic proves noisy anyway, #80 says to ship the rule alone and drop the lint
- **Layer patterns are guesses** about target-project layouts, e.g. `models/` as service and `db/` as schema. Wrong guesses mostly give `unknown`, which means silence, the safe direction.
- **Backticked mockup refs in `/rad-plan` prose.** The template files aren't plans and aren't linted. Examples in real plans need fences, which the Reminders cover.

## Issue Gaps
- **[ASSUMPTION — #80]** "Stack-ordered" means *every* wave is single-layer and there are at least 2 distinct layers overall. A plan that's mostly layered with one mixed wave is silent. This favors precision over recall, as #80 asks.
- **[ASSUMPTION — #80]** The layer taxonomy is `schema | api | ui | service`, plus `test` (neutral) and `unknown` (silences). The precedence is test, schema, api, ui, service, and the patterns are built-in constants.
- **[ASSUMPTION — #80]** A repeated single layer (e.g. three `service` waves) is treated as a horizontal refactor and stays silent.
- **[ASSUMPTION — #82]** The mockup path convention is `.agents/mockups/<feature>.html` (`.htm` accepted). Only references matching that directory are checked, and prose paths elsewhere are ignored.
- **[ASSUMPTION — #82]** #82 said a missing mockup "ties into #74 premise-freshness". This plan implements it as a separate on-disk existence advisory instead, because freshness only reads `path:NNN` anchors against `origin/<default>`, where a new mockup would never exist yet.
- **[ASSUMPTION]** `/rad-review` needs no change: its Step 2b already includes the full `lint-plan.sh` output.
