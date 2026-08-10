# Research: Per-Wave Back-Pressure Contract
Created: 2026-08-04
Author: architect
Status: pending-plan
Source: https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents (inline spec)

> **Scope note.** This is a feature-scoped research artifact, not a project-scoped
> one. `/rad-research` is written to feed `/rad-design` (domains, team, platform,
> agent-boundary generation) — all of which are already settled for this repo.
> This artifact feeds `/rad-plan` instead. See Open Question 5.

## Project Summary

Make "did this wave verify its own work" a **deterministic, event-recorded fact**
produced by the harness, rather than a claim the wave agent makes about itself in
prose. Today RAD trusts the agent's self-report for whether validation passed, and
the one deterministic per-wave gate does not execute anything.

## The external claim

HumanLayer, *Skill Issue: Harness Engineering for Coding Agents*: an agent's
probability of success correlates with its ability to verify its own work. Their
three implementation lessons, each of which maps to a distinct gap below:

1. **Run subsets, not full suites** — full-suite output floods context.
2. **Swallow output on success; surface only errors.**
3. **Re-engage the agent on failure** by feeding the error back as context
   (their mechanism: hook exit code 2).

## Current State (verified)

### What already exists — more than assumed

RAD is **not** missing per-wave verification wiring. `harness/spine.js:292-307`
already runs a gate after every wave whose outcome would otherwise advance, and
demotes `success` → `fail-tests` on failure, routing it through the matrix into
the bounded retry/revision path. The comment at `spine.js:52` records the design
intent explicitly: *"The test gate now runs per-wave (a regression blocks AT the
introducing wave, not at the end)."* `check-tests.sh` was deliberately removed
from `POST_CHECKS` for this reason.

The hook surface is also already in place: six lifecycle points
(`harness/hook-runner.js`, `scripts/hooks/README.md`), two of them veto-capable
(`pre-wave`, `post-wave`), with `post-wave` firing *after the wave result and
before the per-wave gate* — structurally the right seam. Hook observations already
become `hook-observed` / `hook-failed` / `hook-veto` events with provenance.

### The load-bearing finding

**`scripts/check-tests.sh` does not run tests.** It parses the plan's
`## Tests to Write` section and checks that each listed test file **exists on
disk** (`check-tests.sh:39-43`). It never executes a test, a build, a typecheck,
or a linter. Its exit code answers "were the promised test files created?", not
"does the code work?"

So the per-wave gate is real, deterministic, and correctly wired — but the signal
flowing through it is a **file-presence check**. A wave can create every promised
test file, have all of them fail, and the gate passes.

The only thing that actually executes verification is the agent, following the
prose instruction in the wave prompt (`contract.js:102-110`):

```
3. Run the validation command
4. Self-classify the outcome before reporting
```

The command comes from the task's `Validate:` field, rendered as free text
(`contract.js:60`). The harness never sees the command, never runs it, and never
sees its output. It sees only the agent's self-classification in `WAVE_RESULT`.
That is precisely the "trusted prose" the deliver gate exists to eliminate
everywhere else in RAD.

### Gap analysis

| # | Gap | Evidence | Maps to lesson |
|---|-----|----------|----------------|
| 1 | Verification is executed by the agent and self-reported; the harness cannot distinguish "validated" from "claimed validated" | `contract.js:102-110`, `resultToOutcome` consumes only self-classification | — (RAD-specific) |
| 2 | The deterministic gate checks file presence, not behavior | `check-tests.sh:39-43` | — (RAD-specific) |
| 3 | No per-wave scoping — one global gate command for every wave, no subsetting | `spine.js:293` hardcodes `scripts/check-tests.sh` | 1 |
| 4 | Failure output never reaches the agent; retries re-send an **identical prompt** | `spine.js:249` calls `runWave(wave)`; `cli.js:433` binds `runWave = (wave) => adapter(wave, planCtx)` with `planCtx` fixed for the whole deliver | 3 |

Gap 4 deserves emphasis. The retry budget is 3 attempts (`MAX_ATTEMPTS`), and every
attempt builds the same prompt from the same `wave` and the same bound `planCtx`.
Nothing about the failure — not the gate status, not the failing task, not the
error the agent itself reported — is fed back. A retry differs from its predecessor
only by model nondeterminism.

The doom-loop breaker (`spine.js:379`) fingerprints gate-derived fields precisely
so identical failures hash equally and trip the cap early. Read together: **RAD
built a detector for a loop its own retry path structurally guarantees.** Closing
gap 4 is what would make retries meaningfully different from each other.

Lesson 2 (elide on success) is already satisfied — by construction, since `sh`
surfaces only `{ status }`. But it is satisfied *too* aggressively: output is
discarded on failure too, which is what creates gap 4.

## Key Requirements

- A wave (or task) can **declare** its verification command in the plan, in a form
  the harness parses deterministically — not prose the agent interprets.
- The harness **executes** that command itself at a fixed point in the wave loop.
- On success: output is discarded; no context cost.
- On failure: the outcome is demoted through the existing matrix **and** a bounded,
  truncated excerpt of the failure output is fed into the next attempt's prompt.
- The verification result is written as an **event** carrying at minimum: which
  command ran, exit status, and pass/fail — so `/rad-insights` and the Gate-2
  digest can fold "was this wave actually verified" as a fact.
- Absent declaration = today's behavior, byte-for-byte. Every RAD feature to date
  has held this line (`RAD_WORKTREE`, `RAD_SYNC`, `RAD_TOKEN_BUDGET`, hooks).

## Design Decision Points

### D1 — Where is the command declared?

- **(a) Per-task `Verify:` field** alongside `Validate:`. Finest grain, but the
  gate runs per *wave*, so N task commands need a composition rule.
- **(b) Per-wave `Verify:` line** in the `### Wave N` block — precedent exists:
  `Model:` is already an optional per-wave line (CLAUDE.md, Cost & Frugality).
  Matches the gate's actual granularity.
- **(c) Plan-level `## Verification` section** with an optional per-wave override.

**Recommendation: (b), with (c) as the default fallback.** It matches the existing
`Model:` precedent exactly, matches the gate's granularity, and gives lesson 1
(subsetting) for free — wave 2 runs `npm test -- harness/test/gates.test.js`, not
the whole suite.

### D2 — Who executes it?

- **(a) Extend the `sh` boundary in the spine** — replace the hardcoded
  `scripts/check-tests.sh` with the declared command.
- **(b) A `post-wave` hook** — the seam already exists and is veto-capable.
- **(c) A new `scripts/check-verify.sh`** invoked through the existing `sh` port.

**Recommendation: (c).** It keeps the spine's `sh` port shape unchanged (a script
path + feature), keeps arbitrary command execution out of `spine.js` (which must
stay purely deterministic control flow over injected ports), and leaves the hook
surface free for *operator* policy rather than consuming it for a core feature.
(b) is tempting but wrong: hooks are the operator's extension point, and a hook
veto replaces the outcome without carrying output back anyway.

**Note:** whichever wins, declared commands are arbitrary shell from a plan file.
The plan is already gated by human approval, so the trust boundary is the same as
today's — but the execution path needs the same allow-listed-env treatment the
adapters use (`docs/rad-wave-contract.md`, "Never leak credentials").

### D3 — How does failure output reach the next attempt?

This is the structural change. Options:

- **(a) Widen `runWave`** to `runWave(wave, { attempt, priorFailure })`, and have
  `buildWavePrompt` render an optional `## Prior Attempt Failure` section. Touches
  the provider-neutral contract, but **additively** — an adapter ignoring the
  second argument behaves exactly as today.
- **(b) Mutate `planCtx.executionNotes.reminders`** between attempts. No contract
  change, but smuggles failure state through a field meaning something else.
- **(c) Write the excerpt to the execution log** and rely on the agent reading it.
  Zero contract change; also zero guarantee.

**Recommendation: (a).** (b) is a correctness trap and (c) reintroduces exactly the
trust-the-agent problem this feature exists to remove. The contract doc explicitly
defines `runWave(wave, planCtx)` — the adapters already accept two arguments; only
the *spine's* single-argument call site (`spine.js:249`) and the `cli.js` binding
narrow it. That makes (a) a smaller change than it first appears.

**Truncation is mandatory**, not optional: the wave prompt already opens with
*"Truncate large file/command outputs"*. Feeding an untruncated failing test suite
into the retry prompt would reproduce the exact context flood HumanLayer warns
about. Needs a declared cap (head/tail N lines) fixed in the contract.

### D4 — What is recorded?

Existing `wave-attempt` data is `{ wave, outcome, usage }` (+ veto provenance). A
verification result should ride there rather than becoming a new event type —
`{ wave, outcome, usage, verify: { command, status, passed } }` — consistent with
how `usage` was added as an optional key that folds and serializes identically when
absent.

**Do not record the output excerpt in the event.** Events are committed to git
(`.agents/state/<feature>/events.jsonl`); failure output is unbounded and may
contain paths, environment detail, or secrets. Record the *fact*, pass the
*excerpt* in memory to the next prompt.

## Constraints

- **`harness/gates.js` must stay a pure fold.** Verification attaches at the
  spine/script boundary. No transport, no execution inside the fold — the rule
  `RAD_SYNC` already established.
- **The matrix vocabulary is frozen** (7 outcomes). A verification failure maps to
  the existing `fail-tests`; it must not introduce an eighth outcome.
- **Backward compatibility is absolute.** No `Verify:` line ⇒ identical event
  sequence to today.
- **Replay safety.** Event-shape changes interact with #67 (event-log replay
  regression check) — an optional key on `wave-attempt` folds the same when absent,
  but this needs an explicit test.
- **`spine.js` never executes arbitrary commands directly** — everything goes
  through the injected `sh` port so the spine stays unit-testable with zero real
  shell.

## Open Questions

1. **Does `check-tests.sh` stay?** Its file-presence check is a genuinely different
   signal ("did you write the tests you promised") from execution. Keep both as
   distinct gates, or fold presence into the new verify step? Recommend keeping —
   it catches a failure mode execution does not (silently dropping a promised test).
   But its name is actively misleading and should change.
2. **Composition when a wave declares no `Verify:` but tasks do** — run all, run
   none, or first-failure-wins?
3. **Timeout for a declared verification command.** The adapters have
   `withTimeout`; a hanging test suite must not hang the deliver. What is the
   default, and is it declarable?
4. **Interaction with `RAD_WORKTREE`** — a declared command must run in the
   worktree's checkout, not the main tree, when isolation is on.
5. **Process gap: there is no feature-scoped research step.** `/rad-research` is
   project-scoped (feeds `/rad-design`'s agent-architecture generation);
   `/rad-plan` delegates only bounded codebase lookup to an Explore sub-agent. A
   design question spanning the wave contract, the spine, and the event schema has
   nowhere to live between "idea" and "plan". This artifact was written by hand
   into the research slot. Related to #81 (tiered planning entry) — the same
   observation from the opposite end: RAD needs a *heavier* pre-plan path as well
   as a lighter one.

## Adjacent Issues

- **#63** (persist per-task WAVE_RESULT statuses, mine traces) — the `verify` key
  on `wave-attempt` is the same event-enrichment surface; these should be planned
  together or sequenced deliberately.
- **#77** (autonomous-mode stop contract) — "verified itself" is a natural
  completion criterion; autonomous mode needs this to be a fact, not a claim.
- **#59** (Gate-2 review digest) — a per-wave verification record is exactly the
  kind of deterministic signal the digest should fold.
- **#67** (event-log replay regression check) — gates the event-shape change.
- **#75/#76** (green lane) — auto-approval is far more defensible when the harness
  can prove each wave verified itself. Deterministic verification is a prerequisite
  worth stating explicitly in the green-lane arc.
