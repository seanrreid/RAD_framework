# Maintaining AGENTS.md and CLAUDE.md

Project conventions are the most important context in this template. They are the permanent, always-loaded facts that every session starts with. Keeping them accurate and dense is what makes the difference between an agent needing constant correction and an agent just working.

---

## The split: AGENTS.md and CLAUDE.md

RAD keeps conventions in two files (#171):

| File | Holds | Read by |
|------|-------|---------|
| `AGENTS.md` | The project conventions: Project, Stack, Structure, Commands, Architecture Decisions, Coding Conventions, Testing Standards, What the Agent Must Never Do, Known Constraints, RAD Configuration, Workflow | Codex natively; Claude Code through the import in `CLAUDE.md`; every RAD reader |
| `CLAUDE.md` | A short header, the line `@AGENTS.md`, and a "Claude Code specifics" section (namespaced commands, the deliver-gate hook, maintenance notes) | Claude Code at session start |

Edit conventions in `AGENTS.md`. Put only Claude Code-specific material in `CLAUDE.md`. A fresh install scaffolds both files.

**`@AGENTS.md` only works at session start.** Claude Code expands the import when it loads `CLAUDE.md` into a session. A direct read of `CLAUDE.md` (by a reviewer agent, a skill, or a script) returns the import line, not the conventions. That is why RAD's readers go to `AGENTS.md` directly.

### The fallback

Every RAD reader (the reviewers, `/rad-review`, `/kickoff`, `/rad-epic-decompose`, `/rad-insights`, `scripts/draft-insights-plan.sh`) takes project conventions from `AGENTS.md` when it exists in the project root, otherwise from `CLAUDE.md`. A project that keeps its conventions in `CLAUDE.md` works unchanged; installs and upgrades never move or edit an existing `CLAUDE.md`. To move, follow [UPGRADE.md "Moving conventions to AGENTS.md (#171)"](../UPGRADE.md#moving-conventions-to-agentsmd-171).

Once `AGENTS.md` exists it is the conventions file: readers do not fall back to `CLAUDE.md` for a section `AGENTS.md` lacks.

### The budgets

`scripts/lint-claude-md.sh` (CI job `claude-md-budget`, advisory) checks both files:

- **150 lines** each for `AGENTS.md` and `CLAUDE.md`. Every line costs tokens in every session.
- **32 KiB (32,768 bytes)** for `AGENTS.md`, Codex's default `project_doc_max_bytes`. Codex truncates a larger file.

Run it with no argument to check whichever of the two files exist, or pass a path to check one file.

---

## What belongs in AGENTS.md

**Stable, verified facts about the project.** Things that are true every session and won't change without a deliberate decision.

✅ Include:
- Stack and dependencies (exact versions matter)
- Project structure (directory layout, key file purposes)
- Run commands (exact commands, not paraphrased)
- Coding conventions (specific rules, not vague aspirations)
- Architecture decisions with file references
- Testing standards and ratios
- Hard constraints ("never do X")
- Known gotchas and non-obvious system behaviors

❌ Don't include:
- In-progress feature status (put that in plan files)
- Session-specific notes (put that in compaction artifacts)
- Vague quality goals ("write clean code")
- Things you haven't verified are actually true
- Long explanations — dense facts only

---

## The density principle

Every line in `AGENTS.md` and `CLAUDE.md` costs tokens in every session. Earn those tokens. A line like:

> "Write good, clean, maintainable code"

burns tokens and communicates nothing the agent doesn't already do. Replace it with:

> "All functions must have Google-style docstrings. See `backend/app/routers/habits.py:25` for the pattern."

That's a concrete, verifiable fact that the agent can act on.

---

## When to update it

Update `AGENTS.md` immediately when you:

- Add a new dependency or change a version
- Change the directory structure
- Make an architectural decision that will affect future work
- Discover a non-obvious constraint or gotcha
- Establish a new convention the team agrees on
- Change the test setup or commands

Don't batch these up. Stale conventions are actively harmful — the agent will make decisions based on outdated information and you'll spend session time correcting it.

---

## How to update it

1. Make the change in `AGENTS.md` directly (in `CLAUDE.md` only for Claude Code specifics)
2. Verify the fact against the actual codebase — don't write from memory
3. Include a file reference where possible: `see backend/app/database.py:10`
4. Commit it with the code change it describes: `docs: update AGENTS.md with WAL mode constraint`

---

## Signs the conventions need attention

- The agent references files that don't exist
- The agent uses libraries not in the project
- The agent asks questions about things that should be obvious from the project structure
- You're correcting the same thing across multiple sessions
- The project structure section no longer matches reality

Any of these means `AGENTS.md` has drifted from the codebase. Fix it before the next session.

---

## The review habit

Do a quick review of `AGENTS.md` and `CLAUDE.md` monthly, or after any significant refactor:

1. Read every section
2. Verify each fact against the actual codebase
3. Remove anything that's no longer true
4. Add anything that's become true
5. Commit the update: `docs: AGENTS.md monthly review [date]`

This takes 15 minutes and saves hours of correction over time.

---

## Nested CLAUDE.md files

You can have a `CLAUDE.md` in subdirectories for domain-specific context:

```
project/
├── AGENTS.md              ← project-wide conventions
├── CLAUDE.md              ← imports AGENTS.md (always loaded)
├── backend/
│   └── CLAUDE.md          ← backend-specific conventions (loaded when in backend/)
└── frontend/
    └── CLAUDE.md          ← frontend-specific conventions (loaded when in frontend/)
```

Use nested files for domain-specific conventions that would clutter the root file. Keep the root file focused on project-wide facts.
