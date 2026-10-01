# Upgrading RAD

RAD upgrades replace only the framework-owned files — commands, skills, and
scripts — and never touch your project's configuration, agents, or work history. The
same process works whether or not the project was originally set up with the
installer.

---

## What an upgrade changes

| Path | On upgrade |
|------|-----------|
| `.claude/commands/` | **Overwritten** — all command files refreshed |
| `.claude/skills/` | **Overwritten** — all RAD skills refreshed |
| `scripts/` | **Overwritten** — all `*.sh` helpers refreshed |
| `CLAUDE.md` | Never touched — your project conventions |
| `.rad/config.yml` | Never touched — your config data (platform, default branch, roles, scope map). Created by `rad config migrate` only when missing |
| `.claude/agents/` | Never touched — your generated agent boundaries |
| `.agents/` | Never touched — your research, architecture, plans, logs, findings |

The upgrade also recreates any missing directories in the RAD structure, so a
project that predates newer directories (e.g. `.agents/findings/`) is healed
automatically.

---

## Standard upgrade (installer)

This is the recommended path for every project — including ones that were set
up by hand.

```bash
# 1. Get the latest framework source
git clone https://github.com/seanrreid/RAD_framework /tmp/rad
# (already cloned? refresh it instead)
#   cd /tmp/rad && git pull

# 2. Upgrade your project in place
bash /tmp/rad/install.sh --dir /path/to/your-project --upgrade
```

Then commit the refreshed files:

```bash
cd /path/to/your-project
git add .claude/commands/ .claude/skills/ scripts/
git commit -m "chore: upgrade RAD framework to latest"
```

Run `/rad-status` in Claude Code afterward to confirm the new command set
loaded.

---

## Upgrading a project that didn't use the installer

You can still use the installer — and you should. `install.sh --upgrade`
depends on no prior installer state, marker file, or manifest. It is a plain,
idempotent copy: it creates the expected directory structure, copies commands
and scripts over whatever is present, and leaves your data alone. A
hand-assembled RAD project upgrades cleanly with the exact command above.

### Manual upgrade (no script)

If you'd rather not run the installer, the upgrade is just two copies — the
script does nothing more for the command/script files:

```bash
cd /path/to/your-project
cp -r /tmp/rad/.claude/commands/. .claude/commands/
cp -r /tmp/rad/.claude/skills/. .claude/skills/
cp /tmp/rad/scripts/*.sh scripts/
chmod +x scripts/*.sh

git add .claude/commands/ .claude/skills/ scripts/
git commit -m "chore: upgrade RAD framework to latest"
```

Do **not** copy `CLAUDE.md`, `.rad/config.yml`, `.claude/agents/`, or `.agents/`
content — those belong to your project. If the project has no `.rad/config.yml`
yet, create it as described in
[Upgrading to .rad/config.yml (#87)](#upgrading-to-radconfigyml-87).

---

## A note on local edits

The upgrade replaces commands and scripts wholesale. If anyone has **locally
edited** a RAD command or script inside the project, those edits are
overwritten. Run `git diff` after upgrading to see exactly what changed and
re-apply any customizations.

For this reason, project-specific behavior belongs in `CLAUDE.md` or your
generated agent files — not in the framework commands, which are designed to be
replaceable on every upgrade.

---

## Upgrading to RAD v2 (Lane B)

RAD v2 changes the branch and approval model. The upgrade itself is the same
command as any other (`install.sh --upgrade`), but the workflow you use
afterward changes. Read this before upgrading a project with active work.

### What changed

**One work branch per feature.** The old two-branch model (`plan/[feature]`
for the plan, `deliver/[feature]` for the code) is retired. Each feature now
lives on a single `rad/[feature]` branch, cradle to grave: `/rad-plan` cuts it
from the default branch and commits the plan doc, `/rad-approve` records
approval on it, and `/rad-deliver` runs on it and opens the PR. The branch name
is recorded in the plan doc's `Branch:` header.

**No plan PR.** There is no longer a Gate 1 plan PR, no `rad:plan` /
`rad:pending-review` labels, and nothing to merge for approval. `/rad-approve`
writes `Status: approved` to the plan doc at the `rad/[feature]` branch **tip**
and pushes that branch — it never commits to the default branch. The plan doc
reaches the default branch later, together with the code, through the single
deliver PR (`rad:deliver`). This keeps contributors off the protected default
branch.

**Gates.** Gate 1 is `/rad-approve` on the branch tip (no PR). Gate 2 is the
deliver PR being reviewed and merged.

**Default branch is configurable.** Nothing hardcodes `main` anymore. Set
`default_branch:` in `.rad/config.yml`; the framework resolves it via
`scripts/get-default-branch.sh`.

**Proxy approval.** A non-architect can record an approval the architect gave
out-of-band:
`/rad-approve <feature> --on-behalf-of "<architect>" --evidence "<cite>"`.

**Plan docs gained sections.** New plans include `## Scope` and
`## Acceptance Criteria`.

### New scripts

The upgrade installs three new helpers into `scripts/`:

- `get-default-branch.sh` — resolves the default branch from `.rad/config.yml`
- `checkout-plan.sh` — checks out a plan's `rad/[feature]` branch
- `rad-label.sh` — applies RAD labels to a PR

### New skills

Two new skills land in `.claude/skills/`:

- `kickoff/` → `/kickoff` — session-start ritual
- `wrap/` → `/wrap` — session-end ritual

### Handling in-flight work

The upgrade only refreshes framework files; it does not migrate existing
branches. Any feature already on `plan/[feature]` or `deliver/[feature]`
branches should either:

- **Finish under the old flow** before upgrading the way you work on it (merge
  its plan PR and complete its deliver PR as before), or
- **Recreate it under Lane B** — re-run `/rad-plan` (or `/rad-adopt`) for the
  feature to cut a fresh `rad/[feature]` branch, then proceed through
  `/rad-approve` and `/rad-deliver`.

Don't try to convert a live `plan/`/`deliver/` pair into a single `rad/` branch
by hand.

### Update your labels

Drop the old `rad:plan` plan-PR label (unused in v2). Keep `rad:deliver`. Note
that `rad:pending-review` is no longer a plan-PR label — it is now one of the
`rad:<status>` board labels that `scripts/rad-label.sh` creates and manages
automatically on first use. See INSTALL.md for the current label set.

---

## Upgrading to .rad/config.yml (#87)

RAD's config data (`platform`, `default_branch`, `roles`, and the
`agent_scope_map`) moved out of CLAUDE.md into `.rad/config.yml`. This is a
**hard cutover**: the scripts and harness read only `.rad/config.yml`, and they
error with `rad: no .rad/config.yml` when it is missing. They no longer read the
RAD Configuration block in CLAUDE.md.

### Automatic: `install.sh --upgrade`

When `.rad/config.yml` is missing, `install.sh --upgrade` runs
`rad config migrate`, which reads the pre-#87 RAD Configuration block in your
CLAUDE.md and writes `.rad/config.yml`. It never passes `--force` (an existing
config is left alone) and never edits CLAUDE.md. Review and commit the result:

```bash
node harness/cli.js config validate
git add .rad/
git commit -m "chore: add .rad/config.yml"
```

### Afterward: remove the old block from CLAUDE.md

`rad config migrate` prints the line ranges of the config blocks it read. Once
`.rad/config.yml` is committed, delete those blocks (Git Platform, Role
Assignments, Agent Scope Map) from CLAUDE.md by hand. They are no longer read,
so leaving them only invites drift.

### Manual path

Run the migration yourself from the project root:

```bash
node harness/cli.js config migrate [--from <path>]
node harness/cli.js config validate
```

`--from` points at a CLAUDE.md other than `./CLAUDE.md`. The migration refuses
to overwrite an existing `.rad/config.yml` unless you pass `--force`, and it
fails (writing nothing) if a required key is missing or still a template
placeholder. If you have no pre-#87 CLAUDE.md block to migrate from, create a
fresh config instead:

```bash
node harness/cli.js config init --architect <id>
```

---

## See also

- [INSTALL.md](INSTALL.md) — first-time installation and uninstalling
- [docs/daily-workflow.md](docs/daily-workflow.md) — the team workflow
- [docs/architect-guide.md](docs/architect-guide.md) — architecture setup and maintenance
