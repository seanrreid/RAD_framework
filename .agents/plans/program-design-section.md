# Plan: Program Design Section
Created: 2026-07-24
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-07-24T14:25:43.256Z
Recorded-By: sean@torchcodelab.com
Branch: rad/program-design-section

## Context
RAD plan tasks carry `File:` / `What:` / `Validate:` — the *where* and *what* of a change —
but never its *shape* (type/method signatures, control flow, file-tree delta). Dex Horthy's
*Why Software Factories Fail* names this the "criminally underemphasized" Program Design
phase (see memory `wsff-source-author-update`, issue #79). This adds an **optional**
`## Program Design` section to the plan template and an **advisory** lint warning when a
*large* plan omits it — nudging the design layer most worth reviewing at Gate 1 into the
plan, without ever blocking.

## Scope
| In scope | Out of scope |
|---|---|
| New optional `## Program Design` section in the plan template (`rad-plan.md`) | Making the section mandatory / a `REQUIRED_SECTIONS` entry — it stays advisory |
| Advisory in `lint-plan.sh` when a large plan lacks the section (warning, never error) | Any new path matcher or wave counter — reuse `has_section`, `WAVE_COUNT`, `path_matches` |
| Test cases for the advisory (fires / silent / boundary) | Firing the advisory for small plans — they must stay silent |
| The `>=3 waves OR high-risk path` "large" definition | Enforcing the section's *content* (we check presence, not that signatures are correct) |

## Acceptance Criteria
1. The plan template in `.claude/commands/team/rad-plan.md` includes an optional `## Program Design` section (placed after `## Files in Scope`) whose guidance names its three artifacts — key type/method signatures, a call-stack sketch, and a file-tree diff — and states it is recommended for large/medium plans and skippable for small ones.
2. `lint-plan.sh` emits an advisory **warning** (exit code unchanged — never an error) when a plan is **large** (`WAVE_COUNT >= 3` **OR** any scope path matches `RAD_HIGH_RISK_PATTERNS`) **and** has no `## Program Design` section.
3. `lint-plan.sh` produces **no** Program Design advisory for a small plan (`< 3` waves **and** no high-risk path) that lacks the section.
4. A large plan that **has** the section produces no Program Design advisory.
5. The implementation reuses existing machinery only — `has_section`, `WAVE_COUNT`, and the existing high-risk `path_matches` loop over `plan_scope_paths` — with **no** new matcher and **no** change to `REQUIRED_SECTIONS`.

## Agent Scope
- Explore (research only) — bounded summary consumed to write this plan. No implementation agents required.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| .claude/commands/team/rad-plan.md | 99-182 | Insert optional `## Program Design` section after Files in Scope + a one-line recommended/skippable note |
| scripts/lint-plan.sh | 178-194 | Add `HIGH_RISK_HIT` boolean in the existing high-risk loop; add the large-plan-missing-section advisory block |
| scripts/test-lint-plan.sh | 41-93 | Parameterize `write_plan` wave count; add fires/silent/boundary/with-section cases |

## Program Design
<!-- Dogfooding the very section this plan introduces. Shape before code. -->

**Type / signature changes**
- `scripts/lint-plan.sh` — no new functions. Introduce one local boolean `HIGH_RISK_HIT` (default `false`), set `true` inside the existing high-risk path loop. The new advisory is an inline `if` block, not a function.
- `scripts/test-lint-plan.sh` — extend `write_plan`'s signature by ONE trailing optional param:
  `write_plan(out_path, scope_rows, task_file, wave_count=1, program_design=false)`.
  Backward-compatible: existing callers pass 3 args and get today's single-wave, no-Program-Design fixture unchanged.

**Call-stack / control-flow sketch**
```
lint-plan.sh (top-level, sequential)
  ... existing checks ...
  WAVE_COUNT=$(grep -c '^### Wave' …)           # already computed (~line 109)
  high-risk block (~178-193):
    for path in plan_scope_paths:               # existing loop — reuse
      if path_matches path RAD_HIGH_RISK_PATTERNS:
        WARNINGS+=(high-risk advisory)          # existing
        HIGH_RISK_HIT=true                      # NEW: set flag in-loop
  NEW Program Design advisory block (after ~193):
    if (WAVE_COUNT >= 3 || HIGH_RISK_HIT) && ! has_section "Program Design":
      WARNINGS+=("large plan (…) has no ## Program Design section — …")
  ... existing budget/section checks, unchanged …
  print WARNINGS block; exit reflects ERRORS only  # unchanged
```

**File-tree diff**
```
 .claude/commands/team/rad-plan.md   (M)  + ## Program Design section in template block + prose note
 scripts/lint-plan.sh                (M)  + HIGH_RISK_HIT flag, + advisory block (~15 lines)
 scripts/test-lint-plan.sh           (M)  ~ write_plan +1 param, + 4 test cases
```
No files added, moved, or deleted.

## Execution Notes

### Do Not Touch
- `REQUIRED_SECTIONS` array in `scripts/lint-plan.sh` — Program Design is optional; adding it there would make omission a hard error, violating "advisory, never an error" (AC#5).
- `path_matches` / `plan_scope_paths` in `scripts/lib/plan-paths.sh` — reuse as-is; the issue forbids a new matcher.

### Key Files
- `scripts/lint-plan.sh` — reuse `has_section` (~28-30), `WAVE_COUNT` (~109), and the high-risk loop (~178-193); the new advisory slots right after the high-risk block so both `WAVE_COUNT` and `HIGH_RISK_HIT` are in scope.
- `scripts/test-lint-plan.sh` — `write_plan` (~41-93) hardcodes one wave today; it needs the wave-count param to build a `>=3`-wave fixture. `run_lint` + `grep -q` on `$LINT_OUT` / `$LINT_CODE` is the assertion style.
- `.claude/commands/team/rad-plan.md` — insert the section after `## Files in Scope` (~line 127), before `## Execution Notes`.

### Reminders
- The advisory is a WARNING only — `WARNINGS+=(...)`, never `ERRORS+=(...)`; the exit code must be unchanged in every freshness-independent case (AC#2).
- "Large" is `>=3` waves (boundary: exactly 3 warns, exactly 2 is silent) OR at least one high-risk path.
- Presence check only — do not attempt to validate the section's contents.

## Wave Plan

### Wave 1 — parallel
Two independent files; no shared edit surface, safe to implement together.

#### Task 1.1: Program Design advisory in lint-plan.sh + tests
File: scripts/lint-plan.sh:178-194
What: In the existing high-risk advisory loop, add `HIGH_RISK_HIT=true` when a path matches (initialize `HIGH_RISK_HIT=false` before the loop). After the high-risk block, add: `if { [ "$WAVE_COUNT" -ge 3 ] || $HIGH_RISK_HIT; } && ! has_section "Program Design" "$PLAN_FILE"; then WARNINGS+=("large plan (>=3 waves or high-risk path) has no ## Program Design section — capture signatures, a call-stack sketch, and a file-tree diff before delivery"); fi`. Reuse `has_section`/`WAVE_COUNT`; touch neither `REQUIRED_SECTIONS` nor any matcher. Add cases to `scripts/test-lint-plan.sh`: parameterize `write_plan` with a wave-count arg (default 1, backward-compatible) and a program-design-present arg (default false); then assert (a) large-via-high-risk-path + no section → advisory present, exit unchanged; (b) large-via-3-waves + no section → advisory present; (c) small (1 wave, non-high-risk) + no section → NO advisory; (d) large + section present → NO advisory.
Validate: AC#2 (large + missing → warns, exit unchanged), AC#3 (small + missing → silent), AC#4 (large + present → silent), AC#5 (reuses has_section/WAVE_COUNT/path_matches, no REQUIRED_SECTIONS change). Edge cases: exactly 3 waves → warns; exactly 2 waves + no high-risk → silent; high-risk path with only 1 wave → warns; exit code identical to a run without the block.

#### Task 1.2: Program Design section in the plan template  ← parallel with 1.1
File: .claude/commands/team/rad-plan.md:127
What: Insert an optional `## Program Design` section into the template markdown block, after `## Files in Scope` and before `## Execution Notes`. Include an HTML comment describing its three artifacts (key type/method signatures; a call-stack / control-flow sketch; a file-tree diff of files added/moved/deleted) and stating it is recommended for large/medium plans and skippable for small (1–2 waves, no high-risk path). Add one prose line near the Wave rules or template noting the same recommended/skippable guidance. Do not reword existing sections or rules.
Validate: AC#1 (template contains the optional section with the three named artifacts and the recommended/skippable note). No independent executable test — the section is a markdown scaffold; its machine-recognizability (the `## Program Design` header the linter greps) is covered by Task 1.1's `has_section` test cases. Stated explicitly per the co-located-test convention: this task has no standalone test surface.

## Tests to Write
- [ ] Program Design advisory: large-via-high-risk fires, large-via-3-waves fires, small stays silent, large-with-section stays silent, exit code unchanged — scripts/test-lint-plan.sh

## Non-Goals
- Making `## Program Design` a required section — it is advisory-only; omission never fails a lint or blocks approval.
- Validating the *content* of a Program Design section (that signatures are correct, the call-stack is accurate) — the check is header presence only.
- Introducing a new path matcher, a second wave counter, or a tiered-planning entry point (that is issue #81, a separate plan).
- Firing the advisory for medium plans (2 waves, no high-risk) — the template recommends the section there, but the lint only nudges large plans.

## Out-of-Scope Dependencies
None — all files are within architect (full-repo) scope.

## Risks
- All touched files are RAD self-protected machinery (`scripts/`, `.claude/`, per #73), so this plan will correctly trip the self-protected advisory and be non-auto-clearable — expected, must go through architect approval.
- Extending `write_plan`'s signature is a shared-test-helper change: existing callers must keep working. Mitigation: the new params are trailing with today's defaults (wave_count=1, program_design=false), so 3-arg callers are byte-for-byte unchanged; the full existing suite must stay green.
- False sense of safety: a plan can satisfy the advisory with an empty/token `## Program Design` heading. Accepted for v1 — presence is a nudge, not a guarantee; content quality remains the architect's Gate-1 judgment (documented as a non-goal).
