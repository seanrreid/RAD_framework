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
                                     Open draft PR for architect review
/rad-design [slug]
  Read research artifact           /rad-adopt [issue or description]
  Draft agent hierarchy              Same as /rad-plan, sourced from
  Write .agents/architecture/        a pre-existing issue or description
  [architect reviews + approves]
  Generate .claude/agents/ files

                    ── Gate 1 ──
                    /rad-approve (architect)
                    Reviews plan, commits Status: approved to main
                    No branch merge required

                                   /rad-deliver [plan-file]
                                     Checks plan has Status: approved
                                     Each wave → fresh sub-agent context
                                     Orchestrator carries only WAVE_RESULT
                                     Atomic commit per task
                                     Execution log appended per step

                    ── Gate 2 ──
                    Architect reviews code PR
                    Standard code review
                    Merge to main
```

---

## Two Gates

**Gate 1 — Plan approval** (architect runs `/rad-approve`)
- One file: `.agents/plans/[feature].md`
- Architect reviews the *approach* before code is written
- `/rad-approve` commits `Status: approved` to the plan file on `main` — no branch merge required
- Blocked: `/rad-deliver` checks for `Status: approved` in the plan file

**Gate 2 — Code PR** (`deliver/[feature]` → `main`)
- All implementation changes
- Architect reviews the *output* after execution
- Standard code review workflow

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
| All roles | `/rad-status`, `/rad-insights` | Team dashboard and review pattern analysis |

All commands are committed to the project repo. The `architect/` subdirectory
signals which commands carry architect-level responsibility — enforcement is via
branch protection and PR workflow, not command access control.

---

## Installation

### 1. Copy commands and agents

```bash
cp -r .claude/commands/ /path/to/your-project/.claude/commands/
cp -r .claude/agents/   /path/to/your-project/.claude/agents/
```

### 2. Install scripts

```bash
cp -r scripts/ /path/to/your-project/scripts/
chmod +x /path/to/your-project/scripts/*.sh
```

### 3. Configure git platform

```bash
scripts/detect-platform.sh  # auto-detects from git remote

# Or set explicitly in CLAUDE.md:
# platform: github | gitlab | bitbucket | forgejo | manual
```

### 4. Fill in CLAUDE.md

Open `CLAUDE.md` and complete all sections. The RAD Configuration section
defines role assignments and platform settings.

### 5. Verify

```
/rad-status
```

You should see platform detection, agent count, and role confirmation.

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
├── .agents/
│   ├── research/                     ← research artifacts (/rad-research output)
│   ├── architecture/                 ← architecture drafts (/rad-design draft → approved)
│   ├── plans/                        ← plan artifacts (Gate 1)
│   ├── logs/                         ← execution logs per plan
│   ├── findings.jsonl                ← append-only review findings log (written by /rad-review)
│   └── findings/README.md            ← findings log schema and query reference
└── scripts/
    ├── detect-platform.sh            ← detects git platform from remote
    ├── open-pr.sh                    ← platform-agnostic PR creation
    ├── check-plan-approved.sh        ← checks Status: approved or branch merge
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
| `docs/daily-workflow.md` | Getting started with the team workflow |
| `docs/architect-guide.md` | Setting up and maintaining the architecture |
| `docs/plan-pr-guide.md` | How plan PRs work and what to review |
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
