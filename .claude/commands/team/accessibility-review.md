---
description: >
  Run the accessibility-reviewer agent on the current diff or specified files.
  Checks WCAG 2.1 AA: semantic HTML, ARIA, keyboard navigation, focus management,
  color contrast, and screen reader support. Stack-agnostic. Standalone — does
  not require a plan file.
---

# /accessibility-review

Run a WCAG 2.1 AA accessibility review on changed frontend files or specified files.

## Input

`$ARGUMENTS` (optional):
- Empty → reviews all frontend files changed since branching from main
- File paths → reviews only those files

---

## Process

Invoke the `accessibility-reviewer` agent with `$ARGUMENTS` as context.

The agent will:
1. Identify relevant frontend files from the diff or arguments
2. Read `CLAUDE.md` for stack and component library context
3. Apply WCAG 2.1 AA checks across all perceivable, operable,
   understandable, and robust criteria
4. Output a structured findings report with WCAG criterion references

---

## Output

The agent's findings are displayed directly. No additional formatting needed.

If no frontend files are in scope, the agent exits cleanly with a note.

If run as part of `/rad-review`, findings feed into the review's accessibility
check step.
