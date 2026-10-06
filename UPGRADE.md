# Upgrading RAD

RAD upgrades refresh only the framework-owned files — commands, skills, the
`ai/` guardrail pack, scripts, and the harness — and never touch your project's
configuration, agents, or work history. Framework files you have edited locally
are kept, not overwritten. The same process works whether or not the project was
originally set up with the installer.

---

## What an upgrade changes

| Path | On upgrade |
|------|-----------|
| `.claude/commands/` | **Refreshed** — unedited command files updated; locally edited ones kept |
| `.claude/skills/` | **Refreshed** — unedited RAD skills updated; locally edited ones kept |
| `ai/` | **Refreshed** — unedited guardrail files updated; locally edited ones (e.g. `slop-register.md`) kept |
| `scripts/` | **Refreshed** — `*.sh` helpers, `scripts/lib/`, and `scripts/hooks/`; locally edited files kept |
| `harness/` | **Refreshed** — everything except `harness/node_modules/`, which is never touched |
| `.rad/installed.json` | **Written / updated** — the install manifest (see [How upgrades handle local edits](#how-upgrades-handle-local-edits)) |
| Preset files | **Re-applied** when a preset is recorded in `.rad/installed.json` — from its recorded source, same keep-local-edits rules as core (see [Presets on upgrade](#presets-on-upgrade)) |
| `.rad/upgrade-pending/` | Written only when a local edit was kept — the new core version of each kept file |
| `.rad/upgrade-backup/` | Written only on the first upgrade of a pre-manifest install — backups of overwritten files |
| `CLAUDE.md` | Never touched — your project conventions |
| `.rad/config.yml` | Never touched — your config data (platform, default branch, roles, scope map). Created by `rad config migrate` only when missing |
| `.claude/agents/` | Never touched — your generated agent boundaries |
| `.agents/` | Never touched — your research, architecture, plans, logs, findings |

The upgrade also recreates any missing directories in the RAD structure, so a
project that predates newer directories (e.g. `.agents/findings/`) is healed
automatically.

### Presets on upgrade

`install.sh --upgrade` re-applies the recorded preset after the core upgrade
(`node harness/cli.js install-preset --reapply`). It reads the preset's source
directory from `.rad/installed.json` and picks up any changes there: new or
changed preset files are written, a locally edited preset file is kept with the
new version staged under `.rad/upgrade-pending/`, and a preset file you deleted
is reported `deleted` and not restored. With no preset recorded, the step does
nothing. If the recorded source directory is gone, the step fails naming the
path and the fix (pass `--preset <dir>`); `--upgrade --preset <dir>` installs
from the given directory instead. Settings are never re-seeded into an existing
`settings:` block. A preset problem never undoes the core upgrade; the installer
reports it at the end and exits 1.

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

`node` must be installed: the installer stops with a named error if it is
missing.

The installer prints one line per file it did not simply update (`keep:`,
`deleted:`, `backup-write:`, `stale:`). If it **kept a locally edited framework
file** or found one **deleted locally**, it still finishes every other step,
then exits 1 and points you to:

```bash
node harness/cli.js install-status
```

Resolve those files as described in
[How upgrades handle local edits](#how-upgrades-handle-local-edits), then commit
the refreshed files together with the manifest:

```bash
cd /path/to/your-project
git add .claude/commands/ .claude/skills/ ai/ scripts/ harness/ .rad/installed.json
git commit -m "chore: upgrade RAD framework to latest"
```

Run `/rad-status` in Claude Code afterward to confirm the new command set
loaded.

---

## Upgrading a project that didn't use the installer

You can still use the installer — and you should. `install.sh --upgrade` does
not require a prior manifest: with no `.rad/installed.json`, it treats the run as
the first upgrade of a pre-manifest install. Any framework file that differs
from the new version is backed up to `.rad/upgrade-backup/<timestamp>/<path>`
and then overwritten, and the manifest is written so later upgrades can detect
local edits. It also creates the expected directory structure and leaves your
data alone. A hand-assembled RAD project upgrades cleanly with the exact command
above.

### Manual upgrade (no script)

If you'd rather not run the installer, run the same core step it runs. This
lays down the framework files through the manifest, with the same kept-edit,
staging, and backup behavior:

```bash
cd /path/to/your-project
node /tmp/rad/harness/cli.js install-core --source /tmp/rad --target .

git add .claude/commands/ .claude/skills/ ai/ scripts/ harness/ .rad/installed.json
git commit -m "chore: upgrade RAD framework to latest"
```

`install-core` exits 0 when every file was written, 1 when it kept a local edit
or found a deleted file, and 2 (writing nothing) on bad arguments or a malformed
`.rad/installed.json`. A plain `cp` of the framework files also works, but it
overwrites local edits without a backup and leaves no manifest, so the next
upgrade cannot tell your edits apart from old framework versions.

Do **not** copy `CLAUDE.md`, `.rad/config.yml`, `.claude/agents/`, or `.agents/`
content — those belong to your project. If the project has no `.rad/config.yml`
yet, create it as described in
[Upgrading to .rad/config.yml (#87)](#upgrading-to-radconfigyml-87).

---

## How upgrades handle local edits

Every install and upgrade writes `.rad/installed.json`, a manifest of the
framework core files and the SHA-256 of the version RAD installed:

```json
{
  "version": 1,
  "rad_version": "<source git sha, or \"unknown\">",
  "installed_at": "2026-10-05T15:00:00.000Z",
  "files": {
    "scripts/lint-plan.sh": { "layer": "core", "sha256": "…" }
  }
}
```

Commit it with the rest of the install. The core set is `.claude/commands/**`,
`.claude/skills/**`, `ai/**`, `scripts/*.sh`, `scripts/lib/**`,
`scripts/hooks/**`, and `harness/**` except `harness/node_modules/**`
(`.DS_Store` files are skipped). `CLAUDE.md`, `.claude/agents/`,
`.claude/settings*.json`, `.agents/`, and `.rad/config.yml` are never in it.

On upgrade, each core file is compared with the manifest:

| Situation | What happens | Installer exit |
|-----------|--------------|----------------|
| File unchanged since the last install | Updated to the new version | 0 |
| File **edited locally** | **Kept.** The new version is staged at `.rad/upgrade-pending/<path>`. The manifest keeps the old baseline, so the edit is still detected next time | 1 |
| File **deleted locally** | Not restored; reported | 1 |
| No manifest, or no manifest entry for the file (first upgrade of a pre-manifest install), and the file differs from the new version | Backed up to `.rad/upgrade-backup/<timestamp>/<path>`, then overwritten | 0 |
| A symlink or directory where a framework file belongs | Never written through; treated as a local edit (kept, new version staged) | 1 |
| File in the manifest but no longer part of RAD | Reported as `stale`, left in place, dropped from the manifest | 0 |

Upgrade never deletes a `harness/node_modules/` the project installed itself.

### Checking for drift

```bash
node harness/cli.js install-status [--target <dir>]
```

It is read-only. When a preset is recorded it first prints
`preset: <name> <version> (<source>)`. Then it prints
`modified: [<layer>] <path>` for each tracked file that differs from the
manifest and `missing: [<layer>] <path>` for each one that is gone, where
`<layer>` is `core` or `preset`. Exit 0 means clean; 1 means drift (or no
`.rad/installed.json` yet); 2 means bad arguments or a malformed manifest.

### Merging a kept edit

Staged copies under `.rad/upgrade-pending/` are **not** cleared automatically.
For each one: merge your local edit with the staged new version into the file at
its normal path, then delete the staged copy. Do not commit
`.rad/upgrade-pending/`.

### A malformed manifest

If `.rad/installed.json` cannot be parsed or has the wrong shape, the install
stops before any framework file is written (`install-core` exits 2 and the
installer exits non-zero). Fix the file, or delete it. Deleting it makes the next
upgrade behave like a first upgrade: any differing framework file is backed up
to `.rad/upgrade-backup/` and then overwritten.

### Where customizations belong

Project-specific behavior still belongs in `CLAUDE.md`, `ai/slop-register.md`,
or your generated agent files rather than the framework commands. A kept edit to
a command or script has to be merged by hand on every upgrade that changes it.

Org- and client-wide defaults (shared hooks, guardrail extensions, agent files,
docs, and settings) belong in a preset rather than in edits to core files: a
preset is tracked separately, re-applied on every upgrade, and never conflicts
with core. See [INSTALL.md](INSTALL.md#presets).

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

## Moving conventions to AGENTS.md (#171)

RAD now keeps project conventions in `AGENTS.md`, which Codex reads natively,
and a small `CLAUDE.md` that imports it with `@AGENTS.md`. Fresh installs get
both files. An upgrade never edits or overwrites your files:

| Your project has | `install.sh --upgrade` does |
|------------------|-----------------------------|
| neither file | copies both templates |
| `AGENTS.md` only | copies only the `CLAUDE.md` stub |
| `CLAUDE.md` only | adds nothing and prints a one-line hint pointing here |
| both | nothing |

**Nothing breaks if you don't move.** Every RAD reader takes conventions from
`AGENTS.md` when it exists, otherwise from `CLAUDE.md`, so a project that keeps
its conventions in `CLAUDE.md` works as before.

### The manual move

1. Create `AGENTS.md` in the project root from the conventions in your
   `CLAUDE.md` (Project, Stack, Structure, Commands, Architecture Decisions,
   Coding Conventions, Testing Standards, Never Do, Known Constraints, and so
   on). Move the text as it is; reword a rule only where it names Claude but
   applies to any agent.
2. In `CLAUDE.md`, replace those sections with the single line `@AGENTS.md`.
   Claude Code expands the import when it loads `CLAUDE.md` at session start.
3. Keep Claude-only notes in `CLAUDE.md`, below the import: namespaced command
   names, hooks such as the deliver gate, and maintenance notes about
   `CLAUDE.md` itself. RAD's own `CLAUDE.md` is an example.
4. Check both files against the budgets, then commit:
   ```bash
   scripts/lint-claude-md.sh
   git add AGENTS.md CLAUDE.md
   git commit -m "docs: move conventions to AGENTS.md"
   ```

Once `AGENTS.md` exists it is the conventions file: readers do not fall back to
`CLAUDE.md` for a section it lacks, so move every convention in one step. See
[docs/maintaining-claude-md.md](docs/maintaining-claude-md.md) for the split
and the budgets (150 lines each; 32 KiB for `AGENTS.md`).

---

## See also

- [INSTALL.md](INSTALL.md) — first-time installation and uninstalling
- [docs/daily-workflow.md](docs/daily-workflow.md) — the team workflow
- [docs/architect-guide.md](docs/architect-guide.md) — architecture setup and maintenance
