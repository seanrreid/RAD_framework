# Installing RAD

RAD ships with an install script that handles the full setup — directory
structure, commands, scripts, and CLAUDE.md scaffolding — in one step.

---

## Prerequisites

| Tool | Required | Purpose |
|------|----------|---------|
| `git` | Yes | RAD requires a git repository |
| `claude` CLI | Yes | Claude Code — [install here](https://claude.ai/code) |
| `gh` or `glab` | Recommended | PR automation. RAD falls back to manual mode without one |

---

## Quick Install

Clone the RAD repo and run the installer from your project directory:

```bash
git clone https://github.com/torchcodelab/rad-framework /tmp/rad
cd /path/to/your-project
bash /tmp/rad/install.sh
```

Or point directly at your project:

```bash
bash /tmp/rad/install.sh --dir /path/to/your-project
```

The script will prompt for any information it needs.

---

## Non-Interactive Install

For CI pipelines or scripted setup, skip all prompts:

```bash
bash /tmp/rad/install.sh --dir /path/to/your-project --yes
```

---

## What Gets Installed

```
your-project/
├── CLAUDE.md                         ← scaffolded from template (fill in before use)
├── .claude/
│   └── commands/
│       ├── architect/
│       │   ├── rad-design.md         → /rad-design
│       │   └── rad-approve.md        → /rad-approve
│       ├── team/
│       │   ├── rad-research.md       → /rad-research
│       │   ├── rad-plan.md           → /rad-plan
│       │   ├── rad-adopt.md          → /rad-adopt
│       │   ├── rad-deliver.md        → /rad-deliver
│       │   └── rad-review.md         → /rad-review
│       └── shared/
│           ├── rad-status.md         → /rad-status
│           └── rad-insights.md       → /rad-insights
│   └── skills/
│       ├── kickoff/SKILL.md          → /kickoff
│       └── wrap/SKILL.md             → /wrap
├── .agents/
│   ├── research/                     ← /rad-research output
│   ├── architecture/                 ← /rad-design drafts
│   ├── plans/                        ← /rad-plan output
│   ├── logs/                         ← /rad-deliver execution logs
│   └── findings/                     ← /rad-review findings log
└── scripts/
    ├── detect-platform.sh
    ├── get-default-branch.sh
    ├── checkout-plan.sh
    ├── rad-label.sh
    ├── open-pr.sh
    ├── check-plan-approved.sh
    ├── check-scope.sh
    ├── lint-plan.sh
    └── rad-status.sh
```

The installer also copies the RAD skills into `.claude/skills/` (`kickoff/` and
`wrap/`, providing `/kickoff` and `/wrap`) alongside all `scripts/*.sh` helpers.

`.claude/agents/` is not populated at install time — the architecture process
(`/rad-research` → `/rad-design`) generates those files for your specific project.

---

## Guardrail Pack

RAD ships a guardrail pack in `ai/` that gives every wave sub-agent a consistent
set of coding rules. The pack is treated as framework code — it is always overwritten
on install and upgrade, the same as `.claude/commands/` and `scripts/`.

### What the ai/ directory contains

```
ai/
├── guardrails.md        ← baseline coding-agent rules (always loaded)
├── slop-register.md     ← project-specific overrides (customize for your stack)
└── extensions/
    ├── backend.md       ← routes, services, jobs, API clients
    ├── database.md      ← migrations, models, queries, transactions
    ├── frontend.md      ← UI components, CSS, forms, accessibility
    ├── security.md      ← auth, sessions, secrets, permissions, crypto
    └── testing.md       ← tests, fixtures, mocks, snapshots
```

`ai/guardrails.md` is the baseline every agent loads unconditionally. The
extensions add domain-specific rules on top. The source of truth is the
[agent_guides repo](https://github.com/seanrreid/agent_guides) — sync from there
when upstream updates are released.

### Customizing ai/slop-register.md for your stack

`ai/slop-register.md` is the one file in `ai/` you are meant to edit. It captures
project-specific mistakes your agents repeat. Keep entries short and concrete.

Examples by stack:

```markdown
## Deprecated Or Forbidden
- Do not use: `moment.js` — use `date-fns` instead.
- Do not use: raw `fetch` — use the project's `apiClient` helper.

## Required Conventions
- Always use: `logger.error(err, context)` for error logging, not `console.error`.
- Always use: `z.parse()` (Zod) for external input validation at API boundaries.

## Layering Rules
- Never place: database queries in route handlers — use the repository layer.

## Required Checks
- Run before handoff: `pnpm typecheck && pnpm test`
```

Add an entry whenever the same agent mistake appears more than once.
Remove entries when the codebase changes and the rule no longer applies.

### Extension loading protocol

Wave sub-agents follow the smallest-relevant-set principle:

1. Always load `ai/guardrails.md` as the baseline.
2. List the file paths to be touched in the wave.
3. Match each path against the `Applies When` section of each extension file.
4. Load only the extensions that match. When in doubt, include the extension.
5. State the loaded extensions explicitly before writing any code.

This keeps context tight while ensuring agents have the rules they need for
the work they are actually doing.

### Verifying the agent loaded the right extensions

Before a task begins, ask the agent to summarize its active guardrails:

```
Summarize the guardrail extensions you have loaded for this task and why each
one applies.
```

A correct response names the baseline and each domain extension with a one-line
rationale. If the agent lists extensions that do not apply to the task, prompt it
to drop them and restate. If it omits an applicable extension, provide the path
and ask it to re-read before proceeding.

---

## Post-Install Setup

### 1. Fill in CLAUDE.md

Open `CLAUDE.md` and complete every section. The RAD Configuration section
is critical — it defines your platform, team roles, and branch conventions.

### 2. Platform labels (usually automatic)

There is no plan PR in RAD (the old `rad:plan` label is gone) — the only PR is the
deliver PR, which uses the `rad:deliver` label.

`install.sh` already creates `rad:deliver` for you when `gh` is available and
authenticated, and the `rad:<status>` board labels (`rad:draft`,
`rad:pending-review`, `rad:approved`, `rad:in-progress`, `rad:review`,
`rad:done`, …) are created automatically on first use by `scripts/rad-label.sh`.
**So in the common case there is nothing to do here.**

Only if the installer ran without `gh` (or on GitLab) create the deliver label
manually:

**GitHub:**
```bash
gh label create 'rad:deliver' --color '0e8a16' --description 'RAD delivery PR'
# rad:<status> labels are auto-created by scripts/rad-label.sh on first use.
```

**GitLab:**
```bash
glab label create 'rad:deliver' --color '#0e8a16'
# rad:<status> labels are auto-created by scripts/rad-label.sh on first use.
```

### 3. Set up branch protection (recommended)

Protect your default branch (the one set as `default_branch:` in CLAUDE.md) so
only designated architects can merge. This is what enforces the Gate 2 deliver
PR review — not command access. Keeping the default branch protected is also why
RAD routes the plan doc through the deliver PR rather than committing it directly.

**GitHub** (replace `main` with your default branch):
```bash
gh api repos/:owner/:repo/branches/main/protection \
  --method PUT \
  --field required_pull_request_reviews='{"required_approving_review_count":1}'
```

### 4. Commit the installed files

```bash
git add .claude/ .agents/ scripts/ CLAUDE.md
git commit -m "chore: install RAD framework"
git push
```

### 5. Start the architecture process

In Claude Code, open your project and run:

```
/rad-research path/to/your-prd.md
```

See `docs/daily-workflow.md` for the full workflow from here.

---

## Upgrading

When a new version of RAD is available, re-run the installer with `--upgrade`:

```bash
bash /tmp/rad/install.sh --dir /path/to/your-project --upgrade
```

The upgrade overwrites `.claude/commands/`, `.claude/skills/`, and `scripts/`,
and never touches `CLAUDE.md`, `.claude/agents/`, or `.agents/` content. It works
whether or not the project was originally set up with the installer.

See **[UPGRADE.md](UPGRADE.md)** for the full guide, including upgrading
projects that didn't use the installer, a manual upgrade path, and how local
edits are handled.

---

## Uninstalling

RAD has no daemon or global state. To remove it from a project:

```bash
rm -rf .claude/commands/ .claude/skills/ scripts/
rm -rf .agents/research/ .agents/architecture/ .agents/plans/ .agents/logs/ .agents/findings/
rm CLAUDE.md
git add -A
git commit -m "chore: remove RAD framework"
```

If you want to keep your plan history but remove the commands:

```bash
rm -rf .claude/commands/ scripts/
git add .claude/commands/ scripts/
git commit -m "chore: remove RAD commands"
```

---

## Troubleshooting

**`/rad-status` shows "No agents defined"**
The architecture hasn't been generated yet. Run `/rad-research` then `/rad-design`
to produce the agent files. See `docs/architect-guide.md`.

**Platform CLI not found after install**
The `scripts/detect-platform.sh` will fall back to manual mode. Install `gh`
(GitHub) or `glab` (GitLab) and re-run. Manual mode is fully functional — it
prints PR creation instructions instead of automating them.

**Commands not appearing in Claude Code**
Claude Code discovers commands from `.claude/commands/` in the project root.
Verify the files are present and you've opened the correct directory in Claude Code.
Run `/rad-status` to confirm the command set loaded.

**CLAUDE.md not found after install**
The installer creates it from the RAD template. If it's missing, copy it manually:
```bash
cp /tmp/rad/CLAUDE.md /path/to/your-project/CLAUDE.md
```
