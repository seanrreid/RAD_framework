# Plan: RAD Framework v2 — Branch, Approval, and Story Refactor

Created: 2026-05-26
Author: architect
Status: pending-review

## Context

After real-world use in a production project (ThreatCaptain/agentx3), several
friction points emerged with the current framework. Plan branches add Git noise
without adding governance value. The default branch is hardcoded to `main` but
projects use different conventions. The plan artifact is thinner than it should
be — splitting context and the wave plan across two artifacts makes handoff
harder. This plan addresses all three, plus imports two session-ritual skills
from agentx3 that proved useful in practice.

## Scope

| In scope | Out of scope |
|---|---|
| Default branch made configurable via CLAUDE.md | Changing how deliver branches work |
| Remove plan branch + plan PR entirely | Changing the agent scope map format |
| Enrich plan doc with Context, AC, embedded Wave Plan | Project-specific convention checks (BEAKON, etc.) |
| Update all commands to use new approval model | Story numbering systems |
| Add Issue Gaps + intent confirmation to /rad-adopt | Story file paths (projects choose their own) |
| Add AC coverage, execution log, retry cap to /rad-deliver | Design system tooling |
| Import /kickoff and /wrap as generalized skills | |

## Acceptance Criteria

1. `default_branch:` in CLAUDE.md is the authoritative branch — no command hardcodes `main`
2. `/rad-plan` creates no branch and opens no PR — plan file commits directly to default branch
3. `/rad-approve` updates `Status: approved` in the plan file and commits — no branch operations
4. `/rad-deliver` gates on `Status: approved` in the plan file — no branch-merge check
5. Plan document includes Context, Scope, AC, and embedded Wave Plan in one file
6. Every task's `Validate:` field cites a specific AC item; `/rad-review` checks AC coverage
7. `/rad-deliver` creates an execution log in `.agents/logs/` and updates it after every task
8. `/rad-deliver` caps task retries at 2 and escalates to architect on third failure
9. `/rad-deliver` runs `check-tests.sh` before opening the deliver PR
10. `/rad-adopt` confirms its interpretation before writing files and includes a mandatory Issue Gaps section
11. `/kickoff` and `/wrap` skills exist in `.claude/skills/` and work without project-specific references

## Wave Plan

**Status:** pending-review
**Approved-By:** —
**Approved-At:** —

---

### Wave 1 — sequential
Default branch plumbing. Prerequisite for Wave 2.

#### Task 1.1: Create get-default-branch.sh
**File:** `scripts/get-default-branch.sh`
**What:** New script. Reads `default_branch:` value from CLAUDE.md using grep/sed.
Falls back to `main` if the field is missing or empty. Exits 0 with the branch
name on stdout.
**Validate:** AC#1 — script outputs the correct branch for a CLAUDE.md with
`default_branch: develop` and falls back to `main` when the field is absent.

#### Task 1.2: Substitute hardcoded `main` in all commands
**File:** `.claude/commands/team/rad-plan.md`, `.claude/commands/team/rad-deliver.md`,
`.claude/commands/team/rad-adopt.md`, `.claude/commands/architect/rad-approve.md`,
`scripts/open-pr.sh`, `scripts/check-plan-approved.sh`
**What:** Replace every `--base main`, `git checkout main`, and literal `main`
branch reference with `$(scripts/get-default-branch.sh)` or a variable set from it.
**Validate:** AC#1 — grep finds no unguarded literal `main` branch references
in the above files.

---

### Wave 2 — sequential
Depends on: Wave 1 complete.

Remove the plan branch and PR gate. This is the highest-leverage change.

#### Task 2.1: Rewrite /rad-plan — no branch, no PR
**File:** `.claude/commands/team/rad-plan.md`
**What:** Remove Steps 5–6 (branch creation, PR opening, amend-to-record-URL).
After linting passes, commit the plan file directly to the default branch with
`git add .agents/plans/[feature].md && git commit`. Output summary no longer
mentions a PR or branch — just the plan file path and that the architect can
run `/rad-approve`.
**Validate:** AC#2 — command spec contains no `git checkout -b plan/`, no
`scripts/open-pr.sh` call, no `--force-with-lease` push.

#### Task 2.2: Rewrite /rad-approve — file-only, no branch ops
**File:** `.claude/commands/architect/rad-approve.md`
**What:** Remove all `git checkout plan/[feature]` and `git pull origin plan/[feature]`
steps. Read plan file from working tree or default branch via `git show`. After
architect confirms, write updated Status/Approved-By/Approved-At to the file,
commit to default branch (`git add` + `git commit` + `git push`). No branch
created or checked out.
**Validate:** AC#3 — command spec contains no `git checkout plan/`, no plan
branch reference in commit steps.

#### Task 2.3: Simplify check-plan-approved.sh — file status only
**File:** `scripts/check-plan-approved.sh`
**What:** Delete the fallback branch-merge check functions (`check_local`,
`check_github`, `check_gitlab`) and the platform-detect block. Keep only the
file-status check: read `Status:` from the plan file, exit 0 for `approved`,
exit 1 for everything else with a clear message. Update the usage comment.
**Validate:** AC#4 — script exits 0 when plan file has `Status: approved`,
exits 1 for `pending-review`, `needs-revision`, `rejected`.

#### Task 2.4: Update /rad-deliver approval gate
**File:** `.claude/commands/team/rad-deliver.md`
**What:** Replace the plan-branch-merged check with a direct call to the
simplified `check-plan-approved.sh`. Error message should reference
`/rad-approve [feature]` not a PR merge.
**Validate:** AC#4 — deliver command spec calls `check-plan-approved.sh` and
error output does not mention branch or PR.

#### Task 2.5: Deprecate plan branch labels from CLAUDE.md template
**File:** `CLAUDE.md`
**What:** Remove `rad:plan` and `rad:pending-review` from the PR Labels section.
Remove the plan branch convention (`plan branches: plan/[feature-name]`) from
Branch Conventions. Update the Workflow summary to remove the plan-PR step.
**Validate:** AC#2 — CLAUDE.md template no longer instructs users to create
plan-branch labels.

---

### Wave 3 — sequential
Depends on: Wave 2 complete.

Richer plan document format and deliver improvements.

#### Task 3.1: Define new plan document schema in /rad-plan
**File:** `.claude/commands/team/rad-plan.md`
**What:** Update the plan document template in Step 3 to add: a `## Scope`
table (in/out), a `## Acceptance Criteria` numbered list, and convert the
existing `## Wave Plan` section so each task's `Validate:` field cites `AC#N`.
Keep all existing fields (Context, Agent Scope, Files in Scope, Execution Notes,
Non-Goals, Risks).
**Validate:** AC#5, AC#6 — template contains `## Acceptance Criteria` section
and task `Validate:` fields reference `AC#N` format.

#### Task 3.2: Add execution log to /rad-deliver
**File:** `.claude/commands/team/rad-deliver.md`
**What:** After the deliver branch is created (current Step 3), add a step that
creates `.agents/logs/[feature]-[YYYY-MM-DD].md` with a header and an empty
step table. After each task completes, append a row to the table. The deliver
PR body pulls the log table via the existing Step 11 template. Add `.agents/logs/`
to the framework's `.gitignore` note in CLAUDE.md (logs are delivery artifacts,
not committed by default — teams opt in).
**Validate:** AC#7 — deliver command spec creates the log file and references
updating it after each task.

#### Task 3.3: Add retry cap and escalation to /rad-deliver
**File:** `.claude/commands/team/rad-deliver.md`
**What:** Add a Task Failure section (after the per-task execution steps) that
specifies: cap retries at 2 per task; on the third failure, stop and output a
structured escalation notice with the task, AC, issue summary, and what was
tried. Do not continue to the next task or wave.
**Validate:** AC#8 — deliver command spec explicitly states "cap retries at 2"
and defines the escalation output format.

#### Task 3.4: Wire check-tests.sh gate into /rad-deliver
**File:** `.claude/commands/team/rad-deliver.md`
**What:** Before the open-PR step, add a step that calls
`scripts/check-tests.sh [plan-file]`. If it exits non-zero, block PR creation
and output the missing tests. This script already exists — just needs to be
called.
**Validate:** AC#9 — deliver command spec calls `check-tests.sh` before
`open-pr.sh` and blocks on failure.

#### Task 3.5: Add AC coverage check to /rad-review
**File:** `.claude/commands/team/rad-review.md`
**What:** Add a Step: "AC Coverage" that iterates over every AC item in the
plan and verifies at least one task's `Validate:` cites it. Flag any uncovered
AC as HIGH priority. This runs in addition to the existing scope and plan
fidelity checks.
**Validate:** AC#6 — rad-review command spec includes an AC coverage step that
flags uncovered ACs as HIGH.

#### Task 3.6: Add intent confirmation + Issue Gaps to /rad-adopt
**File:** `.claude/commands/team/rad-adopt.md`
**What:** (a) After fetching issue context, add a confirmation step: output a
plain-language interpretation of the issue and ask "Correct? (yes / clarify)"
before writing any files. (b) Add a mandatory `### Issue Gaps` section to the
plan template — lists every assumption made for under-specified issues, or
"None" if the issue was fully specified. Architect verifies gaps at approval.
**Validate:** AC#10 — adopt command spec has a confirmation step before file
creation and plan template includes `### Issue Gaps`.

---

### Wave 4 — parallel (independent of Wave 3)
Depends on: Wave 2 complete.

New session ritual skills.

#### Task 4.1: Create /kickoff skill
**File:** `.claude/skills/kickoff/SKILL.md`
**What:** Generalized session startup skill. Steps: (1) read CLAUDE.md for
project context, (2) check git state and emit branch guard if on default branch,
(3) scan `.agents/plans/` and report plans by status (pending-review = architect
action, approved = ready to execute, in-progress = delivery underway), (4) optionally
run issue triage if `gh`/`glab` is available, (5) ask what to focus on this
session. Output must fit in ~400 words. No project-specific file references.
**Validate:** AC#11 — skill file exists, contains no references to project-
specific artifacts (BEAKON, PENDING.md, MIGRATION_MANIFEST, design system).

#### Task 4.2: Create /wrap skill
**File:** `.claude/skills/wrap/SKILL.md`
**What:** Generalized end-of-session skill. Steps: (1) gather session commits
via `git log`, (2) update plan statuses that changed this session (e.g., mark
in-progress if deliver branch opened, mark review if PR opened), (3) append
a dated progress note to the plan's Notes section if work happened, (4) output
a scannable session summary (done, in-progress, decisions, next session), (5)
flag uncommitted changes and offer to commit. No project-specific file references.
**Validate:** AC#11 — skill file exists, output format is generic, no project-
specific artifacts referenced.

---

### Tests to Write

- [ ] `check-plan-approved.sh` exits 0 for `Status: approved`, exits 1 for all other statuses — `scripts/check-plan-approved.sh`
- [ ] `get-default-branch.sh` returns `develop` when CLAUDE.md has `default_branch: develop` — `scripts/get-default-branch.sh`
- [ ] `get-default-branch.sh` returns `main` when `default_branch:` field is absent — `scripts/get-default-branch.sh`
- [ ] `lint-plan.sh` fails on a plan missing `## Acceptance Criteria` — `scripts/lint-plan.sh`

### Execution Notes

#### Do Not Touch
- `scripts/check-role.sh` — role auth is unrelated to this refactor
- `scripts/check-scope.sh` — scope checking is unrelated
- `scripts/detect-platform.sh` — still used by `open-pr.sh`
- `.claude/commands/shared/` — status and insights commands are unaffected

#### Key Files
- `.claude/commands/architect/rad-approve.md` — primary approval command, central to Wave 2
- `scripts/check-plan-approved.sh` — gate script; Wave 2 strips it to file-status only
- `.claude/commands/team/rad-plan.md` — loses its branch/PR steps in Wave 2, gains richer template in Wave 3
- `CLAUDE.md` — template that all downstream projects copy; changes here affect every new project

#### Reminders
- Wave 1 must land before Wave 2 — commands reference `get-default-branch.sh`
- Wave 3 and Wave 4 can be executed in parallel after Wave 2
- `lint-plan.sh` will need updating in Wave 3 to validate the new AC section format
- Downstream projects (like agentx3) will need to update their copied commands manually — consider a migration note in the release commit message

### Non-Goals

- Migrating existing agentx3 plan files to the new format — that's the downstream project's responsibility
- Changing the deliver branch naming convention (`deliver/[feature]`)
- Adding a story numbering system — projects define their own slugs
- Automating migration for teams already using the framework
- Changing how `/rad-design` generates the Agent Scope Map

### Out-of-Scope Dependencies

None — all changes are within the framework's own command and script files.

---

## Notes

*(Add during execution)*
