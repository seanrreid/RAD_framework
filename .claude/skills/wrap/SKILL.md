---
name: wrap
description: >
  End-of-session wrap-up for a RAD project. Gathers the session's commits, updates
  any plan statuses that changed, appends a dated progress note, outputs a session
  summary, and flags uncommitted work. Run before ending a work session.
---

# Session Wrap-Up

Capture what happened so the next session starts clean. No project-specific files —
this works on any RAD project.

## Steps

### 1. Gather session changes

```bash
git branch --show-current
git log --oneline @{u}.. 2>/dev/null || git log --oneline -10
git status --short
```

Collect the commits made this session, the current branch, and any uncommitted
changes.

### 2. Update plan status if it changed

If the session advanced a plan, update its `Status:` on the work branch and push
so the board (which reads `rad/` branch tips) stays current:

- Delivery started this session → `Status: in-progress`
- Deliver PR opened this session → `Status: review` (if your project uses it) and note the PR
- Plan still being drafted → leave `pending-review`

```bash
# On the rad/ work branch:
git add .agents/plans/<feature>.md
git commit -m "wrap(<feature>): session status update"
git push origin "rad/<feature>"
scripts/rad-label.sh <issue-number> <status>   # omit if there is no issue
```

### 3. Append a dated progress note

If meaningful work happened on a plan but its status didn't change, append a dated
line to the plan's `## Notes` section (create the section if absent) so the next
session has continuity:

```
- {date}: {one-line summary of what was done and what's next}
```

### 4. Reconcile the execution log (delivery sessions only)

If on a `rad/` branch with an execution log under `.agents/logs/`, confirm the log's
final rows reflect what actually completed. Skip silently if there's no log.

### 5. Output the session summary

```
# Session Wrap — {date}

## Branch: {branch}

## Done
- {completed items with commit refs}

## In progress
- {started but not finished}

## Plan status changes
- {feature}: {old} → {new}

## Next session
- {the obvious next step}

## ⚠️ Uncommitted changes
{list, or "none"}
```

### 6. Offer to commit leftovers

If there are uncommitted changes, list them and ask whether to commit before
ending — never commit silently.

## Rules

- Push plan-status changes to the `rad/` branch tip — the board reads tips, not the working tree
- Never commit to the default branch
- Append to `## Notes`, never rewrite history in it — build a timeline
- Flag uncommitted changes; commit only with confirmation
- Keep the summary scannable
