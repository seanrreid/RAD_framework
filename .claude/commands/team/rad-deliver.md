---
description: >
  Execute an approved plan from .agents/plans/ using wave-based execution.
  Each wave runs in a fresh sub-agent context — main context holds only the
  execution log and wave outcomes, not file contents or diffs. Requires the
  plan branch to be merged before execution begins. Creates a deliver branch
  and opens a code review PR when complete.
---

# /rad-deliver

Execute an approved plan wave by wave. Each wave is delegated to a sub-agent
with only the files it needs. Main context stays lean — it orchestrates and
logs, never accumulates task implementation detail.

## Input

`$ARGUMENTS` must be the path to a plan file:
```
/rad-deliver .agents/plans/email-confirmation.md
```

If empty, list available approved plans:
```bash
ls .agents/plans/*.md | while read f; do
  grep "^Status:" "$f" | grep -q "approved" && echo "$f"
done
```

---

## Process

### Step 1: Verify plan is approved

```bash
PLAN_BRANCH="plan/$(basename "$ARGUMENTS" .md)"
scripts/check-plan-approved.sh "$PLAN_BRANCH" main
```

If not approved:
```
✗ Cannot execute: plan is not yet approved.

Plan:   [plan file]
Branch: [plan branch]

The architect must run /rad-approve [feature-name] before execution can begin.
```

Stop. Do not proceed.

### Step 2: Create deliver branch

```bash
git checkout main
git pull origin main
git checkout -b deliver/[feature-name]
```

### Step 3: Read plan and initialize orchestration state

Read the plan file **once** and extract:

- `## Execution Notes` section (Key Files, Do Not Touch, Reminders)
- All wave definitions (wave number, type, tasks with file lists and validation)
- `## Tests to Write` section

Store this as your working plan state. **Do not re-read the plan file during
wave execution** — you already have everything you need.

### Step 4: Initialize execution log

Create `.agents/logs/[feature-name]-[YYYY-MM-DD].md`:

```markdown
# Execution Log: [Feature Name]
Plan: .agents/plans/[feature-name].md
Started: [timestamp]
Branch: deliver/[feature-name]
Executor role: [developer | designer]

## Steps

| Step | Wave | Task | Status | Commit | Time |
|------|------|------|--------|--------|------|
```

### Step 5: Execute waves via sub-agents

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

Branch: deliver/[feature-name]
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

## Tasks

### Task [N.1]: [title]
File: [path:lines]
What: [precise description from plan]
Validate: [validation command from plan]

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
   Validated: [validation method]"
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

```
✗ Wave [N] failed at Task [N.M]: [title]
Issue: [error from WAVE_RESULT]

Options:
  1. Fix and retry this wave
  2. Update the plan for the failed task and retry
  3. Stop — open a blocking issue on the plan PR
```

Cap retry attempts at 2 per wave. On third failure, stop and surface to architect.

Do not shed the `WAVE_RESULT` content between waves — keep the summary rows
in your context as the carry-forward state. Discard nothing from the log, but
do not re-read file contents from completed waves.

### Step 6: Write tests

After all waves complete, delegate test writing to a sub-agent:

```
You are writing tests for a completed RAD delivery. Do not modify any files
outside the test paths listed below.

Branch: deliver/[feature-name]
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

### Step 7: Scope and test verification

Run deterministic checks before opening the PR:

```bash
scripts/check-scope.sh .agents/plans/[feature].md deliver/[feature] main
scripts/check-tests.sh .agents/plans/[feature].md
```

If `check-scope.sh` fails, stop and surface the out-of-scope files to the
architect — do not open the PR until resolved.

If `check-tests.sh` fails, write the missing test files before proceeding.

### Step 8: Update plan status to complete

Update the plan file's Status field and commit it to the deliver branch so it
lands on main when the deliver PR is merged:

```
Status: complete
Completed-At: [ISO 8601 timestamp]
```

```bash
git add .agents/plans/[feature].md
git commit -m "deliver([feature]): mark plan complete"
```

### Step 9: Open code review PR

```bash
scripts/open-pr.sh \
  --title "Deliver: [Feature Name]" \
  --body "[execution summary with commit list and test coverage]" \
  --base main \
  --head deliver/[feature-name] \
  --no-draft \
  --label "rad:deliver"
```

### Step 10: Final output

```
✓ Delivery complete: [feature name]

Waves:    [N] complete
Tasks:    [N] complete, [N] tests written
Commits:  [N]
Log:      .agents/logs/[feature-name]-[date].md
PR:       [code review PR url]

Architect review required before merging.
```

---

## Rules

- Hard stop if plan is not approved — never execute an unapproved plan
- Read the plan file **once** at Step 3 — do not re-read it during wave execution
- Each wave runs in a sub-agent — never execute task file edits directly in main context
- Main context carries only: WAVE_RESULT summaries and the execution log — not file contents
- Cap retries at 2 per wave — surface to architect on third failure
- Execution log must be updated after every wave — not just at the end
- Never modify files outside the plan's "Files in Scope" without stopping to ask
- Tests are mandatory — do not skip the "Tests to Write" section
- Do not push or open a PR inside a wave sub-agent — that is the orchestrator's responsibility
