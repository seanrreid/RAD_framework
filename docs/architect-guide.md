# Architect Guide

Your responsibilities in the RAD framework: setting up the architecture,
maintaining agent boundaries, and operating the two approval gates.

---

## Your commands

You have everything the team has, plus:

| Command | Install location | Purpose |
|---------|-----------------|---------|
| `/rad-design` | `~/.claude/commands/` | Generate agent architecture |
| `/rad-approve` | `~/.claude/commands/` | Review and approve plan PRs |
| All team commands | Project `.claude/commands/` | Plan, deliver, review, status |
| `/rad-insights` | Shared (project + global) | Review pattern analysis across cycles |

Install architect commands to your global Claude Code config:
```bash
cp .claude/commands/architect/* ~/.claude/commands/
```

These are global — they follow you across all RAD projects. Team commands stay
in the project `.claude/commands/` and are committed to the repo.

---

## Setting up a new project

### 1. Run /rad-design

```
/rad-design
```

This runs the rpi-design interview. You'll be asked about:
- Project description and domains
- Codebase structure and stack
- Common task types
- Anything unusual

After the interview, a draft architecture is generated. React to it, refine it,
then confirm. The command generates:
- `.claude/agents/*.md` — agent definitions with role annotations
- The Agent Scope Map block to paste into `CLAUDE.md`

### 2. Assign roles to agents

The generated agents will have default role assignments:
- UI, frontend, content agents → `developer, designer`
- API, backend agents → `developer`
- Auth, payments, infra, database agents → `architect`

Review these and adjust to match your team. Edit the `roles:` frontmatter field
in each `.claude/agents/*.md` file.

### 3. Update CLAUDE.md

Paste the Agent Scope Map block into the RAD Configuration section.
Fill in the role assignments with your team members' usernames.

### 4. Commit and push

```bash
git add .claude/agents/ CLAUDE.md
git commit -m "chore: initialize RAD agent architecture"
git push
```

The team can now clone and start planning.

### 5. Set up branch protection (recommended)

Protect `main` so only you can merge. This enforces the gatekeeper role
at the git level, not just by convention.

**GitHub:**
```bash
gh api repos/:owner/:repo/branches/main/protection \
  --method PUT \
  --field required_pull_request_reviews='{"required_approving_review_count":1}' \
  --field restrictions='{"users":["your-username"],"teams":[]}'
```

**GitLab:**
Project → Settings → Repository → Protected Branches → Allowed to merge: Maintainers

---

## Maintaining the architecture

### When to re-run /rad-design

- Major codebase restructuring (new top-level directories, new services)
- Adding a new domain that doesn't fit existing agents
- Onboarding a new role type with different access needs

Re-running `/rad-design` generates new agent files. Review the diff carefully
before committing — existing plans reference current agent scopes.

### Updating individual agents

For smaller changes (adjusting scope, adding a tool, changing a description),
edit `.claude/agents/[name].md` directly. Commit with:

```bash
git commit -m "chore(agents): [what changed and why]"
```

### Handling scope requests

When a team member needs access to something outside their scope, they'll
flag it in a plan PR as an out-of-scope dependency. Your options:

1. **Handle it yourself** — implement the out-of-scope piece and note it
   in the plan PR comment
2. **Expand their scope** — if the request is reasonable, update the agent
   file to include the directory and update the scope map in `CLAUDE.md`
3. **Create a helper** — add a new context tool that returns exactly the
   information they need without expanding their read access broadly

Option 3 is usually best — it maintains the information boundary while
unblocking the contributor.

---

## Operating the two gates

### Gate 1: Plan PRs

See `docs/plan-pr-guide.md` for the full review checklist.

The key thing: plan PRs are small and should be fast. A good plan PR review
is 5–10 minutes. If you find yourself spending more time than that, the plan
is probably too large or too vague — request changes rather than approving anyway.

**Your merge is the approval signal.** There is no separate approval step.

### Gate 2: Code PRs

Standard code review, plus check:
- `/rad-review` was run (look for it in PR comments or CI)
- Execution log looks clean
- All changes within declared scope
- Tests present and meaningful

If something is wrong that `/rad-review` should have caught, it means the
self-review step was skipped — note this in your review and remind the contributor.

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
The contributor will leave a comment on the plan PR. Options:
1. Update the plan task description and ask them to retry
2. Check out the deliver branch and fix the specific task yourself
3. If the failure reveals a design problem, close the deliver PR and update
   the plan PR with corrections

### Out-of-scope dependency mid-execution
The contributor should have stopped and commented. Review the situation:
- If it's a small thing: do it yourself in a separate commit on the deliver branch
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
- The same thing gets corrected across multiple plan PRs

When you spot drift: fix `CLAUDE.md` immediately and commit:
```bash
git commit -m "docs: update CLAUDE.md — [what changed]"
```

Do a full CLAUDE.md review monthly or after any significant refactor.
See `docs/maintaining-claude-md.md` for the review checklist.
