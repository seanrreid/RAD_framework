# Plan: Housekeeping Batch
Created: 2026-09-25
Author: architect
Status: complete
Completed-At: 2026-09-25T16:53:06Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-09-25T16:38:10.946Z
Recorded-By: sean@torchcodelab.com
Branch: rad/housekeeping-batch
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/88
Issue-Title: Prune stale .claude/skills/: rpi-design survived its absorption into /rad-research + /rad-design

## Context

This plan batches three low-risk issues and one docs fix. It closes #88, #92 and
#47.

- **#88.** `.claude/skills/rpi-design/` (7 files, about 1,000 lines) survived its absorption into `/rad-research` + `/rad-design`. It is a live skill whose description competes with `/rad-design`, and its `03-implement.md` describes implementing without going through Gate 2. References remain at `install.sh:144` and `README.md:123,175`. `install.sh --upgrade` copies with `cp -r`, which never deletes, so existing installs would keep the stale skill even after it's removed from the repo. `kickoff` and `wrap` were audited and are consistent, except that `wrap/SKILL.md:33` suggests `Status: review`, which `rad-status.sh` has no icon for.
- **#92.** Research artifacts are invisible. `scripts/rad-status.sh` collects only `.agents/plans/`, `/kickoff` delegates to it, and the research `Status:` header has no reader. `/rad-research` writes `pending-design` unconditionally, even for work headed to `/rad-plan`, and `pending-plan` / `parked` exist only as hand-edits.
- **#47.** `docs/rad-wave-contract.md` is interface-only. It doesn't record which reasons for wave decomposition are permanent (outcome checkpointing) and which will depreciate (context fitting).
- **Docs.** `docs/case-vs-rad.md:77` and `docs/harness-engineering-vs-rad.md:112` still say "in review as #123", which has since merged.

## Scope

| In scope | Out of scope |
|---|---|
| Delete `.claude/skills/rpi-design/` and its references; `install.sh --upgrade` removes a stale copy | Salvaging `rpi-design` templates into `/rad-design` (it has no equivalent consumer) |
| `rad-status.sh`: a Research (pre-plan) section from branch tips, the base branch and the local tree; an icon for `review` | Having `/rad-design` or `/rad-plan` advance a research artifact's `Status:` |
| `/kickoff` reports research with the next command for each status | Implementing `rad-status.sh --json` (parsed but unused) |
| The research status vocabulary defined, with `/rad-research` setting it by consumer | Stale-research detection after N sessions (#92's open question) |
| A "Why waves" section in `rad-wave-contract.md`, linking existing rationale | Changing wave execution behaviour (#47 is documentation only) |
| Fix the two "in review as #123" lines | Other doc refreshes |

## Acceptance Criteria

1. `.claude/skills/rpi-design/` no longer exists. `install.sh`, `README.md` and the rest of the repo contain no `rpi-design` reference (the `harness/package-lock.json` hash false positive excepted).
2. `install.sh --upgrade` removes a pre-existing `<target>/.claude/skills/rpi-design/` and removes nothing else. The removal is limited to that exact path and logged.
3. `scripts/rad-status.sh` prints a "Research (pre-plan)" section listing each `.agents/research/*.md` (excluding `README.md`) with its slug, `Status:` and source (branch tip, base branch or local), deduped with the same source priority as plans. Artifacts with status `pending-design` or `pending-plan` show their next command (`/rad-design <slug>` or `/rad-plan <slug>`), `parked` ones are listed without a hint, and when there are none the section says so explicitly. A plan with `Status: review` renders with a dedicated icon.
4. A new `scripts/test-rad-status.sh` covers research found on a `rad/` branch tip only, on the base branch only, a slug present on both (branch tip wins), `README.md` exclusion, the `parked` no-hint case, the empty-state line, and the `review` icon. It passes under bash and `/bin/bash` 3.2.
5. `/kickoff` step 3 and its brief template include a Research (pre-plan) group with the next command for each status. `/rad-research` documents the allowed values (`pending-design`, `pending-plan`, `parked`) and sets `pending-plan` when the artifact feeds `/rad-plan` directly, or `pending-design` when it feeds `/rad-design`.
6. `docs/rad-wave-contract.md` has a "Why waves" section separating outcome-checkpointing properties (permanent: the event per wave, the matrix stop conditions, the budget breakers, resume) from context-fitting properties (depreciating: the forced fresh context per wave, ~50% sizing). It links `docs/wave-execution.md` rather than duplicating it, and states that no behaviour changes.
7. Neither `docs/case-vs-rad.md` nor `docs/harness-engineering-vs-rad.md` says "in review as #123". Every `scripts/test-*.sh` passes, `scripts/lint-shell-safety.sh` reports no new findings, and `npm test --prefix harness` passes.

## Agent Scope

No agents were called. Research was one Explore sub-agent (8 of 10 searches)
covering the `rpi-design` tree and its references, `install.sh`, the `kickoff` and
`wrap` skills, `rad-status.sh` and its test coverage, `/rad-research` and
`/rad-design`, the current research artifacts, and the wave docs.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| .claude/skills/rpi-design/SKILL.md | delete | Remove stale skill |
| .claude/skills/rpi-design/phases/01-research.md | delete | Remove stale skill |
| .claude/skills/rpi-design/phases/02-plan.md | delete | Remove stale skill |
| .claude/skills/rpi-design/phases/03-implement.md | delete | Remove stale skill |
| .claude/skills/rpi-design/templates/compaction-template.md | delete | Remove stale skill |
| .claude/skills/rpi-design/templates/diagram-template.md | delete | Remove stale skill |
| .claude/skills/rpi-design/templates/readme-template.md | delete | Remove stale skill |
| install.sh | 130-150 | Drop the `rpi-design` info line; remove a stale copy on upgrade |
| README.md | 115-180 | Drop the `/rpi-design` roles row and tree entry |
| scripts/rad-status.sh | 35-230 | `collect_research` plus a Research (pre-plan) render section; `review` icon |
| scripts/test-rad-status.sh | new | Fixture tests for research collection and the `review` icon |
| scripts/lint-shell-safety-baseline.txt | 1-40 | Update only if the `rad-status.sh` edit legitimately shifts a baselined line |
| .claude/skills/kickoff/SKILL.md | 40-100 | Research (pre-plan) group in step 3 and the brief template |
| .claude/commands/team/rad-research.md | 140-190 | Status vocabulary; set by consumer |
| docs/rad-wave-contract.md | 1-30 | A "Why waves" section after the intro |
| docs/case-vs-rad.md | 77 | Remove "in review as" |
| docs/harness-engineering-vs-rad.md | 112 | Remove "in review as" |

## Execution Notes

### Do Not Touch
- `harness/**`: nothing here needs it.
- `.claude/commands/architect/rad-design.md` and `.claude/commands/team/rad-plan.md`: status advancement is out of scope.
- `.claude/skills/wrap/SKILL.md`: the `review` mismatch is fixed on the `rad-status.sh` side instead.
- `.agents/research/*.md`: existing artifacts are reported as they are, not rewritten.
- `scripts/check-scope.sh`: `.agents/research/` scope-exemption is unrelated.

### Key Files
- `scripts/rad-status.sh`: `collect_plans` (three passes: branch tips, origin/base, local; `SEEN_FEATURES` string-set dedupe; `emit_plan_row`) and the Active Plans render with its status-icon `case`.
- `scripts/test-script-hardening.sh` (#3) and `scripts/test-check-plan-approved.sh`: temp-repo fixture patterns (use `mktemp -d "${HOME}/.rad-test-…XXXXXX"` to avoid the macOS `/var` symlink quirk; copy `rad-status.sh`, `get-default-branch.sh` and `detect-platform.sh`).
- `install.sh`: `copy_skills` (wholesale `cp -r`) and the per-item `info` lines.
- `.claude/skills/kickoff/SKILL.md`: step 3 grouping and the brief template's `## Plans` block.
- `.claude/commands/team/rad-research.md`: the artifact template's `Status:` line.
- `docs/wave-execution.md`: the rationale to link ("What waves are", fresh context per wave, ~50% sizing, "the log is the checkpoint").

### Reminders
- `rad-status.sh` must stay bash-3.2-safe (no associative arrays, `mapfile` or globstar). Use a separate `SEEN_RESEARCH` string set. On branch tips, list research with `git ls-tree origin/<branch> -- .agents/research`, because a research slug need not match its branch's feature.
- On a research-only `rad/` branch (no plan file), the research must still appear. That's the exact #92 repro.
- The upgrade cleanup must be exact-path only (`"$TARGET_DIR/.claude/skills/rpi-design"`), guarded against an empty `TARGET_DIR`, and logged. Never a glob.
- `.claude/` and `scripts/` are self-protected, so this plan is never auto-clearable.
- Tests to Write descriptions must not contain em-dashes except before the path.

## Wave Plan

### Wave 1 — parallel
Verify: bash scripts/test-rad-status.sh && bash scripts/test-script-hardening.sh && bash scripts/test-bash32-parse.sh && bash scripts/lint-shell-safety.sh

Three independent tasks in disjoint files.

#### Task 1.1: Remove the rpi-design skill and its references
File: .claude/skills/rpi-design/SKILL.md, install.sh, README.md
What: `git rm -r .claude/skills/rpi-design/` (all 7 files). In `install.sh`: remove the `rpi-design` `info` line in `copy_skills`, and in the upgrade path remove `"$TARGET_DIR/.claude/skills/rpi-design"` if it exists. Use that exact path, guard `TARGET_DIR` as non-empty, and log `removed stale skill: rpi-design`. In `README.md`: drop the `/rpi-design` roles-table row and the tree entry. Then grep the repo for `rpi-design` and confirm the only hit is the `harness/package-lock.json` hash. Exercise the upgrade path against a temp target containing a fake `.claude/skills/rpi-design/` plus a sibling `.claude/skills/keep-me/`: the first is removed and the sibling survives.
Validate: AC#1, AC#2 — the grep shows no references; the temp-target upgrade run removes only `rpi-design`; `bash -n install.sh` passes.

#### Task 1.2: Research visibility in rad-status.sh
File: scripts/rad-status.sh:35-230, scripts/test-rad-status.sh, scripts/lint-shell-safety-baseline.txt
What: Add `collect_research` mirroring `collect_plans`'s three passes, with the same source priority. On branch tips, `git ls-tree` `.agents/research` for every `origin/${PREFIX}*` branch; then `origin/<base>`; then the local tree. Exclude `README.md`, dedupe via `SEEN_RESEARCH`, and emit `slug|status|source`. Render a "── Research (pre-plan) ──" section after Active Plans. `pending-design` shows `Next: /rad-design <slug>`, `pending-plan` shows `Next: /rad-plan <slug>`, `parked` is listed without a hint, any other value is listed as is, and no artifacts prints `(no research artifacts)`. Add a `review` case to the plan status-icon map. New `scripts/test-rad-status.sh` builds a temp origin + clone fixture covering: research on a `rad/` branch tip that has no plan file (the #92 repro); research on base only; the same slug on both (branch tip wins); `README.md` excluded; `parked` with no hint; the empty state; a `review` plan icon. Run under bash and `/bin/bash`. Update the shell-safety baseline only if a baselined line legitimately moved, with the reason in the commit message.
Validate: AC#3, AC#4 — `bash scripts/test-rad-status.sh` and `/bin/bash scripts/test-rad-status.sh` pass; `bash scripts/test-script-hardening.sh` passes; `bash scripts/lint-shell-safety.sh` reports no new findings.

#### Task 1.3: Wave rationale and docs wording
File: docs/rad-wave-contract.md, docs/case-vs-rad.md, docs/harness-engineering-vs-rad.md
What: In `docs/rad-wave-contract.md`, between the intro and "The adapter interface", add "## Why waves: outcome-checkpointing vs context-fitting". It has two short lists: **permanent** (one recorded outcome per wave against the frozen matrix, stop conditions, the token/attempt breakers, resume from `wave-complete`, per-wave `Verify:` and `Model:`) and **depreciating** (a forced fresh agent context per wave, ~50%-context task sizing). It states that if a future model could run a whole plan in one context, only the forced reset becomes optional. Link `docs/wave-execution.md` sections instead of restating them, cross-link #46, and say explicitly that nothing about execution changes. In the two comparison docs, change "(in review as [#123](…))" to "([#123](…))".
Validate: AC#6, AC#7 — the section exists with both lists and the links; `grep -n "in review as" docs/*.md` finds nothing.

### Wave 2 — sequential
Depends on: Wave 1 complete (the kickoff wording follows the `rad-status.sh` output format)
Verify: bash scripts/rad-status.sh >/dev/null && npm test --prefix harness

#### Task 2.1: Kickoff reporting and research status vocabulary
File: .claude/skills/kickoff/SKILL.md, .claude/commands/team/rad-research.md
What: In `kickoff/SKILL.md` step 3, add a Research (pre-plan) group read from `rad-status.sh`'s new section: `pending-design` leads to `/rad-design <slug>`, `pending-plan` to `/rad-plan <slug>`, and `parked` is listed only. Add a `## Research` block after `## Plans` in the brief template. In `rad-research.md`, document the allowed `Status:` values (`pending-design` means it feeds `/rad-design`; `pending-plan` means it feeds `/rad-plan` directly; `parked` means it's deliberately deferred). Change the template so the status is chosen by the artifact's intended consumer rather than hard-coded to `pending-design`. Note that `rad-status.sh` is the first reader.
Validate: AC#5, AC#7 — both files state the vocabulary and the next command per status; a live `bash scripts/rad-status.sh` shows the research section with the current artifacts; `npm test --prefix harness` passes.

## Tests to Write
- [ ] research on a rad branch tip with no plan file is listed with its next command — scripts/test-rad-status.sh
- [ ] base-only research listed; same slug on branch tip and base dedupes to the branch tip — scripts/test-rad-status.sh
- [ ] README excluded, parked listed without a hint, empty state prints its line — scripts/test-rad-status.sh
- [ ] a plan with Status review renders with its own icon — scripts/test-rad-status.sh

## Non-Goals
- Advancing a research artifact's status from `/rad-design` or `/rad-plan`.
- Implementing `rad-status.sh --json`.
- Stale-research detection.
- Any change to wave execution behaviour.

## Out-of-Scope Dependencies
None. Every file is architect-writable.

## Risks
- **`install.sh` upgrade deletion.** It's deleting user files, so it's exact-path only, guarded against an empty target, logged, and tested with a sibling skill that must survive.
- **`rad-status.sh` output change.** `/kickoff` and any human reader see a new section. There is no machine consumer of the text output (`--json` is unimplemented), so nothing parses it.
- **Shell-safety baseline.** Editing `rad-status.sh` may shift baselined line numbers. Update it only for legitimate moves, never to hide a new finding.
- **Removing a skill someone still invokes by habit.** `/rad-research` + `/rad-design` replace it. The README change makes that explicit.

## Issue Gaps

- **No salvage from `rpi-design/templates/`.** #88 says salvage anything `/rad-design` should own before deleting. `/rad-design` has no diagram, README or compaction guidance, and none of the three templates has a RAD consumer. *Verify: agree, or keep the hierarchy diagram template as an optional hint in `/rad-design`?*
- **An upgrade cleanup was added.** #88 didn't mention that `install.sh --upgrade` never deletes files. Without the cleanup, every existing install keeps the stale skill. *Verify: exact-path removal on upgrade is acceptable?*
- **`kickoff`/`wrap` audit result: keep both.** The only mismatch (`wrap` suggesting `Status: review`) is fixed by teaching `rad-status.sh` the `review` status, not by editing `wrap`. *Verify: agree `review` is a real plan status worth an icon?*
- **Research status is defined and made visible, but still not advanced by any command.** #92 recommendation 3 is interpreted as "define the vocabulary, have `/rad-research` set it correctly, and make `rad-status.sh` the first reader". Transitions in `/rad-design` and `/rad-plan` are left out. *Verify: file a follow-up for status transitions?*
- **#47 gets documentation only**, as the issue itself proposes ("No behavior change now").
