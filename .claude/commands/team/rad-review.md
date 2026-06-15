---
description: >
  Review code changes on the current rad/ work branch against the plan and project
  conventions. Run after /rad-deliver completes and before requesting architect
  review. Catches scope drift, convention violations, missing AC coverage, and
  missing test coverage before the architect sees the deliver PR.
---

# /rad-review

Self-review the `rad/[feature]` work branch before requesting architect review.
Catches problems early — better to find them now than in the architect's review
of the deliver PR.

## Input

`$ARGUMENTS` (optional): specific files to review. If empty, reviews all
changes on the current `rad/[feature]` branch since it diverged from the default
branch.

```bash
BASE=$(scripts/get-default-branch.sh)
git diff "$BASE"...HEAD --name-only
```

---

## Process

### Step 1: Load context

- Read `CLAUDE.md` conventions and constraints
- Read the plan file for this work branch:
  ```bash
  BASE=$(scripts/get-default-branch.sh)
  FEATURE=$(git branch --show-current | sed 's#^rad/##')
  PLAN=".agents/plans/$FEATURE.md"
  ```
- Read the execution log:
  ```bash
  LOG=$(ls .agents/logs/$FEATURE-*.md 2>/dev/null | tail -1)
  ```

### Step 2: Scope check

```bash
scripts/check-scope.sh "$PLAN" "rad/$FEATURE" "$BASE"
```

The script outputs each changed file as in-scope or out-of-scope. Include its
full output in the review report. Any out-of-scope files are HIGH priority.

### Step 2b: Lint advisories

```bash
scripts/lint-plan.sh "$PLAN"
```

Run the plan linter against the plan under review and include its full output in
the review report. These are **advisory only** — they surface plan-quality
warnings for the architect's attention but do **not** gate the review or block
architect review. This is separate from the Step 2 scope check.

### Step 3: Plan fidelity check

For each task in the plan, verify the implementation matches the description:
- Is the change in the right file at roughly the right location?
- Does it do what the task described — no more, no less?
- Were non-goals respected?

### Step 3b: Acceptance Criteria coverage

Iterate over every item in the plan's `## Acceptance Criteria` list. For each
`AC#N`, verify at least one Wave task's `Validate:` field cites it. Any AC with
no citing task is **HIGH priority** — the plan declared an outcome that no task
delivers. List every uncovered AC by number.

(If the plan predates the AC schema and has no `## Acceptance Criteria` section,
note that and skip — do not fabricate criteria.)

### Step 4: Quality review

Spawn the `quality-reviewer` agent on the changed files:

```
Use the quality-reviewer agent on all files changed since branching from the default branch.
```

Include the agent's full output in the review report. Promote any HIGH findings
to blocking issues in the summary.

### Step 4b: Accessibility review

Spawn the `accessibility-reviewer` agent on changed frontend files:

```
Use the accessibility-reviewer agent on all files changed since branching from the default branch.
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

### Step 5b: Guardrail review

Always load `ai/guardrails.md` as the baseline.

Then, from the list of changed file paths, match each path against the
`Applies When` clause of each file in `ai/extensions/` and load only the
extensions that match:

| Extension file | Applies When (summary) |
|---|---|
| `ai/extensions/backend.md` | server routes, controllers, services, jobs, queues, RPC handlers, API clients, backend config, request validation, authorization, logging, error handling, rate limits, retries, caching, service boundaries |
| `ai/extensions/database.md` | migrations, schema definitions, models, query builders, repositories, seed data, indexes, data access logic, persistence behavior, transactions, constraints, backfills, tenancy filters |
| `ai/extensions/frontend.md` | UI components, CSS, routes, forms, client-side state, browser behavior, visual design, accessibility, frontend tests |
| `ai/extensions/security.md` | authentication, authorization, sessions, secrets, permissions, roles, audit logs, cryptography, dependency trust, input handling, file uploads, webhooks, payments, data exposure |
| `ai/extensions/testing.md` | tests, fixtures, test helpers, mocks, snapshots, factories, CI test commands |

Load only files whose `Applies When` section matches the changed paths or task domain. State which extensions were loaded (or "baseline only" if none apply).

**Examine the diff for each changed file:**

```bash
BASE=$(scripts/get-default-branch.sh)
git diff "$BASE"...HEAD -- [file]
```

Run the **Review Checklist** from `ai/guardrails.md` against the actual changes. Check for each of these 10 items:

1. Plausible but incorrect logic
2. Over-engineered abstractions for a small task
3. Code that ignores local conventions
4. Hallucinated or deprecated APIs
5. Broad error handling that makes failures harder to debug
6. Cargo-cult retries, caching, circuit breakers, or validation
7. Duplicated behavior with a slightly different implementation
8. Changed public contracts without matching tests and callers
9. Responsibilities moved into the wrong module or layer
10. Large blast radius for a narrow request

**Classify each finding:**

- **HARD** (blocks the PR): hallucinated/deprecated APIs (item 4), broad catch blocks that swallow errors (item 5), responsibilities moved to the wrong module/layer (item 9), changed public contracts without updated tests/callers (item 8), large blast radius for a narrow request (item 10)
- **SOFT** (advisory): over-engineered abstractions (item 2), code ignoring local conventions (item 3), duplicated behavior (item 7), cargo-cult patterns (item 6)

Note: item 1 (plausible but incorrect logic) should be classified HARD if the logic error would produce incorrect runtime behavior, SOFT if it is stylistic or speculative.

**Gate decision:**

- If any **HARD** violations are found: output a FAIL report listing each violation with `file:line` reference. **Do not proceed to Step 6 or the PR-open step.** The review status is `NEEDS FIXES FIRST`.
- If only **SOFT** findings: append them to the review summary as "Advisory" items and continue.
- If no findings: output `Guardrails: PASS` and continue.

### Step 6: Output the review

```markdown
## Self-Review: [Feature Name]
Branch: rad/[feature-name]
Date: [timestamp]
Files reviewed: [N]

### Scope
[✓ All changes within plan scope | ✗ Out-of-scope: [files]]

### Plan Fidelity
[✓ Implementation matches plan | Issues found:]
- [issue] — [file:line]

### Acceptance Criteria Coverage
[✓ All ACs covered by tasks | ✗ Uncovered (HIGH): AC#[N], AC#[M]]

### Conventions
**Priority: HIGH**
- [violation] — [file:line] — Fix: [what to do]

**Priority: MEDIUM**
- [issue] — [file:line]

**Priority: LOW**
- [note]

### Test Coverage
- [✓ | ✗] [test description] — [file]

### Guardrails
Extensions loaded: [baseline only | baseline + [list]]
Status: [PASS | FAIL]

**HARD violations (blocking):**
- [violation] — [file:line]

**Advisory (SOFT):**
- [finding] — [file:line]

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
FEATURE=$(git branch --show-current | sed 's#^rad/##')
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
- An acceptance criterion with no task delivering it is always HIGH priority
- HIGH issues block architect review — fix them first
- Do not flag style preferences not in `CLAUDE.md`
- If a test is missing, it is a HIGH priority issue — tests are not optional
- If the plan was deviated from without a noted reason, flag as MEDIUM
