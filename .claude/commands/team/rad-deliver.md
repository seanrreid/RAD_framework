---
description: >
  Execute an approved plan from .agents/plans/ using wave-based execution.
  Each wave runs in a fresh sub-agent context — main context holds only the
  execution log and wave outcomes, not file contents or diffs. Runs on the plan's
  existing rad/ work branch (no new branch), gates on the approved status at the
  branch tip, and opens the single code review PR to the default branch.
---

# /rad-deliver

Execute an approved plan wave by wave. Each wave is delegated to a sub-agent
with only the files it needs. Main context stays lean — it orchestrates and
logs, never accumulates task implementation detail.

Under the Lane B model the work has lived on its `rad/[feature]` branch since
`/rad-plan` — that branch carries the plan, the approval, and now the code. There
is **no separate deliver branch**, and the deliver PR is the only PR.

## Input

`$ARGUMENTS` must be the path to a plan file:
```
/rad-deliver .agents/plans/email-confirmation.md
```

If empty, list available approved plans (reading branch tips):
```bash
scripts/rad-status.sh 2>/dev/null | grep approved || echo "No approved plans found."
```

---

## Process

### Step 1: Resolve and validate the work branch

Read the plan file's `Branch:` header and validate it. Never cut a new branch — a
plan missing the `Branch:` field (or carrying an old `plan/`/`deliver/` name) was
created before the Lane B workflow:

```bash
PLAN_FILE="$ARGUMENTS"
WORK_BRANCH=$(grep -E '^Branch:' "$PLAN_FILE" | head -1 | awk '{print $2}')

if [[ ! "$WORK_BRANCH" =~ ^rad/[a-z0-9][a-z0-9-]*$ ]]; then
  echo "✗ Invalid or missing Branch field: '${WORK_BRANCH:-<missing>}' (expected rad/<feature>)."
  echo "  This plan predates the branch-at-creation workflow. Recreate it with /rad-plan, or add the Branch field manually."
  exit 1
fi
```

### Step 2: Verify the plan is approved

The gate reads the plan's own branch tip:

```bash
scripts/check-plan-approved.sh "$WORK_BRANCH"
```

If not approved:
```
✗ Cannot execute: plan is not yet approved.

Plan:   [plan file]
Branch: [work branch]

The architect must run /rad-approve [feature-name] before execution can begin.
```

Stop. Do not proceed.

### Step 3: Check out the work branch at its tip

There is no separate deliver branch — the plan has lived on `rad/[feature]` since
`/rad-plan`. Land on its tip and rebase on the latest default branch so the
eventual PR is clean:

```bash
scripts/checkout-plan.sh "$WORK_BRANCH"   # fetches + ff-pulls to the remote tip
BASE=$(scripts/get-default-branch.sh)
git fetch origin "$BASE"
if ! git rebase "origin/$BASE"; then
  echo "✗ Rebase on $BASE hit conflicts. Resolve, then re-run /rad-deliver."
  exit 1
fi
```

### Step 4: Read plan and initialize orchestration state

Read the plan file **once** and extract:

- `## Execution Notes` section (Key Files, Do Not Touch, Reminders)
- All wave definitions (wave number, type, tasks with file lists and validation)
- `## Acceptance Criteria` and `## Tests to Write` sections

Store this as your working plan state. **Do not re-read the plan file during
wave execution** — you already have everything you need.

### Step 5: Initialize execution log

Create `.agents/logs/[feature-name]-[YYYY-MM-DD].md`:

```markdown
# Execution Log: [Feature Name]
Plan: .agents/plans/[feature-name].md
Started: [timestamp]
Branch: rad/[feature-name]
Executor role: [developer | designer]

## Steps

| Step | Wave | Task | Status | Commit | Time |
|------|------|------|--------|--------|------|
```

Mark the plan in-progress on the work branch:

```bash
# Update plan header: Status: approved → Status: in-progress
git add .agents/plans/[feature-name].md
git commit -m "deliver([feature]): begin execution"
git push origin "rad/[feature-name]"
scripts/rad-label.sh [issue-number] in-progress   # omit if there is no issue
```

### Step 6: Execute waves via sub-agents

For each wave in the plan, announce it, then delegate to a wave sub-agent.
After the agent returns, update the execution log and decide whether to continue.

**Wave announcement (orchestrator output):**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Wave [N]: [parallel | sequential] — [task count] tasks
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Invoke the wave sub-agent** with this prompt (fill in all bracketed values
from your plan state before calling):

```
You are executing Wave [N] of a RAD delivery. Do not read files speculatively —
only load what is listed below. Do not open PRs or push branches.

Branch: rad/[feature-name]
Feature: [feature-name]
Execution log: .agents/logs/[feature-name]-[date].md
Wave type: [parallel | sequential]

## Execution Notes
### Do Not Touch
[lines from plan — hard stops, treat as out-of-scope]

### Key Files (pre-load before starting)
[lines from plan]

### Reminders
[lines from plan]

## Guardrail Extensions

Before writing any code, complete this protocol:

1. List the file paths you expect to touch in this wave.
2. Match each path against the "Applies When" clause of each file in `ai/extensions/`
   (frontend.md, backend.md, database.md, security.md, testing.md).
3. Always load `ai/guardrails.md` as the baseline — no exceptions.
4. Load only the domain extensions whose "Applies When" clause matches your changed
   paths or the task domain. When in doubt, include the extension.
5. State the loaded extensions explicitly (e.g., "Loaded: ai/guardrails.md,
   ai/extensions/backend.md, ai/extensions/security.md") before writing any code.

## Tasks

### Task [N.1]: [title]
File: [path:lines]
What: [precise description from plan]
Validate: [AC#N and validation method from plan]

### Task [N.2]: [title]
...

## For each task:
1. Load only the files listed — no additional reads
2. Implement exactly what the task describes — nothing more
3. Run the validation command
4. If validation passes:
   git add [changed files]
   git commit -m "deliver([feature]): [task title]

   Wave [N], Task [N.M]
   Validated: [AC#N — validation method]"
5. Append to execution log:
   | [step#] | Wave [N] | [task title] | ✓ complete | [commit hash] | [time] |
6. Do not continue to the next task if validation fails

## Return format
At the end, output exactly this block and nothing after it:

WAVE_RESULT
wave: [N]
status: [complete | failed]
tasks:
  - title: [task title]
    status: [complete | failed]
    commit: [hash or —]
    error: [one-line summary or —]
END_WAVE_RESULT
```

**After the sub-agent returns:**

1. Parse the `WAVE_RESULT` block
2. Append any missing execution log rows (the agent writes them, but verify)
3. Output wave completion:

```
✓ Wave [N] complete — [task count] tasks
  Task [N.1]: [title] — [commit hash]
  Task [N.2]: [title] — [commit hash]
```

4. Proceed to the next wave **only if** `status: complete`

**If the wave sub-agent returns `status: failed`:**

Retry the failed task at most twice (re-delegate a fresh sub-agent scoped to just
that task). On the **third** failure, stop the whole delivery and emit a
structured escalation — do not continue to the next task or wave:

```
✗ Delivery blocked — Wave [N], Task [N.M]: [title]
AC:        AC#[N] — [criterion]
Issue:     [error from WAVE_RESULT]
Tried:     [1-line summary of each of the 3 attempts]
Branch:    rad/[feature-name]  (partial work is committed and pushed)
Escalate:  architect review needed before continuing.
```

Do not shed the `WAVE_RESULT` content between waves — keep the summary rows
in your context as the carry-forward state. Discard nothing from the log, but
do not re-read file contents from completed waves.

### Step 7: Write tests

After all waves complete, delegate test writing to a sub-agent:

```
You are writing tests for a completed RAD delivery. Do not modify any files
outside the test paths listed below.

Branch: rad/[feature-name]
Feature: [feature-name]

## Tests to Write
[full "Tests to Write" section from the plan]

Write each test file. Then run:
  git add [test files]
  git commit -m "test([feature]): add tests per plan

  Tests:
  [list of tests written]"

Return:
TEST_RESULT
status: [complete | failed]
tests:
  - file: [path]
    status: [written | failed]
END_TEST_RESULT
```

### Step 8: Scope and test verification

Run deterministic checks before opening the PR:

```bash
BASE=$(scripts/get-default-branch.sh)
scripts/check-scope.sh .agents/plans/[feature].md "rad/[feature]" "$BASE"
scripts/check-tests.sh .agents/plans/[feature].md
```

If `check-scope.sh` fails, stop and surface the out-of-scope files to the
architect — do not open the PR until resolved.

If `check-tests.sh` fails, write the missing test files before proceeding.

### Step 9: Update plan status to complete

Update the plan file's Status field and commit it to the work branch so it lands
on the default branch when the deliver PR merges:

```
Status: complete
Completed-At: [ISO 8601 timestamp]
```

```bash
git add .agents/plans/[feature].md
git commit -m "deliver([feature]): mark plan complete"
git push origin "rad/[feature-name]"
scripts/rad-label.sh [issue-number] review   # omit if there is no issue
```

### Step 10: Open code review PR

```bash
scripts/open-pr.sh \
  --title "Deliver: [Feature Name]" \
  --body "[execution summary with commit list and test coverage]" \
  --head "rad/[feature-name]" \
  --no-draft \
  --label "rad:deliver"
```

`--base` defaults to the project default branch. This is the **only** PR in the
flow — it carries the plan doc and the code together.

### Step 11: Final output

```
✓ Delivery complete: [feature name]

Waves:    [N] complete
Tasks:    [N] complete, [N] tests written
Commits:  [N]
Log:      .agents/logs/[feature-name]-[date].md
Branch:   rad/[feature-name]
PR:       [code review PR url]

Architect review required before merging.
```

---

## Rules

- Hard stop if plan is not approved — never execute an unapproved plan
- Never cut a new branch — the `rad/[feature]` branch already exists from `/rad-plan` and is the PR head; if the `Branch:` field is missing/old, stop and flag it
- Read the plan file **once** at Step 4 — do not re-read it during wave execution
- Each wave runs in a sub-agent — never execute task file edits directly in main context
- Main context carries only: WAVE_RESULT summaries and the execution log — not file contents
- Cap retries at 2 per task — emit the structured escalation and stop on the third failure
- Execution log must be updated after every wave — not just at the end
- Never modify files outside the plan's "Files in Scope" without stopping to ask
- Tests are mandatory — do not skip the "Tests to Write" section
- Do not push or open a PR inside a wave sub-agent — that is the orchestrator's responsibility
