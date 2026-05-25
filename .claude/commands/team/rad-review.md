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

```bash
scripts/check-scope.sh "$PLAN" deliver/[feature] main
```

The script outputs each changed file as in-scope or out-of-scope. Include its
full output in the review report. Any out-of-scope files are HIGH priority.

### Step 3: Plan fidelity check

For each task in the plan, verify the implementation matches the description:
- Is the change in the right file at roughly the right location?
- Does it do what the task described — no more, no less?
- Were non-goals respected?

### Step 4: Quality review

Spawn the `quality-reviewer` agent on the changed files:

```
Use the quality-reviewer agent on all files changed since branching from main.
```

Include the agent's full output in the review report. Promote any HIGH findings
to blocking issues in the summary.

### Step 4b: Accessibility review

Spawn the `accessibility-reviewer` agent on changed frontend files:

```
Use the accessibility-reviewer agent on all files changed since branching from main.
```

Include the agent's full output. HIGH findings are blocking; MEDIUM findings
should be addressed before merge.

### Step 5: Test coverage check

```bash
scripts/check-tests.sh "$PLAN"
```

Include the script output in the review report. Missing test files are HIGH
priority. For present test files, also verify:
- [ ] Tests behavior, not implementation
- [ ] Includes error/edge paths, not just the happy path

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

### Step 7: Persist findings to insights log

Extract the `rad-findings` JSON blocks from the quality-reviewer and accessibility-reviewer
outputs. Combine with cycle metadata and append to `.agents/findings.jsonl`.

Get cycle metadata:

```bash
FEATURE=$(git branch --show-current | sed 's/deliver\///')
DATE=$(date +%Y-%m-%d)
CYCLE_ID="${FEATURE}-${DATE}"
```

For each finding in each reviewer's `rad-findings` block, append one line to
`.agents/findings.jsonl`. Findings from quality-reviewer omit the `wcag` field;
findings from accessibility-reviewer include it.

```json
{"type":"finding","cycle_id":"[CYCLE_ID]","feature":"[FEATURE]","date":"[DATE]","reviewer":"[reviewer]","priority":"[priority]","category":"[category]","file":"[file]","line":[line or null],"issue":"[issue]","wcag":"[wcag or null]"}
```

Then append one cycle summary record:

```json
{"type":"cycle","cycle_id":"[CYCLE_ID]","feature":"[FEATURE]","date":"[DATE]","outcome":"[READY_FOR_ARCHITECT_REVIEW | NEEDS_FIXES_FIRST]","high":[total HIGH across all reviewers],"medium":[total MEDIUM],"low":[total LOW]}
```

Append — never overwrite. Create the file if it does not exist.

---

## Rules

- Do not fix issues — report them with file:line references
- Out-of-scope changes are always HIGH priority — no exceptions
- HIGH issues block architect review — fix them first
- Do not flag style preferences not in `CLAUDE.md`
- If a test is missing, it is a HIGH priority issue — tests are not optional
- If the plan was deviated from without a noted reason, flag as MEDIUM
