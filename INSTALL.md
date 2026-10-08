# Installing RAD

RAD ships with an install script that handles the full setup — directory
structure, commands, scripts, and CLAUDE.md scaffolding — in one step.

---

## Prerequisites

| Tool | Required | Purpose |
|------|----------|---------|
| `git` | Yes | RAD requires a git repository |
| `claude` CLI | Yes | Claude Code — [install here](https://claude.ai/code) |
| `node` | Yes | Runs `harness/cli.js`, which lays down the framework files. The installer stops with a named error if it is missing |
| `gh` or `glab` | Recommended | PR automation. RAD falls back to manual mode without one |

---

## Quick Install

Clone the RAD repo and run the installer from your project directory:

```bash
git clone https://github.com/seanrreid/RAD_framework /tmp/rad
cd /path/to/your-project
bash /tmp/rad/install.sh
```

Or point directly at your project:

```bash
bash /tmp/rad/install.sh --dir /path/to/your-project
```

The script will prompt for any information it needs.

To apply a team preset in the same run, add `--preset <dir>` (see
[Presets](#presets)):

```bash
bash /tmp/rad/install.sh --dir /path/to/your-project --preset /path/to/team-preset
```

---

## Non-Interactive Install

For CI pipelines or scripted setup, skip all prompts:

```bash
bash /tmp/rad/install.sh --dir /path/to/your-project --yes
```

`--preset <dir>` works the same way with `--yes`.

---

## What Gets Installed

```
your-project/
├── AGENTS.md                         ← scaffolded from template (project conventions)
├── CLAUDE.md                         ← scaffolded stub: `@AGENTS.md` + Claude Code specifics
├── .rad/
│   ├── config.yml                    ← .rad/config.yml, written by `rad config init` (platform, roles, scope map)
│   └── installed.json                ← install manifest: framework files + hashes (commit it)
├── .claude/
│   └── commands/
│       ├── architect/
│       │   ├── rad-design.md         → /rad-design
│       │   └── rad-approve.md        → /rad-approve
│       ├── team/
│       │   ├── rad-research.md       → /rad-research
│       │   ├── rad-plan.md           → /rad-plan
│       │   ├── rad-adopt.md          → /rad-adopt
│       │   ├── rad-deliver.md        → /rad-deliver (generated from .rad/skills/)
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
│   ├── logs/                         ← optional wave execution logs (nothing gates on them)
│   └── findings/                     ← /rad-review findings log
├── ai/                               ← guardrail pack (see below)
├── harness/                          ← `rad` CLI (harness/cli.js)
└── scripts/
    ├── detect-platform.sh
    ├── get-default-branch.sh
    ├── checkout-plan.sh
    ├── rad-label.sh
    ├── open-pr.sh
    ├── check-plan-approved.sh
    ├── check-scope.sh
    ├── lint-plan.sh
    ├── rad-status.sh
    ├── lib/
    │   └── plan-paths.sh             ← shared plan-path helpers (lint-plan, check-scope, …)
    └── hooks/                        ← wave lifecycle hooks
```

The installer also copies the RAD skills into `.claude/skills/` (`kickoff/` and
`wrap/`, providing `/kickoff` and `/wrap`) alongside all `scripts/*.sh` helpers.

Every framework file the installer lays down (`.claude/commands/`,
`.claude/skills/`, `ai/`, `scripts/`, and `harness/` except
`harness/node_modules/`) is recorded with its SHA-256 in `.rad/installed.json`.
Commit the manifest with the rest of the install: upgrades use it to tell an
unedited framework file (safe to update) from one you changed (kept). Check for
drift at any time with `node harness/cli.js install-status`. See
[UPGRADE.md](UPGRADE.md#how-upgrades-handle-local-edits).

`.claude/agents/` is not populated at install time — the architecture process
(`/rad-research` → `/rad-design`) generates those files for your specific project.

### Presets

A preset is a team's add-on layer: extra hooks, guardrail extensions, agent
files, docs, and default settings, installed on top of the core framework and
tracked in the same `.rad/installed.json`. Use one for org- or client-wide
defaults that every project should get.

A preset directory holds `preset.yml` (`name`, kebab-case; `version`, a string;
optional `settings` with `high_risk_patterns` and/or `hooks_dir`) and an optional
`files/` tree that mirrors the target project. Preset files may only land under
`scripts/hooks/`, `ai/extensions/`, `.claude/agents/`, or `docs/`.

```bash
bash /tmp/rad/install.sh --dir /path/to/your-project --preset /path/to/team-preset
# or, in a project that already has RAD installed:
node harness/cli.js install-preset --source /path/to/team-preset
```

- **Add-only.** A path the core layer already owns is refused and nothing is
  written.
- **Local edits are kept**, the same as core files: the new version is staged
  under `.rad/upgrade-pending/`. A preset file you deleted is reported
  `deleted` and not restored.
- **Settings are seeded only when absent.** If `.rad/config.yml` has no
  `settings:` block, the preset's settings are appended as one. If a block
  already exists, the config is left untouched and each missing key is reported
  as `unseeded` for you to add by hand.
- **One preset per project.** The manifest records its name, version, and
  absolute source path; installing a preset with a different name is refused.
- **A preset problem never undoes core.** The core install is kept; the
  installer reports the preset failure at the end and exits 1.

A preset needs `.rad/config.yml`; if the config step failed, the preset step is
skipped. The RAD repo ships a working example in `presets/example/` (it is not
installed into projects); its README covers the layout in full. The CLI verbs
are documented in [docs/rad-cli.md](docs/rad-cli.md#install-commands).

---

## Guardrail Pack

RAD ships a guardrail pack in `ai/` that gives every wave agent a consistent
set of coding rules. The pack is treated as framework code — it is refreshed on
install and upgrade, the same as `.claude/commands/` and `scripts/`, and local
edits to it are kept the same way.

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

Your edits survive upgrades. Because the file differs from the version recorded
in `.rad/installed.json`, `install.sh --upgrade` keeps your copy and stages the
new framework version at `.rad/upgrade-pending/ai/slop-register.md` (the
installer then exits 1 and points to `node harness/cli.js install-status`).
Merge in anything new from the staged copy, then delete it.

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

Wave agents follow the smallest-relevant-set principle:

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

### 1. Review `.rad/config.yml`, then fill in AGENTS.md

`.rad/config.yml` is the single source for RAD's config data: `platform`,
`default_branch`, `roles` (architect, developers, designers), the optional
`agent` (the wave agent `rad deliver` runs), and the `agent_scope_map`. On a
fresh install, `install.sh` writes it with
`rad config init` and prints the result for review:

- `roles.architect` defaults to the installer's `git config user.email`. To use a
  different identity, re-run with `./install.sh --architect <id>` (or run
  `node harness/cli.js config init --architect <id> --force`).
- `platform` defaults to `manual` and `default_branch` to `main`; edit the file
  to change them.
- `agent` is set with `./install.sh --agent claude|codex`, which writes the
  preset (`claude` → `adapter: command`, `command: claude -p`; `codex` →
  `command: codex exec`). Without `--agent`, a fresh **interactive** install
  asks which agent to use — `claude`, `codex`, or `skip` (default `claude`);
  `skip` writes no `agent:`. `--yes` without `--agent` writes none and never
  prompts. Upgrades never prompt and never change an existing config. With no
  `agent:` (and no `RAD_AGENT`/`RAD_AGENT_CMD` in the environment),
  `rad deliver` — and so `/rad-deliver`, which runs it — refuses with exit 2;
  add the block to the file later (see
  [Agent Adapter](docs/configuration.md#agent-adapter)).
- Check the file at any time with:
  ```bash
  node harness/cli.js config validate
  ```

If the config could not be written (for example, no git identity and no
`--architect`), `install.sh` finishes the rest of the install, then exits 1 and
prints the exact `rad config init` command to run.

Then open `AGENTS.md` and complete every section. AGENTS.md holds your
project conventions (stack, structure, commands, coding and testing standards);
RAD's config data lives in `.rad/config.yml`, not in either conventions file.
`CLAUDE.md` imports AGENTS.md with `@AGENTS.md` and holds only Claude Code
specifics; leave conventions out of it.

The installer never overwrites an existing file. If the project already had
`AGENTS.md`, only the `CLAUDE.md` stub is added. If it already had `CLAUDE.md`
but no `AGENTS.md`, neither file is added: RAD reads conventions from
`CLAUDE.md` as the fallback, and the installer prints a hint pointing to
[UPGRADE.md "Moving conventions to AGENTS.md (#171)"](UPGRADE.md#moving-conventions-to-agentsmd-171).
See [docs/maintaining-claude-md.md](docs/maintaining-claude-md.md) for the split.

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

Protect your default branch (the one set as `default_branch:` in `.rad/config.yml`) so
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
git add .claude/ .agents/ .rad/ ai/ scripts/ harness/ CLAUDE.md   # .rad/ holds config.yml and installed.json
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

The upgrade refreshes the framework files (`.claude/commands/`,
`.claude/skills/`, `ai/`, `scripts/`, `harness/`) and updates
`.rad/installed.json`. A framework file you edited locally is kept, not
overwritten: the new version is staged under `.rad/upgrade-pending/`, and the
installer finishes, then exits 1 and points to `node harness/cli.js install-status`.
It never touches `CLAUDE.md`, `.claude/agents/`, `.agents/` content, or an existing
`.rad/config.yml`. If `.rad/config.yml` is missing, the upgrade runs
`rad config migrate` to create it from the pre-#87 RAD Configuration block in
CLAUDE.md (never with `--force`, never editing CLAUDE.md). It works whether or not
the project was originally set up with the installer.

If a preset is recorded in `.rad/installed.json`, `--upgrade` re-applies it from
its recorded source after the core upgrade (the same as
`node harness/cli.js install-preset --reapply`), picking up any changes in that
source. Pass `--preset <dir>` with `--upgrade` to install or update from a given
directory instead. If the recorded source directory is gone, the preset step
fails naming the path; core is still upgraded and the installer exits 1.

See **[UPGRADE.md](UPGRADE.md)** for the full guide, including upgrading
projects that didn't use the installer, a manual upgrade path, and how local
edits are handled.

---

## Uninstalling

RAD has no daemon or global state. To remove it from a project:

```bash
rm -rf .claude/commands/ .claude/skills/ scripts/
rm -rf .agents/research/ .agents/architecture/ .agents/plans/ .agents/logs/ .agents/findings/
rm -rf .rad/                          # removes .rad/config.yml
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

**Scripts fail with `rad: no .rad/config.yml`**
RAD reads its platform, default branch, and roles only from `.rad/config.yml`.
Create it with one of:
```bash
node harness/cli.js config init --architect <id>   # new install
node harness/cli.js config migrate                 # from a pre-#87 CLAUDE.md
```
then run `node harness/cli.js config validate`.

**Commands not appearing in Claude Code**
Claude Code discovers commands from `.claude/commands/` in the project root.
Verify the files are present and you've opened the correct directory in Claude Code.
Run `/rad-status` to confirm the command set loaded.

**AGENTS.md or CLAUDE.md not found after install**
The installer copies each from the RAD template only when the project has
neither file, or (for the `CLAUDE.md` stub) when it already has `AGENTS.md`. A
project with only `CLAUDE.md` keeps it as the conventions file and gets no
`AGENTS.md`; that is expected (see UPGRADE.md "Moving conventions to AGENTS.md
(#171)"). If a file is missing otherwise, copy it manually:
```bash
cp /tmp/rad/AGENTS.md /path/to/your-project/AGENTS.md
cp /tmp/rad/CLAUDE.md /path/to/your-project/CLAUDE.md
```
