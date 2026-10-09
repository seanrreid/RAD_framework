---
name: rad-review
description: >
  Read-only review of the current rad/ work branch against its plan: runs the
  deterministic scope, plan-lint, approval-blocker and test-presence checks,
  then the quality and accessibility reviewer sub-agents, and reports a
  combined summary. Never edits files, commits, or pushes.
targets:
  claude: none
  codex: skill
---

# rad-review

Review the current `rad/<feature>` work branch before requesting architect
review. This review is strictly read-only.

## Input

Read {{args}} (optional): specific files to review. If empty, review every file
changed on the branch since it diverged from the default branch.

## Process

### Step 1: Resolve the branch, plan, and base

```bash
BASE=$(scripts/get-default-branch.sh)
BRANCH=$(git branch --show-current)
FEATURE=${BRANCH#rad/}
PLAN=".agents/plans/$FEATURE.md"
git diff "$BASE"...HEAD --name-only
```

- If `scripts/get-default-branch.sh` exits non-zero, report its stderr and stop.
- If the branch name does not start with `rad/`, or `$PLAN` does not exist,
  report that and stop: this review needs a RAD work branch and its plan.

### Step 2: Deterministic checks

Run each command and include its full output and exit code in the report:

```bash
scripts/check-scope.sh "$PLAN" "$BRANCH" "$BASE"
scripts/lint-plan.sh "$PLAN"
scripts/check-approval-blockers.sh "$PLAN"
scripts/check-tests-present.sh "$PLAN"
```

- `check-scope.sh`: any out-of-scope file is HIGH priority.
- `lint-plan.sh`: advisory only; it does not change the review outcome.
- `check-approval-blockers.sh`: exit 1 lists blockers on stderr; note that
  they will block approval. Exit 2 is an error; report it.
- `check-tests-present.sh`: report any task missing its tests.

A non-zero exit from any of these is reported, never a reason to stop the
review.

### Step 3: Reviewer sub-agents

1. Spawn the `quality-reviewer` sub-agent, defined at
   `.codex/agents/quality-reviewer.toml`, on the changed files (or the files
   the user named). Include its full findings report.
2. UI files are changed files ending in `.html`, `.css`, `.scss`, `.jsx`,
   `.tsx`, `.vue` or `.svelte`. When any UI file changed, also spawn the
   `accessibility-reviewer` sub-agent, defined at
   `.codex/agents/accessibility-reviewer.toml`, on those files and include its
   full findings report. Otherwise note that no UI files changed.

If a sub-agent cannot be spawned, say so in the report; do not review the
files yourself in its place.

### Step 4: Exercise the artifact

If {{args}} contains `--no-exercise`, remove that token from the file list, skip
this step, and print `Exercise: skipped (--no-exercise)`. Otherwise run the
plan's `## Exercise` recipe against the delivered branch:

```bash
node harness/cli.js exercise "$FEATURE"
```

- **No recipe:** the command prints `Exercise: skipped (no recipe)`; report that.
- **Ran:** include its stdout (the `rad-findings` block) and its stderr summary
  line in the report.
- **Failure:** on a non-zero exit, report the exit code and stderr line and
  continue. A missing or failing exercise never stops the review.

The mode is `blocking` only when `RAD_EXERCISE_BLOCKING` is `1` or `true`;
otherwise it is `observe-only`. In `blocking` mode, HIGH exercise findings count
as blocking items; in `observe-only` mode they are listed as advisory. This is a
self-review check only: it never touches the approval gate. Report the output
only; write nothing.

### Step 5: Combined summary

Report, in order:
- the branch, plan, and base;
- each deterministic check with its exit code and output;
- each reviewer's findings;
- a "Behavioral Exercise" section (recipe present or skipped, mode, findings);
- a summary listing every blocking item (out-of-scope files, approval
  blockers, missing tests, HIGH findings, and HIGH exercise findings in
  `blocking` mode) or stating that none were found.

## Rules

- Never edit, create, or delete files. Never write `.agents/findings.jsonl`.
- Never commit or push.
