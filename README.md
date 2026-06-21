# RAD: Research, Architect, Deliver

![Rad Logo](./assets/rad_logo.png)

A hybrid agent framework for small teams. Enforces information boundary
architecture, GSD-style wave execution, and PR-based approval gates.

Built for teams of any size — works with a dedicated architect or with a
developer playing both roles on smaller projects.

---

## How It Works

```
ARCHITECT / TEAM                   TEAM
────────────────                   ────
/rad-research [prd or issue]       /rad-plan [feature]
  Consume spec artifact              Explore sub-agent researches codebase
  Clarify team + platform            Returns bounded RESEARCH_SUMMARY
  Write .agents/research/[slug]      Generate + lint plan file
                                     Cut rad/[feature] work branch
/rad-design [slug]                   Commit plan to that branch (no PR)
  Read research artifact
  Draft agent hierarchy            /rad-adopt [issue or description]
  Write .agents/architecture/        Same as /rad-plan, sourced from
  [architect reviews + approves]     a pre-existing issue or description
  Generate .claude/agents/ files

                    ── Gate 1 ──
                    /rad-approve (architect)
                    Reviews plan, writes Status: approved to the
                    rad/[feature] branch tip and pushes it
                    No PR — approval lives on the branch

                                   /rad-deliver [plan-file]
                                     Checks plan has Status: approved
                                     Runs on the existing rad/[feature] branch
                                     Each wave → fresh sub-agent context
                                     Orchestrator carries only WAVE_RESULT
                                     Atomic commit per task
                                     Execution log appended per step
                                     Opens the single deliver PR

                    ── Gate 2 ──
                    Architect reviews the deliver PR
                    (rad/[feature] → default branch)
                    Plan doc + code land together
                    Standard code review, then merge
```

---

## One Branch, One PR

Every feature lives on a single `rad/[feature]` work branch, cradle to grave.
`/rad-plan` cuts it from the default branch and commits the plan doc to it.
`/rad-approve` writes `Status: approved` to that branch's tip. `/rad-deliver`
runs on the same branch and opens the one deliver PR. The plan doc and the code
reach the default branch together through that single reviewed PR, which keeps
contributors off the protected default branch. There is no plan PR.

The default branch is whatever you set as `default_branch:` in CLAUDE.md
(resolved by `scripts/get-default-branch.sh`) — it is never hardcoded.

## Two Gates

**Gate 1 — Plan approval** (architect runs `/rad-approve`)
- One file: `.agents/plans/[feature].md` on the `rad/[feature]` branch
- Architect reviews the *approach* before code is written
- `/rad-approve` writes `Status: approved` to the plan doc on the branch tip and
  pushes that branch — no PR, no merge to the default branch
- Blocked: `/rad-deliver` checks for `Status: approved` at the branch tip

**Gate 2 — Deliver PR** (`rad/[feature]` → default branch)
- Plan doc and all implementation changes, together
- Architect reviews the *output* after execution
- Standard code review workflow, then merge

---

## Token Efficiency

RAD delegates heavy context work to sub-agents so main sessions stay lean:

| Phase | What runs in a sub-agent | What stays in main context |
|-------|--------------------------|---------------------------|
| `/rad-research` URL input | Haiku sub-agent: fetches and summarizes spec URL | Bounded `SPEC_SUMMARY` block |
| `/rad-design` file generation | Parallel Haiku sub-agents: one per agent file | Completion confirmations |
| `/rad-plan` research | Explore sub-agent: searches codebase, returns `RESEARCH_SUMMARY` | The summary block (~20 lines) |
| `/rad-deliver` per wave | Wave sub-agent: loads files, implements, validates, commits | `WAVE_RESULT` block per wave |
| `/rad-review` | quality-reviewer + accessibility-reviewer agents | Finding summaries |

The plan linter enforces a **context budget** on the Files in Scope table:
- **Warn** at >800 lines in scope — consider splitting
- **Error** at >1500 lines — must split before the plan can be approved

---

## Role Structure

| Role | Commands | Responsibility |
|------|----------|----------------|
| Architect | All commands | Defines agent boundaries, approves plans, merges PRs |
| Developer | `/rad-research`, `/rad-plan`, `/rad-adopt`, `/rad-deliver`, `/rad-review` | Research, plan, and execute within boundaries |
| Designer | `/rad-research`, `/rad-plan`, `/rad-adopt`, `/rad-deliver` | UI-scoped research, planning, and execution |
| All roles | `/rad-status`, `/rad-insights`, `/kickoff`, `/wrap` | Team dashboard, review pattern analysis, session start/end rituals |

All commands are committed to the project repo. The `architect/` subdirectory
signals which commands carry architect-level responsibility — enforcement is via
branch protection and PR workflow, not command access control.

---

## Installation

```bash
git clone https://github.com/torchcodelab/rad-framework /tmp/rad
bash /tmp/rad/install.sh --dir /path/to/your-project
```

The installer handles directory structure, commands, scripts, and CLAUDE.md
scaffolding in one step. See [INSTALL.md](INSTALL.md) for the full guide
including upgrade and uninstall instructions.

---

## File Structure After Installation

```
your-project/
├── CLAUDE.md                         ← always-loaded project context + RAD config
├── .claude/
│   ├── agents/                       ← auto-discovered by Claude Code
│   │   ├── orchestrator.md
│   │   ├── [domain]-orchestrator.md
│   │   ├── [tool-name].md
│   │   ├── accessibility-reviewer.md ← built-in reviewer (invoked by /rad-review)
│   │   └── quality-reviewer.md       ← built-in reviewer (invoked by /rad-review)
│   └── commands/
│       ├── architect/
│       │   ├── rad-approve.md        → /rad-approve   (architect)
│       │   └── rad-design.md         → /rad-design    (architect)
│       ├── team/
│       │   ├── rad-research.md       → /rad-research  (team)
│       │   ├── rad-plan.md           → /rad-plan      (team)
│       │   ├── rad-adopt.md          → /rad-adopt     (team)
│       │   ├── rad-deliver.md        → /rad-deliver   (team)
│       │   ├── rad-review.md         → /rad-review    (team)
│       │   ├── accessibility-review.md → /accessibility-review (team)
│       │   └── quality-review.md     → /quality-review (team)
│       └── shared/
│           ├── rad-status.md         → /rad-status    (shared)
│           └── rad-insights.md       → /rad-insights  (shared)
│   └── skills/
│       ├── kickoff/SKILL.md          → /kickoff       (session start ritual)
│       └── wrap/SKILL.md             → /wrap          (session end ritual)
├── .agents/
│   ├── research/                     ← research artifacts (/rad-research output)
│   ├── architecture/                 ← architecture drafts (/rad-design draft → approved)
│   ├── plans/                        ← plan artifacts (Gate 1)
│   ├── logs/                         ← execution logs per plan
│   ├── findings.jsonl                ← append-only review findings log (written by /rad-review)
│   └── findings/README.md            ← findings log schema and query reference
└── scripts/
    ├── detect-platform.sh            ← detects git platform from remote
    ├── get-default-branch.sh         ← resolves default_branch from CLAUDE.md
    ├── checkout-plan.sh              ← checks out a plan's rad/[feature] branch
    ├── rad-label.sh                  ← applies RAD labels to a PR
    ├── open-pr.sh                    ← platform-agnostic PR creation
    ├── check-plan-approved.sh        ← checks Status: approved at branch tip
    ├── check-role.sh                 ← validates contributor role vs. command
    ├── check-scope.sh                ← validates file changes against agent scope
    ├── check-tests.sh                ← checks for test coverage in deliver output
    ├── lint-plan.sh                  ← validates plan structure + context budget
    └── rad-status.sh                 ← powers /rad-status dashboard
```

---

## Docs

| Doc | Read when |
|-----|-----------|
| `INSTALL.md` | Installing or uninstalling RAD |
| `UPGRADE.md` | Upgrading an existing RAD project to the latest version |
| `docs/how-it-works.md` | The whole process explained — model, lifecycle, guardrails |
| `docs/harness-and-framework.md` | What RAD *is* — the harness core vs. the framework shell, grounded in code |
| `docs/daily-workflow.md` | Getting started with the team workflow |
| `docs/architect-guide.md` | Setting up and maintaining the architecture |
| `docs/plan-pr-guide.md` | How plan approval works and what to review |
| `docs/wave-execution.md` | How /rad-deliver runs tasks in waves |
| `docs/platform-support.md` | Git platform configuration and fallbacks |
| `docs/onboarding.md` | Guide for new team members |
| `docs/apply-to-existing.md` | Applying RAD to an existing project (2–3 weeks) |
| `docs/12-factor-agents.md` | How RAD maps to 12-Factor Agent principles |
| `docs/maintaining-claude-md.md` | Keeping CLAUDE.md accurate over time |
| `.agents/findings/README.md` | Findings log schema, record types, and jq query reference |

---

## Credits

- Dex Horthy — [Advanced Context Engineering](https://youtu.be/rmvDxxNubIg) and [12-Factor Agents](https://www.youtube.com/watch?v=8kMaTybvDUw)
- Cole Medin — [PIV loop pattern](https://github.com/coleam00/habit-tracker)
- GSD Framework — [wave execution model](https://github.com/gsd-build/get-shit-done)
