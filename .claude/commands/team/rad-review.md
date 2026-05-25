---
description: >
  Review code changes on the current deliver branch against the plan and project
  conventions. Run after /rad-deliver completes and before requesting architect
  review. Catches scope drift, convention violations, and missing test coverage
  before the architect sees the PR.
---

# /rad-review

Self-review the deliver branch before requesting architect review. Catches
problems early — better to find them now than in the architect's review.

## Input

`$ARGUMENTS` (optional): specific files to review. If empty, reviews all
changes on the current branch since branching from main.

```bash
git diff main...HEAD --name-only
```

---

## Process

### Step 1: Load context

- Read `CLAUDE.md` conventions and constraints
- Read the plan file for this deliver branch:
  ```bash
  FEATURE=$(git branch --show-current | sed 's/deliver\///')
  PLAN=".agents/plans/$FEATURE.md"
  ```
- Read the execution log:
  ```bash
  LOG=$(ls .agents/logs/$FEATURE-*.md 2>/dev/null | tail -1)
  ```

### Step 2: Scope check

Verify every changed file is listed in the plan's "Files in Scope":

```
Scope Check:
✓ frontend/src/features/habits/api.ts — in scope
✓ frontend/src/features/calendar/CalendarDay.tsx — in scope
✗ backend/app/models.py — NOT in plan scope

Out-of-scope changes require architect approval before this PR can merge.
```

If any out-of-scope files are changed, flag as HIGH priority.

### Step 3: Plan fidelity check

For each task in the plan, verify the implementation matches the description:
- Is the change in the right file at roughly the right location?
- Does it do what the task described — no more, no less?
- Were non-goals respected?

### Step 4: Convention check

Review each changed file against `CLAUDE.md` conventions:
- Naming patterns
- Type annotations / docstrings / comments per convention
- Import patterns
- Prohibited patterns ("What Claude Must Never Do")

### Step 5: Test coverage check

For each item in the plan's "Tests to Write":
- [ ] Was it written?
- [ ] Does it test behavior, not implementation?
- [ ] Does it include the error/edge path, not just the happy path?

### Step 6: Output the review

```markdown
## Self-Review: [Feature Name]
Branch: deliver/[feature-name]
Date: [timestamp]
Files reviewed: [N]

### Scope
[✓ All changes within plan scope | ✗ Out-of-scope: [files]]

### Plan Fidelity
[✓ Implementation matches plan | Issues found:]
- [issue] — [file:line]

### Conventions
**Priority: HIGH**
- [violation] — [file:line] — Fix: [what to do]

**Priority: MEDIUM**
- [issue] — [file:line]

**Priority: LOW**
- [note]

### Test Coverage
- [✓ | ✗] [test description] — [file]

### Summary
Status: [READY FOR ARCHITECT REVIEW | NEEDS FIXES FIRST]
Blocking issues: [N]
  - [issue]

### Recommended next steps
[If ready:] Request review on PR: [url]
[If not ready:] Fix [N] blocking issues, then re-run /rad-review
```

---

## Rules

- Do not fix issues — report them with file:line references
- Out-of-scope changes are always HIGH priority — no exceptions
- HIGH issues block architect review — fix them first
- Do not flag style preferences not in `CLAUDE.md`
- If a test is missing, it is a HIGH priority issue — tests are not optional
- If the plan was deviated from without a noted reason, flag as MEDIUM
