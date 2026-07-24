# Cosmos vs RAD

A point-by-point comparison of Augment Code's Cosmos (public preview) against
RAD — where the two converge, where they genuinely differ, and which Cosmos
ideas are worth adopting, deferring, or declining. Like the CUGA review in
[`references.md`](references.md), the headline finding is **convergent design
validation**: an independent, funded team landed on the same shape RAD did.

Source: [Augment Code — Cosmos, now in public preview](https://www.augmentcode.com/blog/cosmos-now-in-public-preview)
Captured: 2026-07-13

---

## What Cosmos Is

Cosmos positions itself as "the operating system for agentic software
development": coordinated agent systems across the whole SDLC with human
oversight, rather than individual agents scattered across a team. Its pitch
rests on three claims:

1. **Systemic over individual** — solo agent adoption silos expertise and
   worsens review bottlenecks; the org needs a unified system.
2. **Agents doing, humans steering** — three strategic checkpoints
   (prioritization review, spec/intent validation, deep code review) replace
   many ad-hoc interruption points.
3. **Model agnosticism** — no single-vendor lock-in; their Prism router mixes
   cost/quality models for a claimed ~20–30% token savings.

Architecturally it is a hosted platform: apps and "reference experts" (Deep
Code Review, PR Author, E2E Testing, Incident Response) on top of system
services (Expert Registry, Knowledge Base, Human-in-the-Loop, Learning
Flywheel) on top of a core (Agent Runtime, Context Engine, Event Bus,
Organizational Knowledge Layer).

---

## The Comparison

| Dimension | Cosmos | RAD |
|-----------|--------|-----|
| Memory | Vendor-hosted Knowledge Base; soft learned knowledge distilled from interactions | Plain git: `events.jsonl` on branch tips, `findings.jsonl`, plan docs; portable via `RAD_SYNC` |
| Learning | Learning Flywheel → agent memory/context stores | Findings recurrence → CLAUDE.md conventions and lint rules (deterministic distillation) |
| Human gating | Three checkpoints, workflow convention | Gates 0–2, fail-closed enforcement (event authority + PreToolUse hook) + severity routing |
| Agents | Reference experts + Expert Registry, hosted runtime | Per-step skills + scoped `.claude/agents/`, BYO wave-execution agent (`RAD_AGENT`) |
| Model routing | Prism: dynamic per-request cost/quality routing | Static per-wave `Model:` tiering declared in the approved plan + `RAD_TOKEN_BUDGET` |
| Environments | Laptops, dev VMs, Augment cloud, org clouds | Main checkout by default; opt-in `RAD_WORKTREE` isolation |
| Ownership | Hosted platform; substrate is the product | Plain git the operator owns; no service dependency |

### Memory: two different memories, not one weaker one

It is tempting to summarize RAD's memory as "markdown plus GitHub issues."
That undersells it, and conflates two layers:

- **RAD's memory is hard process state**: the append-only event log on the
  work-branch tip (approvals, wave outcomes, ownership, token spend),
  `findings.jsonl`, and the plan docs. It is auditable, deterministic, folded
  by pure functions, and machine-portable via `RAD_SYNC` — already proven
  moving between machines. (Session-level `MEMORY.md` recall belongs to the
  coding assistant, not to RAD.)
- **Cosmos's memory is soft learned knowledge**: context distilled from
  conversations into a vendor-hosted store so agents "become the best agents
  for *your* environment."

These are different axes. On hard state RAD is arguably ahead of what Cosmos
describes — and owns it in plain git rather than a platform. The soft-knowledge
store is the genuine gap, and it is already a known one: it is the deferred
half of the portable-memory decision (hard state landed via `RAD_SYNC`, PR #43;
the user-following soft store remains a future brief).

### Learning: flywheel into lints vs flywheel into agent memory

RAD is not at zero on learning. The insights-feedback loop (recurrence
detection over `.agents/findings.jsonl` → suggested CLAUDE.md conventions and
lint rules) **is** a learning flywheel — it just distills lessons into
deterministic checks instead of into agent context.

That difference is a position, not a deficiency. It is the Bitter Lesson
stance (see [`harness-and-framework.md`](harness-and-framework.md)) applied to
learning: knowledge baked into a lint survives model swaps and stays
inspectable; knowledge baked into an agent's context store is a capability bet
on the vendor's retrieval. Cosmos's flywheel will feel more magical; RAD's is
more durable. "Improve RAD's learning" means closing the loop harder
(auto-proposing the lint rather than only suggesting it), not copying the
Cosmos mechanism.

### Gating: near 1:1 checkpoint map, but RAD's gates are enforced

Cosmos's three checkpoints map almost exactly onto RAD's gates:

| Cosmos checkpoint | RAD gate |
|-------------------|----------|
| Prioritization review | Gate 0 — `/rad-epic-decompose` (optional shaping) |
| Spec and intent validation | Gate 1 — `/rad-approve` on the plan |
| Deep code review | Gate 2 — deliver-PR review |

Two real differences:

1. **Enforcement.** RAD's gates are fail-closed and mechanically enforced: the
   `approved` event on the branch tip is the sole gate authority, checked by a
   pure fold and additionally blocked by a deterministic PreToolUse hook.
   Cosmos's checkpoints read as workflow convention.
2. **Granularity.** Severity routing (`RAD_LOW_RISK_PATTERNS`) goes a step past
   fixed checkpoints: the human is invoked only when the change needs judgment,
   and the routing decision is deterministic and fail-closed rather than
   model-judged.

One idea worth chewing on from their side: Cosmos frames deep code review as
**optimized for recall, not precision** — agents read everything, humans are
shown "places where key assumptions are shifting" rather than the full diff.
That is a different Gate-2 philosophy than RAD's (where the architect reads the
deliver PR), and a candidate input for the interactive-evaluation discussion in
[`discovery-interactive-evaluation.md`](discovery-interactive-evaluation.md).

### Model routing: dynamic vs declared

Cosmos's Prism routes each request across models dynamically for cost/quality.
RAD's counterpart is static: per-wave `Model:` tiering plus the
`RAD_TOKEN_BUDGET` breaker. The trade is deliberate — a model choice declared
in the plan is **auditable at Gate 1**; a dynamic router saves more tokens but
makes the cost/quality decision invisible to the approver. RAD has implicitly
declined dynamic routing by putting model choice in the approved plan.

### Environments: the real gap, but interrogate what the VM buys

This is the one dimension where Cosmos is clearly ahead in polish: VMs across
laptop, cloud, and org infrastructure vs RAD's opt-in `RAD_WORKTREE`.

Before adopting, separate what the VM actually buys:

- **Fleet-scale parallelism** and **untrusted-agent sandboxing** — Cosmos's
  actual value proposition, and not RAD's problem at its current scale. Also
  exactly where Cosmos's vendor lock lives.
- **Checkout isolation** — the part RAD already has. The cheap 80% is making
  `RAD_WORKTREE` the default for `/rad-deliver` rather than opt-in and
  tightening the lifecycle ergonomics (filed as
  [#61](https://github.com/seanrreid/RAD_framework/issues/61)).

VMs become worth revisiting when RAD needs concurrent deliver runs or agents
the operator doesn't trust with the host.

---

## Verdict

- **Convergences (validation, adopt nothing):** persistent process memory,
  staged human checkpoints, specialized per-stage agents, model agnosticism,
  environment isolation. Same family as the CUGA finding — independent teams
  keep converging on RAD's substrate bets.
- **Genuinely new relative to RAD:**
  - *Soft-knowledge learning store* — already on the future-brief list as the
    deferred half of portable memory. Cosmos raises its priority as evidence
    the market values it; it does not change the design (user-following store,
    never the gate authority).
  - *Dynamic model routing (Prism)* — declined by design; RAD keeps model
    choice declared and auditable in the plan.
  - *Recall-not-precision review framing* — open candidate for the Gate-2 /
    interactive-evaluation discussion.
- **Steal-with-modification:** default-on worktree isolation for
  `/rad-deliver`, not VMs.
- **Issues filed** (gap-framed, source-free):
  [#59](https://github.com/seanrreid/RAD_framework/issues/59) — deliver-PR
  review digest (recall-oriented Gate-2 surface from existing folds);
  [#60](https://github.com/seanrreid/RAD_framework/issues/60) — plan-time
  reliability readout from `events.jsonl` (learn from successes, not just
  findings);
  [#61](https://github.com/seanrreid/RAD_framework/issues/61) — worktree
  isolation default-on for `/rad-deliver`.
- **Settled RAD decisions challenged:** none. The platform-vs-substrate split
  (Cosmos sells the substrate; RAD's bet is plain git the operator owns) is
  the load-bearing difference, and Cosmos strengthens rather than weakens the
  case for it.
