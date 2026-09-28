# Plan: Light Planning Tier (/rad-plan --light)
Created: 2026-09-28
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-09-28T15:30:34.192Z
Recorded-By: sean@torchcodelab.com
Branch: rad/light-planning-tier
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/81
Issue-Title: Tiered planning entry (/rad-plan --light) so process cost tracks task size (WSFF 80/20)

## Context

#81 (from Dex Horthy, *Why Software Factories Fail*: ~40% of tasks are near-oneshot) asks for a light planning path so process cost tracks task size. The human gate must never be skipped; only the planning ceremony shrinks.

**Premise correction:** the issue says every change pays the full `/rad-research` → `/rad-design` → `/rad-plan` toll. It doesn't. `/rad-research` and `/rad-design` run **once per project**. The cost per change is `/rad-plan` alone: an Explore research sub-agent plus a template with 10 required lint sections (`lint-plan.sh:77`). So "light" means a **smaller `/rad-plan`**. The issue's framing as a sibling of the #37 severity router is also out of date, since #137 removed that router.

**Architect decisions (2026-09-28):**
1. **A declared tier with a smaller shape.** A `Tier: light` header marks the plan; no header means standard, so every existing plan is unchanged.
   - A light plan must have: Context, Acceptance Criteria, Files in Scope, a one-wave Wave Plan, Tests to Write and Non-Goals.
   - Scope, Agent Scope, Execution Notes and Risks become optional.
   - `/rad-plan --light` replaces the full Explore research step with a capped quick scope check. It still cuts a `rad/` branch, and it still needs `/rad-approve`.
2. **The guardrail is a non-waivable approval blocker.** This reuses the #141 mechanism. A `Tier: light` plan beyond the light limits gets a `light-tier` blocker, and `rad approve` refuses until the plan is made smaller or promoted to standard by removing the header. The limits are: more than 1 wave, more than 3 tasks, or any high-risk or self-protected path. `/rad-plan --light` also refuses up front.
3. **Self-protected paths are always excluded.** RAD's own machinery always gets a full plan, so `--light` applies only to projects RAD is installed in, never to RAD itself.

Research findings:
- `harness/cli.js` reads Execution Notes subsections as optional (`subSectionLines` returns `[]` when a subsection is missing, `:256-271`, `:382-396`), so a light plan without them delivers normally. `check-scope.sh` and `check-tests-present.sh` read only Files in Scope and Tests to Write, which stay required.
- `check-approval-blockers.sh` builds its blockers in `main()` from markers and un-waived high-risk findings (`:86-100`). A light-tier set slots in beside them, never goes through `applied_waivers`, and so can't be waived.
- A light plan with a high-risk path gets two blockers: the ordinary high-risk finding, which a waiver can clear, and the light-tier violation, which it can't. So a waiver can't carry a risky change on the light path.

## Scope

| In scope | Out of scope |
|---|---|
| `plan_tier` and `plan_light_violations` helpers + limit constants in `scripts/lib/plan-paths.sh` | `/rad-adopt --light` (adopt stays standard in v1) |
| Light-tier violations as non-waivable blockers in `check-approval-blockers.sh` | Any change to `harness/` (the CLI already refuses on any blocker) |
| `lint-plan.sh`: `Tier:` validation, the light required-section set, light violations in the blocker section | A model-proposed tier (the Foreman-style classifier from the #81 thread) |
| `/rad-plan --light` mode + light template; tier guidance in `/rad-approve`, `docs/daily-workflow.md`, CLAUDE.md Workflow | Operator-configurable light limits |

## Acceptance Criteria

1. `plan_tier <plan>` prints `light` or `standard`. It reads `Tier:` **only from the header block**, the lines before the first `## ` heading, so a `Tier:` line in a fenced example or later section never changes a plan's tier. It prints `standard` when the header block has no `Tier:` line, and the header's value (trimmed and lower-cased) otherwise. It prints any other value verbatim so the caller can reject it. It returns non-zero with a stderr message for a missing or unreadable plan.
2. `plan_light_violations <plan>` prints nothing for a `standard` plan. For a `light` plan it prints one `light-tier: <reason>` line per violation:
   - more waves than `RAD_LIGHT_MAX_WAVES` (1)
   - more `#### Task` headings than `RAD_LIGHT_MAX_TASKS` (3)
   - each scope path matching the high-risk pattern (shared `plan_high_risk_pattern`)
   - each scope path matching `path_is_self_protected`

   A light plan within every limit prints nothing.
3. `check-approval-blockers.sh` treats every `light-tier` line as a blocker: exit 1, each named on stderr with the promotion hint ("shrink the plan or remove `Tier: light` to make it a standard plan"). A `## Waivers` bullet can't clear it: any waiver id starting with `light-tier` is never applied. A `standard` plan, or a light plan within limits, gets exactly today's result.
4. `lint-plan.sh`:
   - A `Tier:` value other than `light` or `standard` is an **error**.
   - A `light` plan is checked against the light required-section set: missing Context, Acceptance Criteria, Files in Scope, Wave Plan, Tests to Write or Non-Goals is an error; missing Scope, Agent Scope, Execution Notes or Risks isn't.
   - Light-tier violations appear in the `⛔ Approval blockers` section, and lint's exit code stays driven only by `ERRORS`.
   - A plan with no `Tier:` header gives output identical to today's.
5. `/rad-plan` accepts `--light`. It runs a quick scope check (an Explore sub-agent capped at 3 tool calls) instead of the full research step, and **refuses** `--light` with a pointer to standard `/rad-plan` when the change needs more than 1 wave or 3 tasks or touches a high-risk or self-protected path. Otherwise it writes the light template with `Tier: light`, lints it, cuts `rad/<feature>` and commits. It never skips `/rad-approve`. Standard `/rad-plan` behavior is unchanged.
6. `/rad-approve` notes that `light-tier` blockers can't be waived and how to promote a plan. `docs/daily-workflow.md` gives tier guidance: small and low-risk means `--light`, anything else standard, and research and design are per-project. The CLAUDE.md Workflow block lists `/rad-plan --light`.
7. Every `scripts/test-*.sh` passes under `bash` and `/bin/bash` 3.2, and `npm test --prefix harness` passes. Re-linting every existing `.agents/plans/*.md` (none has a `Tier:` header) gives output and exit codes identical to before the change.

## Agent Scope

- Direct reads, confirmed by grep, because no mapper covers this cross-cutting slice:
  - `lint-plan.sh` required fields and sections (`:50-80`), wave and task counting (`:113-139`), and the blocker collectors (`:434-480`)
  - the `check-approval-blockers.sh` `main`/`report_blockers` structure (`:40-102`)
  - `cli.js` optional Execution Notes parsing (`:245-275`, `:376-400`)
  - the `rad-plan.md` Input and Explore step (`:18-92`)
  - `rad-approve.md` Blockers & Waivers (`:130-175`)
  - the CLAUDE.md Workflow block (`:440-450`)
- Earlier in this session `lint-surface-mapper` (architect) mapped the shared helper conventions this plan reuses: `require_readable_plan`, `plan_scope_paths`, `path_is_self_protected`, `plan_high_risk_pattern`, and the bash 3.2 rules.
- Out-of-scope dependencies: none. The author is the architect; `scripts/` and `.claude/` are self-protected.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| scripts/lib/plan-paths.sh | 490-509 | Append `plan_tier`, `plan_light_violations`, `RAD_LIGHT_MAX_WAVES`, `RAD_LIGHT_MAX_TASKS` |
| scripts/test-plan-paths.sh | 530-556 | Append helper cases |
| scripts/check-approval-blockers.sh | 40-102 | Light-tier blockers, never waivable |
| scripts/test-check-approval-blockers.sh | 140-169 | Append light-tier cases |
| scripts/lint-plan.sh | 40-140 | `Tier:` validation; light required-section set |
| scripts/lint-plan.sh | 434-500 | Light violations in the blocker section |
| scripts/test-lint-plan.sh | 820-847 | Append tier cases |
| .claude/commands/team/rad-plan.md | 18-120 | `--light` input handling + quick scope check + refusal |
| .claude/commands/team/rad-plan.md | 190-303 | Light template + rules |
| .claude/commands/architect/rad-approve.md | 125-180 | Light-tier blockers are non-waivable; promotion path |
| docs/daily-workflow.md | 86-133 | Tier guidance |
| CLAUDE.md | 440-450 | Workflow line for `/rad-plan --light` |

## Program Design

### 1. Signatures introduced

```bash
# scripts/lib/plan-paths.sh — new
RAD_LIGHT_MAX_WAVES=1
RAD_LIGHT_MAX_TASKS=3
RAD_LIGHT_BLOCKER_PREFIX='light-tier'
plan_tier <plan>              # stdout: light | standard | <other value verbatim>
plan_light_violations <plan>  # stdout: "light-tier: <reason>" per violation; nothing for standard

# scripts/check-approval-blockers.sh — contract unchanged (exit 0/1/2); one more blocker source
```

```markdown
# Plan: Fix typo in signup email
Created: 2026-10-01
Author: developer
Status: pending-review
Tier: light
Branch: rad/fix-signup-email-typo
```

### 2. Control-flow sketch

```
/rad-plan --light <description>
 ├─ quick scope check (Explore, ≤3 tool calls)
 ├─ fits light limits? ── no ──► refuse: "run standard /rad-plan" (nothing written)
 └─ yes → light template (Tier: light) → lint → cut rad/<feature> → commit

rad approve  (unchanged harness)
 └─ check-approval-blockers.sh
      markers + un-waived high-risk findings            [unchanged]
      + plan_light_violations (never waivable)          ← NEW
      any → exit 1 → rad approve refuses, writes nothing
```

### 3. File-tree diff

```
scripts/lib/plan-paths.sh                 M  +2 helpers, +3 constants
scripts/check-approval-blockers.sh        M  +light-tier blocker source
scripts/lint-plan.sh                      M  Tier validation, light section set, blocker listing
scripts/test-{plan-paths,check-approval-blockers,lint-plan}.sh  M
.claude/commands/team/rad-plan.md, architect/rad-approve.md     M
docs/daily-workflow.md, CLAUDE.md         M
```

## Execution Notes

### Do Not Touch
- harness/** (the CLI already refuses on any blocker script exit 1)
- The marker, high-risk and waiver helpers and `RAD_SELF_PROTECTED_PATTERN` in scripts/lib/plan-paths.sh (call them, don't change them)
- .claude/commands/team/rad-adopt.md (adopt stays standard in v1)

### Key Files
- scripts/lib/plan-paths.sh: `require_readable_plan`, `plan_scope_paths`, `path_matches`, `plan_high_risk_pattern`, `path_is_self_protected`
- scripts/check-approval-blockers.sh: `main`, `report_blockers`, `applied_waivers`
- scripts/lint-plan.sh: `header_field`, `REQUIRED_SECTIONS` (:77), wave/task counting (:113-139), blocker collectors (:434-480)
- scripts/test-lint-plan.sh: `write_plan` and `write_wave_plan` fixtures; the hermetic `GREPO` fixture for any success-line assertion

### Reminders
- **Backward compatibility is the load-bearing invariant.** No `Tier:` header must give byte-identical lint output and blocker-script results. Re-lint every existing plan (AC#7).
- Light-tier blockers must never pass through `applied_waivers`. Add a test that a `- light-tier…:` waiver bullet changes nothing.
- Bash 3.2 / BSD awk: no associative arrays and no `mapfile`. Put a leading `(` on `case` patterns inside `$( … )`. Build the light section set as a separate array literal, never by mutating the standard one.
- If a helper exits non-zero, record an ERROR in lint and exit 2 in the blocker script; never treat a failure as "no violations" (fail closed).
- Any literal `Tier: light` example in prose goes in a fenced block, and so does any example marker.

## Wave Plan

### Wave 1 — sequential
Verify: bash scripts/test-plan-paths.sh && /bin/bash scripts/test-plan-paths.sh && bash scripts/test-check-approval-blockers.sh && /bin/bash scripts/test-check-approval-blockers.sh
Tasks in this wave must run in sequence (the blocker script sources the helpers).

#### Task 1.1: Tier and light-violation helpers
File: scripts/lib/plan-paths.sh:490-509, scripts/test-plan-paths.sh:530-556
What: Append the constants and two helpers, with header comments stating their constraints.
- `plan_tier`: read the first `^Tier:` line in the header block only (stop at the first `^## ` heading), trimmed and lower-cased; `standard` when absent. Don't use `lint-plan.sh`'s whole-file `header_field`.
- `plan_light_violations`:
  - Return immediately for anything other than `light`.
  - Count `### Wave` and `#### Task` headings against the two maximums, emitting `light-tier: N waves (max 1)` and `light-tier: N tasks (max 3)`.
  - For each `plan_scope_paths` entry, emit `light-tier: high-risk path <p>` when it matches `plan_high_risk_pattern`, and `light-tier: self-protected path <p>` when `path_is_self_protected` holds. A path matching both emits both lines.

Both helpers use `require_readable_plan`.
Tests:
- tier: absent, `light`, ` Light `, `standard`, `bogus`, missing plan, and a standard plan whose body has a fenced `Tier: light` example (stays `standard`)
- violations: standard plan with 5 waves gives none; light within limits gives none; 2 waves; 4 tasks; a high-risk path; a self-protected path; a path that is both; missing plan
Validate: AC#1, AC#2 — `bash scripts/test-plan-paths.sh` and `/bin/bash scripts/test-plan-paths.sh` pass.

#### Task 1.2: Light-tier blockers in check-approval-blockers.sh
File: scripts/check-approval-blockers.sh:40-102, scripts/test-check-approval-blockers.sh:140-169
What: In `main`, compute `plan_light_violations` (a helper failure exits 2) and pass it to `report_blockers`, which names each on stderr as `✗ <line> (shrink the plan or remove "Tier: light" to make it a standard plan)` and counts it. It never goes through `applied_waivers`. Tests:
- light within limits: exit 0
- light with 2 waves: exit 1, named
- light with a self-protected path: exit 1
- light with a high-risk path and a matching high-risk waiver: exit 1 (the light-tier blocker stands) and stdout empty
- a `- light-tier: …: reason` waiver bullet has no effect
- a standard plan with 5 waves: exit 0, as today
- a standard plan's results unchanged across every existing case
Validate: AC#3 — `bash scripts/test-check-approval-blockers.sh` and `/bin/bash scripts/test-check-approval-blockers.sh` pass.

### Wave 2 — sequential
Verify: bash scripts/test-lint-plan.sh && /bin/bash scripts/test-lint-plan.sh && for t in scripts/test-*.sh; do bash "$t" >/dev/null || exit 1; done
Tasks in this wave must run in sequence.

#### Task 2.1: Tier handling in lint-plan.sh
File: scripts/lint-plan.sh:40-140, 434-500, scripts/test-lint-plan.sh:820-847
What:
- After the required-field checks, read `plan_tier`. A value other than `light` or `standard` becomes the error `Invalid Tier: '<v>' (expected light or standard)`.
- Choose `REQUIRED_SECTIONS` or a new `LIGHT_REQUIRED_SECTIONS=("Context" "Acceptance Criteria" "Files in Scope" "Wave Plan" "Tests to Write" "Non-Goals")` by tier.
- Add a `collect_light_blockers` beside `collect_marker_blockers` that appends each `plan_light_violations` line to `BLOCKERS`. A helper failure is an ERROR.
- No other behavior changes.

Tests:
- A light plan missing Agent Scope, Execution Notes and Risks: no missing-section errors.
- A light plan missing Context: error.
- `Tier: bogus`: error, exit 1.
- A light plan with 2 waves: blocker section lists `light-tier: 2 waves (max 1)`, exit 0.
- A standard plan missing Agent Scope: still an error.
- A no-header plan: output identical to a copy linted with main's lint, in `GREPO`.

Then re-lint every `.agents/plans/*.md` with the pre-change and post-change lint (using temp copies, not a stash) and confirm the output and exit codes are identical.
Validate: AC#4, AC#7 — `bash` and `/bin/bash` `scripts/test-lint-plan.sh`, every `scripts/test-*.sh` under both shells, `npm test --prefix harness`, and the re-lint report.

### Wave 3 — parallel
Verify: for t in scripts/test-*.sh; do bash "$t" >/dev/null || exit 1; done && npm test --prefix harness
Tasks in this wave can run in parallel (disjoint prose files).

#### Task 3.1: /rad-plan --light mode and light template
File: .claude/commands/team/rad-plan.md:18-120, 190-303
What:
- **Input:** `--light` may prefix the description.
- **Step 2:** under `--light`, replace the full Explore research with a quick scope check. Use an Explore sub-agent capped at 3 tool calls that returns the candidate files and the likely wave and task count.
- **Refusal:** refuse `--light` before writing anything when the change needs more than 1 wave or 3 tasks, or touches a high-risk (`RAD_HIGH_RISK_PATTERNS`) or self-protected path. Name the reason and point to standard `/rad-plan`.
- **Step 3:** add a fenced **light template**. It has the header with `Tier: light`, then Context, Acceptance Criteria, Files in Scope, one `### Wave 1` of 3 tasks or fewer, Tests to Write and Non-Goals (2 or more), with optional Risks.
- **Steps 4-6:** unchanged (lint, cut branch, commit, "waiting for `/rad-approve`").
- **Rules:** a light plan still requires `/rad-approve`; promote a plan by removing `Tier: light` and adding the standard sections.

This task has no unit-testable surface (prompt prose).
Validate: AC#5 — read-through. The fenced light template, copied to a temp plan with real paths, lints with no errors under the new `lint-plan.sh`.

#### Task 3.2: Tier guidance in /rad-approve, daily-workflow and CLAUDE.md
File: .claude/commands/architect/rad-approve.md:125-180, docs/daily-workflow.md:86-133, CLAUDE.md:440-450
What:
- In `/rad-approve`'s Blockers & Waivers guidance: `light-tier` blockers can't be waived. The fix is to shrink the plan or promote it to standard by removing `Tier: light` and adding the standard sections, then re-run.
- In `docs/daily-workflow.md`: a short "Choosing a planning tier" note. Small, single-wave, low-risk work outside RAD's own paths uses `/rad-plan --light`; everything else uses standard. `/rad-research` and `/rad-design` run once per project.
- In the CLAUDE.md Workflow block: add `Team:       /rad-plan --light → same, condensed single-wave plan for small low-risk changes (Tier: light)`.

This task has no unit-testable surface (prompt prose and docs).
Validate: AC#6 — read-through, and the script and harness suites stay green.

## Tests to Write
- [ ] plan_tier: absent / light / mixed-case / standard / bogus / missing — scripts/test-plan-paths.sh
- [ ] plan_light_violations: standard silent, within-limits silent, waves, tasks, high-risk, self-protected, both — scripts/test-plan-paths.sh
- [ ] blocker script: light-tier blockers exit 1, never waivable, standard unchanged — scripts/test-check-approval-blockers.sh
- [ ] lint: light section set, invalid tier, light blockers listed, standard unchanged, no-header parity — scripts/test-lint-plan.sh

## Non-Goals
- `/rad-adopt --light`.
- A model-proposed or automatic tier choice. The invoker picks the tier, and a human approves at Gate 1.
- Configurable light limits (`RAD_LIGHT_*` env vars).
- Any harness change, or any relaxation of `/rad-approve`.
- Letting RAD's own (self-protected) paths use the light tier.

## Out-of-Scope Dependencies
None

## Risks
- **A light path that erodes the gate** is the risk #81 names. Mitigations:
  - approval is never skipped
  - limits are enforced as non-waivable blockers at `rad approve`, not only in `/rad-plan` prose
  - high-risk and self-protected paths are excluded
  - promotion is explicit (remove the header)
- **Backward compatibility.** A bug in tier detection could change lint output for every existing plan. That's why the no-header path must be byte-identical, verified by re-lint (AC#7).
- **The quick scope check can undercount.** A 3-tool-call look may miss files. The limits are re-checked on the written plan at `rad approve`, so an undercount can't slip past the gate; at worst it causes a refusal later.
- **Double blockers** on a light plan with a high-risk path (one waivable, one not) may look redundant. That's intended: it tells the author to promote the plan, not waive it.

## Issue Gaps
- **[DECIDED — architect]** The tier is declared by a `Tier: light` header, with a smaller required-section set. The guardrail is a non-waivable approval blocker. Self-protected paths are excluded.
- **[ASSUMPTION]** The light limits are 1 wave and 3 tasks, matching the existing per-wave task cap, so a light plan is exactly "one wave's worth".
- **[ASSUMPTION]** The quick scope check is an Explore sub-agent capped at 3 tool calls, not zero research. `/rad-plan`'s rule against reading files directly in main context still holds.
- **[ASSUMPTION]** `Scope` becomes optional for light plans. A light plan's Files in Scope and Non-Goals already bound it, and `check-scope.sh` reads only Files in Scope.
- **[ASSUMPTION]** `Tier:` is read only from the header block, before the first `## ` heading, because this plan's own Program Design has a fenced `Tier: light` example that a whole-file read would pick up.
- **[ASSUMPTION]** An unknown `Tier:` value is a lint **error**, not a fallback to standard, so a typo like `Tier: lite` can't quietly produce a standard plan the author believes is light (fail closed).
- **[ASSUMPTION]** `/rad-adopt` stays standard-only in v1. Adopted issues are usually larger, and `## Issue Gaps` needs the full shape.
