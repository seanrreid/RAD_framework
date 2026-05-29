---
description: >
  Plan a feature or bug fix within your role's agent boundaries. Delegates
  codebase research to an Explore sub-agent that returns bounded summaries.
  Main context receives only the research summary, then generates a
  wave-structured plan file, cuts a rad/ work branch, and commits the plan to it.
  No PR is opened — execution is blocked until the architect runs /rad-approve.
---

# /rad-plan

Research and plan a feature within your agent boundaries. The plan doc lives on
its own `rad/[feature]` work branch (Lane B): nothing is committed to the default
branch here. The architect approves with `/rad-approve` — there is no plan PR. The
plan and its code reach the default branch later, together, via the single
deliver PR.

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

### Step 2: Delegate research to an Explore sub-agent

Spawn an Explore sub-agent with the prompt below. Fill in all bracketed values
before calling. **Do not read files directly in main context** — the sub-agent
returns bounded summaries; use those to write the plan.

```
You are researching a codebase to support a feature plan. Return bounded
summaries only — no raw file dumps. Cap each file summary at 15 lines.
Stop after 10 searches total regardless of what remains.

Feature: [feature description from $ARGUMENTS]
Role scope: [agent scope for this role from CLAUDE.md Agent Scope Map]

Research goals:
1. Find the files most likely touched by this feature (entry points, components,
   models, routes, tests — whatever is relevant to the stack)
2. For each file found, summarize: what it does, approximate line count,
   which lines are relevant to this feature
3. Identify any shared infrastructure, auth modules, or files this feature
   must not touch
4. Note any existing patterns (naming, structure, test conventions) the
   implementation should follow

Return format — output this block and nothing after it:

RESEARCH_SUMMARY
feature: [feature name]
searches_used: [N] of 10

files:
  - path: [file path]
    lines: [approximate line count]
    relevant_lines: [range or "throughout"]
    summary: [1–2 sentences: what it does and what changes for this feature]

do_not_touch:
  - [path] — [why]

patterns:
  - [observed pattern the plan should follow]

out_of_scope_flags:
  - [anything that signals this feature may cross agent scope boundaries]
END_RESEARCH_SUMMARY
```

**After the sub-agent returns:** parse the `RESEARCH_SUMMARY` block. This is
your complete research input. Do not spawn additional research agents or read
files directly. If the summary reveals the feature is larger than one plan can
hold (more than ~12 files in scope), split into two plans before continuing.

### Step 3: Generate the wave-structured plan

Derive the feature slug (kebab-case) and the work branch name `rad/[feature-slug]`.
Record the branch in the `Branch:` header so every downstream step
(`/rad-approve`, `/rad-deliver`) can resolve and validate it.

```markdown
# Plan: [Feature Name]
Created: [date]
Author: [role — developer | designer]
Status: pending-review
Branch: rad/[feature-slug]

## Context
[2–3 sentences: what exists today and what needs to change]

## Scope
| In scope | Out of scope |
|---|---|
| [what this plan will change] | [related thing this plan will NOT touch] |

## Acceptance Criteria
<!-- Numbered, testable outcomes. Every Wave task's Validate: field must cite one. -->
1. [observable, verifiable outcome]
2. [observable, verifiable outcome]

## Agent Scope
[List every agent called during research. Flag any out-of-scope dependencies.]

## Files in Scope
<!-- Lines must be a range (e.g. 45-120) or a single number. The linter sums
     these to compute context budget. Warn at 800 lines, error at 1500. -->
| File | Lines | Change |
|------|-------|--------|
| [path] | [start-end] | [what changes] |

## Execution Notes

### Do Not Touch
<!-- Files that must not be modified during execution.
     Add shared infrastructure, auth modules, anything that would break other in-flight work. -->
- None

### Key Files
<!-- Files Claude should load before starting — no line numbers needed.
     List files that carry context essential to executing this plan correctly. -->
- [file path] — [why it matters]

### Reminders
<!-- Execution-time cautions: ordering constraints, side effects, environment requirements. -->
- None

## Wave Plan

### Wave 1 — [parallel | sequential]
Tasks in this wave [can run in parallel | must run in sequence].

#### Task 1.1: [title]
File: [path:lines]
What: [precise description]
Validate: AC#[N] — [how to verify]

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
- Every task's `Validate:` field must cite a specific `AC#N` — no floating tasks.

### Step 4: Save the plan

Save to: `.agents/plans/[feature-slug].md`

### Step 4b: Lint the plan

```bash
scripts/lint-plan.sh .agents/plans/[feature-slug].md
```

Fix any errors before committing. Warnings should be reviewed but do not block.

### Step 5: Cut the work branch and commit the plan

Cut `rad/[feature-slug]` from the project default branch and commit the plan doc
to it. **No PR is opened, and nothing is committed to the default branch.**

```bash
BASE=$(scripts/get-default-branch.sh)

# Cut the work branch from the latest default branch
git fetch origin "$BASE"
git checkout -b "rad/[feature-slug]" "origin/$BASE"

# Stage only the plan file
git add .agents/plans/[feature-slug].md
git commit -m "plan: [feature name]

Author: [role]
Waves: [N]
Tasks: [total task count]
Out-of-scope deps: [yes/no]"

# Publish the branch tip — /rad-approve reads the plan from origin/rad/[feature-slug]
git push -u origin "rad/[feature-slug]"
```

If the project tracks plans against issues and `gh` is available, mirror the
status label (best-effort; no-ops without `gh`):

```bash
scripts/rad-label.sh [issue-number] pending-review   # omit if there is no issue
```

### Step 6: Output summary

```
Plan created: .agents/plans/[feature-slug].md
Branch:       rad/[feature-slug]   (pushed — no PR; this is the Lane B model)
Waves:        [N]
Tasks:        [total]
ACs:          [count]

Waiting for architect approval.
The architect runs /rad-approve [feature-slug] to unblock execution.
Run /rad-deliver .agents/plans/[feature-slug].md once approved.
```

---

## Rules

- Only call agents available to your role (check Agent Scope Map in CLAUDE.md)
- Do not read files directly — delegate all research to the Explore sub-agent
- Do not write any code in this phase
- Research is one sub-agent call — do not spawn multiple research agents
- Cap the sub-agent at 10 searches — split the plan if the feature needs more
- Every plan must have at least 2 non-goals and at least 1 acceptance criterion
- Every Wave task's `Validate:` must cite an `AC#N`
- Cut the `rad/[feature]` branch from the default branch and commit the plan there —
  never commit the plan to the default branch, and never open a plan PR
- Do not run `/rad-deliver` yourself — wait for the architect to run `/rad-approve`
- If out-of-scope dependencies exist, flag them clearly — do not attempt to
  work around them by reading files directly
