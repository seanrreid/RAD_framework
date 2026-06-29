# Discovery: Interactive Evaluation Step in `/rad-review`

Status: discovery (pre-research)
Created: 2026-06-29
Author: architect
Companion: [`harness-design-long-running-apps.md`](harness-design-long-running-apps.md) (principle #5)
Tracking issue: _(filed — see cross-link in this doc's footer)_

---

## Problem

`/rad-review` is today **entirely static**. Every step reads code or diffs and
forms a judgment without ever exercising the artifact:

| Step | What it inspects |
|------|------------------|
| 2 / 2b | scope (`check-scope.sh`), lint advisories |
| 3 / 3b | plan fidelity, Acceptance-Criteria coverage |
| 4 / 4b | `quality-reviewer` / `accessibility-reviewer` — both read changed files |
| 5 | `check-tests.sh` — test-file **presence**, not execution |
| 5b | guardrails checklist over the diff |

Anthropic's harness-design case study (principle #5) found that an evaluator
which *interacts with the live output* before scoring catches a class of defects
static grading cannot — runtime behavior, endpoint/DB state, usability gaps. RAD
already has the GAN-shaped separation the article credits (generate = `/rad-deliver`,
evaluate = `/rad-review` + architect approval); it is missing the *interaction*.

## Proposal (one line)

Add an opt-in, provider-neutral **"exercise the artifact"** step to `/rad-review`
that drives the running change through the configured agent CLI, observes
behavior, and records behavioral findings — without contaminating the
deterministic approval gate.

---

## The governing constraint

RAD's invariant: **deterministic checks own correctness; LLM steps are bounded;
the approval gate is a pure event-fold.** An interactive evaluator is irreducibly
non-deterministic (an LLM driving tools and forming a behavioral judgment).
Therefore the step must sit on the **observe-only** side of the same line RAD
already drew for wave-lifecycle hooks — it may *record*, never *gate*. The
approval gate (`rad gate <feature> approved`) is never touched by this feature.

---

## Design decisions (settled 2026-06-29)

### 1. Gating posture — **Configurable**

- **Default: observe-only.** Behavioral findings flow into the `/rad-review`
  report and `.agents/findings.jsonl` (new `reviewer: "exercise"` source); they
  never block. Fail-open, exactly like the observe-only wave-hook class.
- **Opt-in promotion:** a new env flag (working name `RAD_EXERCISE_BLOCKING`)
  promotes behavioral HIGH findings to **self-review** blockers — i.e. flips the
  summary to `NEEDS FIXES FIRST`, the same teeth `quality-reviewer` HIGHs have
  today. This is still **self-review only** — it never reaches the approval gate
  or the event log's authority. Unset/empty = OFF (advisory).
- Backward-compatible: absent the recipe block (below) and the flag, `/rad-review`
  behaves byte-for-byte as today.

### 2. Run recipe — **Per-plan `Exercise:` block**

How RAD learns to drive *this* artifact, project-neutrally. A new optional plan
section, parallel to `## Acceptance Criteria`, the architect approves as part of
the plan contract:

```markdown
## Exercise
- Launch: `<command to bring the artifact up>`   # e.g. npm run dev, ./bin/cli, pytest -q
- Drive:  <how to interact — URL + actions, CLI args, REPL calls, endpoints>
- Observe (AC#N): <the behavior that should hold, tied to an Acceptance Criterion>
- Teardown: `<optional cleanup>`
```

Rationale for per-plan over a CLAUDE.md project convention: the recipe ties the
behavioral expectation to the **specific feature** and to its Acceptance Criteria
(so "exercise" verifies the same outcomes the plan promised), and it rides the
artifact the architect already reviews and approves. A project-level convention
is coarser and drifts from per-feature intent. (CLAUDE.md `Commands` can still
provide launch defaults the recipe falls back to.)

Plans with **no** `## Exercise` block skip the step entirely — opt-in per plan.

### 3. Provider neutrality

The step must **not** assume Claude + Playwright MCP (what the article used).
It drives the artifact through the **configured agent CLI** per
[`rad-wave-contract.md`](rad-wave-contract.md) / [`rad-cli.md`](rad-cli.md) —
whatever the operator set as `RAD_AGENT` / `RAD_AGENT_CMD` (Claude, Codex,
aider, …). The recipe declares *what* to do; the provider's own tools decide
*how*. Behavioral compensation stays in the swappable adapter layer, never the
deterministic core — the durable lesson from the companion doc.

### 4. New step vs. reuse `/verify`

The built-in `/verify` skill already "runs the app and observes behavior." Open
implementation question (defer to research): is the RAD step a **thin wrapper**
that hands the per-plan recipe to `/verify`, or a first-class `/rad-review` step
(say Step 4c, "Exercise the artifact") that spawns the configured agent directly?
Leaning wrapper-where-possible to minimize new surface, but the recipe → agent
contract is RAD-owned either way.

---

## Where it slots in `/rad-review`

New **Step 4c: Exercise the artifact** (after the static reviewer agents, before
test-coverage). Reads the plan's `## Exercise` block; if absent, prints
`Exercise: skipped (no recipe)` and continues. If present, drives the recipe via
the configured agent, collects behavioral findings, and emits a new report
section:

```markdown
### Behavioral Exercise
Recipe: [present | skipped (no recipe)]
Mode: [observe-only | blocking (RAD_EXERCISE_BLOCKING)]
Findings:
- [HIGH|MED|LOW] [observed behavior vs AC#N] — [repro]
```

Findings persist to `.agents/findings.jsonl` with `reviewer: "exercise"` so
`/rad-insights` can trend behavioral defects alongside quality/a11y.

---

## Open questions for `/rad-research`

1. Wrapper over `/verify` vs. first-class step (decision #4) — and does `/verify`
   compose cleanly with a non-Claude `RAD_AGENT_CMD`?
2. `Exercise:` block schema — free-form vs. structured fields; how strictly to
   tie each `Observe:` line to an `AC#N`.
3. Findings dedup/idempotency on re-run (the step is non-deterministic; repeated
   runs may surface different findings — how does that interact with
   `findings.jsonl` cycle records?).
4. Sandboxing/safety: exercising an artifact runs project code. Scope of what the
   launch command may touch; interaction with `RAD_WORKTREE` isolation.
5. Lint surface: should `lint-plan.sh` advise when an `## Exercise` block is
   absent on a plan whose scope touches runnable surfaces?

---

## Non-goals

- Not a gate. Never touches `rad gate <feature> approved` authority.
- Not auto-fix. Like the rest of `/rad-review`, it reports; it does not edit.
- No Claude-specific tooling baked into the core.

## Prior art / relationships

- Companion synthesis: [`harness-design-long-running-apps.md`](harness-design-long-running-apps.md)
- Observe-vs-veto precedent: wave-lifecycle hooks (`scripts/hooks/README.md`,
  `.agents/research/wave-lifecycle-hooks.md`)
- Provider-neutral driver contract: [`rad-wave-contract.md`](rad-wave-contract.md)
