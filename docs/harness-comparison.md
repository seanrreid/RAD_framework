# RAD vs. Current Harness Thinking: Strengths and Weaknesses

> A comparison of RAD against two contemporary articulations of "agent harness"
> design, to locate RAD's distinctive bets — and its blind spots.
>
> Sources:
> - [LangChain — The Anatomy of an Agent Harness](https://www.langchain.com/blog/the-anatomy-of-an-agent-harness)
> - [Addy Osmani — Agent Harness Engineering](https://addyosmani.com/blog/agent-harness-engineering/)
> - [WorkOS — CASE](https://github.com/workos/case) (closest sibling system; see dedicated section below)
> - RAD docs: [`harness-and-framework.md`](harness-and-framework.md), [`how-it-works.md`](how-it-works.md)

---

## The shared lens

Both articles share a thesis: **Agent = Model + Harness — "if you're not the
model, you're the harness."** A capable harness with a decent model beats an
excellent model with poor infrastructure. The harness is now the primary
optimization vector, and its *dominant* job is **context engineering**: fighting
context rot, compaction, tool-call offloading, progressive disclosure,
verification loops, the "ratchet" (every mistake becomes a permanent rule in
`AGENTS.md`), and human-approval gates for risky actions.

That framing is the key to seeing RAD clearly, because **RAD makes a deliberately
different bet** than either article. Its stated identity is *"ship determinism,
not intelligence."*

---

## Where RAD is strong

**1. Determinism and provability — its defining strength, and genuinely rare.**
Both articles treat verification as "run tests, inspect logs, feed errors back."
RAD goes much further on the *control* side: gates are **pure folds over an
append-only event log**, authority is frozen into the event at write-time, and
record-time validation makes invalid histories *unrepresentable* (no duplicate
`approved`, no events after terminal phases). The stop-condition matrix is
**policy-as-data** with no default fallthrough — an unrecognized outcome is an
error, not a guess. Neither article describes anything this rigorous; they stop at
"hooks enforce constraints at lifecycle points." RAD turned "what is allowed" into
math you can replay.

**2. True model-neutrality — RAD lives the principle both articles only gesture
at.** LangChain says "model neutrality remains valuable" but concedes harnesses
co-evolve with models and overfit to tool designs. RAD's IoC seam (`runWave`
injected, one single call site, no model SDK imported in the spine) means the
agent is genuinely opaque and swappable — `claude -p`, `codex exec`, `aider`, or
the SDK, all behind one provider-neutral contract.

**3. Artifacts-on-disk + git as state — exactly the foundational primitive both
articles name.** Both say filesystem + git are *the* foundational primitives
(durable state, versioning, multi-agent coordination, resumability). RAD is
all-in: every phase emits a diffable file, the branch tip is the source of truth,
and `resumeFrom(history)` lets an interrupted deliver resume rather than repeat.

**4. Human oversight is structural, not bolted on.** Osmani specifically calls out
"approval gates… before risky operations like PR creation." RAD's *entire spine*
is built around two such gates, with an honest audit trail (`actor` vs
`recordedBy` for proxy approvals). Most harnesses treat human-in-the-loop as a
hook; RAD treats it as the load-bearing structure.

**5. A doom-loop breaker that's better than the article's advice.** The articles
recommend bounded retries and "Ralph loops." RAD's `fingerprint.js` aborts on a
*repeated identical failure* rather than burning a fixed retry budget — strictly
smarter than a fixed count.

---

## Where RAD is weak (and the articles expose the gaps)

**1. RAD does almost nothing about context engineering — the thing both articles
call the harness's #1 job.** LangChain: *"Harnesses today are largely delivery
mechanisms for good context engineering."* RAD's answer to context rot is
essentially "fresh sub-agent per wave + bounded summaries." That's a coarse reset,
not the toolkit the articles describe: no compaction, no tool-call
offloading-to-filesystem above a size threshold, no progressive skill disclosure,
no in-wave context budgeting. RAD has a *token budget breaker* (good for cost), but
that caps spend — it doesn't improve what's *in* the window. By the articles' own
definition, RAD has optimized the part of the harness that's rare and hard to get
right, while under-investing in the part they say matters most for agent
effectiveness.

**2. No "ratchet" / learning loop.** Osmani's central best practice: *every agent
mistake becomes a permanent rule* — `AGENTS.md` lines each traceable to a specific
failure. RAD has `findings.jsonl` and `/rad-insights` for *trend analysis*, which
is close in spirit, but there's no mechanism that feeds a recurring failure *back
into the agent's operating instructions* automatically. RAD observes patterns; it
doesn't ratchet them into prevention.

**3. Tool design and the inner agent loop are out of scope — by construction.**
Both articles spend heavily on tool economy ("fewer focused tools," descriptions
cost tokens), bash/sandbox primitives, and progressive disclosure. Because RAD
treats the agent as opaque, all of that is the adapter's / operator's problem.
Strength for portability, but RAD offers no help on what the articles consider
half the craft.

**4. Sandboxing/isolation is thin relative to the articles' emphasis.** The
articles treat sandboxes as a foundational primitive (safe defaults, isolation,
on-demand scale). RAD has opt-in *git worktree* isolation (`RAD_WORKTREE`) —
file-level, not a security/resource sandbox.

**5. Heavyweight for small or solo work; assumes a multi-role, git-platform
world.** RAD's strengths (two gates, role checks, deliver PR, branch-per-feature)
presume a team with an architect and a GitHub/GitLab-style flow. The articles'
harnesses scale *down* to a single autonomous agent in a loop. RAD's ceremony is a
poor fit for "let an agent grind on this for an hour" — the very long-horizon
autonomous mode the articles optimize for. (`runWave` as a driven-vs-autonomous
mode is noted as still-TODO, which is exactly this gap.)

**6. Single point where parallelism stops.** LangChain flags "orchestrating
hundreds of parallel agents" as the open frontier. RAD parallelizes *tasks within
a wave*, but the spine is a sequential wave loop with one model call site.

---

## The honest synthesis

RAD and these articles are optimizing **different halves of
`Agent = Model + Harness`**:

- The articles optimize the harness as a **capability amplifier** — make the agent
  *more effective* at long-horizon work (context, tools, verification, learning).
  Their implicit user is one developer pointing an autonomous agent at a problem.
- RAD optimizes the harness as a **governance and provability layer** — make the
  agent's output *trustworthy and auditable* in a multi-human team, with the agent
  kept deliberately swappable and opaque. Its implicit user is a team that needs to
  *prove what happened* and *gate who approved it*.

So RAD's greatest strength and greatest weakness are the same decision: **"ship
determinism, not intelligence."** It makes RAD uniquely strong on provability,
neutrality, and oversight — and uniquely silent on context engineering and the
agent-effectiveness craft that both articles consider the main event. RAD isn't a
worse version of these harnesses; it's a harness for a different question. The risk
is that as base models get cheaper and context tooling becomes table stakes, RAD's
"opaque agent" stance leaves real effectiveness on the table that operators will
have to recover entirely in their own adapter.

**One thing worth borrowing without betraying RAD's identity: a deterministic
ratchet** — closing the `findings.jsonl` → operating-rules loop so recurring
failures provably become prevention. That's squarely in RAD's "deterministic,
auditable" wheelhouse and patches its biggest learning-loop gap.

---

## RAD vs. CASE (workos/case)

The two articles above describe harness *thinking*. CASE is a harness *system* —
and it is by far RAD's closest sibling. Its thesis: *"Case exists to make
agent-authored PRs reliable, reviewable, and self-improving."* A deterministic
TypeScript/Bun executor drives a fixed phase pipeline — `scout → implementer →
verifier → reviewer → closer → retrospective` — with context isolation per phase,
file-based evidence gates, append-only event logs, and a retrospective that writes
learnings back. If RAD and CASE were in a lineup, you'd struggle to tell whose
design doc was whose.

### How much they've independently converged

Both arrived at the same primitives, separately — strong evidence RAD's core bets
are right:

- **Deterministic executor over phase transitions** (CASE's Bun executor ≈ RAD's
  `spine.js`).
- **Append-only event logs** (`.case/events/` ≈ `harness/events.js`).
- **Context isolation per phase** (CASE's per-role contexts ≈ RAD's fresh
  sub-agent per wave).
- **Identical-failure-fingerprint early abort** — *both* abort on a repeated
  failure fingerprint rather than burning the retry budget, with a two-cycle
  revision budget. The most striking convergence.
- **Provider-agnostic agent** (CASE's `--model` priority chain with per-role
  overrides ≈ RAD's `runWave` adapters + per-wave `Model:` tiering).
- **State files separating human intent from machine state** (CASE's `.task.json`
  ≈ RAD's plan doc + events).
- **Deliberately bounded to the PR loop** — both explicitly name generic-platform
  features as non-goals.

### Where CASE is ahead of RAD

**1. The ratchet — CASE built the exact learning loop this doc flags RAD as
missing.** Its retrospective is a *first-class phase*: it appends tactical
learnings to `.case/learnings.md` and proposes harness changes under
`.case/amendments/`, with the explicit philosophy *"when agents struggle, fix the
harness,"* not the output repo. This is precisely the "ratchet" recommended above.
RAD's `findings.jsonl` + `/rad-insights` *observe trends*; CASE *closes the loop*
back into its own guardrails.

**2. Evidence discipline as a machine gate.** CASE's gates require concrete
artifacts captured from *real run output* — `ca mark-tested` from actual test
output, plus a dedicated `verifier` role with intentionally "fresher" context that
tests user-facing scenarios before the closer opens a PR. RAD's `check-tests.sh`
only confirms named tests *exist on disk*. CASE proves they *ran and passed*; RAD
proves they're *present*.

**3. Product completeness / DX.** One command — `ca 1234` (GitHub) or `ca DX-1234`
(Linear) — auto-detects the tracker, fetches the issue, runs baseline
verification, and dispatches the pipeline. Compiled single binary. RAD is more
assembly-required: slash commands, shell scripts, CLAUDE.md config.

### Where RAD is ahead of CASE

**1. Formal determinism rigor.** RAD's claims go further: gates are **pure folds**,
authority is **frozen into the event at write-time**, record-time validation makes
**invalid histories unrepresentable**, and the stop matrix has **no default
fallthrough**. CASE is deterministic and resumable, but doesn't claim the same
gate-algebra hardening.

**2. Human judgment gated up-front.** The deepest divergence. CASE's pipeline is
**autonomous** — scout and implementer run before a human necessarily weighs in;
the human mostly meets the work at the *PR boundary* (steering via `ca --agent` is
optional). RAD inserts **Gate 1 (plan approval) before any code is written** — a
human architect signs off on *intent and approach* first. For high-risk or
regulated work, approving the *plan* beats reviewing the *diff*. CASE's reviewer is
an agent; RAD's approver is a person.

**3. Multi-role team model.** RAD has role gating (architect / developer /
designer), proxy approval with an honest `actor` vs `recordedBy` audit trail, and
"developers can't approve their own plans." CASE reads as a *solo developer driving
an agent*. RAD's governance answers *"who approved this?"*; CASE's answers *"what
evidence exists?"*

**4. Zero-dependency portability.** RAD's guardrails are bash 3.2+ shell scripts
with no runtime install, plus a `manual` platform mode needing no `gh`/`glab`. CASE
requires **Bun ≥ 1.0** and is bound to **GitHub/Linear** (though its compiled
binary is a cleaner single-artifact distribution).

### Synthesis

CASE and RAD are the same *kind* of thing — a deterministic, context-isolated,
evidence-gated, provider-neutral harness bounded to the PR loop — built to nearly
identical primitives. The split is about **who the harness serves**:

- **CASE** is an *autonomous pipeline with a built-in self-improvement loop*,
  optimized for a developer pointing an agent at an issue. Ahead on the ratchet,
  evidence discipline, and DX.
- **RAD** is a *governance-and-roles harness with human judgment gated up-front*,
  optimized for a team that must prove who approved what. Ahead on formal gate
  determinism, up-front human oversight, role/team modeling, and zero-install
  portability.

The pointed takeaway: **CASE shipped the exact thing recommended above** — a
deterministic ratchet that feeds failures back into the guardrails. That
recommendation is no longer theoretical; CASE's `learnings.md` + `amendments/`
split is a concrete template for closing RAD's `findings.jsonl` → operating-rules
loop.
</content>
</invoke>
