# Plan Approval Guide

> (Formerly the Plan PR guide — RAD v2 removed the plan PR; approval is now
> recorded directly on the work branch.)

How to read, review, and approve a plan as the architect.
Plan approval is Gate 1 — you're approving the approach before any code is written.

---

## Where the plan lives

Under Lane B there is one work branch per feature, cradle-to-grave:
`rad/[feature]`. `/rad-plan` (or `/rad-adopt`) cuts this branch from the
default branch, writes the plan doc to `.agents/plans/[feature-name].md`, and
commits it to the branch. The branch name is recorded in the plan doc's
`Branch:` header.

There is **no plan PR**. You review the plan doc directly on its `rad/[feature]`
branch tip:

```bash
git fetch
git checkout rad/[feature]
```

Read the file — it is the source of truth.

---

## Plan statuses

The plan doc carries a `Status:` header that tracks it through Gate 1:

| Status | Meaning |
|--------|---------|
| `pending-review` | Plan committed to the `rad/` branch, awaiting your review |
| `approved` | You approved it via `/rad-approve`; `/rad-deliver` is unblocked |
| `needs-revision` | You want changes before approval; contributor updates the plan and pushes |
| `rejected` | The feature/approach is wrong; the plan does not proceed |

`/rad-approve` is what moves a plan to `approved`. It writes `Status: approved`
to the plan doc on the `rad/` branch tip and pushes to that same branch — never
to the default branch. The plan reaches the default branch later, together with
the code, through the single deliver PR.

---

## What you're reviewing

**Not** the code — no code exists yet.
**Not** the implementation details — that's for the deliver PR.

You're reviewing:

### 1. Scope correctness
Are all the files in "Files in Scope" within the contributor's agent boundaries?

Check the Agent Scope Map in `CLAUDE.md`. If a developer is touching auth files
and auth is `architect`-only, set the plan to `needs-revision` (or `rejected`).
This is the most important check.

```
Files in Scope should only reference directories listed under the
contributor's role in the Agent Scope Map.
```

Also check that the plan passed the linter's context budget check. The linter
runs during `/rad-plan` and warns at >800 lines in scope, errors at >1500.
If a plan with a budget error reaches you, ask the contributor to split it —
it cannot be approved in this state.

### 2. Scope and acceptance criteria
Plan docs include a `## Scope` section and a `## Acceptance Criteria` section.
Confirm both are present and sound:

- Scope clearly bounds what this feature does (and references the non-goals).
- Each acceptance criterion is concrete and testable.
- Every acceptance criterion is covered by at least one task. Tasks cite the
  criteria they satisfy as `AC#N`.

`/rad-approve` surfaces the scope and acceptance criteria in its review summary
so you can sanity-check coverage before approving. Later, `/rad-review` flags
any uncovered acceptance criterion as a HIGH finding on the deliver PR — catch
gaps here at Gate 1 instead.

### 3. Plan precision
Can a junior dev execute this plan without interpretation?

Each task should specify:
- Exact file path (not just a directory)
- Line range or "new file"
- A precise description of the change
- A runnable validation check
- The acceptance criteria it satisfies (`AC#N`)

Vague tasks produce vague code. Request changes on anything like:
- "Update the frontend to handle the new response"
- "Add tests"
- "Fix the styling"

### 4. Wave structure
Does the parallel/sequential breakdown make sense?

Tasks in a `parallel` wave must be genuinely independent. If Task 1.2 reads
output from Task 1.1, they're not parallel — they need to be in different waves.

Tasks in a `sequential` wave must actually depend on the prior wave. If they're
independent, mark them parallel for execution efficiency.

### 5. Non-goals
Are the non-goals realistic and useful?

Good non-goals prevent scope creep during execution. Bad non-goals are either
obvious ("don't break production") or too vague ("no major refactoring").

Request at least 2 non-goals that are specific to this feature.

### 6. Out-of-scope dependencies
Are cross-domain dependencies declared, not hidden?

If the plan says "None" but you can see the feature obviously requires
something outside the contributor's scope, flag it. Hidden dependencies
cause execution failures or unauthorized file reads.

---

## Recording your decision

### Approve

Plan is correct. Run:

```
/rad-approve [feature]
```

This writes `Status: approved` to the plan doc on the `rad/[feature]` branch
tip and pushes to that branch. That recorded approval is what unblocks the
contributor's `/rad-deliver`. There is no merge and no separate approval
comment — the status on the branch tip is the signal.

### Proxy approval (`--on-behalf-of`)

When you approved the plan out-of-band (in a meeting, over chat) but aren't at
a terminal, someone else can record your decision for you:

```
/rad-approve <feature> --on-behalf-of "<architect>" --evidence "<cite>"
```

- The named approver must be a configured architect (validated via
  `check-role.sh`).
- `--evidence` is mandatory — cite where the out-of-band approval happened.
- The record stores `Approved-By` (the architect who decided) and `Recorded-By`
  (whoever ran the command) as separate fields; they are never collapsed.

Use this only for a real approval you already gave. See the Architect Guide for
the full integrity rules.

### Request changes

Set the plan to `needs-revision` and leave specific, actionable feedback on the
plan doc. Examples:

> Task 2.1 references `backend/app/auth/tokens.py` which is outside your
> agent scope. Remove this task and open a separate plan for the auth change,
> or flag it as an out-of-scope dependency.

> Wave 1 marks Task 1.1 and 1.2 as parallel but 1.2 reads the output of 1.1.
> Move 1.2 to Wave 2.

> "Add tests" is not a specific enough test description. List exactly what
> behaviors need to be tested.

> Acceptance criterion AC#3 isn't covered by any task. Add a task that
> satisfies it or remove it from scope.

The contributor updates the plan file on the `rad/[feature]` branch, pushes,
and you re-review.

### Reject

If the feature itself is wrong (not just the plan), set the plan to `rejected`
with an explanation. The contributor should start over with a new plan after
you've clarified the requirements.

---

## Turnaround expectations

Plan review should be small (one markdown file) and fast. A good plan review
takes 5–10 minutes. If it's taking longer, the plan is probably too large —
consider asking the contributor to split it.

The faster you review plans, the less the team is blocked waiting. Plan review
is not code review — treat it accordingly.

---

## When you want to modify the plan yourself

Check out the `rad/[feature]` branch, edit the plan file directly, and push.
Note what you changed and why (in your approval or a message to the contributor),
then run `/rad-approve`.

This is appropriate when the plan is mostly right but needs a specific fix
that would be faster to do yourself than to explain in feedback.

---

## What unblocks `/rad-deliver`

`/rad-deliver` gates on `Status: approved` at the `rad/[feature]` branch tip. It
runs on that same branch (no new branch) and opens the single deliver PR
(`rad:deliver`) from `rad/[feature]` → the default branch — the only PR in the
flow, and the one place the plan doc and code reach the default branch together.

Until `/rad-approve` has recorded approval on the branch tip, `/rad-deliver`
stays blocked.
