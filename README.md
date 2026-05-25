# RAD — Research · Architect · Deliver

A hybrid agent framework for small teams. Combines rpi-design's information
boundary architecture with GSD-style wave execution and PR-based approval gates.

Built for teams with a primary architect/gatekeeper and junior developers or
designers working within defined boundaries.

---

## How It Works

```
ARCHITECT                          TEAM
─────────                          ────
/rad-design                        /rad-plan [feature]
  Interview + generate               Research within agent boundaries
  .claude/agents/ hierarchy          Generate plan file
                                     Commit to plan/[feature] branch
                                     Open draft PR automatically

                    ── PR Review ──
                    Architect reviews plan PR
                    Comments, requests changes
                    Merge = approval

                                   /rad-deliver [plan-file]
                                     Checks plan is approved (merged)
                                     Wave execution in fresh contexts
                                     Atomic commit per step
                                     Execution log appended per step

                    ── PR Review ──
                    Architect reviews code PR
                    Standard code review
                    Merge to main
```

---

## Two Gates, Two PRs

**Gate 1 — Plan PR** (`plan/[feature]` → `main`)
- One file: `.agents/plans/[feature].md`
- Architect reviews the *approach* before code is written
- Merge = approval to execute
- Blocked: `/rad-deliver` will not run on an unmerged plan

**Gate 2 — Code PR** (`deliver/[feature]` → `main`)
- All implementation changes
- Architect reviews the *output* after execution
- Standard code review workflow

---

## Role Structure

| Role | Commands | Access |
|------|----------|--------|
| Architect | All commands + `/rad-design` | Defines agent boundaries, approves plans, merges PRs |
| Developer | `/rad-plan`, `/rad-deliver`, `/rad-review` | Plans and executes within boundaries |
| Designer | `/rad-plan`, `/rad-deliver` | UI-scoped planning and execution only |
| All roles | `/rad-status`, `/rad-insights` | Team dashboard and review pattern analysis |

Install architect commands from `.claude/commands/architect/` to `~/.claude/commands/`.
Install team commands from `.claude/commands/team/` to the project's `.claude/commands/`.

---

## Installation

### 1. Copy agent definitions

```bash
cp -r .claude/agents/ /path/to/your-project/.claude/agents/
```

### 2. Install architect commands (your machine only)

```bash
cp .claude/commands/architect/* ~/.claude/commands/
cp .claude/commands/shared/* ~/.claude/commands/
```

### 3. Install team commands (project-level, committed to repo)

```bash
cp .claude/commands/team/* /path/to/your-project/.claude/commands/
cp .claude/commands/shared/* /path/to/your-project/.claude/commands/
```

### 4. Install scripts

```bash
cp scripts/* /path/to/your-project/scripts/
chmod +x /path/to/your-project/scripts/*.sh
```

### 5. Configure git platform

```bash
# GitHub (default)
scripts/detect-platform.sh  # auto-detects from git remote

# Or set explicitly in CLAUDE.md:
# git_platform: github | gitlab | bitbucket | forgejo | manual
```

### 6. Fill in CLAUDE.md

Open `CLAUDE.md` and complete all sections. Pay particular attention to
the RAD Configuration section — it defines role boundaries and platform settings.

### 7. Verify

In Claude Code, run:
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
│   │   └── [tool-name].md
│   └── commands/
│       ├── rad-plan.md               → /rad-plan  (team)
│       ├── rad-deliver.md            → /rad-deliver (team)
│       ├── rad-review.md             → /rad-review (team)
│       └── rad-status.md             → /rad-status (shared)
├── .agents/
│   ├── plans/                        ← plan artifacts (Gate 1 PRs)
│   ├── logs/                         ← execution logs per plan
│   ├── findings.jsonl                ← append-only review findings log (written by /rad-review)
│   └── findings/README.md            ← findings log schema and query reference
└── scripts/
    ├── detect-platform.sh            ← detects git platform from remote
    ├── open-pr.sh                    ← platform-agnostic PR creation
    └── check-plan-approved.sh        ← checks if plan branch is merged
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
| `docs/migration-from-rpi.md` | Migrating from rpi-design practitioner template (3 days) |
| `docs/apply-to-existing.md` | Applying RAD to an existing project with no prior rpi (2–3 weeks) |
| `docs/12-factor-agents.md` | How RAD maps to 12-Factor Agent principles |
| `docs/maintaining-claude-md.md` | Keeping CLAUDE.md accurate over time |
| `.agents/findings/README.md` | Findings log schema, record types, and jq query reference |

---

## Credits

- Dex Horthy — [Advanced Context Engineering](https://youtu.be/rmvDxxNubIg) and [12-Factor Agents](https://www.youtube.com/watch?v=8kMaTybvDUw)
- Cole Medin — [PIV loop pattern](https://github.com/coleam00/habit-tracker)
- GSD Framework — [wave execution model](https://github.com/gsd-build/get-shit-done)
