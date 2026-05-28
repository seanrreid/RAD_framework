# 12-Factor Agents

A reference guide to Dex Horthy's 12-Factor Agent principles, and how this
skill and the architectures it generates relate to each one.

Original talk: [AI Engineer World's Fair 2025](https://www.youtube.com/watch?v=8kMaTybvDUw)  
Original repo: [github.com/humanlayer/12-factor-agents](https://github.com/humanlayer/12-factor-agents)

---

## The Core Argument

Dex Horthy's thesis, drawn from interviewing 100+ teams shipping agents in
production: most successful AI systems are not "give the model a bag of tools
and let it loop" — they are mostly deterministic software with LLM steps
inserted at specific, bounded decision points.

The 12 factors are the engineering principles that separate the 80% demo from
the production system. They are language-agnostic and framework-agnostic.
Whether you are building with Claude Code, a custom Python agent loop, or an
orchestration platform, these patterns apply.

---

## The 12 Factors

### Factor 1 — Natural Language to Tool Calls

The core LLM superpower is converting unstructured text into structured JSON
that deterministic code can act on. This is the capability worth building
around. Everything else is scaffolding.

**In this skill:** The research phase converts your natural language project
description into a structured architecture plan. The implement phase converts
that plan into concrete files. Each phase is a bounded natural language →
structured output transformation.

---

### Factor 2 — Own Your Prompts

LLMs are pure functions. The only thing that determines output quality — given
a fixed model — is what tokens go in. Every token in a framework-generated
prompt that you don't control is a token you can't optimize.

**In this skill:** Every system prompt in the generated `.claude/agents/` files
is fully explicit and human-readable. There are no hidden framework prompts
wrapping them. You own every token. Edit them directly when the defaults don't
match your project.

---

### Factor 3 — Own Your Context Window

Context is the scarcest resource in an agent system. What you put in, and what
you leave out, determines quality more than model choice. This is the central
insight behind the term "context engineering."

The context window has four inputs: the prompt, memory (persistent facts),
retrieved content (RAG, file reads), and conversation history. Each must be
managed deliberately.

**In this skill:** This is the primary design principle of the entire
architecture. The information boundary rules — context tools return ≤15 lines,
orchestrators never read files, plans seed fresh sessions instead of carrying
conversation history — are all Factor 3 applied structurally. The `CLAUDE.md`
file is permanent, curated memory. The compaction artifact is managed history.
The context tool scope restrictions are managed retrieval.

---

### Factor 4 — Tools Are Just Structured Outputs

Tool use is not a special capability. The LLM outputs JSON describing an
action; deterministic code executes it; results optionally feed back. There is
nothing magical about it. Thinking of tools as exotic lets frameworks hide the
switch statement from you.

**In this skill:** Context tools are defined with explicit `tools: Read, Grep,
Glob` in their frontmatter. They are not magic — they are Claude Code's
built-in file reading capabilities invoked with a bounded system prompt. The
"tool call" is just structured output that Claude Code routes to its file
reading implementation.

---

### Factor 5 — Unify Execution State and Business State

Agent state and application state should live in the same place. Store every
agent action, decision, and result as an append-only event log tied to a
business entity. This enables replay, debugging, crash recovery, and
compliance — and makes the agent effectively stateless between steps.

**In this skill:** The `.agents/plans/` directory is a step toward this — plan
files are persistent state that survives sessions. The gap: there is no
execution log appended per step during `/execute`. Adding a
`.agents/logs/[plan-name].md` that records each completed step, what changed,
and the timestamp would complete this factor. Consider this an open improvement.

---

### Factor 6 — Launch/Pause/Resume with Simple APIs

An agent that can only run to completion is fragile. An agent that can be
interrupted, have its state stored, and resume from any point is production
grade. This requires that the core agent loop be stateless — state lives in
the database (or in files), not in memory.

**In this skill:** Plan files with `last_completed_step` support resume in
principle. The compaction artifact enables cross-session resumption. The gap
is the same as Factor 5 — without a per-step execution log, resume is a
convention rather than a guaranteed capability. The `/compact` command
(practitioner template) produces the resume artifact manually.

---

### Factor 7 — Contact Humans with Tool Calls

Human-in-the-loop is not an edge case — it is a first-class operation. The
agent should be able to declare its intent to request human input as a
structured tool call, enabling async approval workflows rather than blocking
the agent on a synchronous prompt.

**In this skill:** The `/execute` command's step-by-step confirmation loop is
the practitioner version of this. The agent surfaces a completed step and
waits for human confirmation before proceeding. For autonomous agent systems
built from the generated architecture, the parent orchestrator should treat
human approval as a tool call at plan-confirmation boundaries.

---

### Factor 8 — Own Your Control Flow

Do not hand control flow to a framework loop. Know exactly when and why the
LLM makes decisions. The more of your control flow that is deterministic code,
the more reliable your system is. LLM decision-making should be isolated to
specific, bounded choice points — not wrapped around the entire execution.

**In this skill:** The practitioner template owns control flow through slash
commands — the human explicitly invokes `/prime`, `/plan`, `/execute`, and
`/validate` in sequence. The architect template (generated `.claude/agents/`
files) relies on Claude Code's built-in orchestration, which is less
deterministic. The Stripe Minions "blueprints" pattern — alternating
deterministic nodes with LLM loops — is the ideal implementation of Factor 8
for autonomous systems.

---

### Factor 9 — Compact Errors into Context Window

When an error occurs, summarize it — do not dump the full stack trace into
context. A verbose error fills the window with noise the model can't act on.
A compact summary ("Step 3 failed: missing field `user_id` in response from
`/api/completions`") gives the model exactly what it needs to choose the next
step.

**In this skill:** Context tools are required to return compact summaries even
on failure: `"Not found. Searched: src/components"` rather than a full
directory listing of what was searched. The `/execute` command surfaces step
failures with a structured report, not a raw error dump. The compaction
artifact itself is Factor 9 applied to session history.

---

### Factor 10 — Small, Focused Agents

The number one cause of agent failure at scale is context bloat from monolithic
agents trying to do too much. An agent handling 3–10 steps with a focused
context window outperforms a generalist agent handling 50 steps in a degraded
context window.

> "By keeping agents focused on specific domains with 3–10, maybe 20 steps
> max, you keep context windows manageable and LLM performance high."
> — Dex Horthy

**In this skill:** This is the second primary design principle alongside
Factor 3. The entire orchestrator/context-tool hierarchy is Factor 10
expressed as a system. Each context tool does exactly one thing. Each role
orchestrator owns exactly one domain. The parent orchestrator delegates rather
than executing. The `/rad-research` command identifies the domain boundaries
that make Factor 10 work for your specific project.

---

### Factor 11 — Trigger from Anywhere, Meet Users Where They Are

The agent shouldn't care how it was invoked. Slack, CLI, webhook, internal
platform, cron job — the same agent should be triggerable from any surface
without modification. Coupling an agent to its invocation channel creates
maintenance burden and limits adoption.

**In RAD:** The RAD commands demonstrate this — `/rad-research`, `/rad-plan`,
and `/rad-deliver` run identically whether invoked in Claude Code's desktop
app, the CLI, or the IDE extension. The generated architectures should document
all intended trigger points in `CLAUDE.md` and the compaction artifact.

---

### Factor 12 — Make Your Agent a Stateless Reducer

Treat the agent as a pure function: `(state, input) → (new_state, actions)`.
No hidden internal state between invocations. Any memory the agent needs from
prior steps comes from the explicit context provided, not from implicit
in-memory state. This enables horizontal scaling, crash recovery, testing, and
auditability.

**In this skill:** The compaction artifact is the serialized state passed into
each new session — it is the explicit state snapshot a stateless reducer would
take as input. The gap is that the generated agent files don't enforce a formal
state envelope. Agents accumulate state through conversation history rather
than receiving an explicit serialized snapshot. For production autonomous
deployments, the parent orchestrator should pass an explicit state document as
the first message of each delegation, not rely on conversation context.

---

### Factor 13 (Appendix) — Pre-Fetch All Context You Might Need

Retrieve likely-needed context deterministically before the agent loop starts.
Don't wait for the agent to discover it needs a file and fetch it mid-run.
Pre-fetch known dependencies upfront, reducing mid-execution surprises and
improving first-attempt success rates.

**In RAD:** The `/rad-research` command pre-fetches project context from a spec
artifact before architecture design begins. The `/rad-plan` Explore sub-agent
pre-fetches codebase context before any feature planning. The gap: this
pre-fetch is still agentic (the LLM decides what to read) rather than
deterministic (scanning the task description for links and file references and
fetching them automatically before the LLM loop starts). The Stripe Minions
architecture does this deterministically — a known improvement for future
iterations.

---

## Factor Coverage Summary

| Factor | Description | Coverage in this skill |
|--------|-------------|----------------------|
| 1 | Natural language to tool calls | ✅ Core mechanism of all phases |
| 2 | Own your prompts | ✅ All prompts are explicit and editable |
| 3 | Own your context window | ✅ Primary design principle |
| 4 | Tools are just structured outputs | ✅ Explicit `tools:` frontmatter |
| 5 | Unify execution and business state | ⚠️ Plans exist; execution log missing |
| 6 | Launch/pause/resume | ⚠️ Supported by convention; not enforced |
| 7 | Contact humans with tool calls | ✅ Step confirmation in `/execute` |
| 8 | Own your control flow | ✅ Practitioner template; ⚠️ architect template |
| 9 | Compact errors into context | ✅ Compact failure summaries required |
| 10 | Small, focused agents | ✅ Primary design principle |
| 11 | Trigger from anywhere | ✅ CLI, Claude Code, manual — same prompts |
| 12 | Stateless reducer | ⚠️ Compaction artifact; no formal state envelope |
| 13 | Pre-fetch context | ⚠️ Agentic pre-fetch; not yet deterministic |

**Legend:** ✅ Addressed by design · ⚠️ Partially addressed; known gap

---

## The Three Open Gaps

The factors marked ⚠️ converge on three concrete improvements:

**1. Execution log (Factors 5 + 6)**
Add `.agents/logs/[plan-name].md` — append one line per completed step during
`/execute`. Enables true resume, audit trail, and crash recovery without
relying on conversation history.

**2. Deterministic pre-fetch (Factor 13)**
In `/prime` and `/plan`, scan the task description for file paths, URLs, and
ticket references before the LLM loop starts and load them upfront. Reduces
mid-run discovery and improves first-attempt success.

**3. Explicit state envelope (Factor 12)**
For autonomous agent deployments, pass a formal state document as the first
message of each orchestrator delegation instead of relying on accumulated
conversation context. The compaction artifact is already this document — it
just needs to be passed explicitly rather than assumed.

These are incremental improvements that can be added to the existing templates
without restructuring. See the project README for contribution notes.
