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

- Every behavior change ships a test in the same commit — new scripts get a co-located `test-<name>.sh` fixture; harness changes extend `harness/test/*.test.js`; a task with no testable surface says so explicitly in its Validate field
- Functions stay under ~40 lines with intent-revealing names; magic values become named constants at the top of the file; comments state constraints, not narration
- Never swallow errors: every catch/`|| true` either rethrows, exits non-zero, or logs the reason with context; fail-closed is the default at every gate or check boundary
- Edge cases are named in the task's Validate field before implementation (empty input, missing field, zero/negative, non-array) and each gets an explicit test case

---

## Testing Standards

-
-

---

## What Claude Must Never Do

- Never commit secrets, tokens, or credentials
- Never assume a library exists — only use packages in the package file
- Never execute /rad-deliver without an `approved` event in `.agents/state/<feature>/events.jsonl` (the gate authority, appended by /rad-approve). The plan doc's `Status: approved` header is a display-only mirror, not the gate. This rule is now ALSO deterministically enforced by a PreToolUse hook (`scripts/deliver-gate-hook.mjs`, registered in `.claude/settings.json`) that blocks an unapproved /rad-deliver Skill call fail-closed (exit 2) — not prose alone.
-

---

## Known Constraints

-

---

## RAD Configuration

Authoritative config — platform, default branch, roles and the agent scope
map — lives in `.rad/config.yml`. Read it with:

```bash
node harness/cli.js config get <key>    # e.g. platform, default_branch, roles.architect
node harness/cli.js config validate
```

Never read config values from this file. The full reference is
[`docs/configuration.md`](docs/configuration.md): the `.rad/config.yml`
schema, the `rad config` command, every `RAD_*` environment variable, and the
approval, branch and PR-label rules.

Plans that edit `.rad/`, `harness/` or `scripts/` are always flagged for
architect review (self-protected paths; not configurable).

---

## Workflow

```
Architect:  /rad-epic-decompose → Gate 0: shapes a GitHub epic into per-child stories, writes .agents/epics/ (no plans, no commit)
Anyone:     /rad-research → consumes PRD/issue, writes .agents/research/
Architect:  /rad-design   → drafts + generates .claude/agents/ boundaries
Team:       /rad-plan     → cuts rad/[feature] branch, commits plan (no PR)
Team:       /rad-plan --light → same, condensed single-wave plan for small low-risk changes (Tier: light)
Team:       /rad-adopt    → same as /rad-plan but sourced from a pre-existing issue
Architect:  /rad-approve  → records approval on the branch tip (Gate 1, no PR)
Team:       /rad-deliver  → wave execution on the same branch, opens the deliver PR (Gate 2)
Architect:  PR review     → merge the rad/[feature] branch to default_branch
```

`/rad-epic-decompose` is an OPTIONAL Gate-0 shaping step upstream of
`/rad-research`. It decomposes a GitHub epic into per-child shaping stories,
writing a discovery artifact to `.agents/epics/epic-[N]-[slug].md` (Status:
draft). It does not generate plans, research, or deliver, and it never
auto-commits — the architect reviews, signs off, and commits by hand. See
`docs/epic-decomposition.md` for when, why, and how to run it.

See `docs/daily-workflow.md` for the full guide.
