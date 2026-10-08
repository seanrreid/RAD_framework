---
name: rad-research
description: >
  Run the Research phase of the RAD framework. Consumes a PRD, GitHub issue,
  or inline spec and produces a research artifact for use by /rad-design.
  Can be run by any team member — no architect role required.
targets:
  claude: command:team/rad-research
  codex: skill
---

# rad-research

Consume a specification artifact and produce a RAD research artifact. This is
the R in Research/Architect/Deliver.

## Input

`{{args}}` should be one of:
- A file path: `docs/prd.md`, `SPEC.md`, `issues/42.md`
- A URL: `https://github.com/org/repo/issues/42`
- Empty — you will be prompted to paste the spec inline

---

## Process

### Step 1: Load the spec

Determine the input type from `{{args}}`:

**If `{{args}}` starts with `http://` or `https://`:**

If your tool can run a sub-agent, delegate the URL fetch with the prompt below;
otherwise fetch it inline with the same caps. Either way, keep only the bounded
`SPEC_SUMMARY` block in your working context:

```
Fetch the following URL and extract the key facts needed to design a software
system. Return a bounded summary only — no raw content dump. Max 60 lines.

URL: [URL from {{args}}]

Extract and return exactly this structure:

SPEC_SUMMARY
title: [project or issue title]
what_is_being_built: [1–3 sentences]
key_requirements:
  - [requirement]
  - [requirement]
main_domains:
  - [domain area — e.g. UI, API, auth, payments, notifications]
constraints:
  - [any technical, compliance, or scope constraints mentioned]
acceptance_criteria:
  - [if present — otherwise omit this field]
open_questions:
  - [anything ambiguous or unresolved in the spec]
END_SPEC_SUMMARY
```

Parse the `SPEC_SUMMARY` block. This is your complete spec input — do not
carry the raw page content forward.

**If `{{args}}` is a file path:**

Read the file directly. Extract the same fields from the content. Do not
delegate — a single read is sufficient.

**If `{{args}}` is empty:**

Say:
> "Paste your PRD, issue description, or spec below. When you're done, say 'done'."

Wait for the user's input. Extract the same fields from what they paste.

---

### Step 2: Confirm the spec read

Present the extracted facts to the user for confirmation:

```
Here's what I extracted from the spec:

**What's being built:** [what_is_being_built]

**Main domains:** [list]

**Key requirements:**
[list]

**Constraints:** [list or "None found"]

**Open questions:** [list or "None"]

Does this capture the spec correctly? Add anything missing before we continue.
```

Wait for confirmation. If the user corrects or adds anything, update your
extracted facts accordingly.

---

### Step 3: Ask RAD-specific clarifying questions

Ask all of the following at once — do not drip them one at a time:

```
A few things the spec won't tell me:

1. **Team:** Who will work on this? List names or usernames for:
   - Architect (approves plans via /rad-approve, merges deliver PRs): 
   - Developers:
   - Designers (if any):
   If there's no designated architect, say so — one person can fill both roles.

2. **Platform:** Where does your git repo live?
   github | gitlab | bitbucket | forgejo | manual (I'll print instructions instead of running CLI)

3. **Domain sensitivity:** Based on the domains above — [list extracted domains] —
   which should be architect-only vs. open to all developers?
   Architect-only is recommended for: auth, payments, infra, database migrations.

4. **Constraints:** Anything not in the spec that should shape the agent boundaries?
   Examples: legacy code areas to avoid, compliance requirements, multi-repo setup,
   third-party integrations that need careful scoping.

5. **Delivery target:** Any deadlines or phasing requirements that should influence
   how we scope the agent architecture?

6. **Mockup (optional, only if the spec has a user-visible surface):** Want a quick
   HTML mockup of the key screen(s) before we plan? Use HTML mockups, not prose,
   for UX where a misunderstanding is expensive. Skip if not useful.
```

Omit question 6 when the spec has no user-visible surface (APIs, CLIs with no
new output, harness-internal work).

Wait for answers. If any answer is unclear, ask one targeted follow-up.

If the mockup offer is accepted, write a single self-contained HTML file (inline
CSS, no external dependencies needed) to the path below, using the slug from
Step 4, and list it in the artifact's `## Mockup` section. A mockup is never
required — if declined or not applicable, write nothing and omit the section.

```
.agents/mockups/<slug>.html
```

---

### Step 4: Derive the project slug

From the spec title or project name, derive a kebab-case slug.
Examples: `e-commerce-platform`, `habit-tracker-api`, `auth-service-redesign`

If the title is ambiguous, confirm the slug with the user before saving.

---

### Step 4b: Try to refute the request (disposition)

This step's ONLY job is to try to establish that the request should **not** be
planned — with a concrete citation. It is not a design step and proposes no
solution. Research has a bias toward forcing a solution onto every request;
resist it here. Look for:

- A test that already pins the requested behavior as intended (`not-actionable`)
- A doc that states the current behavior is deliberate (`not-actionable`)
- An existing plan in `.agents/plans/` that already covers it (`superseded`)
- For a vague request: exactly what is missing to scope it (`insufficient-context`)

Record one disposition:

| Disposition | Meaning | Disposition-Evidence |
|-------------|---------|----------------------|
| `actionable` | Worth planning | empty |
| `not-actionable` | Intended behavior, already covered, or out of scope | the citation (file:line, test name, doc path) |
| `insufficient-context` | Cannot be scoped without specific missing info | the exact missing-items list |
| `superseded` | An existing plan/feature covers it | the covering plan path or feature |

**Absence of evidence → `actionable`.** A non-actionable disposition without a
concrete citation is not allowed — if you cannot cite it, the request is
actionable. A disposition is advice, not a lock: `/rad-plan` and `/rad-adopt`
refuse a cited non-actionable disposition, but the user can always proceed with
`--override-disposition "<reason>"`, which is recorded in the plan.

---

### Step 5: Write the research artifact

Choose the `Status:` by the artifact's intended consumer:
- `pending-design` — it feeds `/rad-design` (a new agent architecture is needed).
- `pending-plan` — it feeds `/rad-plan` directly (existing agent boundaries suffice).

Allowed `Status:` values:

| Status | Meaning |
|--------|---------|
| `pending-design` | Awaiting `/rad-design` |
| `pending-plan` | Awaiting `/rad-plan` — skips design |
| `parked` | Deliberately deferred; no next command |
| `consumed` | Turned into a plan / delivered work — hidden from the pre-plan list |

`consumed` is set by hand for now once the research has been turned into a plan —
no command advances it yet. `scripts/rad-status.sh` is the reader: it lists
pre-plan research with a next-command hint per status, and hides `consumed`
artifacts and any whose slug already has a plan.

Save to `.agents/research/[slug].md`:

```markdown
# Research: [Project Name]
Created: [YYYY-MM-DD]
Author: [developer | architect]
Status: [pending-design | pending-plan]
Disposition: [actionable | not-actionable | insufficient-context | superseded]
Disposition-Evidence: [citation or missing-items list; empty for actionable]
Source: [file path | URL | inline]

## Project Summary
[2–3 sentences describing what is being built]

## Key Requirements
- [requirement]
- [requirement]

## Domains

| Domain | Description | Sensitivity |
|--------|-------------|-------------|
| [name] | [what it owns] | open \| architect-only |

## Team

architect: [username or "unassigned"]
developers: [usernames or "unassigned"]
designers: [usernames or "none"]

## Platform

platform: [github | gitlab | bitbucket | forgejo | manual]
default_branch: main

## Constraints
- [constraint — or "None"]

## Open Questions
- [anything unresolved — or "None"]

## Mockup
<!-- OPTIONAL. Include only if a mockup was written in Step 3; otherwise omit. -->
.agents/mockups/[slug].html
```

---

### Step 6: Output summary

```
Research artifact created: .agents/research/[slug].md

Domains identified: [N]
Team roles recorded: [architect / developers / designers]
Platform: [platform]
Open questions: [N]

Next step:
  /rad-design [slug]    (Status: pending-design)
  /rad-plan [slug]      (Status: pending-plan)
```

When the disposition is **not** `actionable`, omit the `Next step:` hints and
show this instead:

```
Disposition: [not-actionable | insufficient-context | superseded]
Evidence:    [Disposition-Evidence]

/rad-plan and /rad-adopt will refuse this request unless re-run with:
  --override-disposition "<reason>"
```

---

## Rules

- Never carry a spec URL's raw content in your working context — delegate the fetch
  to a sub-agent if your tool can run one; otherwise keep only the bounded `SPEC_SUMMARY`
- Ask all clarifying questions at once — never one at a time
- Do not generate agent files — that is /rad-design's job
- Do not write to .claude/agents/ — research only
- If the spec is too vague to extract meaningful domains, ask the user to clarify
  before writing the artifact
- The research artifact must reflect the user's confirmed answers, not just the
  raw spec — both sources feed the artifact
