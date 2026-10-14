# Plan: First-Run Docs: Namespaced Commands, Agent Step, Approval Wording
Created: 2026-10-14
Author: architect
Status: pending-review
Branch: rad/first-run-docs-namespaced-commands
Tier: light
Source-Author: none (no source issue)
Source-Comments: none

## Context
An audit on 2026-10-14 (four agents, spot-checked) found that the guides a new team reads first instruct things that fail or mislead. This plan fixes the five first-run docs; the rest of the guides follow in a second plan.

- **Bare commands:** only the namespaced slash commands resolve (`/team:rad-plan`, `/architect:rad-approve`, `/shared:rad-status`); only `/kickoff` and `/wrap` are bare. The five docs contain 109 bare `/rad-*` uses (`daily-workflow` 56, `apply-to-existing` 28, `onboarding` 17, `playbooks` 5, `platform-support` 3).
- **No agent step:** a plain `install.sh --yes` writes no `agent:`, so the first `rad deliver` exits 2. `daily-workflow` and `apply-to-existing` never say to set one before delivering.
- **Incomplete commit step:** `daily-workflow:43` and `apply-to-existing:46` run `git add .claude/ .agents/ scripts/ AGENTS.md CLAUDE.md`, leaving `.rad/`, `harness/` and `ai/` uncommitted, so teammates would have no config or `rad` CLI.
- **Claude-only onboarding:** `onboarding.md` says to run `claude-code` (the binary is `claude`) and to install Claude Code and authenticate to Anthropic as step 1, though the agent is configurable.
- **Approval wording:** docs say `/rad-approve` writes or `rad-deliver` reads `Status: approved`. The gate is the `approved` event in `.agents/state/<feature>/events.jsonl`; the `Status:` header is a display-only mirror (`scripts/check-plan-approved.sh`, `docs/rad-decisions.md`).
- **Playbooks:** `docs/playbooks.md` says two seed playbooks "ship"; they live only in this repository's `.agents/playbooks/` and the installer does not copy them.

The remaining guides (`architect-guide`, `plan-approval-guide`, `epic-decomposition`, `how-it-works`, `UPGRADE.md`) and the three reference docs are separate plans.

## Acceptance Criteria
1. **No bare commands.** In the five files, no `/rad-<name>` occurrence remains that is not part of a longer path or already namespaced. The mapping is: `plan`, `research`, `adopt`, `deliver`, `review` become `/team:rad-<name>`; `approve`, `design`, `epic-decompose` become `/architect:rad-<name>`; `status`, `insights` become `/shared:rad-<name>`. `/kickoff`, `/wrap`, file paths such as `commands/team/rad-plan.md` and text already namespaced are unchanged. Check: `grep -nE '(^|[^:/A-Za-z0-9_.-])/rad-' <five files>` prints nothing.
2. **One namespacing note.** `docs/daily-workflow.md` has one short note near the top listing the three namespaces and the two bare skills, and saying that in Codex the same steps are the `rad-*` skills in `.agents/skills/`. The other four files link to it once instead of repeating it.
3. **Agent step.** `daily-workflow` ("starting a new project") and `apply-to-existing` (week 1) each have an install-time step saying that `install.sh --yes` writes no agent, that `rad deliver` exits 2 until one is set, and how to set it (`install.sh --agent claude|codex` or `node harness/cli.js config init --agent-cmd "<cmd>" --force`), linking to `INSTALL.md#choose-your-agent`.
4. **Complete commit step.** Both `git add` lines become `git add .claude/ .codex/ .agents/ .rad/ ai/ scripts/ harness/ AGENTS.md CLAUDE.md`, matching INSTALL.md.
5. **Agent-neutral onboarding.** `onboarding.md` no longer presents Claude Code as the only prerequisite: the Claude Code install and Anthropic login step is conditional on the chosen agent and names Codex or another CLI as the alternative, links to `INSTALL.md#choose-your-agent`, and the launch line says `claude` and `/shared:rad-status`.
6. **Approval wording.** Every sentence in the five files that says approval writes, sets or is read from `Status: approved` says instead that `/architect:rad-approve` records an `approved` event in `.agents/state/<feature>/events.jsonl` on the branch tip, with the `Status:` header as a display mirror. In `platform-support.md` the branch-tip read is described as reading that event log.
7. **Playbooks honest.** `docs/playbooks.md` says the seed playbooks live in the RAD repository's `.agents/playbooks/` and are not installed into projects; to use one, copy it into the project's `.agents/playbooks/`.
8. **Nothing else changes.** `git diff --stat` shows only the five files plus this plan; links in the five files still resolve to existing files; no other wording in them is edited.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| docs/daily-workflow.md | 1-478 | Sweep commands (56), namespacing note, install-time agent step, git add line (43), approval wording (~205) |
| docs/onboarding.md | 1-199 | Sweep (17), agent-neutral prerequisites (10, 29-35), launch line (60), approval wording (~115) |
| docs/apply-to-existing.md | 1-307 | Sweep (28), week-1 agent step, git add line (46), approval wording (~116, ~180) |
| docs/platform-support.md | 1-217 | Sweep (3), approval wording and event-log read (8, 19, 152, 181) |
| docs/playbooks.md | 1-126 | Sweep (5), seed-playbooks sentence (10) |

## Wave Plan

### Wave 1 — parallel
Tasks in this wave can run in parallel.
Verify: none (documentation only; the grep and link checks in Task 1.3 are the verification)

#### Task 1.1: daily-workflow.md
File: docs/daily-workflow.md:1-478
What: Apply AC#1 by replacing every bare `/rad-<name>` with its namespaced form using the mapping in AC#1; add the namespacing note of AC#2 near the top; add the agent step of AC#3 to the new-project section; fix the `git add` line (AC#4); rewrite approval wording per AC#6. Change nothing else.
Validate: AC#1, AC#2, AC#3, AC#4, AC#6 — the grep of AC#1 is empty for this file; the note, the agent step and the new `git add` line are present.

#### Task 1.2: onboarding.md and apply-to-existing.md
File: docs/onboarding.md:1-199, docs/apply-to-existing.md:1-307
What: Sweep both files per AC#1 and link once to the note in `daily-workflow.md` (AC#2). In `onboarding.md` apply AC#5 and the approval wording of AC#6. In `apply-to-existing.md` add the week-1 agent step (AC#3), fix the `git add` line (AC#4) and the approval wording (AC#6).
Validate: AC#1, AC#2, AC#3, AC#4, AC#5, AC#6 — the grep of AC#1 is empty for both files.

#### Task 1.3: platform-support.md, playbooks.md and checks
File: docs/platform-support.md:1-217, docs/playbooks.md:1-126
What: Sweep both files per AC#1; apply the approval wording and event-log description in `platform-support.md` (AC#6) and the seed-playbooks sentence in `playbooks.md` (AC#7). Then run the AC#1 grep across all five files, check that every relative markdown link in them resolves, and run `git diff --stat main...HEAD`.
Validate: AC#1, AC#6, AC#7, AC#8 — the grep prints nothing; no missing link target; the diff stat lists only the five files and this plan.

## Tests to Write
- None. Documentation only; the grep, link check and diff stat in Task 1.3 are the verification.

## Non-Goals
- The other guides (`architect-guide`, `plan-approval-guide`, `epic-decomposition`, `how-it-works`, `UPGRADE.md`) and the reference docs; they are separate plans
- Changing `install.sh`, its "Next steps" output, or any script
- Rewriting any other prose in the five files

## Risks
- A mechanical sweep can hit a bare `/rad-` inside a path or code sample where the unnamespaced form is correct; AC#1 excludes path-embedded and already-namespaced text, and the diff review catches the rest.
- Codex users may invoke the skills differently; AC#2 deliberately says only that the same steps are the `rad-*` skills in `.agents/skills/`, without claiming a Codex command syntax.
