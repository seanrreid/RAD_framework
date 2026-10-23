# Agent Hierarchy Audit

An audit of the 27 internal agents, sourced in `.rad/agents-internal/`
(repo-internal, never shipped; `rad generate` writes `.claude/agents/` and
`.codex/agents/`), the
`*-parent-orchestrator` → `*-orchestrator` → `*-mapper` hierarchy that
`/rad-design` produced for this repo's own features. Each agent is tagged with
the reason its boundary exists (`purpose:` in its frontmatter), and each mapper
is checked for drift away from the anchors-not-prose contract.

The headline: **every boundary in the hierarchy is durable.** Sixteen agents
exist for authority and eleven for context discipline. None exists only
because a read would not fit in the context window, so nothing here is
provisional debt that larger windows will retire.

That headline answers "is the governance wanted?", not "does it need a
separate agent loop?". The [addendum](#addendum-the-authority-test-reframed)
re-asks the second question: no `authority` agent meets a keep condition, and
most of their prose rules are not deterministically enforced.

Source: issue [#46](https://github.com/seanrreid/RAD_framework/issues/46) and
its comments; the agent files themselves; `.rad/config.yml` `agent_scope_map`.
Captured: 2026-10-06

---

## The Taxonomy

Every agent gets exactly one `purpose`. Each bucket has a test question; the
first one that answers "yes" wins.

| `purpose` | Test question | Depreciates? |
|---|---|---|
| `authority` | Would this boundary still be wanted with a perfect, free, infinite-context model? | No. Governance: role gating, architect-only delegation, scope fences. |
| `context-discipline` | Is it here because reading everything is too expensive or too distracting? | No. Semantic focus, token cost, anchors over prose. |
| `capacity` | Is it here only because the read wouldn't fit? | Yes. Window growth absorbs it. Flagged as **provisional**. |

The tie-breaker between the last two is: **would we keep this with an infinite
but costly window?** Yes means `context-discipline`.

---

## How #46 Was Reframed

#46 (June 2026) proposed a two-way split: **boundary enforcement** (keep) and
**context-chunking** (deletable when context windows grow). Its expected
outcome was that much of the mapper layer was a workaround to delete later.
Three comments moved that expected outcome.

**Context rot (2026-08-04).** HumanLayer's
[*Skill Issue: Harness Engineering for Coding Agents*](https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents)
cites Chroma's context-rot research. Performance degrades mainly with low
semantic similarity between the question and the context, not raw length;
distractors compound at longer lengths; larger windows do not help a model
find the relevant part. A 1M window raises the distractor budget, it does not
retire the context firewall. Sub-agent isolation buys *semantic* isolation, so
it keeps paying at any window size.

**Evidence anchoring (2026-08-05).** The
[Harness Handbook](https://ruhan-wang.github.io/Harness-Handbook/) names the
discipline "prose explains; facts anchor": a layer that turns a behaviour
question into evidence anchors rather than text. Every RAD mapper is specified
as "returns file:line anchors ... never raw file contents". That does not
change with window size, because behaviour still scatters across sites. The
comment proposed checking each mapper for drift into prose summaries, which
this audit does.

**Cost (2026-08-20).** ByteByteGo's
["How ChatGPT Optimizes Its Agent Loop"](https://blog.bytebytego.com/p/how-chatgpt-optimizes-its-agent-loop)
describes a production harness on very large windows that is *more* aggressive
about small context: deferred tool discovery, schema compaction, code mode to
keep intermediate data out of history. None of it is capacity-driven; it is
token cost, an economic constraint that a bigger window makes worse, not
better. The comment proposed the three buckets: authority, cost, capacity.

**Decisions (2026-10-06, recorded on #46).** The cost and anchoring arguments
merge into one durable bucket, `context-discipline`. `capacity` is the only
depreciating bucket. The deliverable is this doc and the `purpose:` field;
lint enforcement and `/rad-design` emitting the tag shipped in part 2.

---

## `purpose` vs the Scope Map's `type`

`.rad/config.yml` `agent_scope_map` already gives each agent a `type`
(`orchestrator` or `context-tool`). The two fields overlap in practice but
answer different questions:

- **`type`** is the agent's *role in delegation*: does it route work, or read
  code and return a summary?
- **`purpose`** is *why the boundary exists*: governance, context economics,
  or window size.

In this repo they line up (every orchestrator is `authority`, every mapper is
`context-discipline`), but nothing forces that. A `context-tool` that exists
only to split an oversized read would be `capacity`; an orchestrator that
exists only to keep a parent's context small would be `context-discipline`.

---

## Per-Agent Table

Justifications cite the agent file's own text by line number, as of this
commit. Line 3 is each file's `description:`; `purpose:` sits after `roles:` in
the frontmatter. The drift column applies to mappers only.

| Agent | Layer | `purpose` | Justification (agent's own text) | Drift |
|---|---|---|---|---|
| approval-authority-parent-orchestrator | parent-orchestrator | authority | L52 "Never read files directly — delegate to the two domain orchestrators only"; L56 "Architect-only: this feature sits on the approval-authority / determinism boundary" | n/a |
| harness-ci-parent-orchestrator | parent-orchestrator | authority | L21 "Owns coordination and routing only — reads no files, writes no files, implements no checks"; L38 "CI calls the fold, never changes it" | n/a |
| hooks-parent-orchestrator | parent-orchestrator | authority | L3 "Architect-only; coordinates the determinism-boundary work"; L34 "Always delegate via Task ... never read source directly" | n/a |
| insights-feedback-parent-orchestrator | parent-orchestrator | authority | L40 "Never read files directly — delegate all reading to sub-orchestrators"; L41 "Never touch the events writer or gate fold" | n/a |
| portable-memory-parent-orchestrator | parent-orchestrator | authority | L54 "Never read files directly — delegate to the domain orchestrators only"; L57 "Architect-only: this feature sits on the determinism boundary" | n/a |
| approval-command-integration-orchestrator | orchestrator | authority | L23 "You wire the verbs to the model; you do not define the model"; L51 "The commands must write authority ONLY via the event-model writer" | n/a |
| approval-event-model-orchestrator | orchestrator | authority | L23 "You define the model; you do not wire the verbs"; L45 "Never read files directly — delegate to approval-event-mapper" | n/a |
| ci-wiring-orchestrator | orchestrator | authority | L26 Outside: "check logic of any kind ... harness/gates.js, the events writer"; L41 "Never modify `harness/gates.js`, events writer, or integrity/lint script internals" | n/a |
| convention-lints-orchestrator | orchestrator | authority | L23 Outside: "editing CLAUDE.md or agent files themselves"; L35 "Lints report and exit — they never edit CLAUDE.md, agent files, or plans" | n/a |
| event-fold-orchestrator | orchestrator | authority | L23 "You own the decision to refuse, not the network call"; L49 "Never read files directly — delegate to event-fold-mapper" | n/a |
| event-metrics-orchestrator | orchestrator | authority | L3 "Hard constraint: read-side only — must not modify writer/fold code"; L34 "Never modify writer or fold code in harness/events.js or harness/gates.js" | n/a |
| findings-loop-orchestrator | orchestrator | authority | L3 "Suggestions only — never auto-edits CLAUDE.md or lint scripts"; L42 "a human applies them via PR review and merge" | n/a |
| hook-runtime-orchestrator | orchestrator | authority | L20 "Delegate file-reading tasks ... to hook-surface-mapper via Task; never read source directly"; L42 "Hooks are deterministic operator scripts" | n/a |
| integrity-checks-orchestrator | orchestrator | authority | L3 "CI calls the fold, never changes it — harness/gates.js and the events writer are read-only surfaces"; L34 "Never modify harness/gates.js, harness/events.js, or any writer/fold code" | n/a |
| spine-integration-orchestrator | orchestrator | authority | L20 "Delegate all file inspection to spine-mapper ... never read source files directly"; L41 "A veto hook may only emit an outcome from the fixed matrix vocabulary" | n/a |
| sync-transport-orchestrator | orchestrator | authority | L21 "The fold's decision on divergence is not yours; only the fetch that feeds it is"; L45 "Never read files directly — delegate to sync-surface-mapper" | n/a |
| approval-command-mapper | mapper | context-discipline | L20 "Read-only access to exactly these paths"; L27 "Return ≤35 lines, no raw file dumps"; L35 "always summarize to the output format with file:line anchors" | ok |
| approval-event-mapper | mapper | context-discipline | L20 "Read-only over exactly: ..."; L23 "no raw file dumps — field names, file:line anchors"; L33 "Never return raw file contents" | **drift:** Output Format (L24-28) hard-codes anchors, most now stale (e.g. `isSafeFeature` is at `git-state-store.js:97`, not `:78`; `eventsPath` at `:156`, not `:98`; duplicate-`approved` at `transitions.js:101-112`, not `:94-101`). It hands the mapper answers instead of an anchor contract. |
| ci-surface-mapper | mapper | context-discipline | L24 "file:line anchors + convention notes ... never raw file contents, max 40 lines"; L29 "always summarize to anchors and convention notes" | ok |
| event-fold-mapper | mapper | context-discipline | L20 "Report everything as file:line anchors plus terse event-shape notes — never raw file contents"; L28 "≤35 lines, no raw file dumps" | ok |
| event-metrics-mapper | mapper | context-discipline | L24 "file:line anchors + event-shape notes ... never raw file contents, max 40 lines"; L30 "Sample events.jsonl files for record shape only" | ok |
| findings-surface-mapper | mapper | context-discipline | L18 "Return file:line anchors and shape notes only — never raw file contents or full logs"; L28-40 anchored example; L42 "Maximum 40 lines" | ok |
| hook-surface-mapper | mapper | context-discipline | L24 "Exact read scope: ... Nothing else."; L39 "Never return raw file contents — always anchor to file:line" | **drift:** Output Format (L26-33) is a prose "Summary". Only item 1 asks for file:line; items 2-5 (invocation pattern, slot-in point, dedup notes, config unknowns) carry no anchor requirement, and item 4 pre-writes the dedup prose. The description (L3) promises "emit sites, the script-invocation pattern, and dedup notes", not anchors. |
| integrity-surface-mapper | mapper | context-discipline | L25 "file:line anchors + event/fingerprint-shape notes ... never raw file contents, max 40 lines"; L30 "always summarize to anchors and shape notes" | ok |
| lint-surface-mapper | mapper | context-discipline | L24 "file:line anchors + lint-surface notes ... never raw file contents, max 40 lines"; L30 "Read agent files for frontmatter shape only — never quote body sections" | ok |
| spine-mapper | mapper | context-discipline | L20 "Exact read scope: harness/spine.js, harness/matrix.js, harness/matrix.yaml. Nothing else."; L29 "Always cite file:line for every anchor point" | ok |
| sync-surface-mapper | mapper | context-discipline | L23 "Read-only across exactly: ..."; L27 "≤35 lines, no raw file dumps — file:line anchors and field names only"; L41 "always summarize ... with file:line anchors" | ok |

### Why the buckets fell this way

- **Orchestrators (16, all `authority`).** Every one has `tools: Task` only,
  `reads: nothing` in the scope map, and an Inside/Outside ownership fence.
  Those are exactly the markers the 2026-08-20 comment lists for authority:
  "Reads: nothing", architect-only delegation, role gating. A perfect, free
  model would still be fenced away from the gate fold and the events writer.
- **Developer-open orchestrators** (insights-feedback-parent, event-metrics,
  findings-loop) have no role gate, but each carries a hard fence: read-side
  only, or suggestions only. The fence is the authority.
- **Mappers (11, all `context-discipline`).** Each is a scope-fenced Haiku
  context tool with a line budget and an anchors-not-raw-contents contract. We
  would keep every one with an infinite but costly window. None exists only to
  split a read that would not fit.

---

## Summary

| `purpose` | Count | Agents |
|---|---|---|
| `authority` | 16 | all 5 parent-orchestrators and all 11 orchestrators |
| `context-discipline` | 11 | all 11 mappers |
| `capacity` | 0 | none |

**No agent is provisional.** #46's original premise was that a share of the
hierarchy was a context-window workaround to delete when windows grew. The
audit finds none. The hierarchy's rationale is durable: authority fences are
governance, and mappers are context discipline that window growth does not
relax.

That does not mean the hierarchy can never shrink. Collapsing it would need a
different argument, such as **indirection cost** (three hops to read one file)
or **agent-count overhead** (27 files to keep in sync with the scope map).
"Context grew, so delete it" is not that argument.

### The closest call

**insights-feedback-parent-orchestrator** is the nearest to
`context-discipline`. It is developer-open, so it has no role gate, and its
feature is read-only, so there is less to protect. It stays `authority`
because its own text draws a hard fence: L40 forbids reading files directly
and L41 forbids touching the events writer or gate fold. That fence keeps a
read-side feature from becoming a write-side one, which a perfect model would
still need.

---

## Drift Findings and Stale References

All 11 mappers now pass the anchor check. The two that had drifted and the
three agents with stale references were fixed under
[#192](https://github.com/seanrreid/RAD_framework/issues/192); the findings
below are resolved.

**Drifted mappers (resolved):**
- **approval-event-mapper:** its worked Output Format with literal line numbers
  is replaced by an anchor contract that lists what to locate and requires a
  freshly read `file:line`.
- **hook-surface-mapper:** its Output Format now requires `file:line` on every
  item, and the pre-written dedup text is dropped.

**Stale references (resolved):**
- **spine-integration-orchestrator:** the delegations to `event-log-guardian`
  and `plan-parser-guardian` (neither exists) are removed.
- **event-fold-mapper:** `recordApproval` is now placed in
  `harness/adapters/git-state-store.js`, and its scope names that file.
- **lint-surface-mapper, sync-surface-mapper, findings-surface-mapper:** the
  CLAUDE.md pointers now name the real locations: the scope map in
  `.rad/config.yml`, conventions in AGENTS.md and the `RAD_*` variables in
  `docs/configuration.md`. findings-surface-mapper's Output Format is now an
  anchor contract.

These agents are RAD-repo-internal; they are not shipped to adopters.

---

## Part 2

This doc is part 1 of 2. Part 2 covers:

- **The two shipped reviewers** (`quality-reviewer`, `accessibility-reviewer`).
  Their frontmatter is generated from `.rad/agents/`, and the generator
  rejects unknown keys, so tagging them needs generator support for
  `purpose:` first.
- **Lint enforcement:** `scripts/lint-agent-files.sh` requires `purpose:` on
  every agent that declares `roles:`, and exits non-zero when it is missing,
  empty or outside `authority | context-discipline | capacity`
  (`check_purpose`; invariant `authority-agent-boundaries`).
- **`/rad-design` emitting `purpose:`** with a one-line justification for each
  new agent, and flagging any `capacity` tag as provisional.

---

## Addendum: The Authority Test, Reframed

Captured: 2026-10-23

### The reframed test

The taxonomy's `authority` question ("would this boundary still be wanted with
a perfect, free, infinite-context model?") shows that the governance is
wanted. It does not show that the governance needs its own agent. The
reframed test is:

> **Does this governance need a separate agent loop?**

Anthropic's "When to fold subagents into your main agent loop" (2026-10-22)
keeps a subagent only when one of three conditions holds:

1. **Context bloat**: its work would flood the parent's context (large reads,
   long logs), with measured degradation.
2. **Parallel fresh context**: independent work runs in parallel, each in a
   clean, discardable window.
3. **Tool/instruction conflict**: it needs tools or instructions that would
   conflict with the parent's.

Authority alone is not on the list. A rule that must hold belongs in a
deterministic check (a lint, a gate or a plan scope rule) that returns a
readable refusal, not in an agent's prose. `/rad-design` now asks each
proposed subagent to name its keep condition.

### What the prose actually enforces

Each authority agent's Rules section was classified by constraint *kind*. The
registry (`docs/invariants.yaml`) records the result: kinds already enforced
elsewhere point at that invariant; every prose-only kind is a `bypasses` entry
with `guarded: "no"`, listed by `scripts/lint-invariants.sh --inventory`.
The one deterministic fact about these agents, that each declares a valid
`purpose:`, is invariant `authority-agent-boundaries`.

| Kind | Example rule | Status |
|---|---|---|
| direct reads | "Never read files directly / outside the declared scope" | Prose-only: `agent-prose-direct-reads` (`tools: Task` is structural, but the lint does not check orchestrator tools) |
| raw-content return | "Never return raw file contents" | Prose-only: `agent-prose-raw-content-return` |
| protected-seam edits | "Never modify `harness/gates.js`, the events writer, ..." | Prose-only: `agent-prose-protected-seam-edits` (writes outside a plan's Files in Scope are `scope-enforced`; a plan that lists the file passes) |
| design seam | "`evaluateGate` stays a pure fold", "no check logic in workflow YAML" | Prose-only: `agent-prose-design-seam` |
| transport | "plain git only", "inherit git credentials", "offline fail-safe" | Prose-only: `agent-prose-transport` |
| behavioural | "fail-closed", "deterministic hooks", "suggestions only", "keep parts separable" | Prose-only: `agent-prose-behavioural` |
| role selection | "Architect-only" (`roles: [architect]`) | Prose-only: `agent-prose-role-agent-selection` |
| Status header is a mirror | "The `Status` header is a display mirror ... never the gate" | Enforced: `unapproved-deliver-cannot-run` |
| veto vocabulary | "a veto hook may only emit an outcome from the fixed matrix vocabulary" | Enforced: `hook-veto-fail-closed` |

### Per-agent table

Every authority agent has `tools: Task` and `reads: nothing`, so none of them
reads anything that could bloat a parent (condition 1). That load sits in the
mappers, which stay. None runs work in parallel that its mapper or sibling
could not run directly (condition 2), and none carries tools or instructions
that conflict with its parent's (condition 3). Restricting an agent to `Task`
is a fence, which is authority, not a conflict.

| Agent | Constraint kinds | Enforced / Prose-only | Keep condition met |
|---|---|---|---|
| approval-authority-parent-orchestrator | direct reads, raw-content return, design seam, role selection | Prose-only | none: pure router over two orchestrators |
| harness-ci-parent-orchestrator | direct reads, raw-content return, design seam, protected-seam edits, behavioural, role selection | Prose-only | none: pure router over three orchestrators |
| hooks-parent-orchestrator | direct reads, behavioural, veto vocabulary, role selection | Enforced: veto vocabulary (`hook-veto-fail-closed`); rest prose-only | none: pure router over two orchestrators |
| insights-feedback-parent-orchestrator | direct reads, raw-content return, protected-seam edits, behavioural | Prose-only | none: pure router over two orchestrators |
| portable-memory-parent-orchestrator | direct reads, raw-content return, design seam, role selection | Prose-only | none: pure router over two orchestrators |
| approval-command-integration-orchestrator | direct reads, raw-content return, design seam, behavioural, Status header is a mirror, role selection | Enforced: Status mirror (`unapproved-deliver-cannot-run`); rest prose-only | none: Task-only; reading sits in approval-command-mapper |
| approval-event-model-orchestrator | direct reads, raw-content return, design seam, behavioural, role selection | Prose-only | none: Task-only; reading sits in approval-event-mapper |
| ci-wiring-orchestrator | direct reads, raw-content return, design seam, protected-seam edits, behavioural, role selection | Prose-only | none: Task-only; reading sits in ci-surface-mapper |
| convention-lints-orchestrator | direct reads, raw-content return, design seam, behavioural, role selection | Prose-only | none: Task-only; reading sits in lint-surface-mapper |
| event-fold-orchestrator | direct reads, raw-content return, design seam, behavioural, role selection | Prose-only | none: Task-only; reading sits in event-fold-mapper |
| event-metrics-orchestrator | direct reads, raw-content return, protected-seam edits, behavioural | Prose-only | none: Task-only; reading sits in event-metrics-mapper |
| findings-loop-orchestrator | direct reads, raw-content return, behavioural | Prose-only | none: Task-only; reading sits in findings-surface-mapper |
| hook-runtime-orchestrator | direct reads, behavioural, role selection | Prose-only | none: Task-only; reading sits in hook-surface-mapper |
| integrity-checks-orchestrator | direct reads, raw-content return, protected-seam edits, behavioural, role selection | Prose-only | none: Task-only; reading sits in integrity-surface-mapper |
| spine-integration-orchestrator | direct reads, design seam, behavioural, veto vocabulary, role selection | Enforced: veto vocabulary (`hook-veto-fail-closed`); rest prose-only | none: Task-only; reading sits in spine-mapper |
| sync-transport-orchestrator | direct reads, raw-content return, transport, design seam, role selection | Prose-only | none: Task-only; reading sits in sync-surface-mapper |

### Fold candidates

All 16 authority agents meet no keep condition, so all 16 are fold candidates
for step 5 of the subagent topology update. Nothing is removed, merged or
edited here. Folding waits on the topology eval, goes one agent per PR, and
starts with the five parent-orchestrators, which are pure routers that add a
hop between the caller and the orchestrators. Folding an orchestrator moves
its mapper delegation up one level; the 11 `context-discipline` mappers are
split by context and are not candidates.

The governance does not disappear when an agent folds. Each prose-only kind
above is a `guarded: "no"` bypass in the registry, the list of rules to turn
into deterministic checks rather than carry in agent prose.
