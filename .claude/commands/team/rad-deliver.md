---
description: >
  Execute an approved plan from .agents/plans/ using wave-based execution.
  Each wave runs tasks in fresh contexts. Requires the plan's PR branch to be
  merged before execution begins. Creates a deliver branch and opens a code
  review PR when complete.
---

# /rad-deliver

Execute an approved plan wave by wave, task by task, in fresh contexts.

## Input

`$ARGUMENTS` must be the path to a plan file:
```
/rad-deliver .agents/plans/email-confirmation.md
```

If empty, list available approved plans:
```bash
# List plans that are approved (branch merged)
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

### Step 3: Initialize execution log

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

### Step 4: Execute wave by wave

For each wave in the plan:

**Wave announcement:**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Wave [N]: [parallel | sequential] — [task count] tasks
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Before the first wave, read `## Execution Notes`:**

- Load every file listed under `### Key Files` as baseline context
- Note every file listed under `### Do Not Touch` — treat these as hard stops
  equivalent to out-of-scope files; stop and surface to architect if a task
  requires touching them
- Note any `### Reminders` — apply them throughout execution

**For each task in the wave:**

1. Load only the files listed for this task — no speculative reads
2. Implement exactly what the task describes — nothing more
3. Run the task's validation check
4. If validation passes:
   ```bash
   git add [changed files]
   git commit -m "deliver([feature]): [task title]

   Wave [N], Task [N.N]
   Validated: [validation method]"
   ```
5. Append to execution log:
   ```
   | [step#] | [wave] | [task title] | ✓ complete | [commit hash] | [time] |
   ```
6. Output step summary:
   ```
   ✓ Task [N.N]: [title]
   Changed: [files]
   Commit:  [hash]
   ```

**For parallel waves:** Execute tasks sequentially (Claude Code is single-threaded)
but mark them as logically parallel in the log. Do not wait for human confirmation
between parallel tasks in the same wave — they are independent.

**For sequential waves:** Wait for wave N to complete before starting wave N+1.
Output wave completion before proceeding:
```
✓ Wave [N] complete — [task count] tasks
Starting Wave [N+1]...
```

### Step 5: Handle task failures

If a task fails validation:
```
✗ Task [N.N]: [title]
Issue: [what failed]
Validation: [what was run]
Error: [compact error summary — not full stack trace]

Options:
  1. Fix and retry this task
  2. Update the plan for this task and retry
  3. Stop — open a blocking issue on the plan PR
```

Append to execution log:
```
| [step#] | [wave] | [task title] | ✗ failed | — | [time] |
```

Do not proceed to the next wave if a task fails.
Cap retry attempts at 2 per task. On third failure, stop and surface to architect.

### Step 6: Write tests

After all waves complete, write the tests listed in the plan's "Tests to Write"
section. Commit them:

```bash
git add [test files]
git commit -m "test([feature]): add tests per plan

Tests:
[list of tests written]"
```

### Step 6b: Scope and test verification

Run deterministic checks before opening the PR:

```bash
scripts/check-scope.sh .agents/plans/[feature].md deliver/[feature] main
scripts/check-tests.sh .agents/plans/[feature].md
```

If `check-scope.sh` fails, stop and surface the out-of-scope files to the
architect — do not open the PR until resolved.

If `check-tests.sh` fails, write the missing test files before proceeding.

### Step 7: Update plan status to complete

Update the plan file's Status field and commit it to the deliver branch so it
lands on main when the deliver PR is merged:

```
Status: complete
Completed-At: [ISO 8601 timestamp]
```

```bash
# [write updated plan file with Status: complete and Completed-At]
git add .agents/plans/[feature].md
git commit -m "deliver([feature]): mark plan complete"
```

### Step 8: Open code review PR

```bash
scripts/open-pr.sh \
  --title "Deliver: [Feature Name]" \
  --body "[execution summary with commit list and test coverage]" \
  --base main \
  --head deliver/[feature-name] \
  --no-draft \
  --label "rad:deliver"
```

### Step 9: Final output

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
- Load only files listed in each task — no speculative reads
- One task at a time — never skip ahead within a wave
- Cap retries at 2 per task — surface to architect on third failure
- Execution log must be updated after every task — not just at the end
- Never modify files outside the plan's "Files in Scope" without stopping to ask
- Compact error messages — never dump full stack traces into context
- Tests are mandatory — do not skip the "Tests to Write" section
