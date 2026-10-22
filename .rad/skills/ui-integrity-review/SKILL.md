---
name: ui-integrity-review
description: >
  Run the ui-integrity-reviewer agent on the current diff or specified files.
  Checks frontend changes for decorative/unwired UI, hardcoded display data,
  null/zero/date edge inputs, sibling-path partial fixes (with a grep sweep),
  and toothless test assertions. Advisory and read-only. Standalone — does not
  require a plan file.
targets:
  claude: command:team/ui-integrity-review
  codex: skill
---

# /ui-integrity-review

Run a UI integrity review on the current branch changes or specified files.

## Input

`{{args}}` (optional):
- Empty → reviews the frontend files changed since branching from main
- File paths → reviews only those files
- `--staged` → reviews only staged changes

If `{{args}}` is empty and the diff is empty, stop with: "No changes to review —
the current diff is empty. Pass file paths or make changes first."

---

## Process

Invoke the `ui-integrity-reviewer` agent with `{{args}}` as context.

The agent will:
1. Read `AGENTS.md` for the frontend stack (or `CLAUDE.md` if the project has
   no `AGENTS.md`)
2. Get the relevant diff or file list and keep the frontend sources
3. Trace UI wiring, audit edge inputs, sweep for sibling instances, and audit
   test assertions
4. Output a findings report that shows the sibling sweep, ending with a
   `rad-findings` block

---

## Output

The agent's findings are displayed directly. No additional formatting needed.

The review is advisory: it edits no files, writes no `.agents/findings.jsonl`,
and cannot approve a plan. When run as part of `/rad-review`, the findings are
persisted by that command's findings step.
