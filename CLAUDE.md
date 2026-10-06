# Project Context (Claude Code)

> Always-loaded into every Claude Code session.
> Project conventions live in `AGENTS.md`, imported below. Edit them there.
> This file holds only what is specific to Claude Code.

@AGENTS.md

---

## Claude Code specifics

**Namespaced commands.** RAD's commands are namespaced by role directory
under `.claude/commands/`; a bare `/rad-plan` does not resolve. Use:

- Team: `/team:rad-plan`, `/team:rad-adopt`, `/team:rad-research`,
  `/team:rad-deliver`, `/team:rad-review`, `/team:quality-review`,
  `/team:accessibility-review`
- Architect: `/architect:rad-approve`, `/architect:rad-design`,
  `/architect:rad-epic-decompose`
- Shared: `/shared:rad-status`, `/shared:rad-insights`

**Deliver-gate hook.** The never-deliver-unapproved rule in `AGENTS.md` is
ALSO deterministically enforced by a PreToolUse hook
(`scripts/deliver-gate-hook.mjs`, registered in `.claude/settings.json`) that
blocks an unapproved /rad-deliver Skill call fail-closed (exit 2) — not prose
alone.

**Maintaining this file.**
- `@AGENTS.md` is expanded only when Claude Code loads this file at session
  start. A direct read of `CLAUDE.md` returns the import line, so tools and
  agents that read conventions directly read `AGENTS.md` (or `CLAUDE.md` if the
  project has no `AGENTS.md`).
- Keep conventions in `AGENTS.md`; keep only Claude Code material here. Both
  files are checked by `scripts/lint-claude-md.sh` against the 150-line
  advisory budget. See `docs/maintaining-claude-md.md`.
