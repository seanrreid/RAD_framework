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

### 4. Reconcile plan vs. actual (delivery sessions only)

If on a `rad/` branch with an execution log under `.agents/logs/`, produce a brief
reconciliation note. Skip silently if there's no log.

```bash
# Find the execution log for this feature
ls .agents/logs/[feature-name]-*.md 2>/dev/null | tail -1
```

Check three things:

**ACs covered:** For each numbered AC in the plan, was it cited in a completed task
commit? Note any that were deferred or skipped.

**Concerns flagged:** Were any tasks marked `done_with_concerns`? List each concern
one-line so the architect sees them in the session summary without digging into the log.

**Deferred items:** Anything in `## Non-Goals` or the wave plan that was explicitly
left for a follow-up? Name it so the next session has a standing start.

Append this as a `## Session Notes` block to the plan doc (create the section if absent):

```
## Session Notes

- {date}: Delivered Wave [N]. ACs covered: [list]. Concerns: [list or none].
  Deferred: [list or none].
```

Commit it to the work branch:
```bash
git add .agents/plans/[feature-name].md
git commit -m "wrap([feature]): session reconciliation note"
git push origin "rad/[feature-name]"
```

### 4b. Recurring-findings check (read-only)

Before emitting the summary, compute which finding categories recur at or above
the threshold. Same resolution and count as `/rad-insights` Step 3b — read-only,
no writes:

```bash
t=$(node -e 'const n = Number.parseInt(process.env.RAD_FINDINGS_THRESHOLD ?? "", 10);
process.stdout.write(String(Number.isNaN(n) || n <= 0 ? 5 : n))')

# Every category with count >= threshold (all priorities), descending
jq -r 'select(.type=="finding") | .category' .agents/findings.jsonl \
  | sort | uniq -c | sort -rn | awk -v t="$t" '$1 >= t { print $2 }'
```

Skip silently if `.agents/findings.jsonl` is missing or empty, or if the filter
emits nothing.

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

## Concerns flagged
- {done_with_concerns items from delivery, or "none"}

[Include the next line ONLY if Step 4b emitted at least one category; otherwise
 omit it entirely — not an empty line, not "none".]
Recurring findings: {category list from Step 4b} — run /rad-insights for suggested conventions

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
- The recurring-findings line is threshold-gated and read-only over
  `.agents/findings.jsonl` — /wrap never writes findings or edits conventions;
  when no category meets the threshold, omit the line entirely
- Keep the summary scannable
