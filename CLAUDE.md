# Project Context

> Always-loaded into every Claude Code session.
> Fill in every section. Accurate CLAUDE.md = fewer corrections.
> See `docs/architect-guide.md` for maintenance guidance.

---

## Project

**Name:**
**Description:**
**Status:**

---

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | |
| Frontend | |
| Database | |
| Testing | |
| Package manager | |

---

## Project Structure

```
[describe your directory layout here]
```

---

## Commands

```bash
# Install


# Run (development)


# Run tests


# Run E2E tests

```

---

## Architecture Decisions

-
-

---

## Coding Conventions

-
-

---

## Testing Standards

-
-

---

## What Claude Must Never Do

- Never commit secrets, tokens, or credentials
- Never assume a library exists — only use packages in the package file
- Never execute /rad-deliver without an `approved` event in `.agents/state/<feature>/events.jsonl` (the gate authority, appended by /rad-approve). The plan doc's `Status: approved` header is a display-only mirror, not the gate.
-

---

## Known Constraints

-

---

## RAD Configuration

### Git Platform

```
platform: github        # github | gitlab | bitbucket | forgejo | manual
default_branch: main
```

`manual` mode: platform scripts print instructions instead of calling CLI tools.
Run `scripts/detect-platform.sh` to auto-detect from your git remote.

### Agent Adapter

`rad deliver` selects the wave-execution agent via environment variables (no
config-file loader). Both adapters honor the provider-neutral wave contract in
`docs/rad-wave-contract.md`.

```
RAD_AGENT:     command   # command | sdk  (default: command)
RAD_AGENT_CMD:           # the CLI to spawn, required when RAD_AGENT=command
```

- `command` (default) — spawns an operator-configured CLI agent
  (`RAD_AGENT_CMD`, e.g. `claude -p`, `codex exec`, `aider`). Requires **no**
  `ANTHROPIC_API_KEY`; credentials are the configured command's concern.
- `sdk` — drives the Claude Agent SDK; requires `ANTHROPIC_API_KEY`.

See `docs/rad-cli.md` for selection details and per-path credential rules.

### Branch Conventions

One work branch per feature, cradle-to-grave (plan → approval → code). It is the
head of the single deliver PR. `plan/` and `deliver/` are retired.

```
work branches: rad/[feature-name]
```

The branch is cut from `default_branch` by `/rad-plan` (or `/rad-adopt`), recorded
in the plan doc's `Branch:` header, and never merged piecemeal — the plan doc and
code reach `default_branch` together via the deliver PR. To use a different prefix,
set `RAD_BRANCH_PREFIX` (e.g. `RAD_BRANCH_PREFIX=feature/`) in your environment.

### Cost & Frugality

Both knobs are OPTIONAL and backward-compatible — absent, deliver behaves as before.

```
RAD_TOKEN_BUDGET: <positive integer>   # per-deliver cumulative token ceiling
```

When set, `/rad-deliver` (the harness spine) sums each wave's recorded token usage
and, before starting the next wave, stops gracefully once the running total reaches
or exceeds the budget — a structured `stopped: token-budget` terminal (no throw),
recorded as a `wave-failed` event with `reason: token-budget`. Unset/0/non-numeric
disables the breaker. Waves whose adapter reports no usage contribute 0.

**Per-wave model tiering.** A plan may run cheaper waves on smaller models. Inside a
`### Wave N` block, an optional `Model:` line selects the model for that wave only:

```markdown
### Wave 1
Model: claude-haiku-4-5

### Wave 2
Model: claude-opus-4-8
```

Waves without a `Model:` line use the deliver default. See `docs/rad-cli.md` for the
full description and the `RAD_TOKEN_BUDGET` example.

### Worktree Isolation

OPTIONAL and backward-compatible — absent, deliver runs in the main checkout as before.

```
RAD_WORKTREE:     <any non-empty value>   # opt-in git-worktree isolation for a deliver run
RAD_WORKTREE_DIR: <directory path>        # optional base dir for the isolated tree
```

When `RAD_WORKTREE` is set, `/rad-deliver` isolates the run into a git worktree on the
work branch (create → active → complete-on-success / preserve-on-failure). A
`.rad-worktree.json` marker guards teardown — the lifecycle refuses to remove an
unmarked dir. v1 requires the work branch not already be checked out in the main tree.
Unset/empty = OFF (today's behavior). See `docs/rad-cli.md` for the full lifecycle.

### PR Labels

```
deliver PRs: rad:deliver
```

RAD status labels (mirrored onto the issue/PR by `scripts/rad-label.sh`, when a
target and `gh` are available — a fetch-free board layer; git branch tips remain
canonical):

```
rad:draft  rad:pending-review  rad:needs-revision  rad:rejected
rad:approved  rad:in-progress  rad:review  rad:done
```

Labels are created on first use. GitHub: Settings → Labels. GitLab: Project → Labels.

### Role Assignments

```
architect:  sean@torchcodelab.com
developers: []
designers:  []
```

Architects approve plans via `/rad-approve` and merge deliver PRs.
Developers and designers plan and deliver but cannot approve their own plans.

### Approval Rules

A plan is approved when the architect runs `/rad-approve`, which appends an
`approved` event to `.agents/state/<feature>/events.jsonl` on its `rad/` branch
tip. That event is the **sole gate authority** — `/rad-deliver` gates on it via
the read-only `rad gate <feature> approved` query (see `docs/rad-cli.md`). There
is no plan PR. `/rad-approve` also writes a `Status: approved` header to the plan
doc, but that header is a **display-only mirror** of the event, never the gate.
Approval requires:
- [ ] Architect review and approval (recorded on the work-branch tip)
- [ ] All files within declared agent scope (checked by /rad-review)
- [ ] Acceptance Criteria all covered by tasks (checked by /rad-review)

### Agent Scope Map

<!-- Generated by /rad-design. Do not edit manually. -->
<!-- Re-run /rad-design to update after architecture changes. -->

```
[will be populated by /rad-design]
```

---

## Workflow

```
Anyone:     /rad-research → consumes PRD/issue, writes .agents/research/
Architect:  /rad-design   → drafts + generates .claude/agents/ boundaries
Team:       /rad-plan     → cuts rad/[feature] branch, commits plan (no PR)
Team:       /rad-adopt    → same as /rad-plan but sourced from a pre-existing issue
Architect:  /rad-approve  → records approval on the branch tip (Gate 1, no PR)
Team:       /rad-deliver  → wave execution on the same branch, opens the deliver PR (Gate 2)
Architect:  PR review     → merge the rad/[feature] branch to default_branch
```

See `docs/daily-workflow.md` for the full guide.
