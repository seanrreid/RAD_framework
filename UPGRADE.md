# Upgrading RAD

RAD upgrades replace only the framework-owned files — commands and scripts —
and never touch your project's configuration, agents, or work history. The
same process works whether or not the project was originally set up with the
installer.

---

## What an upgrade changes

| Path | On upgrade |
|------|-----------|
| `.claude/commands/` | **Overwritten** — all command files refreshed |
| `scripts/` | **Overwritten** — all `*.sh` helpers refreshed |
| `CLAUDE.md` | Never touched — your project configuration |
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
git clone https://github.com/torchcodelab/rad-framework /tmp/rad
# (already cloned? refresh it instead)
#   cd /tmp/rad && git pull

# 2. Upgrade your project in place
bash /tmp/rad/install.sh --dir /path/to/your-project --upgrade
```

Then commit the refreshed files:

```bash
cd /path/to/your-project
git add .claude/commands/ scripts/
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
cp /tmp/rad/scripts/*.sh scripts/
chmod +x scripts/*.sh

git add .claude/commands/ scripts/
git commit -m "chore: upgrade RAD framework to latest"
```

Do **not** copy `CLAUDE.md`, `.claude/agents/`, or `.agents/` content — those
belong to your project.

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

## See also

- [INSTALL.md](INSTALL.md) — first-time installation and uninstalling
- [docs/daily-workflow.md](docs/daily-workflow.md) — the team workflow
- [docs/architect-guide.md](docs/architect-guide.md) — architecture setup and maintenance
