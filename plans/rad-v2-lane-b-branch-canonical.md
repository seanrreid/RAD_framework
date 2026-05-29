# Plan: RAD Framework v2 — Lane B (Branch-Canonical Approval)

Created: 2026-05-29
Author: architect
Status: approved
Approved-By: Sean R Reid
Approved-At: 2026-05-29
Supersedes: plans/rad-v2-branch-approval-story-refactor.md

## Context

After production use in ThreatCaptain/agentx3, the framework needs a v2 that
fixes three things at once: (1) the approval artifact model fights protected
default branches, (2) the dedicated plan PR adds Git ceremony without governance
value, and (3) the plan document is thinner than it should be.

The earlier v2 plan answered (1) by committing the plan file **directly to the
default branch** (Lane A). That is wrong for our setup: the default branch is
protected, and we explicitly want to keep multiple contributors from committing
to it outside a reviewed PR. agentx3 proved the opposite model in production —
**Lane B**: the plan document is canonical at its **work-branch tip**, approval
is recorded on that branch, and the default branch receives the plan + code only
via the single reviewed **deliver PR**. Nothing touches the protected branch
except a merge.

This plan adopts Lane B, generalized away from agentx3's story-specific idioms
(`docs/stories/S-{N}-{slug}.md`, `pnpm stories`, Handbook reading order,
`/story-prep`) back onto the framework's existing generic units
(`.agents/plans/[feature].md`, work branches). It folds in the orthogonal
improvements from the superseded plan.

### Lane B in one paragraph

`/rad-plan` creates one work branch per feature, writes the plan doc, commits and
pushes it — **no PR**. `/rad-approve` checks out that branch tip, sets
`Status: approved`, commits and pushes to the **same branch** — **never** the
default branch. `/rad-deliver` checks out that same branch tip, gates on the
branch-tip status, executes waves committing code to the branch, then opens the
**one** PR (work branch → default branch). The plan doc and the code reach the
default branch together, through review.

## Scope

| In scope | Out of scope |
|---|---|
| Single configurable work-branch prefix; one branch per feature lifecycle | A story numbering system (projects keep their own slugs) |
| Branch-tip-canonical reads via new `checkout-plan.sh` | Importing agentx3 story tooling (`/story-prep`, `pnpm stories`) |
| Configurable `default_branch` — no command hardcodes `main` | Changing the agent scope map format |
| Remove the dedicated plan PR; deliver PR is the sole gate to default branch | Changing how `/rad-design` generates scope maps |
| Simplify `check-plan-approved.sh` to branch-tip-first, platform-agnostic | Project-specific convention checks |
| `--on-behalf-of` proxy approval + `check-role.sh` identity-override | Auto issue-to-branch pipelines (agentx3 "RAD Auto") |
| `rad-label.sh` status mirror + branch-tip board in `rad-status.sh` | Design-system / Figma tooling |
| Richer plan doc (Scope, AC); execution log; retry cap; AC coverage | Migrating agentx3's own files (downstream's responsibility) |
| Issue Gaps + intent confirmation in `/rad-adopt`; `/kickoff` + `/wrap` | |
| Update all docs/templates to the Lane B model | |

## Acceptance Criteria

1. `default_branch:` in CLAUDE.md is authoritative — no command or script hardcodes `main`.
2. A single configurable work-branch prefix (default `rad/`) governs the whole feature lifecycle (plan → approve → deliver); `plan/` and `deliver/` are retired. The branch name is recorded in the plan doc's `Branch:` header and regex-validated wherever a step operates on it.
3. `/rad-plan` cuts the `rad/[feature]` work branch from the default branch, records it in the plan header, commits + pushes the plan doc, and opens **no PR** (no `open-pr.sh`, no `rad:plan` plan-PR labels).
4. `/rad-approve` records approval on the **work-branch tip** and never commits to the default branch; the rad-approve description and steps agree (no "commits to main" contradiction).
5. `/rad-deliver` gates on the work-branch-tip `Status: approved` and opens exactly one PR (work branch → default branch), carrying both plan doc and code.
6. `check-plan-approved.sh` reads the work-branch tip first, is platform-agnostic (no `gh`/`glab` PR-merge dependency), and exits 0 only for `approved`.
7. `checkout-plan.sh` fetches and fast-forwards to the work-branch tip, regex-validating the branch name against the configured prefix and failing loudly on a missing, malformed, or diverged branch.
8. `/rad-approve --on-behalf-of "<architect>" --evidence "<cite>"` records a proxy approval: the named approver is validated as a configured architect, evidence is mandatory, and `Approved-By` (architect) and `Recorded-By` (runner) are stored separately.
9. `check-role.sh` accepts an optional identity-override argument and validates it instead of the running git user; with no override, behavior is unchanged.
10. `rad-label.sh` mirrors a plan's status onto its issue/PR as a single `rad:<status>` label, and no-ops cleanly when `gh` is unavailable.
11. `rad-status.sh` aggregates plans from **work-branch tips** (not just the working tree), so it shows plans authored on other contributors' branches.
12. The plan document includes `## Scope` and `## Acceptance Criteria`; every task's `Validate:` field cites a specific `AC#N`.
13. `/rad-deliver` writes an execution log under `.agents/logs/`, caps task retries at 2 with architect escalation on the third failure, and runs `check-tests.sh` before opening the deliver PR.
14. `/rad-review` flags any AC item not covered by at least one task `Validate:` as HIGH priority.
15. `/rad-adopt` confirms its interpretation before writing files and includes a mandatory `### Issue Gaps` section.
16. `/kickoff` and `/wrap` skills exist and contain no project-specific references.
17. All docs/templates describe the Lane B model — no doc instructs users to open or merge a plan PR.

## Branch Model (resolved)

Validated against agentx3's production model and adapted to the framework's
generic units:

- **One namespaced prefix, cradle-to-grave: `rad/[feature]`.** A single branch
  carries the plan doc → approval → code, and is the head of the one deliver PR.
  Today's `plan/` and `deliver/` prefixes are **retired** (agentx3 retired its
  equivalents for the same reason). `rad/` is neutral, namespaced, and avoids the
  "delivery code on a `plan/` branch" confusion and the gitflow `feature/`
  collision. The prefix is configurable in CLAUDE.md; `rad/` is the default.
- **Branch cut at creation.** `/rad-plan` (and `/rad-adopt`) cut `rad/[feature]`
  from the default branch and commit the plan doc there — **never** to the
  default branch. Later steps operate on the existing branch and never cut a new
  one. (agentx3 cuts at `/story-create`; the framework's first artifact step is
  `/rad-plan`.)
- **Branch name recorded and validated.** The plan doc header carries a
  `Branch:` field; `checkout-plan.sh` and `/rad-deliver` regex-validate it
  (`^rad/[a-z0-9][a-z0-9-]*$`) and hard-stop on a missing/old name rather than
  cutting a new branch.

---

## Wave Plan

**Status:** pending-review
**Approved-By:** —
**Approved-At:** —

---

### Wave 1 — sequential
Branch-model foundation. Prerequisite for everything else.

#### Task 1.1: Create get-default-branch.sh
**File:** `scripts/get-default-branch.sh`
**What:** New script. Reads `default_branch:` from CLAUDE.md (grep/sed); falls
back to `main` if absent/empty. Prints the branch name on stdout, exit 0.
**Validate:** AC#1 — returns `develop` for a CLAUDE.md with `default_branch: develop`, and `main` when the field is absent.

#### Task 1.2: Create checkout-plan.sh (generalized from agentx3 checkout-story.sh)
**File:** `scripts/checkout-plan.sh`
**What:** New script. Given a work branch, regex-validate the name against the
configured prefix (`^rad/[a-z0-9][a-z0-9-]*$` for the default) before touching
git, then `git fetch origin <branch>` (fail loudly if missing), check out a
tracking branch, `git pull --ff-only` (fail loudly on divergence). This is the
single safe "read/write a plan against its tip" idiom shared by `/rad-plan`,
`/rad-approve`, `/rad-deliver`. (Direct generalization of agentx3's
`checkout-story.sh`, swapping the `story/S-{N}-{slug}` contract for `rad/`.)
**Validate:** AC#7 — rejects a malformed name; fails on a non-existent branch and on a diverged local branch; succeeds by leaving the working tree at the remote tip.

#### Task 1.3: Replace hardcoded `main` everywhere
**File:** `scripts/open-pr.sh`, `scripts/check-plan-approved.sh`, `.claude/commands/team/rad-plan.md`, `.claude/commands/team/rad-deliver.md`, `.claude/commands/team/rad-adopt.md`, `.claude/commands/architect/rad-approve.md`
**What:** Replace every `--base main`, `git checkout main`, and literal `main`
branch reference with the value from `scripts/get-default-branch.sh`.
**Validate:** AC#1 — grep finds no unguarded literal `main` branch references in the listed files.

---

### Wave 2 — sequential
Depends on: Wave 1 complete. The Lane B core — highest leverage.

#### Task 2.1: Simplify check-plan-approved.sh to branch-tip-canonical
**File:** `scripts/check-plan-approved.sh`
**What:** Rewrite to read approval status in this order: (1) `git show origin/<work-branch>:<plan-file>` tip, (2) plan file on `origin/<default-branch>` (merged), (3) local working tree. Exit 0 only for `approved`; exit 1 with clear messages for `pending-review`/`needs-revision`/`rejected`. Delete the `check_github`/`check_gitlab`/`check_local` PR-merge fallbacks and the platform-detect block — the plan PR no longer exists, and `git show` is platform-agnostic.
**Validate:** AC#6 — exits 0 when the work-branch tip has `Status: approved`; exits 1 for every other status; uses no `gh`/`glab`.

#### Task 2.2: Rewrite /rad-plan — work branch, no PR
**File:** `.claude/commands/team/rad-plan.md`
**What:** After linting, cut `rad/[feature]` from the default branch (`get-default-branch.sh` as base), record the branch in the plan doc's `Branch:` header field, commit the plan file, push. Remove the `open-pr.sh` call, the `rad:plan`/`rad:pending-review` PR labels, and the amend-to-record-PR-URL step. Output points to `/rad-approve`, not a PR. Keep the Explore-subagent research model (generic; do **not** import the Handbook idiom).
**Validate:** AC#2, AC#3 — spec cuts `rad/[feature]`, writes the `Branch:` header, and contains no `open-pr.sh` call, no `rad:plan` label, no PR-URL amend.

#### Task 2.3: Rewrite /rad-approve — record on the work-branch tip
**File:** `.claude/commands/architect/rad-approve.md`
**What:** Use `checkout-plan.sh` to land on the work-branch tip, read the plan, run the linter, show the review summary, and on confirmation write `Status: approved` + `Approved-By` + `Approved-At`, then commit + push to the **work branch**. Never check out or commit to the default branch. Fix the description so it agrees with the steps (remove "commits it to main"). Keep reject/needs-revision flows, writing to the work branch.
**Validate:** AC#4 — spec records approval on the work branch only; description and steps both say the default branch is untouched.

#### Task 2.4: Update /rad-deliver — single branch, single PR
**File:** `.claude/commands/team/rad-deliver.md`
**What:** Read the `Branch:` header from the plan doc and regex-validate it (hard-stop with a migration hint if missing or an old `plan/`/`deliver/` name — never cut a new branch, mirroring agentx3's guard). Use `checkout-plan.sh` to land on that branch tip; gate via `check-plan-approved.sh <work-branch>`. Execute waves committing code to the **same** work branch. Open exactly one PR (work branch → default branch) carrying plan doc + code. Error messages reference `/rad-approve`, not a PR merge.
**Validate:** AC#2, AC#5 — spec validates the `Branch:` header, never cuts a new branch, gates on the tip, and opens one PR to the default branch.

#### Task 2.5: Update CLAUDE.md template for Lane B
**File:** `CLAUDE.md`
**What:** Consolidate Branch Conventions to the single configurable `rad/` work-branch prefix (retiring `plan/` + `deliver/`) and document the `Branch:` plan-header field. Remove the `rad:plan`/`rad:pending-review` **plan-PR** labels; keep the `rad:<status>` status labels (used by Wave 4's mirror). Update the Workflow summary and Approval Rules to drop the plan-PR/Gate-1-PR step — approval is `/rad-approve` on the work branch; the deliver PR is the only PR. Confirm `default_branch:` is documented as authoritative.
**Validate:** AC#2, AC#17 — template defines one work-branch convention and instructs no plan-PR creation/merge anywhere.

#### Task 2.6: Align /rad-adopt with the Lane B branch model
**File:** `.claude/commands/team/rad-adopt.md`
**What:** `/rad-adopt` produces a plan just like `/rad-plan`, so give it the same Lane B treatment: cut `rad/[feature]` from the default branch, record the `Branch:` header, commit + push the plan doc, open **no PR**, no `rad:plan` labels. Output points to `/rad-approve`. (The intent-confirmation and Issue Gaps additions are Task 5.6 — keep them separate so the branch-model change lands cleanly in Wave 2.)
**Validate:** AC#2, AC#3 — adopt cuts `rad/[feature]`, writes the `Branch:` header, and opens no plan PR.

---

### Wave 3 — sequential
Depends on: Wave 2 complete (modifies the same rad-approve + a shared script).

Proxy approval — unblock the architect bottleneck.

#### Task 3.1: Add identity-override to check-role.sh
**File:** `scripts/check-role.sh`
**What:** Accept an optional 3rd argument `[identity-override]`. When present, validate that name/email against the role list instead of the running git user, and print "Identity checked: <name>". When absent, behavior is unchanged (validates the running git user).
**Validate:** AC#9 — with a 3rd arg, validates the named identity; with none, validates the git user as before.

#### Task 3.2: Add --on-behalf-of / --evidence to /rad-approve
**File:** `.claude/commands/architect/rad-approve.md`
**What:** Parse `--on-behalf-of "<name>"` and `--evidence "<cite>"` from `$ARGUMENTS` (slug/path before the first `--`). Default mode gates on the runner's architect role. Proxy mode: refuse if `--evidence` is missing/blank; validate the named approver via `check-role.sh architect CLAUDE.md "<name>"`; the runner does **not** need the architect role. Record `Approved-By: <architect> (out-of-band)`, `Recorded-By: <runner>`, `Approval-Evidence: <cite>`. Add a proxy-mode confirmation prompt restating approver + evidence + recorder. Document the integrity rules (never collapse Approved-By and Recorded-By; only record real approvals).
**Validate:** AC#8 — proxy approval requires evidence, validates the named architect, and records approver + recorder separately.

---

### Wave 4 — parallel (independent of Wave 3)
Depends on: Wave 2 complete.

Status visibility — required because plans now live on branches, not the working tree.

#### Task 4.1: Add rad-label.sh status mirror (port from agentx3)
**File:** `scripts/rad-label.sh`
**What:** New script. Mirror a plan's status onto a GitHub issue/PR as a single `rad:<status>` label (create-if-missing; remove sibling `rad:` labels). No-op exit 0 when `gh` is unavailable/unauthenticated. Generalize agentx3's issue-keyed version to accept a target (issue or PR number); skip when no target exists (framework plans created via `/rad-plan` may have no issue). Call it from `/rad-plan`, `/rad-approve`, `/rad-deliver` where a target is known.
**Validate:** AC#10 — applies exactly one `rad:<status>` label and exits 0 without error when `gh` is absent.

#### Task 4.2: Make rad-status.sh read work-branch tips (generalize agentx3 stories.sh)
**File:** `scripts/rad-status.sh`
**What:** Add a branch-tip aggregation pass: enumerate `origin/<prefix>/*` branches, read each plan doc from its tip (`git show`), and merge with plans landed on the default branch and the local working tree (working tree last). This restores a complete board now that in-flight plans no longer live on the default branch. Preserve the existing `--json` mode.
**Validate:** AC#11 — dashboard lists a plan that exists only on a remote work branch, not in the working tree.

---

### Wave 5 — parallel (independent of Waves 3–4)
Depends on: Wave 2 complete.

Orthogonal improvements carried forward from the superseded plan.

#### Task 5.1: Richer plan document schema in /rad-plan
**File:** `.claude/commands/team/rad-plan.md`
**What:** Add a `Branch:` header field (set by Task 2.2), a `## Scope` (in/out) table, and a numbered `## Acceptance Criteria` list to the plan template; convert each Wave task `Validate:` field to cite `AC#N`. Keep all existing sections (Context, Agent Scope, Files in Scope, Execution Notes, Non-Goals, Risks).
**Validate:** AC#2, AC#12 — template includes the `Branch:` header and `## Acceptance Criteria`, and tasks reference `AC#N`.

#### Task 5.2: Add execution log to /rad-deliver
**File:** `.claude/commands/team/rad-deliver.md`
**What:** Create `.agents/logs/[feature]-[YYYY-MM-DD].md` with a step table; append a row after each task; surface the table in the deliver PR body. Note in CLAUDE.md that `.agents/logs/` are delivery artifacts (teams opt in to committing).
**Validate:** AC#13 — spec creates the log and updates it per task.

#### Task 5.3: Add retry cap and escalation to /rad-deliver
**File:** `.claude/commands/team/rad-deliver.md`
**What:** Cap retries at 2 per task; on the third failure stop and emit a structured escalation (task, AC, issue summary, what was tried). Do not continue.
**Validate:** AC#13 — spec states "cap retries at 2" and defines the escalation output.

#### Task 5.4: Wire check-tests.sh gate into /rad-deliver
**File:** `.claude/commands/team/rad-deliver.md`
**What:** Before opening the deliver PR, call `scripts/check-tests.sh [plan-file]`; block PR creation and list missing tests on non-zero exit.
**Validate:** AC#13 — spec calls `check-tests.sh` before `open-pr.sh` and blocks on failure.

#### Task 5.5: Add AC coverage check to /rad-review
**File:** `.claude/commands/team/rad-review.md`
**What:** Add an "AC Coverage" step that verifies every `## Acceptance Criteria` item is cited by at least one task `Validate:`; flag uncovered ACs as HIGH.
**Validate:** AC#14 — spec flags any uncovered AC as HIGH.

#### Task 5.6: Add intent confirmation + Issue Gaps to /rad-adopt
**File:** `.claude/commands/team/rad-adopt.md`
**What:** After fetching issue context, output a plain-language interpretation and ask "Correct? (yes / clarify)" before writing files. Add a mandatory `### Issue Gaps` section to the plan template (assumptions for under-specified issues, or "None").
**Validate:** AC#15 — spec confirms intent before file creation and the template includes `### Issue Gaps`.

#### Task 5.7: Create /kickoff and /wrap skills
**File:** `.claude/skills/kickoff/SKILL.md`, `.claude/skills/wrap/SKILL.md`
**What:** Generalized session-ritual skills. `/kickoff`: read CLAUDE.md, branch guard on the default branch, report plans by status (reading branch tips per Wave 4.2), optional issue triage, ask the session focus. `/wrap`: gather session commits, update changed plan statuses, append a dated progress note, output a session summary, flag uncommitted changes. No project-specific references.
**Validate:** AC#16 — both skills exist with no BEAKON/PENDING.md/design-system references.

#### Task 5.8: Update lint-plan.sh for the new schema
**File:** `scripts/lint-plan.sh`
**What:** Add validation that a plan contains `## Acceptance Criteria` and that each Wave task has a `Validate:` line. Keep the existing context-budget line-sum checks.
**Validate:** AC#12 — linter fails a plan missing `## Acceptance Criteria`.

---

### Wave 6 — sequential
Depends on: Waves 2–5 complete.

Docs, templates, migration. The framework's docs are its product surface.

#### Task 6.1: Rewrite docs to the Lane B model
**File:** `docs/daily-workflow.md`, `docs/architect-guide.md`, `docs/onboarding.md`, `docs/plan-pr-guide.md`, `docs/apply-to-existing.md`, `docs/platform-support.md`, `docs/wave-execution.md`, `README.md`, `INSTALL.md`, `UPGRADE.md`, `.agents/plans/README.md`
**What:** Replace every "plan PR" / "Gate 1 PR" / "merge the plan branch" narrative with the Lane B flow (work branch → `/rad-approve` on the branch → deliver PR). `docs/plan-pr-guide.md` is repurposed into an approval guide (or removed with redirects). Document the configurable work-branch prefix and `default_branch`. Update the gate model (Gate 1 = `/rad-approve` on branch; Gate 2 = deliver PR review).
**Validate:** AC#17 — no doc instructs opening or merging a plan PR; grep for "plan PR"/"Gate 1 PR" returns only historical/superseded references.

#### Task 6.2: Add an UPGRADE migration note
**File:** `UPGRADE.md`
**What:** Document the v1→v2 migration for teams already on the framework: branch-convention change, removal of plan PRs/labels, new scripts, and that existing in-flight plan branches keep working but new plans use the single-branch flow.
**Validate:** AC#17 — UPGRADE.md describes the Lane B migration steps.

#### Task 6.3: Update install.sh references
**File:** `install.sh`
**What:** Ensure the installer copies the new scripts (`get-default-branch.sh`, `checkout-plan.sh`, `rad-label.sh`) and the `/kickoff` + `/wrap` skills, and no longer references plan-PR labels.
**Validate:** AC#3, AC#16 — installer includes the new scripts/skills and no plan-PR label setup.

---

### Tests to Write

- [ ] `get-default-branch.sh` returns `develop` for `default_branch: develop`, `main` when absent — `scripts/get-default-branch.sh`
- [ ] `checkout-plan.sh` fails on a missing branch and on a diverged local branch — `scripts/checkout-plan.sh`
- [ ] `check-plan-approved.sh` exits 0 for branch-tip `Status: approved`, 1 otherwise, with no `gh`/`glab` calls — `scripts/check-plan-approved.sh`
- [ ] `check-role.sh` validates a 3rd-arg identity-override and is unchanged without it — `scripts/check-role.sh`
- [ ] `rad-label.sh` no-ops (exit 0) when `gh` is absent — `scripts/rad-label.sh`
- [ ] `lint-plan.sh` fails a plan missing `## Acceptance Criteria` — `scripts/lint-plan.sh`

### Execution Notes

#### Do Not Touch
- `scripts/detect-platform.sh` — still used by `open-pr.sh`; platform detection is unrelated to the branch model.
- `scripts/check-scope.sh` — scope checking is unrelated to this refactor.
- `.claude/commands/shared/rad-insights.md` — insights are unaffected.
- `.claude/agents/*` and `.claude/commands/architect/rad-design.md` — agent generation and scope maps are out of scope.

#### Key Files
- `.claude/commands/architect/rad-approve.md` — central to Waves 2 and 3.
- `scripts/check-plan-approved.sh` — the gate; Wave 2 makes it branch-tip-canonical.
- `.claude/commands/team/rad-deliver.md` — loses the separate deliver branch, gains the single-PR flow, execution log, retry cap, and test gate.
- `CLAUDE.md` — the template every downstream project copies; branch-convention and label changes ripple to all of them.

#### Reminders
- Wave 1 must land before Wave 2 (commands depend on `get-default-branch.sh` and `checkout-plan.sh`).
- Branch model is resolved (`rad/[feature]`, cut at `/rad-plan`, recorded in the `Branch:` header) — no open decision blocks Wave 1.
- Waves 3, 4, and 5 are independent once Wave 2 lands — can run in parallel.
- Wave 6 (docs) must be last so it describes the final behavior.
- Downstream projects update their copied commands manually — call this out in the release commit and UPGRADE.md.

### Non-Goals

- A story numbering system or `docs/stories/` layout — projects keep their own slugs.
- Importing agentx3's story tooling (`/story-prep`, `/story-create`, `pnpm stories`, Handbook reading order).
- An auto issue-to-branch pipeline ("RAD Auto").
- Migrating agentx3's own files — downstream's responsibility.
- Changing `/rad-design` or the agent scope map format.

### Out-of-Scope Dependencies

None — all changes are within the framework's own commands, scripts, skills, and docs.

---

## Notes

*(Add during execution)*
