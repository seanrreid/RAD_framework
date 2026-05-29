---
name: kickoff
description: >
  Session startup ritual for a RAD project. Reads CLAUDE.md, guards against
  working on the default branch, reports plans by status (reading rad/ branch
  tips), optionally triages open issues, and asks what to focus on. Run at the
  start of a work session.
---

# Session Kickoff

Orient quickly at the start of a session: load project context, check git state,
surface what needs attention, and pick a focus. Keep the briefing under ~400 words.

## Steps

### 1. Load project context

Read `CLAUDE.md` — project description, stack, conventions, role assignments, and
the Agent Scope Map. This is the contract for the session.

### 2. Check git state

```bash
git branch --show-current
git status --short
git log --oneline @{u}.. 2>/dev/null || true
```

Report the current branch, any uncommitted changes, and how far ahead/behind the
remote you are.

**Branch guard.** Resolve the default branch and warn if you're on it — RAD work
happens on `rad/` branches, never directly on the protected default branch:

```bash
BASE=$(scripts/get-default-branch.sh)
```

> ⚠️ You're on `{BASE}`. RAD work belongs on a `rad/[feature]` branch.
> - New work: `/rad-plan "<feature>"` cuts the branch for you.
> - Resuming: `git fetch && git checkout rad/<feature>`.

Stop the briefing on this warning until it's resolved.

### 3. Report active plans

```bash
scripts/rad-status.sh
```

Group what it returns by status and surface the actionable ones first:
- **pending-review** → *Awaiting architect approval* — the architect runs `/rad-approve <feature>`.
- **approved** → *Ready to execute* — `/rad-deliver .agents/plans/<feature>.md`.
- **in-progress** → *Delivery underway* — note the `rad/` branch.

Skip silently if there are no plans.

### 4. (Optional) Triage open issues

If a platform CLI is available (`gh` or `glab`), list a few open issues so the
team can decide whether any should be adopted via `/rad-adopt`. Skip silently if
no CLI is available.

### 5. Brief and ask

Summarize in this shape, then ask what to focus on:

```
# Session Kickoff — {date}

## Branch: {branch}   {uncommitted note if any}

## Plans
- ⏳ {feature} — pending architect approval
- ✓ {feature} — approved, ready to deliver
- ▶ {feature} — in progress on rad/{feature}

## Suggested focus
{the most actionable item — an approved plan to deliver, or a pending one to approve}

What would you like to work on?
```

## Rules

- Read `CLAUDE.md` every session — never assume stale context
- Always run the branch guard before suggesting work
- Plans live on `rad/` branch tips — use `rad-status.sh`, don't just scan the working tree
- Keep the briefing scannable and under ~400 words
- Suggest a focus; do not start work without confirmation
