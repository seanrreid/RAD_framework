# Maintaining CLAUDE.md

`CLAUDE.md` is the most important file in this template. It's the permanent, always-loaded context that every session starts with. Keeping it accurate and dense is what makes the difference between Claude needing constant correction and Claude just working.

---

## What belongs in CLAUDE.md

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

Every line in `CLAUDE.md` costs tokens in every session. Earn those tokens. A line like:

> "Write good, clean, maintainable code"

burns tokens and communicates nothing Claude doesn't already do. Replace it with:

> "All functions must have Google-style docstrings. See `backend/app/routers/habits.py:25` for the pattern."

That's a concrete, verifiable fact that Claude can act on.

---

## When to update it

Update `CLAUDE.md` immediately when you:

- Add a new dependency or change a version
- Change the directory structure
- Make an architectural decision that will affect future work
- Discover a non-obvious constraint or gotcha
- Establish a new convention the team agrees on
- Change the test setup or commands

Don't batch these up. Stale `CLAUDE.md` is actively harmful — Claude will make decisions based on outdated information and you'll spend session time correcting it.

---

## How to update it

1. Make the change in `CLAUDE.md` directly
2. Verify the fact against the actual codebase — don't write from memory
3. Include a file reference where possible: `see backend/app/database.py:10`
4. Commit it with the code change it describes: `docs: update CLAUDE.md with WAL mode constraint`

---

## Signs CLAUDE.md needs attention

- Claude references files that don't exist
- Claude uses libraries not in the project
- Claude asks questions about things that should be obvious from the project structure
- You're correcting the same thing across multiple sessions
- The project structure section no longer matches reality

Any of these means `CLAUDE.md` has drifted from the codebase. Fix it before the next session.

---

## The CLAUDE.md review habit

Do a quick `CLAUDE.md` review monthly, or after any significant refactor:

1. Read every section
2. Verify each fact against the actual codebase
3. Remove anything that's no longer true
4. Add anything that's become true
5. Commit the update: `docs: CLAUDE.md monthly review [date]`

This takes 15 minutes and saves hours of correction over time.

---

## Nested CLAUDE.md files

You can have a `CLAUDE.md` in subdirectories for domain-specific context:

```
project/
├── CLAUDE.md              ← project-wide context (always loaded)
├── backend/
│   └── CLAUDE.md          ← backend-specific conventions (loaded when in backend/)
└── frontend/
    └── CLAUDE.md          ← frontend-specific conventions (loaded when in frontend/)
```

Use nested files for domain-specific conventions that would clutter the root file. Keep the root file focused on project-wide facts.
