# How the RAD Process Works

A plain-language guide to the whole RAD workflow — the mental model, the
lifecycle, the artifacts, and the guardrails. If the README is the "what" and the
[daily-workflow](daily-workflow.md) guide is the "what do I type today," this is
the "how and why it fits together."

---

## The one-paragraph version

RAD turns a feature from idea into merged code through a fixed sequence of
commands, each producing a durable artifact. Every feature lives on **one branch**
(`rad/[feature]`) from planning through delivery. A plan is written and committed
there; an architect **approves it on that branch** (no PR for the plan); the team
then executes the plan wave by wave on the same branch and opens **one** pull
request — the deliver PR — which the architect reviews and merges. Nothing touches
the protected default branch except that final reviewed merge.

---

## Core ideas

**1. Artifacts, not memory.** Each phase writes a file you can read, review, and
diff: research notes, an architecture map, a plan, an execution log, a findings
log. The process is auditable because the trail is on disk, not in a chat history.

**2. One branch per feature, cradle-to-grave.** `rad/[feature]` is cut from the
default branch when planning starts and carries the plan → approval → code all the
way to the deliver PR. The old `plan/` and `deliver/` branches are retired. The
branch prefix is configurable (`RAD_BRANCH_PREFIX`, default `rad/`).

**3. The branch tip is the source of truth.** Because the plan doc lives on its
branch (not the default branch) until the deliver PR merges, every tool reads the
**remote branch tip** — `git show origin/rad/[feature]:...`. This is what lets
multiple people work in parallel without colliding, and what keeps work-in-flight
off a protected default branch.

**4. Two gates, one PR.**
   - **Gate 1 — Plan approval.** The architect runs `/rad-approve`, which writes
     `Status: approved` to the plan on its branch tip. *There is no plan PR.*
   - **Gate 2 — Code review.** `/rad-deliver` opens the single deliver PR
     (`rad:deliver` label) from `rad/[feature]` → default branch. The architect
     reviews and merges. The plan doc and the code reach the default branch
     together, through one reviewed merge.

**5. Deterministic guardrails.** Plain shell scripts (no LLM) enforce the rules:
role checks, scope checks, test presence, plan linting, approval status. They run
the same way locally and in any automation, on any platform, on bash 3.2+.

---

## The lifecycle

```
   Anyone        Architect        Team            Architect        Team           Team          Architect
 ┌──────────┐  ┌────────────┐  ┌──────────┐    ┌────────────┐  ┌────────────┐  ┌───────────┐  ┌───────────┐
 │/rad-     │→ │/rad-design │→ │/rad-plan │ →  │/rad-approve│→ │/rad-deliver│→ │/rad-review│→ │ PR review │
 │ research │  │            │  │(or       │    │  (Gate 1)  │  │            │  │           │  │ + merge   │
 │          │  │            │  │ /rad-    │    │            │  │            │  │           │  │ (Gate 2)  │
 │          │  │            │  │  adopt)  │    │            │  │            │  │           │  │           │
 └──────────┘  └────────────┘  └──────────┘    └────────────┘  └────────────┘  └───────────┘  └───────────┘
  .agents/      .agents/         cuts            Status:          waves on        self-review    merge to
  research/     architecture/    rad/[feature]   approved on      the branch +    before the     default
                + .claude/       + plan doc       the branch      deliver PR      architect      branch
                  agents/        (no PR)           tip            (Gate 2)        sees it
```

### Phase 1 — Research (anyone)
`/rad-research` consumes a PRD, issue, or inline spec and writes a research
artifact to `.agents/research/`. No code, no branch — just understanding.

### Phase 2 — Architecture (architect, once per project)
`/rad-design` consumes the research and produces the agent architecture:
`.agents/architecture/[slug].md`, the `.claude/agents/` boundary files, and the
**Agent Scope Map** in CLAUDE.md. Run once to draft, review, then re-run to
generate. This defines which agents exist and what each is allowed to touch.

### Phase 3 — Plan (any team member)
`/rad-plan "<feature>"` (or `/rad-adopt <issue>` to start from a tracked issue):
- delegates codebase research to an Explore sub-agent (bounded summaries, not raw
  file dumps — keeps the main context lean),
- writes a wave-structured plan to `.agents/plans/[feature].md` with a `Branch:`
  header, `## Scope`, `## Acceptance Criteria`, a `## Wave Plan`, and
  `## Tests to Write`,
- **cuts `rad/[feature]` from the default branch, commits the plan there, and
  pushes — no PR.**

A plan is **waves** of **tasks**. Tasks in a wave with no dependency on each other
run in parallel; dependent work goes in a later wave. Every task's `Validate:`
field cites an acceptance criterion (`AC#N`) so nothing is unmoored from a goal.

### Gate 1 — Approve (architect)
`/rad-approve [feature]` checks out the branch tip, shows the plan for review, and
on approval writes `Status: approved` + `Approved-By` + `Approved-At` to the plan
and pushes to the **branch** — never the default branch.

> **Out-of-band approvals.** If the architect approved in Slack / a comment / a
> standup but didn't run the command, a teammate can record it with
> `/rad-approve [feature] --on-behalf-of "<architect>" --evidence "<quote/link>"`.
> The named approver is validated as a configured architect, evidence is
> mandatory, and the record stores both `Approved-By` (the architect) and
> `Recorded-By` (whoever ran it) — the split is the integrity of the gate.

### Phase 4 — Deliver (team)
`/rad-deliver .agents/plans/[feature].md`:
- validates the `Branch:` header and that the plan is `approved` (reading the
  branch tip — it will **not** run an unapproved plan),
- works on the existing `rad/[feature]` branch (never cuts a new one),
- executes each wave in a fresh sub-agent context, committing per task and writing
  an execution log to `.agents/logs/`,
- caps retries at 2 per task and escalates on the third failure,
- runs the scope and test gates, then opens the **one** deliver PR.

### Phase 5 — Self-review (team, before asking the architect)
`/rad-review` runs on the branch before you request architect review:
- scope check (out-of-scope files are HIGH),
- plan fidelity + **acceptance-criteria coverage** (an AC no task delivers is HIGH),
- the `quality-reviewer` and (for frontend) `accessibility-reviewer` agents,
- test coverage,
- and appends structured findings to `.agents/findings.jsonl` for trend analysis
  via `/rad-insights`.

### Gate 2 — Code review (architect)
The architect reviews the deliver PR and merges it to the default branch. That
merge is the only thing that writes to the protected branch.

---

## Where everything lives

| Artifact | Path | Written by |
|---|---|---|
| Research notes | `.agents/research/` | `/rad-research` |
| Architecture + scope map | `.agents/architecture/`, `CLAUDE.md`, `.claude/agents/` | `/rad-design` |
| Plan (the contract) | `.agents/plans/[feature].md` (on its `rad/` branch) | `/rad-plan`, `/rad-adopt` |
| Execution log | `.agents/logs/[feature]-[date].md` | `/rad-deliver` |
| Review findings | `.agents/findings.jsonl` | `/rad-review` |

While a feature is in flight, its plan and log live **only on the `rad/[feature]`
branch** — that's why the board reads branch tips.

---

## The guardrail scripts

These are deterministic (no LLM) and are what the commands call to enforce the
rules. You can run any of them by hand.

| Script | Enforces |
|---|---|
| `get-default-branch.sh` | The configured `default_branch` (never hardcode `main`) |
| `checkout-plan.sh` | Safe checkout of a `rad/` branch at its remote tip (ff-only, name-validated) |
| `check-plan-approved.sh` | A plan is `approved` at its branch tip before delivery (platform-agnostic) |
| `check-role.sh` | The runner (or a named `--on-behalf-of` identity) holds the required role |
| `check-scope.sh` | Every changed file is declared in the plan's Files-in-Scope / Tests-to-Write |
| `check-tests-present.sh` | Every test listed in Tests-to-Write exists on disk |
| `lint-plan.sh` | Plan structure: required sections, AC present, wave/task limits, context budget |
| `rad-label.sh` | Mirrors a plan's status onto its issue/PR as a `rad:<status>` label (best-effort) |
| `rad-status.sh` | The board — aggregates plans from `rad/` branch tips |
| `open-pr.sh` / `detect-platform.sh` | Opens the deliver PR on the detected platform (GitHub/GitLab/…/manual) |

---

## Roles

| Role | Can | Configured in |
|---|---|---|
| Anyone | `/rad-research` | — |
| Developer / Designer | `/rad-plan`, `/rad-adopt`, `/rad-deliver`, `/rad-review` within their agent scope | CLAUDE.md → Role Assignments |
| Architect | `/rad-design`, `/rad-approve`, and merging deliver PRs | CLAUDE.md → Role Assignments |

Role gating is enforced by `check-role.sh` against CLAUDE.md. If the Role
Assignments are still placeholders, role-gated commands won't have a configured
identity to match — fill them in before relying on the gate.

---

## Status & the board

A plan's `Status:` moves through: `pending-review` → `approved` →
`in-progress` → `complete` (with `rejected` / `needs-revision` as off-ramps from
approval). `rad-status.sh` (and `/rad-status`) renders the board by reading every
`rad/` branch tip, so you see in-flight work across the team without checking out
branches. When a platform CLI is available, `rad-label.sh` mirrors the status onto
the issue/PR as a single `rad:<status>` label — a convenient, fetch-free view.
Git branch tips remain canonical; labels are just a mirror.

---

## Testing convention

The framework's own scripts are verified with **committed, self-contained test
scripts** (e.g. `scripts/test-open-pr.sh`) — no external harness. The pattern:
stub the external tools (`gh`, `glab`, `git`) on `PATH`, drive the real script,
and assert the behavior or the exact arguments it produces. Tests are written to
run under **bash 3.2** (macOS stock) as well as bash 4+, so they avoid
associative arrays, `${var,,}`, GNU-only `grep`/`find` extensions, and unguarded
empty-array expansion under `set -u`. A plan's `## Tests to Write` names the test
file(s); `check-tests-present.sh` confirms those files exist on disk before the
deliver PR opens — presence only. It never runs them, so it cannot tell you the
tests pass; execution-based verification is tracked as issue #89.

---

## A worked example

```bash
# 1. Plan a fix (cuts rad/fix-login-timeout, writes the plan, pushes — no PR)
/rad-plan "Fix the login timeout not resetting on activity"

# 2. Architect approves on the branch tip (Gate 1)
/rad-approve fix-login-timeout
#    …or record an out-of-band yes:
/rad-approve fix-login-timeout --on-behalf-of "Sam Lee" --evidence "Slack #eng 2026-05-29: 'approved'"

# 3. Execute the plan wave by wave; opens the single deliver PR
/rad-deliver .agents/plans/fix-login-timeout.md

# 4. Self-review before asking the architect
/rad-review

# 5. Architect reviews the deliver PR and merges to the default branch (Gate 2)
```

At every step the work stays on `rad/fix-login-timeout`; the protected default
branch only changes when that final PR merges.

---

## Common situations

- **Starting from a tracked issue?** Use `/rad-adopt <issue>` instead of
  `/rad-plan`. It fetches the issue, confirms its interpretation with you, and adds
  a mandatory `## Issue Gaps` section recording any assumptions.
- **The architect is a bottleneck?** Use `--on-behalf-of` to record a real
  out-of-band approval (never to self-approve).
- **A task fails repeatedly?** `/rad-deliver` retries twice, then stops with a
  structured escalation rather than pushing through.
- **Adopting RAD on an existing repo?** See [apply-to-existing.md](apply-to-existing.md).
- **Different git platform?** See [platform-support.md](platform-support.md) — the
  approval gate is platform-agnostic; only the deliver PR uses a platform CLI.

---

## See also

- [harness-and-framework.md](harness-and-framework.md) — what RAD *is*: the deterministic harness core vs. the process-framework shell
- [daily-workflow.md](daily-workflow.md) — the day-to-day command reference
- [architect-guide.md](architect-guide.md) — setup, scope maps, and approval
- [plan-pr-guide.md](plan-pr-guide.md) — the plan approval guide
- [wave-execution.md](wave-execution.md) — how `/rad-deliver` runs tasks in waves
- [onboarding.md](onboarding.md) — your first feature, start to finish
