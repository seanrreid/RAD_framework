---
name: rad-adopt
description: >
  Adopt a pre-existing issue into the RAD framework. Fetches issue context from
  GitHub/GitLab (or accepts a free-form description), researches the codebase,
  and generates a wave-structured plan file. The plan goes through rad-approve
  before execution — same gate as rad-plan.
targets:
  claude: command:team/rad-adopt
  codex: skill
---

# rad-adopt

Convert a pre-existing issue into a RAD plan. Use this for work that existed
before the RAD framework was introduced.

## Input

The input ({{args}}) can be:
- A GitHub/GitLab issue URL: `https://github.com/org/repo/issues/42`
- An issue number: `#42` or `42`
- A free-form description: `"Fix the login timeout not resetting on activity"`

If empty, ask for the issue reference or description before proceeding.

`--override-disposition "<reason>"` may accompany the input to proceed past a
research artifact's cited non-actionable disposition (see Step 2b). The override
and its reason are recorded in the plan header.

`--playbook <kind>/<slug>[@<version>]` may accompany the input to start from a
pinned playbook in `.agents/playbooks/` (see Step 3b). A bare ref pins the
playbook's current version.

---

## Process

### Step 1: Determine role and available agents

Read the role and scope config from `.rad/config.yml` (see `docs/configuration.md`):

```bash
node harness/cli.js config get roles.developers   # also roles.designers, roles.architect
node harness/cli.js config get agent_scope_map    # one { agent, type, reads, roles } row per line
```

From that output, find:
- The current user's role (architect, developer, or designer)
- Which agents are available for this role (rows whose `roles` include it)

Only call agents available to your role. Flag out-of-scope dependencies in the
plan rather than working around them.

### Step 2: Fetch issue context

**If {{args}} is a URL or issue number:**

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

**If {{args}} is a free-form description:**

Use the description as-is. Set `Adopted-From: [description]` in the plan header.

### Step 2b: Check the research disposition

Derive the feature slug the same way Step 6 does (kebab-case from the issue
title or description). If a research artifact exists for this issue —
`.agents/research/[feature-slug].md`, or one whose `Source:` is this issue URL —
run:

```bash
scripts/check-disposition.sh .agents/research/[slug].md
# when {{args}} includes --override-disposition "<reason>":
scripts/check-disposition.sh .agents/research/[slug].md --override "<reason>"
```

- **Exit 1** — cited non-actionable disposition. Stop and show its output (the
  disposition, the evidence, and the `--override-disposition "<reason>"` syntax).
  Do not research and do not write a plan. In an unattended run this is a stop —
  report and end, never wait for input.
- **Exit 2** — usage error or unreadable artifact. Report the error and stop.
- **Exit 0** — proceed. If the output begins `overridden:`, add
  `Disposition-Override: [disposition] — [reason]` to the plan's header block
  (after `Issue-Title:`).

No research artifact → no check; continue to Step 3.

### Step 3: Summarize what the issue asks for

Before researching the codebase, output a brief interpretation:

```
Issue: [title or first sentence of description]
Interpreting as: [1-2 sentence plain-language summary of what needs to change]

Is this correct? (yes / clarify)
```

If the user clarifies, update the interpretation and continue.

### Step 3b: Load the pinned playbook

Skip this step unless {{args}} includes `--playbook <kind>/<slug>[@<version>]`.

1. **Resolve the ref.** With no `@<version>`, use the `version` in the playbook
   file's frontmatter (`.agents/playbooks/<kind>--<slug>.md`).
2. **Check it.** Run:

   ```bash
   node harness/cli.js playbook check-ref <kind>/<slug>@<version>
   ```

   A non-zero exit stops this command: show stderr and write no plan. A
   `stale current=N` result is a warning, not a stop: also read the Upgrade Guide
   entries after the pinned version.
3. **Read the playbook** at `.agents/playbooks/<kind>--<slug>.md`. Treat its
   `## Files typically touched` and `## Wave skeleton` as the starting point for
   research scope, Files in Scope and the wave structure. Adapt them to the
   actual change; never copy them blindly.
4. **Record the pin.** Add `Playbook: <kind>/<slug>@<version>` to the plan header,
   after `Issue:` (rad-adopt's header template carries the same line).
5. **Record deviations.** The plan body gets a `## Playbook Deviations` section
   after `## Risks`: each departure from the playbook and why, or `None`.
6. **Guardrails.** Pinning never approves a plan or lowers any gate — the plan
   still goes through rad-approve — and a run never edits a playbook.

### Step 4: Research the codebase

Delegate the research to a sub-agent if your tool can run one; otherwise do it
inline. Either way, keep only a bounded summary of what's affected in your
working context. The issue provides direction —
research confirms scope and uncovers what the issue may not have known.

Cap at 10 tool calls. If more are needed, the issue is too large — split it
into two adopt commands with narrower scope each.

### Step 5: Generate the wave-structured plan

Use the same structure as `rad-plan` (`/team:rad-plan` in Claude Code), with these additions to the header:

```markdown
# Plan: [Feature Name]
Created: [date]
Author: [role — architect | developer | designer]
Status: pending-review
Branch: rad/[feature-slug]
Issue: [issue number when the source is an issue — omit otherwise]
Playbook: [<kind>/<slug>@<version> — omit unless --playbook was given]
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
<!-- Lines must be a range (e.g. 45-120) or a single line (e.g. 88) — a bare
     number counts as ONE line toward the linter's context budget.
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
| [path] | [range] | [what changes] |

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

## Playbook Deviations
<!-- Only when --playbook was given. -->
[Each departure from the playbook and why, or "None"]

## Issue Gaps
[Anything the original issue left unspecified that this plan resolves with
 an assumption. Mark each assumption so the architect can verify it.]
```

The `## Issue Gaps` section is mandatory — it surfaces where the plan made
judgment calls that the original issue left open.

**Verify the whole suite on the last wave.** When a plan touches `harness/`,
`scripts/`, `.rad/`, `.claude/` or `.agents/skills/`, add the line
`Verify: exec bash scripts/verify-all.sh` to the last wave, and run `rad deliver`
with `RAD_VERIFY_TIMEOUT_SECONDS=1800` (the default is 600 s).

**Open questions become clarification markers.** Any open question or unmade
decision MUST be written inline, where it applies, as a marker on a single line:
`[NEEDS CLARIFICATION: <question>]`. Never resolve one silently by assumption.
This is distinct from `## Issue Gaps`: Issue Gaps records assumptions the plan
DID make, for the architect to verify; a marker records a question the plan did
NOT answer. `rad-approve` (`/architect:rad-approve` in Claude Code) refuses while any marker remains unresolved, and
markers cannot be waived.

### Step 6: Save the plan

Save to: `.agents/plans/[feature-slug].md`

Derive the feature slug (kebab-case) from the issue title or description — keep
it short and descriptive — and record the work branch `rad/[feature-slug]` in the
plan's `Branch:` header.

### Step 6b: Lint the plan

```bash
scripts/lint-plan.sh .agents/plans/[feature-slug].md
```

Fix any errors before committing. For adopted plans, `lint-plan.sh` also
verifies `## Issue Gaps` is non-empty. Warnings should be reviewed but do not block.

Then run the plan-time forecast over the files the plan declares:

```bash
node harness/cli.js forecast .agents/plans/[feature-slug].md
```

Show every `forecast:` line (and the summary line) to the author as an
**advisory** before committing — a code-legibility signal from past deliveries
about the regions this plan touches, not a verdict. Exit 0 → continue. Non-zero
(2: unreadable plan or path-parse failure; 1: malformed event log) → report the
reason and continue. The forecast never blocks planning.

### Step 7: Cut the work branch and commit the plan

Cut `rad/[feature-slug]` from the project default branch and commit the plan doc
to it with one command. **No PR is opened, and nothing is committed to the
default branch.**

```bash
node harness/cli.js plan-open .agents/plans/[feature-slug].md [--trailer "Key: Value" ...]
```

Pass one `--trailer "Key: Value"` per attribution line your tool requires on
commits (single-line each); pass none if it requires none.

The command fetches the default branch, cuts `rad/[feature-slug]` from it, stages
only the plan file, commits it with a message it derives from the plan (an
`adopt:` subject because of `Adopted-From:`, plus `Adopted-From`, `Issue`,
`Author`, `Waves`, `Tasks`, `Out-of-scope deps`), pushes the branch, and then
labels the issue `pending-review` itself (from `Issue:`, or from an
`Adopted-From:` issue URL). Do not run those steps by hand.

- **Exit 0** → the branch is pushed; continue to Step 8.
- **Exit 1** → the plan is committed locally but not pushed (or labelling failed).
  Report the message to the author and rerun the same command once the push can
  succeed — a rerun is safe and resumes where it stopped.
- **Exit 2** → nothing changed. Fix the reported problem (lint error, `Branch:`
  header, uncommitted changes, an existing branch) and rerun.

### Step 8: Output summary

```
Plan adopted: .agents/plans/[feature-slug].md
Source:       [issue URL or description]
Branch:       rad/[feature-slug]   (pushed — no PR; this is the Lane B model)
Waves:        [N]
Tasks:        [total]
Issue Gaps:   [count — assumptions the architect should verify]

Waiting for architect approval.
The architect runs rad-approve [feature-slug] to unblock execution.
```

---

## Rules

- Only call agents available to your role (check `node harness/cli.js config get agent_scope_map`)
- Keep raw file contents out of your working context — delegate research to a
  sub-agent if your tool can run one, otherwise run it inline with the same caps;
  either way keep only the bounded summary
- Do not write any code in this phase
- Cap research at 10 tool calls — split if more is needed
- Every plan must have at least 2 non-goals and at least 1 acceptance criterion
- Every Wave task's `Validate:` must cite an `AC#N`
- Cut the `rad/[feature]` branch from the default branch and commit the plan there —
  never commit the plan to the default branch, and never open a plan PR
- The `## Issue Gaps` section is mandatory — never leave it empty
- Do not run `rad-deliver` yourself — wait for the architect to run `rad-approve`
- If the original issue references work already partially done, note it in
  Context and scope the plan to the remaining work only
