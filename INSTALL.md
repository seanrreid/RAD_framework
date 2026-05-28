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
├── .agents/
│   ├── research/                     ← /rad-research output
│   ├── architecture/                 ← /rad-design drafts
│   ├── plans/                        ← /rad-plan output
│   ├── logs/                         ← /rad-deliver execution logs
│   └── findings/                     ← /rad-review findings log
└── scripts/
    ├── detect-platform.sh
    ├── open-pr.sh
    ├── check-plan-approved.sh
    ├── check-scope.sh
    ├── lint-plan.sh
    └── rad-status.sh
```

`.claude/agents/` is not populated at install time — the architecture process
(`/rad-research` → `/rad-design`) generates those files for your specific project.

---

## Post-Install Setup

### 1. Fill in CLAUDE.md

Open `CLAUDE.md` and complete every section. The RAD Configuration section
is critical — it defines your platform, team roles, and branch conventions.

### 2. Create platform labels

**GitHub:**
```bash
gh label create 'rad:plan'            --color '0075ca' --description 'RAD plan PR'
gh label create 'rad:pending-review'  --color 'e4e669' --description 'Awaiting architect review'
gh label create 'rad:deliver'         --color '0e8a16' --description 'RAD delivery PR'
```

**GitLab:**
```bash
glab label create 'rad:plan'           --color '#0075ca'
glab label create 'rad:pending-review' --color '#e4e669'
glab label create 'rad:deliver'        --color '#0e8a16'
```

### 3. Set up branch protection (recommended)

Protect `main` so only designated architects can merge. This is what enforces
the approval gates — not command access.

**GitHub:**
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

The upgrade overwrites `.claude/commands/` and `scripts/`, and never touches
`CLAUDE.md`, `.claude/agents/`, or `.agents/` content. It works whether or not
the project was originally set up with the installer.

See **[UPGRADE.md](UPGRADE.md)** for the full guide, including upgrading
projects that didn't use the installer, a manual upgrade path, and how local
edits are handled.

---

## Uninstalling

RAD has no daemon or global state. To remove it from a project:

```bash
rm -rf .claude/commands/ scripts/
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
