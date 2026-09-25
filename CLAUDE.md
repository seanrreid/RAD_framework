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

**Env-less auth contract (command path).** `RAD_AGENT_CMD` runs under an
**allow-listed** env — only `PATH HOME LANG LC_ALL TMPDIR TERM USER` are
forwarded — so it must authenticate **without inherited env vars**: on-disk
credentials or the OS keychain, not an env-injected token (an exported
`ANTHROPIC_API_KEY`, `GH_TOKEN`, etc. never reaches it).

```
RAD_AGENT_PREFLIGHT: off   # exactly `off` skips the startup probe; unset/anything else runs it
RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS: <positive integer>   # probe deadline (default 60)
```

Before Wave 1, `rad deliver` runs a **startup preflight** on the command path: it
spawns `RAD_AGENT_CMD` once under the same env with one tiny prompt (one small
model call per deliver). If it exits non-zero, cannot spawn, or times out,
deliver exits 1 with `RAD_AGENT_CMD failed to start under the adapter env (it
must authenticate without inherited env vars): <error>` — before any event is
appended (in worktree mode the probe runs inside the new worktree, which is then
preserved). The SDK path and an injected `runWave` never probe.
`RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS` sets the probe deadline (default **60**); a
malformed value (non-numeric, zero, negative) is a hard error — **exit 2**, never
a silent fall back. It is not validated when `RAD_AGENT_PREFLIGHT=off`, since no
probe runs. If your
agent genuinely needs an env-injected credential, configure a **wrapper script**
as `RAD_AGENT_CMD` that loads the secret itself and execs the agent — keeping
re-injection an explicit operator act (the allow-list is deliberately not
widened).

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

### Per-Wave Verification

OPT-IN and backward-compatible — absent, the wave gate behaves exactly as before.

Alongside `Model:`, a `### Wave N` block may carry an optional `Verify:` line naming
the shell command the HARNESS runs after that wave:

```markdown
### Wave 1
Model: claude-haiku-4-5
Verify: npm test --prefix harness

### Wave 2
Verify: bash scripts/test-check-verify.sh
```

**The absent-declaration guarantee.** A wave with no `Verify:` line runs no command and
records no `verify` key — a plan declaring none anywhere produces a **byte-for-byte
identical** event sequence to a run of the same RAD version without verification.
(Since #119 every run's sequence includes a `wave-started` before each agent run, so
the baseline is the same version, not a pre-#119 log.) Opting in is the only way to
change behavior.

**What it adds.** Without it, the per-wave gate is `scripts/check-tests-present.sh` — a
file-PRESENCE check: a wave can create every promised test file, have all of them fail,
and still advance. A declared command is executed by `scripts/check-verify.sh` (through
the deliver spine's injected `sh` port — `spine.js` never runs arbitrary shell itself)
and its REAL exit code is read. A non-zero code demotes the wave to the existing
`fail-tests` outcome through the matrix; the frozen 7-outcome vocabulary gains nothing.
The two gates stay separate and neither replaces the other (issue #91).

The command is arbitrary shell from a **human-approved plan** — approval is the trust
boundary, unchanged. `check-verify.sh` contains the execution: an allow-listed env
subset (`PATH HOME LANG LC_ALL TMPDIR TERM` via `env -i`, so no exported credential
reaches the command), a hard timeout, and a bounded output excerpt (40 lines / 8000
bytes) so a failing suite cannot flood the retry prompt.

```
RAD_VERIFY_TIMEOUT_SECONDS: <positive integer>   # wall-clock ceiling per declared command
```

Defaults to **600** seconds. A malformed value (non-numeric, zero, negative) is a **hard
error — exit 2** at the check boundary, never a silent fall back to the default: an
operator typo must not quietly restore a ten-minute ceiling. A command that exceeds the
ceiling is killed and reported with the reserved exit code **124**, which the spine maps
to the existing `fail-timeout` outcome (matrix action `surface`, a terminal) rather than
`fail-tests` (`revision`) — **a retry cannot fix a hang**, so it surfaces to the operator
instead of burning the attempt budget.

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

In worktree mode the approved gate, the plan doc, and the event log are all read from
the **work branch**, not the main checkout: the gate is evaluated over the branch tip's
log (`git show <branch>:.agents/state/<feature>/events.jsonl`) before any worktree is
created (fail-closed if unapproved or absent), then the plan, state store, agent, and
spine are rooted at the worktree — so events are written in the worktree (on the work
branch) and the main tree is left unmodified. Keep the main checkout on the default
branch; the work branch (`RAD_BRANCH_PREFIX` + feature, default `rad/<feature>`) must
not be checked out there. This is what makes Lane B plans (plan + approval only on the
work branch) deliverable under isolation.
Unset/empty = OFF (today's behavior). See `docs/rad-cli.md` for the full lifecycle.

### Portable Sync

OPTIONAL and backward-compatible — absent, sync is OFF and the verbs behave exactly
as before (no push, no fetch, no new events — byte-for-byte today's behavior).

```
RAD_SYNC: <any non-empty value>   # opt-in plain-git sync folded into the rad verbs
```

When `RAD_SYNC` is set, the state-mutating verbs (`rad approve`/`deliver`) fold **plain
git** transport into their flow: a best-effort `git push` of the work-branch tip after a
state write, and a `git fetch` of the tip before a gate-read so an approval recorded on
another machine is honored. Transport is **plain git only** (`git push`/`git fetch`) — never
the host API (`gh`/`glab`), which keeps it platform-agnostic; the host-API mirror/display
layer is untouched. Auth is **inherited** from the user's existing git credentials — RAD
never prompts for or stores them. Sync is **offline-fail-safe**: the local commit always
lands, the push is best-effort (a failed push never blocks or fails the verb), and a
**fail-closed divergence tripwire** refuses a write on a diverged tip and surfaces the
conflicting holder (recorded via `owner-claimed`/`owner-released` events) rather than
auto-merging. The gate fold (`harness/gates.js`) stays pure — all transport attaches at the
CLI/script boundary, never inside the fold. Unset/empty = OFF. See
`.agents/plans/portable-process-memory.md` for the full design.

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

### Self-Protected Paths

NOT optional and NOT configurable — unlike the neighboring knobs, this set is
built in. A path set covering RAD's own machinery is **always** treated as
high-risk:

```
^harness/|^scripts/|^\.claude/|^\.agents/state/|(^|/)gates\.ya?ml$|(^|/)matrix\.ya?ml$
```

`scripts/lint-plan.sh` always emits an advisory warning for such a path
regardless of `RAD_HIGH_RISK_PATTERNS`. Rationale: a change to RAD's own
machinery always requires architect review.

The set lives as a literal (`RAD_SELF_PROTECTED_PATTERN`) in
`scripts/lib/plan-paths.sh`; changing it requires a reviewed commit — there is
deliberately no env var.

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
byte-for-byte identical to a run of the same RAD version without hooks (since #119
that sequence includes a `wave-started` before each agent run).

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
| portable-memory-parent-orchestrator | parent-orchestrator | nothing | architect |
| sync-transport-orchestrator | role-orchestrator | nothing | architect |
| sync-surface-mapper | context-tool | rad-approve/deliver verb sites, git-vs-host-CLI invocation, detect-platform.sh + mirror scripts, CLAUDE.md RAD config, .env.example | architect |
| event-fold-orchestrator | role-orchestrator | nothing | architect |
| event-fold-mapper | context-tool | harness/gates.js, events.js, gates.yaml, branch-tip read sites | architect |
| approval-authority-parent-orchestrator | parent-orchestrator | nothing | architect |
| approval-event-model-orchestrator | role-orchestrator | nothing | architect |
| approval-event-mapper | context-tool | harness/events.js, transitions.js, gates.js, gates.yaml, adapters/git-state-store.js (recordApproval) | architect |
| approval-command-integration-orchestrator | role-orchestrator | nothing | architect |
| approval-command-mapper | context-tool | .claude/commands/architect/rad-design.md + rad-approve.md, harness/cli.js, check-plan-approved.sh | architect |
| insights-feedback-parent-orchestrator | parent-orchestrator | nothing | developer |
| event-metrics-orchestrator | role-orchestrator | nothing | developer |
| event-metrics-mapper | context-tool | harness/events.js read side, spine outcome/usage record sites, gates.yaml vocab, .agents/state/*/events.jsonl samples | developer |
| findings-loop-orchestrator | role-orchestrator | nothing | developer |
| findings-surface-mapper | context-tool | .agents/findings.jsonl samples, rad-insights + wrap skills, CLAUDE.md conventions, lint-plan.sh | developer |
| harness-ci-parent-orchestrator | parent-orchestrator | nothing | architect |
| ci-wiring-orchestrator | role-orchestrator | nothing | architect |
| ci-surface-mapper | context-tool | scripts/*.sh conventions, deliver-gate-hook.mjs, platform scripts, harness test entries | architect |
| integrity-checks-orchestrator | role-orchestrator | nothing | architect |
| integrity-surface-mapper | context-tool | gates.js, events.js, plan-fingerprint.js, git-state-store.js recordApproval, git-sync.sh, events.jsonl samples | architect |
| convention-lints-orchestrator | role-orchestrator | nothing | architect |
| lint-surface-mapper | context-tool | lint-plan.sh, check-scope.sh, lib/plan-paths.sh, .claude/agents samples, CLAUDE.md scope map | architect |
| quality-reviewer | reviewer | current diff or specified files, CLAUDE.md conventions | architect, developer, designer |
| accessibility-reviewer | reviewer | current diff or specified files, CLAUDE.md stack info | architect, developer, designer |

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
