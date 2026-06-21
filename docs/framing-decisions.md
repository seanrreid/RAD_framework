# Framing Decisions

> The conceptual stances RAD takes — and why. Where [how-it-works.md](how-it-works.md)
> explains *what RAD does* and [harness-and-framework.md](harness-and-framework.md)
> explains *what RAD is*, this doc explains *how RAD positions itself* against the
> ideas circulating in the agent ecosystem (hooks, loops, agent-to-agent
> orchestration, context injection).
>
> These are deliberate decisions, not gaps. Several were arrived at before the
> surrounding vocabulary existed; this doc names them so the position is explicit
> and so future work doesn't relitigate a settled fork.

---

## How to read this doc

Each decision follows the same shape:

- **The idea** — the concept as it's generally discussed.
- **The decision** — RAD's stance.
- **Where it lives** — the code that embodies it.
- **Why** — the reasoning, and what we deliberately gave up.

The throughline: RAD's identity is a deterministic execution harness (see
[harness-and-framework.md](harness-and-framework.md)). Most framing decisions fall
out of one principle — **ship determinism, not intelligence** — applied to a
specific idea.

---

## Decision 1 — Hooks are a first-class extension surface, split by authority

**The idea.** A hook is a user-defined handler that fires at a fixed point in an
agent's lifecycle and can observe, modify, or block what happens next. The common
guidance treats hooks as uniformly "fail-open" — a hook failure should never break
the agent.

**The decision.** RAD has hooks, and splits them by *authority* rather than treating
them uniformly. Some points may **veto** the wave (and so are **fail-closed** — if a
gate can't decide cleanly, it stops); the rest may only **observe** (and so are
**fail-open** — a failure is recorded but never changes flow). A veto can't invent
new control flow: it must name an outcome from the frozen vocabulary and routes
through the same path the agent's own result does.

*(The six points, the fail-closed/fail-open table, and the vocabulary are documented
as mechanism in [harness-and-framework.md](harness-and-framework.md) §6 and the
[hooks README](../scripts/hooks/README.md). This doc is about why the split exists,
not how it's wired.)*

**Why.** "Fail-open everywhere" — the common one-size guidance — is right for
*observability* hooks but wrong for *policy* hooks: a security gate that silently
fails open is not a gate. Splitting by authority lets observation stay non-fatal
while policy stays enforceable. Forcing vetoes through the frozen vocabulary keeps
the determinism guarantee intact — the set of things that can happen after a wave is
fixed whether the decision came from the model or a hook. The cost: operators learn
two semantics instead of one. We judged that worth it — the two cases are genuinely
different, and conflating them is how silent-failure security holes appear.

---

## Decision 2 — Context injection is mostly static and bounded, not runtime

**The idea.** Hooks can inject organizational context — a style guide, the current
sprint's tickets, the user's role — into prompts at runtime, typically at a
prompt-submit lifecycle point.

**The decision.** RAD injects context, but favors **static, declarative, bounded**
injection over runtime handlers:

- **CLAUDE.md** is always-loaded project context (conventions, roles, constraints).
- **`buildWavePrompt`** injects *exactly* the context a wave needs — its file list,
  do-not-touch boundaries, key files, reminders, and the acceptance criteria each
  task validates against — and nothing more.
- **`.claude/agents/` boundary files** inject per-agent scope and instructions.

**Where it lives.** `CLAUDE.md` (always-loaded); `harness/adapters/agent/contract.js`
(`buildWavePrompt`, lines `22-133`); `.claude/agents/`.

**Why.** Static injection is auditable (it's in git, diffable, reviewable) and has no
runtime dependency — the same prompt is reproducible offline. Bounding injection to
*what a wave touches* keeps sub-agent contexts lean, which is the whole token model
(see [harness-and-framework.md](harness-and-framework.md)). What we gave up is
*dynamic* injection: context that changes per session (live ticket state, fresh
findings) is not currently wired in. That is a real, scoped capability — a native
prompt-submit hook is the natural home for it if a concrete need appears — but it is
deliberately not the default, because most context RAD needs is stable and belongs
in version control, not a runtime handler.

---

## Decision 3 — Loops are bounded and matrix-driven, never autonomous

**The idea.** "Agent loops" usually means an agent that repeatedly acts, observes its
own output, and decides on its own when to continue or stop — an autonomous control
loop where the *model* owns termination.

**The decision.** RAD runs loops, but **the matrix owns control flow, not the
model.** The deliver spine's wave loop retries and revises, yet every "what happens
next" decision is a deterministic table lookup rather than model judgment, and every
loop is provably terminating — bounded by a per-wave attempt ceiling, an optional
token budget, and a doom-loop breaker that aborts on a repeated identical failure.
Failure has typed exits (`fail-tests` → bounded revision, `fail-scope` → abort,
`fail-timeout` → surface to a human).

*(The matrix, the resolver, and the doom-loop breaker are documented as mechanism in
[harness-and-framework.md](harness-and-framework.md) §1 and §3. The point here is the
framing: bounded, not autonomous.)*

**Why.** An autonomous loop trades determinism for autonomy — and determinism is the
product. A loop where the model decides when it's done can run away on cost, drift,
or never terminate. A matrix-driven loop is auditable (read the table, know every
transition), testable (feed outcomes, assert actions), and safe (it always halts). We
gave up open-ended autonomy on purpose. This is the same fork as Decision 1: when
intelligence and determinism conflict at a control point, RAD picks determinism.

---

## Decision 4 — Agents prompt agents, but only through bounded artifacts

**The idea.** "Agents prompting agents" / multi-agent orchestration — one agent
delegates to another, often by passing conversation context along.

**The decision.** RAD is multi-agent, but delegation crosses a boundary as a
**bounded artifact**, never as carried-over conversation:

- A three-tier hierarchy — parent-orchestrator → role-orchestrator → context-tool —
  where orchestrators hold *no file contents* and context-tools return ≤15-line
  summaries.
- Command-level delegation returns structured blocks: `RESEARCH_SUMMARY` from the
  Explore sub-agent, `WAVE_RESULT` from each wave sub-agent, findings JSON from the
  reviewers.
- Each sub-agent context is **fresh** — no conversation carryover, no model drift —
  so deterministic guardrails can enforce policy at every hand-off.

**Where it lives.** Agent hierarchy in `CLAUDE.md` (Agent Scope Map) and
`.claude/agents/`; `RESEARCH_SUMMARY` contract in `.claude/commands/team/rad-plan.md`;
`WAVE_RESULT` in `harness/adapters/agent/contract.js`; reviewer delegation in
`.claude/commands/team/rad-review.md`.

**Why.** Passing conversation between agents lets context (and drift, and cost) grow
without bound, and makes the hand-off un-auditable. Passing a *bounded artifact*
keeps every main context lean, makes each hand-off a reviewable interface, and lets a
deterministic check sit on the boundary. The trade-off is expressiveness — a
sub-agent can't ask a clarifying question mid-task; it returns a typed result
(including typed *blocks* like `blocked_spec`) and the harness decides. That
constraint is what makes the orchestration deterministic instead of conversational.

---

## The common thread

| Idea | RAD's framing | The principle |
|---|---|---|
| Hooks | First-class, split by authority (veto fail-closed, observe fail-open) | Determinism: vetoes use the frozen vocabulary |
| Context injection | Static, declarative, bounded — runtime injection deferred | Auditability: context belongs in git |
| Loops | Bounded, matrix-driven — never autonomous | Determinism: the matrix owns control flow |
| Agent-to-agent | Bounded artifacts, fresh contexts — never carried conversation | Determinism + lean context at every hand-off |

Each decision spends some flexibility to buy a determinism or auditability
guarantee. That is the through-line of the whole harness: when a popular pattern
asks RAD to hand control to the model, RAD takes the version of the pattern that
keeps control in deterministic code and lets the model do the part only it can do —
write the change inside a wave.

---

## See also

- [harness-and-framework.md](harness-and-framework.md) — the harness/framework identity these decisions flow from
- [how-it-works.md](how-it-works.md) — the process the decisions shape
- [rad-wave-contract.md](rad-wave-contract.md) — the bounded agent contract (Decisions 2 & 4)
- [`scripts/hooks/README.md`](../scripts/hooks/README.md) — the hook invocation contract (Decision 1)
- [harness-state-store.md](harness-state-store.md) — events and pure folds (Decision 3's determinism)
