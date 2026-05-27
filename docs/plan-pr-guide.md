# Plan PR Guide

How to read, review, and respond to plan PRs as the architect.
Plan PRs are Gate 1 — you're approving the approach before any code is written.

---

## What a plan PR contains

A plan PR has exactly one file: `.agents/plans/[feature-name].md`

The PR description renders the plan as a reviewable checklist. The file itself
is the source of truth. Read the file, not just the description.

---

## What you're reviewing

**Not** the code — no code exists yet.
**Not** the implementation details — that's for the code PR.

You're reviewing:

### 1. Scope correctness
Are all the files in "Files in Scope" within the contributor's agent boundaries?

Check the Agent Scope Map in `CLAUDE.md`. If a developer is touching auth files
and auth is `architect`-only, reject immediately. This is the most important check.

```
Files in Scope should only reference directories listed under the
contributor's role in the Agent Scope Map.
```

Also check that the plan passed the linter's context budget check. The linter
runs during `/rad-plan` and warns at >800 lines in scope, errors at >1500.
If a plan with a budget error reaches you, ask the contributor to split it —
it cannot be approved in this state.

### 2. Plan precision
Can a junior dev execute this plan without interpretation?

Each task should specify:
- Exact file path (not just a directory)
- Line range or "new file"
- A precise description of the change
- A runnable validation check

Vague tasks produce vague code. Request changes on anything like:
- "Update the frontend to handle the new response"
- "Add tests"
- "Fix the styling"

### 3. Wave structure
Does the parallel/sequential breakdown make sense?

Tasks in a `parallel` wave must be genuinely independent. If Task 1.2 reads
output from Task 1.1, they're not parallel — they need to be in different waves.

Tasks in a `sequential` wave must actually depend on the prior wave. If they're
independent, mark them parallel for execution efficiency.

### 4. Non-goals
Are the non-goals realistic and useful?

Good non-goals prevent scope creep during execution. Bad non-goals are either
obvious ("don't break production") or too vague ("no major refactoring").

Request at least 2 non-goals that are specific to this feature.

### 5. Out-of-scope dependencies
Are cross-domain dependencies declared, not hidden?

If the plan says "None" but you can see the feature obviously requires
something outside the contributor's scope, flag it. Hidden dependencies
cause execution failures or unauthorized file reads.

---

## Responding to plan PRs

### Approve and merge
Plan is correct. Merge it.

Merging = approval. The contributor can now run `/rad-deliver`.

Do not add a separate approval comment — the merge is the signal.

### Request changes
Leave specific, actionable comments on the plan file. Examples:

> Task 2.1 references `backend/app/auth/tokens.py` which is outside your
> agent scope. Remove this task and open a separate plan for the auth change,
> or flag it as an out-of-scope dependency.

> Wave 1 marks Task 1.1 and 1.2 as parallel but 1.2 reads the output of 1.1.
> Move 1.2 to Wave 2.

> "Add tests" is not a specific enough test description. List exactly what
> behaviors need to be tested.

The contributor updates the plan file, pushes, and you re-review.

### Close without merging
If the feature itself is wrong (not just the plan), close the PR with an
explanation. The contributor should start over with a new plan after you've
clarified the requirements.

---

## Turnaround expectations

Plan PRs should be small (one markdown file) and fast to review. A good
plan review takes 5–10 minutes. If it's taking longer, the plan is probably
too large — consider asking the contributor to split it.

The faster you review plan PRs, the less the team is blocked waiting.
Plan PRs are not code reviews — treat them accordingly.

---

## When you want to modify the plan yourself

Check out the plan branch, edit the plan file directly, and push. Leave a
comment on the PR noting what you changed and why. Then merge.

This is appropriate when the plan is mostly right but needs a specific fix
that would be faster to do yourself than to explain in comments.

---

## Plan PR labels

| Label | Meaning |
|-------|---------|
| `rad:plan` | This is a plan PR (always present) |
| `rad:pending-review` | Awaiting architect review |
| `rad:changes-requested` | Architect has requested changes |

After merging, the `rad:pending-review` label can be removed. The merged state
is the approval record.
