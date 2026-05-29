---
description: >
  Run the Research phase of the RAD framework. Consumes a PRD, GitHub issue,
  or inline spec and produces a research artifact for use by /rad-design.
  Can be run by any team member — no architect role required.
---

# /rad-research

Consume a specification artifact and produce a RAD research artifact. This is
the R in Research/Architect/Deliver.

## Input

`$ARGUMENTS` should be one of:
- A file path: `docs/prd.md`, `SPEC.md`, `issues/42.md`
- A URL: `https://github.com/org/repo/issues/42`
- Empty — you will be prompted to paste the spec inline

---

## Process

### Step 1: Load the spec

Determine the input type from `$ARGUMENTS`:

**If `$ARGUMENTS` starts with `http://` or `https://`:**

Spawn a general-purpose sub-agent with model `claude-haiku-4-5-20251001`:

```
Fetch the following URL and extract the key facts needed to design a software
system. Return a bounded summary only — no raw content dump. Max 60 lines.

URL: [URL from $ARGUMENTS]

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

Wait for the sub-agent to return. Parse the `SPEC_SUMMARY` block. This is your
complete spec input — do not fetch the URL yourself.

**If `$ARGUMENTS` is a file path:**

Read the file directly. Extract the same fields from the content. Do not spawn
a sub-agent — a single Read is sufficient.

**If `$ARGUMENTS` is empty:**

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
```

Wait for answers. If any answer is unclear, ask one targeted follow-up.

---

### Step 4: Derive the project slug

From the spec title or project name, derive a kebab-case slug.
Examples: `e-commerce-platform`, `habit-tracker-api`, `auth-service-redesign`

If the title is ambiguous, confirm the slug with the user before saving.

---

### Step 5: Write the research artifact

Save to `.agents/research/[slug].md`:

```markdown
# Research: [Project Name]
Created: [YYYY-MM-DD]
Author: [developer | architect]
Status: pending-design
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
  /rad-design [slug]
```

---

## Rules

- Never load the spec URL directly in main context — delegate URL fetching to a sub-agent
- Ask all clarifying questions at once — never one at a time
- Do not generate agent files — that is /rad-design's job
- Do not write to .claude/agents/ — research only
- If the spec is too vague to extract meaningful domains, ask the user to clarify
  before writing the artifact
- The research artifact must reflect the user's confirmed answers, not just the
  raw spec — both sources feed the artifact
