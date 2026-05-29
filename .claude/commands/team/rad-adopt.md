---
description: >
  Adopt a pre-existing issue into the RAD framework. Fetches issue context from
  GitHub/GitLab (or accepts a free-form description), researches the codebase,
  and generates a wave-structured plan file. The plan goes through /rad-approve
  before execution — same gate as /rad-plan.
---

# /rad-adopt

Convert a pre-existing issue into a RAD plan. Use this for work that existed
before the RAD framework was introduced.

## Input

`$ARGUMENTS` can be:
- A GitHub/GitLab issue URL: `https://github.com/org/repo/issues/42`
- An issue number: `#42` or `42`
- A free-form description: `"Fix the login timeout not resetting on activity"`

If empty, ask for the issue reference or description before proceeding.

---

## Process

### Step 1: Determine role and available agents

Read `CLAUDE.md` to find:
- The current user's role (architect, developer, or designer)
- The Agent Scope Map
- Which agents are available for this role

Only call agents available to your role. Flag out-of-scope dependencies in the
plan rather than working around them.

### Step 2: Fetch issue context

**If `$ARGUMENTS` is a URL or issue number:**

```bash
# GitHub
gh issue view [number-or-url] --json title,body,labels,comments,assignees,url

# GitLab
glab issue view [number-or-url] --output json
```

Extract:
- Title
- Body / description
- Labels
- Comments (summarize if long — keep to ≤10 lines)
- Issue URL (for `Adopted-From:` field)

If the CLI is unavailable or the fetch fails, prompt the user to paste the issue
content directly and use that as the description.

**If `$ARGUMENTS` is a free-form description:**

Use the description as-is. Set `Adopted-From: [description]` in the plan header.

### Step 3: Summarize what the issue asks for

Before researching the codebase, output a brief interpretation:

```
Issue: [title or first sentence of description]
Interpreting as: [1-2 sentence plain-language summary of what needs to change]

Is this correct? (yes / clarify)
```

If the user clarifies, update the interpretation and continue.

### Step 4: Research the codebase

Use context tools to confirm what's affected. The issue provides direction —
research confirms scope and uncovers what the issue may not have known.

Cap at 10 tool calls. If more are needed, the issue is too large — split it
into two adopt commands with narrower scope each.

### Step 5: Generate the wave-structured plan

Use the same structure as `/rad-plan`, with two additions to the header:

```markdown
# Plan: [Feature Name]
Created: [date]
Author: [role — architect | developer | designer]
Status: pending-review
Branch: rad/[feature-slug]
Adopted-From: [issue URL or description]
Issue-Title: [original issue title, if fetched]

## Context
[2–3 sentences: what exists today, what the issue reported, what needs to change.
 Note if the original issue was vague or under-specified.]

## Scope
| In scope | Out of scope |
|---|---|
| [what this plan will change] | [related thing this plan will NOT touch] |

## Acceptance Criteria
<!-- Numbered, testable outcomes. Every Wave task's Validate: field must cite one. -->
1. [observable, verifiable outcome]
2. [observable, verifiable outcome]

## Agent Scope
[List every agent called during research. Flag out-of-scope dependencies.]

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| [path] | [range] | [what changes] |

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

...

## Tests to Write
- [ ] [test] — [file]

## Non-Goals
- [at least 2]

## Out-of-Scope Dependencies
[Anything requiring architect-only agents, or "None"]

## Risks
[Anything that could break existing behavior. Note if original issue
 description conflicted with current code state.]

## Issue Gaps
[Anything the original issue left unspecified that this plan resolves with
 an assumption. Mark each assumption so the architect can verify it.]
```

The `## Issue Gaps` section is mandatory — it surfaces where the plan made
judgment calls that the original issue left open.

### Step 6: Save the plan

Save to: `.agents/plans/[feature-slug].md`

Derive the feature slug (kebab-case) from the issue title or description — keep
it short and descriptive — and record the work branch `rad/[feature-slug]` in the
plan's `Branch:` header.

### Step 6b: Lint the plan

```bash
scripts/lint-plan.sh .agents/plans/[feature-name].md
```

Fix any errors before committing. For adopted plans, `lint-plan.sh` also
verifies `## Issue Gaps` is non-empty. Warnings should be reviewed but do not block.

### Step 7: Cut the work branch and commit the plan

Cut `rad/[feature-slug]` from the project default branch and commit the plan doc
to it. **No PR is opened, and nothing is committed to the default branch.**

```bash
BASE=$(scripts/get-default-branch.sh)
git fetch origin "$BASE"
git checkout -b "rad/[feature-slug]" "origin/$BASE"

git add .agents/plans/[feature-slug].md
git commit -m "adopt: [feature name]

Adopted-From: [issue URL or short description]
Author: [role]
Waves: [N]
Tasks: [total task count]
Out-of-scope deps: [yes/no]"

git push -u origin "rad/[feature-slug]"
scripts/rad-label.sh [issue-number] pending-review   # omit if there is no issue
```

### Step 8: Output summary

```
Plan adopted: .agents/plans/[feature-slug].md
Source:       [issue URL or description]
Branch:       rad/[feature-slug]   (pushed — no PR; this is the Lane B model)
Waves:        [N]
Tasks:        [total]
Issue Gaps:   [count — assumptions the architect should verify]

Waiting for architect approval.
The architect runs /rad-approve [feature-slug] to unblock execution.
```

---

## Rules

- Only call agents available to your role (check Agent Scope Map in CLAUDE.md)
- Do not read files directly — only through context tool orchestrators
- Do not write any code in this phase
- Cap research at 10 tool calls — split if more is needed
- Every plan must have at least 2 non-goals and at least 1 acceptance criterion
- Every Wave task's `Validate:` must cite an `AC#N`
- Cut the `rad/[feature]` branch from the default branch and commit the plan there —
  never commit the plan to the default branch, and never open a plan PR
- The `## Issue Gaps` section is mandatory — never leave it empty
- Do not run `/rad-deliver` yourself — wait for the architect to run `/rad-approve`
- If the original issue references work already partially done, note it in
  Context and scope the plan to the remaining work only
