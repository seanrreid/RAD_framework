---
description: >
  ARCHITECT ONLY. Review and approve a pending plan. Updates the plan file's
  status to approved and commits it to main, unblocking /rad-deliver without
  requiring the plan branch to be merged.
---

# /rad-approve

Review a pending plan and approve it for execution. This replaces the PR-merge
gate with a direct architect approval committed to main.

## Input

`$ARGUMENTS` should be a plan name or path:
- `feature-name` → resolves to `.agents/plans/feature-name.md`
- `.agents/plans/feature-name.md` → used directly

If empty, list plans awaiting approval:

```bash
grep -rl "^Status: pending-review" .agents/plans/ 2>/dev/null \
  || echo "No pending plans found."
```

---

## Process

### Step 1: Verify architect role

```bash
scripts/check-role.sh architect
```

If the script exits non-zero, stop. Do not proceed.

### Step 2: Locate and read the plan file

Resolve the plan file path from `$ARGUMENTS`. Read from the plan branch first,
fall back to the working tree:

```bash
FEATURE=$(basename "$ARGUMENTS" .md)
PLAN_FILE=".agents/plans/$FEATURE.md"
PLAN_BRANCH="plan/$FEATURE"

git show "$PLAN_BRANCH:$PLAN_FILE" 2>/dev/null \
  || cat "$PLAN_FILE" 2>/dev/null \
  || { echo "✗ Plan file not found: $PLAN_FILE"; exit 1; }
```

If the plan cannot be found on the branch or locally, stop with an error.

If the plan's current Status is `in-progress`, `complete`, or `approved`, stop:

```
✗ Cannot approve: plan status is already [status].
```

Run the plan linter before showing the review summary:

```bash
scripts/lint-plan.sh "$PLAN_FILE"
```

If the linter reports errors, display them and stop:

```
✗ Plan has lint errors — ask the author to fix them before requesting approval.
[linter output]
```

Warnings are shown to the architect as context but do not block approval.

### Step 3: Display review summary

Output the plan for architect review:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Plan Review: [Feature Name]
Branch:      plan/[feature-name]
Author:      [Author from plan file]
Created:     [Created date from plan file]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Context section]

[Agent Scope section]

[Files in Scope table]

Waves: [N] | Tasks: [total] | Out-of-scope deps: [yes/no]

[Risks section]

[Non-Goals section]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Ask the architect to confirm:

```
Approve this plan?
  yes      → approve and unblock /rad-deliver
  no       → reject (team must revise and resubmit)
  feedback → request revision with notes
```

- **yes** → proceed to Step 4
- **no** → update Status to `rejected`, commit to main, output rejection notice, stop
- **feedback** → prompt for feedback text, append as `## Architect Feedback` section,
  update Status to `needs-revision`, commit to main, output revision notice, stop

### Step 4: Update plan file status

Read the full plan file content (from the branch or working tree). Update the
header fields:

```
Status: approved
Approved-By: [architect username from CLAUDE.md Role Assignments]
Approved-At: [ISO 8601 timestamp — e.g. 2026-05-25T14:32:00Z]
```

### Step 5: Commit approved plan to plan branch

Stay on (or check out) the plan branch — do not touch main:

```bash
git checkout plan/[feature-name]
git pull origin plan/[feature-name]

# Write updated plan file to working tree
# [write full updated content to .agents/plans/[feature].md]

git add .agents/plans/[feature].md
git commit -m "approve: [feature name]

Approved-By: [architect username]
Plan:        .agents/plans/[feature].md
Waves:       [N]
Tasks:       [total task count]"

git push origin plan/[feature-name]
```

Do not commit to main. Do not open a PR.

### Step 6: Output confirmation

```
✓ Plan approved: [feature name]

Plan:        .agents/plans/[feature].md
Approved-By: [architect username]
Approved-At: [timestamp]
Branch:      plan/[feature-name]

Team can now run:
  /rad-deliver .agents/plans/[feature].md
```

---

## Rules

- Only architects listed in CLAUDE.md Role Assignments may run this command
- Never approve a plan with unreviewed out-of-scope dependencies
- Never approve a plan with Status: in-progress, complete, or approved
- Commit only the plan file to the plan branch — no other files
- Never commit to main — the plan lands on main when the deliver PR is merged
- If the architect provides feedback, set Status to needs-revision, not approved
- Do not delete the plan branch — preserve it as a reference
- The approval commit on the plan branch is the audit trail — include approver identity in the message
