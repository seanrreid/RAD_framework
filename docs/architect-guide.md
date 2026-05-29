# Architect Guide

Your responsibilities in the RAD framework: setting up the architecture,
maintaining agent boundaries, and operating the two approval gates.

---

## Your commands

You have everything the team has, plus:

| Command | Purpose |
|---------|---------|
| `/rad-design` | Draft and generate agent architecture |
| `/rad-approve` | Review a plan and record approval on its work-branch tip |
| All team commands | Research, plan, deliver, review, status |
| `/rad-insights` | Review pattern analysis across cycles |

All commands are committed to the project repo alongside team commands — no
global install needed. The `architect/` subdirectory signals responsibility;
access is enforced by branch protection, not file visibility.

---

## Setting up a new project

### 0. Install RAD

```bash
git clone https://github.com/torchcodelab/rad-framework /tmp/rad
bash /tmp/rad/install.sh --dir /path/to/your-project
```

Follow the post-install steps in [INSTALL.md](../INSTALL.md): fill in
`CLAUDE.md`, create platform labels, and commit the installed files.

### 1. Run /rad-research

```
/rad-research [path-to-prd or issue-url]
```

Point it at your PRD, a GitHub/GitLab issue, or paste the spec inline.
It extracts what's being built, asks RAD-specific clarifying questions (team
roles, platform, domain sensitivity), and writes `.agents/research/[slug].md`.

A developer can do this step and hand the artifact to you for review before
you run `/rad-design`.

### 2. Run /rad-design

```
/rad-design [slug]
```

Reads the research artifact and writes an architecture draft to
`.agents/architecture/[slug].md` with `Status: draft`. The draft contains:
- The full agent hierarchy
- Role assignments per agent
- Scope and output contracts for every agent
- The scope map ready for `CLAUDE.md`

Review the draft and edit it directly. Adjust role assignments, tighten scope
boundaries, add constraints. When satisfied, change `Status: draft` to
`Status: approved` and re-run:

```
/rad-design [slug]
```

This generates all `.claude/agents/*.md` files in parallel and prints the
Agent Scope Map block to paste into `CLAUDE.md`.

### 3. Update CLAUDE.md

Paste the Agent Scope Map block into the RAD Configuration section.
Fill in the role assignments with your team members' usernames.

### 4. Commit and push

```bash
git add .claude/agents/ .agents/research/ .agents/architecture/ CLAUDE.md
git commit -m "chore: initialize RAD agent architecture"
git push
```

The team can now clone and start planning.

### 5. Set up branch protection (recommended)

Protect your default branch (the `default_branch:` value in `CLAUDE.md`) so
only you can merge. This enforces the gatekeeper role at the git level, not
just by convention. It also keeps contributors off the protected branch: under
Lane B the plan doc and code only reach the default branch through the single
deliver PR you merge.

**GitHub:** (substitute your default branch name for `<default-branch>`)
```bash
gh api repos/:owner/:repo/branches/<default-branch>/protection \
  --method PUT \
  --field required_pull_request_reviews='{"required_approving_review_count":1}' \
  --field restrictions='{"users":["your-username"],"teams":[]}'
```

**GitLab:**
Project → Settings → Repository → Protected Branches → Allowed to merge: Maintainers

---

## Maintaining the architecture

### When to re-run /rad-research and /rad-design

Re-run `/rad-research` when the project scope changes significantly — new
domains added, team composition changes, or a new PRD supersedes the original.
Update the research artifact, then re-run `/rad-design` to regenerate the
architecture draft.

Re-run `/rad-design` alone (without `/rad-research`) when the architecture
needs adjustment but the research is still accurate:
- Major codebase restructuring (new top-level directories, new services)
- Adding a new domain that doesn't fit existing agents
- Onboarding a new role type with different access needs

Re-running `/rad-design` on an approved architecture artifact regenerates the
agent files. Review the diff carefully before committing — existing plans
reference current agent scopes.

### Updating individual agents

For smaller changes (adjusting scope, adding a tool, changing a description),
edit `.claude/agents/[name].md` directly. Commit with:

```bash
git commit -m "chore(agents): [what changed and why]"
```

### Handling scope requests

When a team member needs access to something outside their scope, they'll
flag it in the plan doc as an out-of-scope dependency. Your options:

1. **Handle it yourself** — implement the out-of-scope piece and note it
   when you record approval (or in a comment on the deliver PR)
2. **Expand their scope** — if the request is reasonable, update the agent
   file to include the directory and update the scope map in `CLAUDE.md`
3. **Create a helper** — add a new context tool that returns exactly the
   information they need without expanding their read access broadly

Option 3 is usually best — it maintains the information boundary while
unblocking the contributor.

---

## Operating the two gates

RAD v2 (Lane B) uses one work branch per feature, cradle-to-grave:
`rad/[feature]`. That branch is cut from the default branch by `/rad-plan`
(or `/rad-adopt`), carries the plan doc, then the approval, then the code, and
is the head of the single deliver PR. There are no separate `plan/` or
`deliver/` branches, and **there is no plan PR.**

### Gate 1: Plan approval on the branch tip

See `docs/plan-pr-guide.md` (the Plan Approval Guide) for the full review checklist.

You review the plan doc directly on its `rad/[feature]` branch tip — no PR is
involved. When the plan is correct, run:

```
/rad-approve [feature]
```

This writes `Status: approved` to the plan doc on the `rad/` branch tip and
pushes that commit to the same branch. It never writes to the default branch.
Recording approval is what unblocks the contributor's `/rad-deliver`.

While reviewing, confirm the plan's `## Scope` and `## Acceptance Criteria` are
present and sound — `/rad-approve` surfaces them in its review summary so you
can sanity-check that every acceptance criterion is covered by a task. Tasks
should cite the criteria they satisfy as `AC#N`.

The key thing: plan review is small and should be fast. A good review is
5–10 minutes. If you find yourself spending more time than that, the plan is
probably too large or too vague — set it to `needs-revision` rather than
approving anyway.

### Gate 2: The deliver PR

`/rad-deliver` runs on the same `rad/[feature]` branch and opens the single
code review PR (label `rad:deliver`) from `rad/[feature]` → the default branch.
The plan doc and the code reach the default branch together through this one
reviewed PR — which is why contributors never push to the protected default
branch directly.

Standard code review, plus check:
- `/rad-review` was run (look for it in PR comments or CI)
- Execution log looks clean
- All changes within declared scope
- Acceptance criteria are met (`/rad-review` flags uncovered ACs as HIGH)
- Tests present and meaningful

If something is wrong that `/rad-review` should have caught, it means the
self-review step was skipped — note this in your review and remind the contributor.

Merging the deliver PR is the final step. Gate 2 = deliver PR reviewed and
merged by the architect.

---

## Proxy approval: `--on-behalf-of`

Sometimes you approve a plan out-of-band — in a meeting, over chat, in a
verbal review — but you're not at a terminal to run `/rad-approve` yourself.
Lane B lets a non-architect record that approval on your behalf:

```
/rad-approve <feature> --on-behalf-of "<architect>" --evidence "<cite>"
```

This records the approval on the `rad/<feature>` branch tip exactly like a
normal approval, but it captures two distinct identities:

- **`Approved-By`** — the architect who actually made the approval decision
  (the `--on-behalf-of` value).
- **`Recorded-By`** — whoever ran the command.

These are stored separately and are never collapsed into one field. The
distinction is the entire point: the record must always show who decided
versus who typed it.

### Integrity rules

This flag is an integrity-sensitive feature. It exists to transcribe a real
decision you already made — never to manufacture one.

- **The decision must be genuine.** Only use `--on-behalf-of` for an approval
  the named architect actually gave out-of-band. Do not use it to self-approve
  or to push a plan forward on the assumption the architect would say yes.
- **The named approver must be a configured architect.** `/rad-approve`
  validates `--on-behalf-of` against the architect role (via `check-role.sh`)
  and refuses if the name isn't a real architect.
- **`--evidence` is mandatory.** You must cite where the out-of-band approval
  happened — a meeting note, a chat permalink, a ticket comment. The command
  rejects a proxy approval with no evidence. The citation is part of the
  approval record and is what makes the proxy auditable.
- **Never edit the record to hide the proxy.** Leaving `Approved-By` and
  `Recorded-By` distinct is what keeps the audit trail honest.

As the architect, watch proxy approvals: the evidence citation should point
to a real decision you remember making. If you see a proxy approval you don't
recognize, treat it as a process violation.

---

## Monitoring review quality over time

```
/rad-insights
```

Every `/rad-review` run appends structured findings to `.agents/findings.jsonl`.
`/rad-insights` reads that log and surfaces patterns across all cycles:

- **Recurring categories** — security, error-handling, accessibility issues that
  keep appearing suggest systemic gaps (missing team knowledge, missing linting rules,
  a component library that needs better defaults)
- **Hotspot files** — files that attract findings across multiple cycles often
  signal technical debt or unclear ownership
- **Trajectory** — HIGH findings per cycle trending down means the team is
  improving; trending up means something changed (new contributor, new domain,
  new framework)

Run this monthly or after any stretch of rapid delivery. The output gives you
a concrete agenda for retros and 1:1s — rooted in actual review data, not anecdote.

---

## Handling escalations

### Task failed during execution
The contributor will flag it (a comment on the deliver PR, or directly).
Options:
1. Update the plan task description on the `rad/[feature]` branch and ask them
   to retry
2. Check out the `rad/[feature]` branch and fix the specific task yourself
3. If the failure reveals a design problem, close the deliver PR, set the plan
   back to `needs-revision`, and update the plan on its `rad/` branch

### Out-of-scope dependency mid-execution
The contributor should have stopped and flagged it. Review the situation:
- If it's a small thing: do it yourself in a separate commit on the
  `rad/[feature]` branch
- If it's significant: the plan was under-specified; close the deliver PR and
  update the plan to account for the dependency

### Context getting noisy
Wave sub-agents keep the delivery orchestrator's context lean — each wave runs
in isolation and only returns a `WAVE_RESULT` summary to main context. Genuine
context rot is now uncommon but can still happen during repeated correction
loops on a failing task. Ask the contributor to start a new Claude Code session
and re-run `/rad-deliver` — it resumes from the execution log.

---

## Keeping CLAUDE.md current

The most common maintenance failure: `CLAUDE.md` drifts from reality.

Signs of drift:
- Team members' agents reference paths that don't exist
- Claude makes wrong assumptions about the stack or conventions
- The same thing gets corrected across multiple plans

When you spot drift: fix `CLAUDE.md` immediately and commit:
```bash
git commit -m "docs: update CLAUDE.md — [what changed]"
```

Do a full CLAUDE.md review monthly or after any significant refactor.
See `docs/maintaining-claude-md.md` for the review checklist.
