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

### Plan Lint — High-Risk Paths

OPTIONAL and backward-compatible — absent, `scripts/lint-plan.sh` uses the built-in default.

```
RAD_HIGH_RISK_PATTERNS: <|-separated extended-regex alternation>
```

`scripts/lint-plan.sh` scans the union of Files-in-Scope paths and per-task `File:`
paths and emits an advisory **warning** (never an error) for any path matching a
high-risk pattern, flagging it for close architect review. The built-in default is:

```
auth|payment|billing|migration|secret|credential|token
```

Set `RAD_HIGH_RISK_PATTERNS` to override the default with your own `|`-separated
extended-regex alternation. Empty disables the check.

### Severity Routing — Low-Risk Allowlist

OPTIONAL and backward-compatible — absent, severity routing is OFF and every plan
takes the normal human-approval path.

```
RAD_LOW_RISK_PATTERNS: <|-separated extended-regex alternation>
```

`scripts/classify-low-risk.sh` computes a deterministic, **fail-closed** auto-clear
verdict over the union of a plan's Files-in-Scope and per-task `File:` paths (the
same path set the high-risk advisory reasons over). It uses the same matcher as
`scripts/lint-plan.sh` — one source of truth in `scripts/lib/plan-paths.sh`.

A plan is classified **low** (exit 0, auto-clearable) **iff all** of the following hold:

- `RAD_LOW_RISK_PATTERNS` is non-empty, **and**
- every touched path matches `RAD_LOW_RISK_PATTERNS`, **and**
- **no** touched path matches `RAD_HIGH_RISK_PATTERNS` (**high-risk wins ties**), **and**
- the declared scope is unchanged vs the working git diff (no out-of-scope drift).

Anything else — empty/unset allowlist, any non-matching path, any high-risk match,
any scope drift, or any ambiguity (e.g. an undetectable diff) — yields **not-low**
(non-zero exit). The router never auto-clears on uncertainty.

The built-in default allowlist is **inert-by-type only**:

```
css|scss|\.(png|jpe?g|gif|svg|webp|woff2?|ttf|otf|eot)$|\.md$|^docs/
```

That is: stylesheets, image/font assets, and docs. **Tests, config, lockfiles, and
CI are deliberately EXCLUDED from the default** — changes to them can alter behavior
or trust and always warrant human judgment. Set `RAD_LOW_RISK_PATTERNS` to override
the default with your own `|`-separated extended-regex alternation; keep it tight.
Empty/unset disables severity routing entirely.

`RAD_LOW_RISK_PATTERNS` is a **TRUSTED operator input**: a broad pattern (e.g. `.*`)
auto-clears every non-high-risk, in-scope plan, bypassing human approval — so keep it
tight and specific. This is a documented trust boundary, not a guarded one.

### Wave-Lifecycle Hooks

OPTIONAL and backward-compatible — absent, `/rad-deliver` behaves exactly as
before. Operator-supplied scripts the deliver spine fires at fixed points in the
wave loop, for policy, notification, or observation.

```
RAD_HOOKS_DIR: <directory path>   # convention dir (default: scripts/hooks)
```

Drop an **executable** script into `<hooksDir>/<point>/`; hooks run in lexical
filename order. The spine fires six lifecycle points:

- **veto-capable** (`pre-wave`, `post-wave`) — a hook MAY abort or redirect the
  wave. **Fail-closed**: a crash, non-zero exit, empty stdout, or out-of-vocabulary
  token is treated as a veto resolving to `abort-user`.
- **observe-only** (`on-outcome`, `on-retry`, `on-error`, `wave-complete`) — a hook
  may only watch. **Fail-open**: a failure records a `hook-failed` event but NEVER
  vetoes and NEVER changes flow.

Veto outcomes reuse the frozen 7-outcome matrix vocabulary (`success | fail-tests
| fail-scope | fail-protocol | fail-timeout | no-changes | abort-user`) — a hook
cannot invent a new outcome. With no hooks dir the appended event sequence is
byte-for-byte identical to today's.

See `scripts/hooks/README.md` for the full invocation contract (argv positions,
`RAD_HOOK_*` env, stdout veto token, exit-code semantics, first-veto-wins).

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
| Agent | Type | Reads | Roles |
|-------|------|-------|-------|
| hooks-parent-orchestrator | parent-orchestrator | nothing | architect |
| spine-integration-orchestrator | role-orchestrator | nothing | architect |
| spine-mapper | context-tool | harness/spine.js, matrix.js, matrix.yaml | architect |
| hook-runtime-orchestrator | role-orchestrator | nothing | architect |
| hook-surface-mapper | context-tool | contract.js, events writer, scripts/** | architect |
| severity-approval-parent-orchestrator | parent-orchestrator | nothing | architect |
| gate-authority-orchestrator | role-orchestrator | nothing | architect |
| gate-authority-mapper | context-tool | harness/gates.js, gates.yaml, events.js, approve/deliver gate-check sites | architect |
| severity-classifier-orchestrator | role-orchestrator | nothing | architect |
| classifier-surface-mapper | context-tool | scripts/check-scope.sh, lint-plan.sh, CLAUDE.md RAD config, .env.example | architect |
| audit-surface-orchestrator | role-orchestrator | nothing | developer |
| audit-surface-mapper | context-tool | rad-insights skill, kickoff skill, events.js read side | developer |
| portable-memory-parent-orchestrator | parent-orchestrator | nothing | architect |
| sync-transport-orchestrator | role-orchestrator | nothing | architect |
| sync-surface-mapper | context-tool | rad-approve/deliver verb sites, git-vs-host-CLI invocation, detect-platform.sh + mirror scripts, CLAUDE.md RAD config, .env.example | architect |
| event-fold-orchestrator | role-orchestrator | nothing | architect |
| event-fold-mapper | context-tool | harness/gates.js, events.js, gates.yaml, branch-tip read sites | architect |

---

## Workflow

```
Architect:  /rad-epic-decompose → Gate 0: shapes a GitHub epic into per-child stories, writes .agents/epics/ (no plans, no commit)
Anyone:     /rad-research → consumes PRD/issue, writes .agents/research/
Architect:  /rad-design   → drafts + generates .claude/agents/ boundaries
Team:       /rad-plan     → cuts rad/[feature] branch, commits plan (no PR)
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
