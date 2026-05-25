---
description: >
  Plan a feature or bug fix within your role's agent boundaries. Researches the
  codebase using scoped context tools, generates a wave-structured plan file,
  commits it to a plan branch, and opens a draft PR for architect review.
  Execution is blocked until the architect merges the plan PR.
---

# /rad-plan

Research and plan a feature within your agent boundaries. The plan becomes a
PR that the architect must review and merge before execution can begin.

## Input

`$ARGUMENTS` should describe the feature or bug fix. Examples:
- "Add skeleton loading states to the habit list"
- "Fix the date picker not respecting user timezone"
- "Add export to CSV for the weekly summary"

If `$ARGUMENTS` is empty, ask for a description before proceeding.

---

## Process

### Step 1: Determine role and available agents

Read `CLAUDE.md` to find:
- The current user's role (developer or designer)
- The Agent Scope Map
- Which agents are available for this role

Only call agents available to your role. If a feature requires an agent outside
your role's scope, note it in the plan as a dependency requiring architect involvement.

### Step 2: Research using context tools

Call the relevant context tools through their orchestrator — do not read files
directly. Each tool call returns a bounded summary (≤15 lines).

Cap at 10 tool calls. If the feature requires more, the scope is too large —
break it into two plans.

### Step 3: Generate the wave-structured plan

```markdown
# Plan: [Feature Name]
Created: [date]
Author: [role — developer | designer]
Status: pending-review
PR: [will be filled after PR creation]

## Context
[2–3 sentences: what exists today and what needs to change]

## Agent Scope
[List every agent called during research. Flag any out-of-scope dependencies.]

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| [path] | [range] | [what changes] |

## Wave Plan

### Wave 1 — [parallel | sequential]
Tasks in this wave [can run in parallel | must run in sequence].

#### Task 1.1: [title]
File: [path:lines]
What: [precise description]
Validate: [how to verify]

#### Task 1.2: [title]  ← parallel with 1.1 if wave is parallel
...

### Wave 2 — [parallel | sequential]
Depends on: Wave 1 complete

#### Task 2.1: [title]
...

## Tests to Write
- [ ] [test] — [file]

## Non-Goals
- [at least 2]

## Out-of-Scope Dependencies
[Anything requiring architect-only agents, or "None"]

## Risks
[Anything that could break existing behavior]
```

**Wave rules:**
- Tasks with no dependency on each other → same wave, mark `parallel`
- Tasks that depend on prior output → new wave, mark `sequential`
- Max 3 tasks per wave. If more needed, add another wave.
- Max 5 waves total. If more needed, split into two plans.

### Step 4: Save the plan

Save to: `.agents/plans/[kebab-case-feature-name].md`

### Step 5: Commit and open plan PR

```bash
# Create and switch to plan branch
git checkout -b plan/[feature-name]

# Stage only the plan file
git add .agents/plans/[feature-name].md
git commit -m "plan: [feature name]

Author: [role]
Waves: [N]
Tasks: [total task count]
Out-of-scope deps: [yes/no]"

# Open PR via platform script
scripts/open-pr.sh \
  --title "Plan: [Feature Name]" \
  --body "[plan file contents rendered as checklist]" \
  --base main \
  --head plan/[feature-name] \
  --label "rad:plan" \
  --label "rad:pending-review"
```

### Step 6: Record PR URL in plan file

After the PR is created, update the plan file's `PR:` field with the URL.
Amend the commit:

```bash
git add .agents/plans/[feature-name].md
git commit --amend --no-edit
git push --force-with-lease origin plan/[feature-name]
```

### Step 7: Output summary

```
Plan created: .agents/plans/[feature-name].md
Branch:       plan/[feature-name]
PR:           [url]
Waves:        [N]
Tasks:        [total]

Waiting for architect review.
Run /rad-deliver .agents/plans/[feature-name].md once the PR is merged.
```

---

## Rules

- Only call agents available to your role (check Agent Scope Map in CLAUDE.md)
- Do not read files directly — only through context tool orchestrators
- Do not write any code in this phase
- Cap research at 10 tool calls — split the plan if more is needed
- Every plan must have at least 2 non-goals
- Do not run `/rad-deliver` yourself — wait for the PR to be merged
- If out-of-scope dependencies exist, flag them clearly — do not attempt to
  work around them by reading files directly
