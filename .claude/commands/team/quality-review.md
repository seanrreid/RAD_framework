---
description: >
  Run the quality-reviewer agent on the current diff or specified files.
  Checks security, error handling, null safety, input validation, naming,
  and CLAUDE.md conventions. Standalone — does not require a plan file.
---

# /quality-review

Run a quality review on the current branch changes or specified files.

## Input

`$ARGUMENTS` (optional):
- Empty → reviews all files changed since branching from main
- File paths → reviews only those files
- `--staged` → reviews only staged changes

---

## Process

Invoke the `quality-reviewer` agent with `$ARGUMENTS` as context.

The agent will:
1. Read `CLAUDE.md` for project conventions and stack info
2. Get the relevant diff or file list
3. Apply universal quality checks + convention checks
4. Output a structured findings report

---

## Output

The agent's findings are displayed directly. No additional formatting needed.

If run as part of `/rad-review`, findings feed into the review's convention
check step.
