# Harness and Framework: What RAD Actually Is

> The architectural identity of RAD, grounded in the code. Read this when you want
> to understand *what kind of thing* RAD is — not how to use it (that's
> [how-it-works.md](how-it-works.md)) — and why the codebase is split the way it is.

---

## The one-line answer

> **RAD is a deterministic execution harness with a process framework wrapped
> around it. The harness is the load-bearing identity; the framework is the
> ergonomic surface that most people touch first.**

Both halves are real, and they answer different questions:

- The **framework** answers *"what is the right sequence of human + agent steps to
  ship a change safely?"* — workflow, roles, gates, conventions.
- The **harness** answers *"given an approved plan and some agent, how do I execute
  it deterministically and prove what happened?"* — spine, matrix, gates, events,
  hooks.

The two share a surface (the `/rad-*` commands), which is why RAD reads as "a
framework" at first contact. But the part that is being hardened, made portable,
and defended over time is the harness. A framework's core is its *opinions*; a
harness's core is its *determinism guarantees*. RAD keeps choosing to defend the
determinism guarantees — which is what makes it, at heart, a harness.

---

## The two layers, side by side

| | Harness core | Framework shell |
|---|---|---|
| **Question it answers** | How do I execute deterministically and prove it? | What is the right sequence of steps? |
| **Where it lives** | `harness/` (JS modules + YAML policy) | `.claude/commands/`, `CLAUDE.md`, `docs/` |
| **Form** | Pure functions, injected I/O, append-only event log | Prose commands, role conventions, branch/PR rules |
| **Identity** | Determinism guarantees | Opinions about process |
| **Swappable?** | The *agent* is swappable; the guarantees are not | The whole shell is replaceable around the core |
| **Tested by** | Feeding events to pure folds, asserting output | Self-contained shell test scripts |

---

## The harness core

Everything load-bearing lives in `harness/` and is structured as **pure
orchestration logic with injected I/O** — the model is called in exactly one place,
and everything else is deterministic.

### 1. The deliver spine — the state machine

`harness/spine.js` is the deterministic wave loop. Its header
(`spine.js:2-27`) names the boundaries explicitly: the **MODEL boundary**, the
**Bash boundary**, an injected clock, and an injected `StateStore`. The spine
function takes every dependency by injection (`spine.js:133-146`), which is what
makes it testable without git or a live model.

- Gate check before any work: `spine.js:150-153`
- The bounded wave loop: `spine.js:194-455`, with bounded retry at `spine.js:221`
- The doom-loop breaker: `spine.js:375-406` — fingerprints identical failures
  (`fingerprint.js`) and aborts on a repeat rather than burning the full retry
  budget. Strictly better than a fixed retry count.

### 2. The IoC boundary — where the opaque agent is invoked

```js
// spine.js:249 — the ONLY place the model is called
const result = await runWave(wave)
```

This is the inversion-of-control seam that makes RAD a harness rather than a
library. The spine never imports a model SDK. `runWave` is **injected** and resolves
to one of two swappable adapters:

- **command** (default) — `harness/adapters/agent/command.js` spawns an
  operator-configured CLI (`RAD_AGENT_CMD`, e.g. `claude -p`, `codex exec`,
  `aider`). No `ANTHROPIC_API_KEY` required; credentials are the command's concern.
- **sdk** — `harness/adapters/agent/sdk.js` drives the Claude Agent SDK.

Both honor the same provider-neutral contract (below), so the agent is opaque: RAD
ships the *determinism around* the intelligence, not the intelligence. See
[rad-wave-contract.md](rad-wave-contract.md).

### 3. The stop-condition matrix — policy as data

The control flow is not hardcoded in the loop; it is a lookup table.

- `harness/matrix.yaml` freezes the **7-outcome vocabulary** and maps
  `(phase, outcome) → action` (`matrix.yaml:28-35`):

  | Outcome | Action |
  |---|---|
  | `success` | advance |
  | `fail-tests` | revision (bounded feedback cycle) |
  | `fail-scope` | abort |
  | `fail-protocol` | abort |
  | `fail-timeout` | surface (escalate to human) |
  | `no-changes` | abort |
  | `abort-user` | abort |

- `resolveOutcome(phase, outcome, matrix)` (`matrix.js:54-69`) is a pure lookup
  with **no default fallthrough** — an unrecognized outcome is an error, not a
  guess. The vocabulary is enforced at every seam (`safeVetoOutcome` at
  `spine.js:43-45` coerces any out-of-vocabulary token to `abort-user`,
  fail-closed).

### 4. Gates as pure folds — authority frozen at write-time

A gate is a pure predicate over the event history, not a mutable flag.

- `evaluateGate(name, history, gates, opts)` (`gates.js:77-122`) is a pure fold:
  no I/O, no side effects. It reads the **frozen `role` field** off the event
  rather than re-deriving authority at read-time.
- The gate rules are declarative: `gates.yaml:19-23` defines the `approved` gate
  (`eventType: approved`, `requiredRole: architect`, `condition: role-equals`).
- Authority is checked **once, at record-time**, and frozen into the event. The
  event carries both `actor` (the architect whose authority it is) and
  `recordedBy` (whoever ran the command) so proxy approvals keep an honest audit
  trail (`events.js:12-42`).
- Record-time validation (`transitions.js`) makes invalid histories
  *unrepresentable* — no events after terminal phases, no duplicate `approved`,
  `approved` must carry a frozen role, etc.

This is why the CLAUDE.md rule holds: the `approved` event on the branch tip is the
sole gate authority; the plan doc's `Status: approved` header is a display-only
mirror.

### 5. The event log — the proof trail

`harness/events.js` defines an append-only event model (`events.js:12-42`).
`state.append()` is the only mutation; everything else is derived by folding:

- `phaseOf(history)` — current phase
- `evaluateGate(name, history)` — gate predicate
- `resumeFrom(history)` (`events.js:170-187`) — find completed waves so an
  interrupted deliver resumes instead of repeating
- `totalUsage(history)` — sum token spend for the budget breaker

Because state is a fold over events, the whole harness is testable by feeding it
events and asserting the output — zero git, zero I/O. See
[harness-state-store.md](harness-state-store.md).

### 6. Lifecycle hooks — extension without forking the spine

`harness/hook-runner.js` lets operators insert policy/observation at six fixed
points without touching the spine. Created with injected `sh`/`now`/`hooksDir`
(`hook-runner.js:129-248`); scripts discovered in lexical order from
`scripts/hooks/<point>/`.

| Point | Class | Semantics | Spine site |
|---|---|---|---|
| `pre-wave` | veto-capable | fail-closed | `spine.js:228-247` |
| `post-wave` | veto-capable | fail-closed | `spine.js:257-291` |
| `on-outcome` | observe-only | fail-open | `spine.js:339-344` |
| `on-retry` | observe-only | fail-open | `spine.js:369-373` |
| `on-error` | observe-only | fail-open | `spine.js:383-416` |
| `wave-complete` | observe-only | fail-open | `spine.js:349-354` |

A veto routes through the **same** `resolveOutcome()` path as an agent-emitted
outcome and can only use the frozen 7-vocabulary — a hook cannot invent a new
outcome. With no hooks dir, the appended event sequence is byte-for-byte identical
to today's. See [`scripts/hooks/README.md`](../scripts/hooks/README.md).

---

## The framework shell

The framework is the ergonomic surface — the part a human reads, types, and follows.
It imposes a process (inversion of control over your *workflow*, not your *runtime*):
you slot a feature into RAD's gates and RAD owns the lifecycle.

- **Slash commands** (`.claude/commands/`) — `/rad-research`, `/rad-design`,
  `/rad-plan`, `/rad-adopt`, `/rad-approve`, `/rad-deliver`, `/rad-review`. Prose,
  not code; they orchestrate the human + sub-agent steps and call into the harness
  CLI for the load-bearing transitions.
- **Roles and scope** (`CLAUDE.md` → Role Assignments, Agent Scope Map) — who may
  do what, and which agent may touch which files.
- **Workflow and conventions** — one `rad/[feature]` branch cradle-to-grave, two
  gates, one deliver PR, the `rad:*` label mirror.
- **The CLI port** (`harness/cli.js`) — the bridge between the prose shell and the
  pure core. `approve`/`deliver`/`status`/`gate` subcommands wire injected I/O into
  the spine and folds.

Swap any of these out — drive the harness from a Makefile, a CI job, or a different
agent CLI — and the determinism guarantees are unchanged. That asymmetry is the
whole point: **the shell is replaceable; the core is not.**

---

## Why the distinction matters

1. **It tells you where to be careful.** Changes inside `harness/` touch
   determinism guarantees — they need the pure-fold tests and the frozen
   vocabulary. Changes in `.claude/commands/` are ergonomics — looser blast radius.

2. **It explains the portability direction.** The strategic investment is in making
   the harness *extractable and standalone* (a portable `rad` CLI; `runWave` as a
   driven-vs-autonomous mode) while treating the command/role layer as the
   replaceable shell. "Ship determinism, not intelligence" is the harness identity
   stated as a principle.

3. **It resolves the "is this a framework?" confusion.** Yes — at the surface. But
   the load-bearing identity is the harness, and that is what should win when the
   two are in tension.

---

## Anchor index

| Concept | File | Anchor |
|---|---|---|
| Spine boundaries | `harness/spine.js` | `2-27` |
| Injected dependencies | `harness/spine.js` | `133-146` |
| MODEL boundary (IoC seam) | `harness/spine.js` | `249` |
| Wave loop / bounded retry | `harness/spine.js` | `194-455`, `221` |
| Doom-loop breaker | `harness/spine.js` | `375-406` |
| Fail-closed veto coercion | `harness/spine.js` | `43-45` |
| Outcome vocabulary + actions | `harness/matrix.yaml` | `28-35` |
| Pure outcome resolver | `harness/matrix.js` | `54-69` |
| Gate as pure fold | `harness/gates.js` | `77-122` |
| `approved` gate rule | `harness/gates.yaml` | `19-23` |
| Event model | `harness/events.js` | `12-42` |
| Resume fold | `harness/events.js` | `170-187` |
| Record-time validation | `harness/transitions.js` | — |
| Hook runner | `harness/hook-runner.js` | `129-248` |
| Command adapter | `harness/adapters/agent/command.js` | — |
| SDK adapter | `harness/adapters/agent/sdk.js` | — |
| Wave contract | `harness/adapters/agent/contract.js` | — |
| CLI port | `harness/cli.js` | `34-56` |

---

## See also

- [how-it-works.md](how-it-works.md) — the process, in plain language
- [harness-state-store.md](harness-state-store.md) — the two ports, events, folds
- [rad-wave-contract.md](rad-wave-contract.md) — the provider-neutral agent contract
- [rad-cli.md](rad-cli.md) — the CLI subcommands and adapter selection
- [`scripts/hooks/README.md`](../scripts/hooks/README.md) — the hook invocation contract
