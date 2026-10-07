---
name: rad-plan
description: >
  Plan a feature or bug fix within your role's agent boundaries. Delegates
  codebase research to a research sub-agent (or inline research) that returns bounded summaries.
  Main context receives only the research summary, then generates a
  wave-structured plan file, cuts a rad/ work branch, and commits the plan to it.
  No PR is opened — execution is blocked until the architect runs rad-approve.
targets:
  claude: command:team/rad-plan
  codex: skill
---

# rad-plan

Research and plan a feature within your agent boundaries. The plan doc lives on
its own `rad/[feature]` work branch (Lane B): nothing is committed to the default
branch here. The architect approves with `rad-approve` (`/architect:rad-approve` in
Claude Code) — there is no plan PR. The
plan and its code reach the default branch later, together, via the single
deliver PR.

## Input

The input ({{args}}) should describe the feature or bug fix. Examples:
- "Add skeleton loading states to the habit list"
- "Fix the date picker not respecting user timezone"
- "Add export to CSV for the weekly summary"

If {{args}} is empty, ask for a description before proceeding.

`--light` may prefix the description to request a **light-tier** plan — a
condensed, single-wave plan for a small, low-risk change:
- "--light Fix the typo in the onboarding guide"

Without `--light`, every step below runs in standard mode, unchanged.

`--override-disposition "<reason>"` may accompany the description to proceed
past a research artifact's cited non-actionable disposition (see Step 0). The
override and its reason are recorded in the plan header.

---

## Process

### Step 0: Check the research disposition

Derive the feature slug the same way Step 3 does (kebab-case; if {{args}}
names a research slug, use it). If `.agents/research/[feature-slug].md` does not
exist, skip this step — no research artifact, no check.

Otherwise run:

```bash
scripts/check-disposition.sh .agents/research/[feature-slug].md
# when {{args}} includes --override-disposition "<reason>":
scripts/check-disposition.sh .agents/research/[feature-slug].md --override "<reason>"
```

- **Exit 1** — cited non-actionable disposition. Stop and show its output (the
  disposition, the evidence, and the `--override-disposition "<reason>"` syntax).
  Do not research and do not write a plan. In an unattended run this is a stop —
  report and end, never wait for input.
- **Exit 2** — usage error or unreadable artifact. Report the error and stop.
- **Exit 0** — proceed. If the output begins `overridden:`, add
  `Disposition-Override: [disposition] — [reason]` to the plan's header block
  (after `Branch:`, and after `Tier:` in a light plan).

### Step 1: Determine role and available agents

Read the role and scope config from `.rad/config.yml` (see `docs/configuration.md`):

```bash
node harness/cli.js config get roles.developers   # also roles.designers, roles.architect
node harness/cli.js config get agent_scope_map    # one { agent, type, reads, roles } row per line
```

From that output, find:
- The current user's role (developer or designer)
- Which agents are available for this role (rows whose `roles` include it)

Only call agents available to your role. If a feature requires an agent outside
your role's scope, note it in the plan as a dependency requiring architect involvement.

### Step 2: Delegate research to a sub-agent

If your tool can run a sub-agent, give it the prompt below; otherwise run the
same research inline with the same caps. Either way, keep only the
`RESEARCH_SUMMARY` block in your working context. Fill in all bracketed values
before starting. **Do not carry raw file contents into the plan** — the research
returns bounded summaries; use those to write the plan.

```
You are researching a codebase to support a feature plan. Return bounded
summaries only — no raw file dumps. Cap each file summary at 15 lines.
Stop after 10 searches total regardless of what remains.

Feature: [feature description from {{args}}]
Role scope: [agent scope for this role from `node harness/cli.js config get agent_scope_map`]

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

**After the research returns:** parse the `RESEARCH_SUMMARY` block. This is
your complete research input. Do not spawn additional research agents or read
files directly. If the summary reveals the feature is larger than one plan can
hold (more than ~12 files in scope), split into two plans before continuing.

#### Step 2 under `--light`: quick scope check

Under `--light`, replace the full research above with a quick scope check. If
your tool can run a sub-agent, give one sub-agent this prompt; otherwise run the
same check inline with the same cap (3 tool calls). Either way, keep only the
`SCOPE_CHECK` block in your working context:

```
You are running a quick scope check for a small change. Use at most 3 tool
calls total, then stop. Return no file contents.

Change: [description from {{args}}, without the --light prefix]

Return format — output this block and nothing after it:

SCOPE_CHECK
tool_calls_used: [N] of 3
candidate_files:
  - [path] — [what changes]
likely_waves: [N]
likely_tasks: [N]
END_SCOPE_CHECK
```

**Refuse `--light` before writing anything** — no plan file, no branch — when
the scope check shows any of:
- more than 1 wave, or more than 3 tasks
- a candidate file matching a high-risk pattern (`RAD_HIGH_RISK_PATTERNS`,
  default `auth|payment|billing|migration|secret|credential|token`)
- a candidate file on a self-protected path (`harness/`, `scripts/`,
  `.claude/`, `.agents/state/`, `gates.yaml`/`matrix.yaml`)

Name the reason and point to standard mode:

```
--light refused: [reason, e.g. "touches self-protected path scripts/lint-plan.sh"]
Run rad-plan [description] (without --light) for a standard plan.
```

### Step 3: Generate the wave-structured plan

Derive the feature slug (kebab-case) and the work branch name `rad/[feature-slug]`.
Record the branch in the `Branch:` header so every downstream step
(`rad-approve`, `rad-deliver` — `/team:rad-deliver` in Claude Code) can resolve and validate it.

```markdown
# Plan: [Feature Name]
Created: [date]
Author: [role — developer | designer]
Status: pending-review
Branch: rad/[feature-slug]
Issue: [issue number — omit when the plan has no issue]

## Context
[2–3 sentences: what exists today and what needs to change]
<!-- If a mockup for this feature exists at .agents/mockups/<feature>.html
     (written by rad-research or rad-design), reference its path here, e.g.
     "Mockup: .agents/mockups/<feature>.html". scripts/lint-plan.sh warns if a
     referenced mockup is missing on disk. Optional — omit if none exists. -->

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
<!-- Lines must be a range (e.g. 45-120) or a single line (e.g. 88) — a bare
     number counts as ONE line. The linter sums these to compute context
     budget. Warn at 800 lines, error at 1500.
     A task `File:` line may list several comma-separated files, each with an
     optional `:lines` suffix; an extra range-only part (e.g. `a.js:16-33, 80-96`)
     is read as another range of the same file.
     A RENAME DECLARES BOTH PATHS: one row for the source, one for the
     destination. scripts/check-scope.sh builds the declared set from the File
     column only — it never reads this Change prose — so a `git mv` destination
     mentioned only in a Change cell reads as out-of-scope drift and fails the
     scope check at deliver time. -->
| File | Lines | Change |
|------|-------|--------|
| [path] | [start-end] | [what changes] |

## Program Design
<!-- OPTIONAL. Recommended for large/medium plans; skippable for small ones
     (1–2 waves, no high-risk path). Capture the three artifacts before delivery:
       1. Key type/method signatures the change introduces or alters
       2. A call-stack / control-flow sketch of how the pieces connect
       3. A file-tree diff of files added / moved / deleted
     The linter greps for this `## Program Design` header and advises (never
     errors) when a large plan omits it. -->

## Execution Notes

### Do Not Touch
<!-- Files that must not be modified during execution.
     Add shared infrastructure, auth modules, anything that would break other in-flight work. -->
- None

### Key Files
<!-- Files the executor should load before starting — no line numbers needed.
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

## Waivers
<!-- OPTIONAL. Only for high-risk path findings you are deliberately keeping.
     One bullet per finding: `- high-risk:<path>: <justification>`.
     Clarification markers cannot be waived — answer them in the plan. -->
```

**Wave rules:**
- Tasks with no dependency on each other → same wave, mark `parallel`
- Tasks that depend on prior output → new wave, mark `sequential`
- Max 3 tasks per wave. If more needed, add another wave.
- Max 5 waves total. If more needed, split into two plans.
- Every task's `Validate:` field must cite a specific `AC#N` — no floating tasks.
- Prefer vertical slices: each wave should land a testable end-to-end increment
  (one workflow's schema + service + API + UI together) rather than a
  stack-ordered sequence (all schema → all service → all UI), which pushes
  integration risk into the last wave. This is a preference, not a rule — pure
  refactors and harness-internal work may be horizontal. `scripts/lint-plan.sh`
  advises (never blocks) when a plan's waves look stack-ordered.

**Open questions become clarification markers.** Any open question or unmade
decision MUST be written inline, where it applies, as a marker on a single line:
`[NEEDS CLARIFICATION: <question>]`. Never resolve one silently by assumption. A
marker stays in the plan until the answer is written in its place.

The optional `## Waivers` section records a justified waiver for each high-risk
path finding (`scripts/lint-plan.sh` lists them) the plan deliberately keeps:

```markdown
## Waivers
- high-risk:src/auth/session.js: touches only the session-expiry constant; no credential handling
```

Markers are resolve-only — they can never be waived. `rad-approve` refuses while
any blocker remains: an unresolved marker, or a high-risk finding that is neither
removed nor waived.

The optional `## Program Design` section (signatures, a call-stack sketch, and a
file-tree diff) is recommended for large/medium plans and skippable for small ones
(1–2 waves, no high-risk path).

#### Step 3 under `--light`: the light template

Under `--light`, write this template instead. `Tier: light` goes in the header
block, before the first `## ` section. Scope, Agent Scope, Execution Notes, and
Risks are optional; the sections below are required.

```markdown
# Plan: [Feature Name]
Created: [date]
Author: [role — developer | designer]
Status: pending-review
Branch: rad/[feature-slug]
Tier: light
Issue: [issue number — omit when the plan has no issue]

## Context
[1–2 sentences: what exists today and what needs to change]

## Acceptance Criteria
1. [observable, verifiable outcome]

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| [path] | [start-end] | [what changes] |

## Wave Plan

### Wave 1 — [parallel | sequential]
<!-- The only wave. At most 3 tasks. -->

#### Task 1.1: [title]
File: [path:lines]
What: [precise description]
Validate: AC#[N] — [how to verify]

## Tests to Write
- [ ] [test] — [file]

## Non-Goals
- [at least 2]

## Risks
<!-- OPTIONAL. -->
[Anything that could break existing behavior]
```

A light plan is limited to 1 wave, at most 3 tasks, and no high-risk or
self-protected path. `scripts/lint-plan.sh` reports a plan beyond any limit as a
non-waivable `light-tier:` approval blocker.

### Step 4: Save the plan

Save to: `.agents/plans/[feature-slug].md`

### Step 4b: Lint the plan

```bash
scripts/lint-plan.sh .agents/plans/[feature-slug].md
```

Fix any errors before committing. Warnings should be reviewed but do not block.

Then run the plan-time forecast over the files the plan declares:

```bash
node harness/cli.js forecast .agents/plans/[feature-slug].md
```

Show every `forecast:` line (and the summary line) to the author as an
**advisory** before committing — a code-legibility signal from past deliveries
about the regions this plan touches, not a verdict. Exit 0 → continue. Non-zero
(2: unreadable plan or path-parse failure; 1: malformed event log) → report the
reason and continue. The forecast never blocks planning.

### Step 5: Cut the work branch and commit the plan

Cut `rad/[feature-slug]` from the project default branch and commit the plan doc
to it with one command. **No PR is opened, and nothing is committed to the
default branch.**

```bash
node harness/cli.js plan-open .agents/plans/[feature-slug].md [--trailer "Key: Value" ...]
```

Pass one `--trailer "Key: Value"` per attribution line your tool requires on
commits (single-line each); pass none if it requires none.

The command fetches the default branch, cuts `rad/[feature-slug]` from it, stages
only the plan file, commits it with a message it derives from the plan (title,
`Author`, `Issue`, `Waves`, `Tasks`, `Out-of-scope deps`), pushes the branch, and
then labels the plan's `Issue:` `pending-review` itself. Do not run those steps by
hand.

- **Exit 0** → the branch is pushed; continue to Step 6.
- **Exit 1** → the plan is committed locally but not pushed (or labelling failed).
  Report the message to the author and rerun the same command once the push can
  succeed — a rerun is safe and resumes where it stopped.
- **Exit 2** → nothing changed. Fix the reported problem (lint error, `Branch:`
  header, uncommitted changes, an existing branch) and rerun.

### Step 6: Output summary

```
Plan created: .agents/plans/[feature-slug].md
Branch:       rad/[feature-slug]   (pushed — no PR; this is the Lane B model)
Waves:        [N]
Tasks:        [total]
ACs:          [count]

Waiting for architect approval.
The architect runs rad-approve [feature-slug] to unblock execution.
Run rad-deliver .agents/plans/[feature-slug].md once approved.
```

---

## Rules

- Only call agents available to your role (check `node harness/cli.js config get agent_scope_map`)
- Do not read files directly — delegate all research to a sub-agent if your tool
  can run one, otherwise run it inline with the same caps; either way keep only
  the `RESEARCH_SUMMARY` block
- Do not write any code in this phase
- Research is one sub-agent call — do not spawn multiple research agents
- Cap the sub-agent at 10 searches — split the plan if the feature needs more
- Every plan must have at least 2 non-goals and at least 1 acceptance criterion
- Every Wave task's `Validate:` must cite an `AC#N`
- Write every open question or unmade decision as an inline one-line
  `[NEEDS CLARIFICATION: <question>]` marker — never silently assume an answer
- Cut the `rad/[feature]` branch from the default branch and commit the plan there —
  never commit the plan to the default branch, and never open a plan PR
- Do not run `rad-deliver` yourself — wait for the architect to run `rad-approve`
- A light plan (`--light`) still requires `rad-approve` — the tier never skips
  the approval gate. To promote a light plan to standard, remove `Tier: light`
  and add the standard sections
- If out-of-scope dependencies exist, flag them clearly — do not attempt to
  work around them by reading files directly
