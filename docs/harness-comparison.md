# RAD vs. Current Harness Thinking: Strengths and Weaknesses

> A comparison of RAD against two contemporary articulations of "agent harness"
> design, to locate RAD's distinctive bets — and its blind spots.
>
> Sources:
> - [LangChain — The Anatomy of an Agent Harness](https://www.langchain.com/blog/the-anatomy-of-an-agent-harness)
> - [Addy Osmani — Agent Harness Engineering](https://addyosmani.com/blog/agent-harness-engineering/)
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
</content>
</invoke>
