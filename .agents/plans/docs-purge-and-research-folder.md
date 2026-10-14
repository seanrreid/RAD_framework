# Plan: Purge Stale Docs and Move Reference Material to docs/research
Created: 2026-10-14
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-14T13:51:02.926Z
Recorded-By: sean@torchcodelab.com
Branch: rad/docs-purge-and-research-folder
Tier: light
Source-Author: none (no source issue)
Source-Comments: none

## Context
The docs folder mixes guidance a user needs (install, configuration, workflow) with one-time history and outside-reading notes. Five files describe work that is finished or never started (two May 2026 v2 plans under `plans/`, `docs/harness-audit.md`, `docs/discovery-interactive-evaluation.md`, `docs/behavior-map-deliver-gate.md`); they stay recoverable in git history. Seven more are comparisons and syntheses of other projects (`wsd-vs-rad`, `flue-vs-rad`, `cosmos-vs-rad`, `case-vs-rad`, `harness-engineering-vs-rad`, `harness-design-long-running-apps`, `12-factor-agents`): useful reading, not instructions. `docs/plan-pr-guide.md` still carries a name for a PR that RAD removed. The README docs table lists only 19 of 36 docs.

Measured on 2026-10-14 (grep of the whole repo outside `.agents/logs`, `.agents/plans` and `.agents/state`): none of the deleted files is referenced by code, scripts, tests or generated skills. Their only inbound links are `docs/rad-decisions.md:11`, `docs/harness-state-store.md:4-5` and each other. `docs/agent-hierarchy-audit.md` IS referenced by the `rad-design` skill in three generated copies, and `docs/acp-evaluation.md` by `docs/rad-wave-contract.md`, so both stay where they are.

## Acceptance Criteria
1. **Purged.** These five paths no longer exist: `plans/rad-v2-branch-approval-story-refactor.md`, `plans/rad-v2-lane-b-branch-canonical.md`, `docs/harness-audit.md`, `docs/discovery-interactive-evaluation.md`, `docs/behavior-map-deliver-gate.md`. The `plans/` directory is gone.
2. **Moved with history.** The seven reference docs listed in Context exist under `docs/research/` (moved with `git mv`) and not in `docs/`. A new `docs/research/README.md` of at most 25 lines says what the folder is (outside comparisons and reading notes, not guidance) and lists the seven files.
3. **Renamed.** `docs/plan-pr-guide.md` is `docs/plan-approval-guide.md`, and every reference to the old name (README, `docs/how-it-works.md`, `docs/architect-guide.md`) points at the new one.
4. **No dead links.** Every relative markdown link in `README.md`, `INSTALL.md`, `UPGRADE.md` and `docs/**/*.md` resolves to a file that exists. Links inside the moved files use `../` where they leave `docs/research/`. `docs/rad-decisions.md:11` points at `docs/harness-and-framework.md` instead of `harness-audit.md`, and `docs/harness-state-store.md` no longer cites the deleted audit as a companion or a branch.
5. **Docs table is complete.** The README Docs table lists every file in `docs/` (top level) and the `docs/research/` folder, each with a one-line "read when", and no row names a file that does not exist.
6. **Nothing else changes.** `git diff --stat` shows only the paths in Files in Scope and this plan; no `scripts/`, `harness/`, `.claude/`, `.rad/` or `.agents/skills/` file is touched, and `docs/agent-hierarchy-audit.md` and `docs/acp-evaluation.md` are unchanged.

## Files in Scope
<!-- Deleted files and pure moves are declared by path with a one-line range; their bodies are not read or edited, except the link lines named in the Change column. -->
| File | Lines | Change |
|------|-------|--------|
| plans/rad-v2-branch-approval-story-refactor.md | 1 | Delete |
| plans/rad-v2-lane-b-branch-canonical.md | 1 | Delete |
| docs/harness-audit.md | 1 | Delete |
| docs/discovery-interactive-evaluation.md | 1 | Delete |
| docs/behavior-map-deliver-gate.md | 1 | Delete |
| docs/rad-decisions.md | 11 | Point the harness decision at `docs/harness-and-framework.md` |
| docs/harness-state-store.md | 3-6 | Remove the deleted audit as a companion and branch |
| docs/wsd-vs-rad.md | 1 | Move to docs/research/wsd-vs-rad.md |
| docs/research/wsd-vs-rad.md | 1-8, 345-350 | Destination; fix `references.md` and `cosmos-vs-rad.md` links |
| docs/flue-vs-rad.md | 1 | Move to docs/research/flue-vs-rad.md |
| docs/research/flue-vs-rad.md | 1-8 | Destination; fix `references.md` link |
| docs/cosmos-vs-rad.md | 1 | Move to docs/research/cosmos-vs-rad.md |
| docs/research/cosmos-vs-rad.md | 1-8, 108-114 | Destination; fix `references.md` link, drop the deleted discovery doc link |
| docs/case-vs-rad.md | 1 | Move to docs/research/case-vs-rad.md |
| docs/research/case-vs-rad.md | 1-8 | Destination; links stay sibling-relative |
| docs/harness-engineering-vs-rad.md | 1 | Move to docs/research/harness-engineering-vs-rad.md |
| docs/research/harness-engineering-vs-rad.md | 1-14 | Destination; `harness-and-framework.md` becomes `../harness-and-framework.md` |
| docs/harness-design-long-running-apps.md | 1 | Move to docs/research/harness-design-long-running-apps.md |
| docs/research/harness-design-long-running-apps.md | 1-25 | Destination; drop any link to the deleted discovery doc |
| docs/12-factor-agents.md | 1 | Move to docs/research/12-factor-agents.md |
| docs/research/12-factor-agents.md | 1-10 | Destination; no internal links expected |
| docs/research/README.md | 1-25 | New index of the folder |
| docs/references.md | 43, 78, 100, 176, 202 | Link targets become `research/<file>` |
| docs/plan-pr-guide.md | 1 | Rename to docs/plan-approval-guide.md |
| docs/plan-approval-guide.md | 1-8 | Destination; intro text only if it names the old file |
| docs/how-it-works.md | 263 | Link to the new guide name |
| docs/architect-guide.md | 182 | Reference to the new guide name |
| README.md | 206-232 | Docs table: complete, with research folder |

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence.
Verify: none (documentation only; Task 1.3 runs the link check and the path diff)

#### Task 1.1: Purge the finished and abandoned docs
File: plans/rad-v2-branch-approval-story-refactor.md:1, plans/rad-v2-lane-b-branch-canonical.md:1, docs/harness-audit.md:1, docs/discovery-interactive-evaluation.md:1, docs/behavior-map-deliver-gate.md:1, docs/rad-decisions.md:11, docs/harness-state-store.md:3-6
What: `git rm` the five files (the `plans/` directory then disappears). In `docs/rad-decisions.md:11` replace the pointer to `docs/harness-audit.md` with `docs/harness-and-framework.md`. In `docs/harness-state-store.md` remove only the `Branch:` and `Companion to:` header lines that cite the audit; leave every other line.
Validate: AC#1, AC#4 — the five paths are absent; `grep -rn "harness-audit\|discovery-interactive\|behavior-map-deliver" README.md INSTALL.md UPGRADE.md docs` finds nothing except links inside files about to move (Task 1.2 fixes those).

#### Task 1.2: Move the reference docs to docs/research
File: docs/wsd-vs-rad.md:1, docs/research/wsd-vs-rad.md:1-8, docs/flue-vs-rad.md:1, docs/research/flue-vs-rad.md:1-8, docs/cosmos-vs-rad.md:1, docs/research/cosmos-vs-rad.md:1-8, docs/case-vs-rad.md:1, docs/research/case-vs-rad.md:1-8, docs/harness-engineering-vs-rad.md:1, docs/research/harness-engineering-vs-rad.md:1-14, docs/harness-design-long-running-apps.md:1, docs/research/harness-design-long-running-apps.md:1-25, docs/12-factor-agents.md:1, docs/research/12-factor-agents.md:1-10, docs/research/README.md:1-25, docs/references.md:43, docs/references.md:78, docs/references.md:100, docs/references.md:176, docs/references.md:202
What: `git mv` each of the seven docs into `docs/research/`. Fix links that now leave the folder (`references.md` and `harness-and-framework.md` become `../…`; sibling links stay as they are; remove the link to the deleted discovery doc from `cosmos-vs-rad.md` and `harness-design-long-running-apps.md`). Update the five `docs/references.md` links to `research/<file>`. Write `docs/research/README.md`: two sentences saying the folder holds outside comparisons and reading notes, not instructions, then a bullet per file with a one-line description taken from that file's first paragraph.
Validate: AC#2, AC#4 — `git status` shows seven renames (not delete + add); the seven names are absent from `docs/` top level.

#### Task 1.3: Rename the approval guide, complete the docs table, check links
File: docs/plan-pr-guide.md:1, docs/plan-approval-guide.md:1-8, docs/how-it-works.md:263, docs/architect-guide.md:182, README.md:206-232
What: `git mv docs/plan-pr-guide.md docs/plan-approval-guide.md` and update the three references. Rewrite the README Docs table so it lists every top-level file in `docs/` plus the `docs/research/` folder, one "read when" line each (reuse the existing wording where a row already exists; drop rows for moved docs and list the folder once). Then run a link check over `README.md`, `INSTALL.md`, `UPGRADE.md` and `docs/**/*.md` (resolve each relative `](path)` against the file's directory, ignore `http` and `#`-only links) and fix any miss. Finish with `git diff --stat main...HEAD`.
Validate: AC#3, AC#4, AC#5, AC#6 — the link check prints no missing target; every `docs/*.md` filename appears in the README table; the diff stat lists only the Files in Scope paths.

## Tests to Write
- None. Documentation and file moves only; the link check and the path diff in Task 1.3 are the verification.

## Non-Goals
- Editing the content of the moved comparison docs beyond link targets
- Moving or editing `docs/agent-hierarchy-audit.md` (the `rad-design` skill cites it from self-protected generated files) or `docs/acp-evaluation.md` (cited by `rad-wave-contract.md`)
- Auditing `docs/rad-cli.md` and the other large reference docs for stale content
- Changing `install.sh`, any script, or any generated file

## Risks
- Links in `.agents/plans/` and `.agents/logs/` history may still name moved or deleted docs; those are records of past work and are not edited.
- A relative link written in a form the link check does not parse (reference-style or multi-line) could be missed; the executor should also grep each moved filename across the repo once more.
