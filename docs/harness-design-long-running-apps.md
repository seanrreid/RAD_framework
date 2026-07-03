# Harness Design for Long-Running Agentic Apps

A reference synthesis of Anthropic's engineering case study, and how RAD relates
to each principle — with particular attention to RAD's provider-agnosticism
constraint.

Source: [Anthropic — Harness design for long-running agentic applications](https://www.anthropic.com/engineering/harness-design-long-running-apps)
Captured: 2026-06-29

---

## The Core Argument

The article is a case study of an autonomous frontend-design app, but its spine
is general: **a harness exists only to compensate for specific, identifiable
model weaknesses, and its job is to keep shrinking as those weaknesses
disappear.** Every harness component encodes an assumption about what the model
can't do on its own; those assumptions age, and should be stress-tested whenever
the model updates. "Find the simplest solution possible, and only increase
complexity when needed."

This is the same family of argument as [`12-factor-agents.md`](12-factor-agents.md)
and the Bitter Lesson framing in `harness-and-framework.md`: most production
agent systems are mostly deterministic software with bounded LLM steps, not a
model looping freely with a bag of tools.

---

## The Principles

1. **Separate generation from evaluation.** Models flatter their own work; asked
   to grade themselves they "confidently praise the work — even when quality is
   obviously mediocre." An independent, skepticism-tuned evaluator beats
   self-critique. (GAN-shaped.)
2. **Context *resets* beat compaction for long tasks.** Claude Sonnet 4.5
   exhibited "context anxiety" — wrapping up work prematurely near perceived
   context limits. A full reset plus a structured handoff artifact gives a clean
   slate; summarize-in-place preserves continuity but not the anxiety.
3. **Files as the inter-agent protocol.** One agent writes a file, the next reads
   it and responds in-file or with a new file. Explicit state transfer, not
   shared memory.
4. **Pre-work contracts between agents.** Generator and evaluator agree on "what
   done looks like" for a chunk before any code is written — bridging vague specs
   and testable outcomes.
5. **Evaluators interact with the live output.** The evaluator drove Playwright
   MCP to exercise the running page (endpoints, DB state) before scoring —
   catching runtime bugs that screenshot grading misses.
6. **Gradable criteria for subjective domains.** Aesthetic quality was scored
   against four weighted criteria (Design Quality, Originality, Craft,
   Functionality). The *wording* of the criteria steered the generator as much as
   the scoring did.
7. **Strip harness complexity as models improve.** Moving Opus 4.5 → 4.6 let the
   team delete the entire "sprint" decomposition construct — the newer model
   sustained coherent work without it. Re-examine assumptions on every model
   update; remove one component at a time and test.
8. **Match evaluator cost to task difficulty.** Evaluation is overhead; it's worth
   it only when the task sits beyond what the current model does reliably solo.
9. **Planner agents expand spec, not implementation detail.** The planner was told
   to be ambitious on scope and stay at product / high-level technical design,
   avoiding early over-specification that locks in flawed assumptions.

**Model-vs-harness boundary:** the harness is temporary scaffolding over specific
model weaknesses (self-evaluation bias, context anxiety, underspecification), not
permanent architecture. As capability grows, the boundary moves outward and
components become optional.

---

## Where RAD Already Aligns (convergent validation)

| Article principle | RAD mechanism |
|-------------------|---------------|
| Files as protocol (#3) | `events.jsonl` event log + plan docs — the handoff artifact between waves and across machines |
| Context resets > compaction (#2) | Wave execution: each wave runs in a fresh sub-agent context; main context holds only the execution log + wave outcomes, never file contents or diffs |
| Pre-work contracts (#4) | Plan doc + Acceptance Criteria + the approval gate; `/rad-approve` freezes the contract |
| Generation / evaluation separation (#1) | `/rad-deliver` (generate) vs `/rad-review` + architect approval (evaluate); a planner cannot approve their own plan |
| Planner expands spec, not detail (#9) | `/rad-plan` produces a wave-structured plan at the task level, not line-level implementation |

This is independent Anthropic corroboration of choices RAD already shipped — the
same way IBM's CUGA and the Strands harness-SDK assessment corroborated the
git-as-brain and fixed-stage-hook designs.

---

## Where It Cuts Against RAD — The Operative Takeaway

Principle #7 is the real signal for a deliberately **provider-agnostic**
framework. The article's harness compensations were **Claude-version-specific**:
"context anxiety" was a Sonnet 4.5 behavior that *vanished* in Opus 4.6, and the
scaffolding built for it was then deleted. For RAD, which must run over Claude,
Codex, OpenCode, and others, that produces a sharp design rule:

- **Keep model-specific behavioral compensation out of the deterministic core.**
  RAD's durable value is the part that is *not* a capability bet: gates as pure
  folds, event-sourced state, scope enforcement, approval authority. That layer
  must never need rewriting when Opus 4.6 → 4.7 or when a different agent CLI is
  swapped in. Keep it model-blind.

- **Behavioral compensation belongs in the swappable layer** — the command/SDK
  adapter (`docs/rad-cli.md`, `docs/rad-wave-contract.md`) and the per-command
  prompts — precisely because providers have *different* weaknesses. Codex won't
  have Claude's "context anxiety"; it will have its own.

- **Justify wave-chunking by determinism and auditability, not by capability.**
  Wave-chunking as an audit/reset mechanism survives any model. Wave-chunking
  justified as "the model can't hold context" is a capability bet that ages — and
  the docs' stated rationale should be the durable one.

- **Steal principle #5.** RAD review is static today (diff + AC coverage +
  convention checks). A provider-neutral "run the artifact and observe behavior
  before judging" evaluation step — driven through whatever agent CLI is
  configured — would catch what static review misses, and stays agnostic because
  it is behavioral, not model-internal. Candidate discovery note: an interactive
  evaluation review step.

---

## Net

The durable lesson, sharpened for RAD: **the parts of a harness that shrink as
models improve are model-capability bets; the parts that persist are determinism
and auditability.** RAD should bet on the latter and confine the former to the
BYO-agent adapter, where each provider carries its own scaffolding.
