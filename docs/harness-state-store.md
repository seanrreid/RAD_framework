# RAD Harness — The StateStore Design

> Status: draft for discussion
> Branch: `rad/harness-audit`
> Companion to: `harness-audit.md` (which recommends *migrate, not rebuild*)
> Question being answered: *How do we migrate RAD's orchestration into code without
> marrying the design to git — and in a way that serves speed, quality,
> determinism, and portability at once?*

---

## The reframe: git is doing three jobs, not one

The audit treats "artifacts-on-branch-tips" as a single asset. It isn't. The
current model silently fuses three separate responsibilities:

1. **Artifact versioning** — storing the *content* of `plan.md`, `research.md`,
   the execution log. Git is the best tool for this; nobody's coupling worry
   lives here.
2. **State storage** — the `Status:` string living *inside* the doc, with
   "current truth = what's at the branch tip."
3. **Concurrency / addressing** — branch name = feature identity, branch
   operations = implicit locking.

The coupling we are wary of is **#2**: state is a string in a versioned file, and
the branch pointer is treated as a database row. The fix is **not** "leave git."
It is: *let git do documents (job 1), and stop overloading the branch tip as a
state cell (job 2).*

---

## The design: two ports, an append-only log, and first-class gates

State and documents decouple on different axes (state → log/db, docs → git/fs), so
they are **two separate ports**. The harness control flow never touches git, a
log, or a database directly — it only ever calls these interfaces. That indirection
*is* the portability surface.

```ts
// ─── StateStore: the state machine's persistence. Append-only. ───
interface StateStore {
  // READ — every read is a pure fold over the event log (deterministic, testable)
  phase(feature):   Phase            // 'researched'|'planned'|'approved'|'in-progress'|'delivered'|'done'
  plan(feature):    Plan | null      // structured: { waves[], acceptanceCriteria[], scopeMap }
  history(feature): Event[]          // full who/when/why trail — the audit log
  list(filter?):    FeatureState[]   // for rad-status — no fan-out over N branches

  // WRITE — the ONLY mutation in the whole system
  append(event: Event): void

  // GATE — a deterministic predicate the harness pauses on (first-class; see below)
  gate(feature, name): GateResult    // { passed, reason, requiredRole?, satisfiedBy? }
}

// ─── ArtifactStore: the documents. Git's actual job. ───
interface ArtifactStore {
  read(feature, name):  string | null    // 'plan.md', 'research.md', execution log
  write(feature, name, content): void
}

type Event = {
  feature: string
  type:    string        // 'plan-created' | 'approved' | 'wave-complete' | 'pr-opened' | …
  actor:   string        // WHO the event is attributed to (e.g. the architect)
  ts:      string         // passed in by the caller; the store never calls Date.now()
  recordedBy?: string    // WHO physically ran the command, if not `actor` (see proxy approval)
  data?:   object
}
```

Six state methods, two artifact methods. That is the entire seam.

**The single invariant:** `append()` is the only mutation. `phase()`, `plan()`,
and `gate()` are *derived* — pure functions of `history()`. State is never
mutated in place, so the "doc says draft but the branch says approved" class of
bug cannot exist: there is one log, and everything else is a view of it.

### Decision 1 — `gate()` is first-class (confirmed)

A gate is not sugar over `phase()`. It is the system's **slop-prevention seam and
its automation seam at once**, so it earns its own method:

- **Slop prevention:** a gate is a deterministic predicate, enforced in code, not
  prose a model might skip. `gate(feature, 'approved')` returns `passed: false`
  with a `reason` until the required event exists.
- **Automation seam:** today the `approved` gate is satisfied by a *human* event.
  Later, a **policy adapter** can emit that event automatically when conditions
  hold (tests green, scope clean, risk below threshold). **Same `gate()` call, no
  harness change.** You move from human-gated to auto-gated one gate at a time —
  never a rewrite. This is the concrete path toward full automation.

### Decision 2 — `Status:` leaves the plan doc (confirmed)

The log is canonical; the doc's status is a **rendered projection**, not a stored
field. A hand-editable `Status:` line would reintroduce a second source of truth
and the desync bugs that come with it. `/rad-status` and any header rendering
read `phase(feature)` and project it; nobody writes status into the file.

### Decision 3 — two ports, not one (confirmed)

Combining State and Artifacts into one store is less code today but re-fuses
exactly the thing we are separating. Two ports lets state move to a log/DB while
documents stay in git — independently, each a one-file adapter swap.

---

## Approval without a bottleneck: the proxy event

`rad-approve` must not become a serialization point that stalls the team. The
event model already expresses the existing `--on-behalf-of` proxy cleanly — and
makes it *auditable*, which prose approval was not.

An approval is one event:

```jsonc
// Architect approves directly:
{ "feature": "x", "type": "approved", "actor": "sean", "ts": "…" }

// Proxy records an approval the architect gave out-of-band (--on-behalf-of):
{ "feature": "x", "type": "approved", "actor": "sean",  // the decision is sean's
  "recordedBy": "dana", "ts": "…",                      // dana physically ran it
  "data": { "channel": "out-of-band", "note": "approved in standup" } }
```

The gate is satisfied by `actor` (the architect), so the team is never blocked on
*who runs the command* — only on *whose judgment it represents*. `recordedBy`
preserves the full audit trail: you always know who pressed the button and on
whose authority. This balances speed (anyone can record) against quality (the
decision is still attributed to, and authorized by, the architect), and it is the
same shape a future automated approver would take (`actor: "policy:auto"`).

```ts
gate(feature, 'approved') -> {
  passed:      history(feature).some(e => e.type === 'approved'),
  requiredRole:'architect',                 // who must be the `actor`
  satisfiedBy: <the approving event, or null>,
  reason:      'needs an approved event attributed to role:architect'
}
```

Role enforcement (is `actor` actually an architect?) stays in the existing
`check-role.sh` guardrail at record time; the store records the attribution, the
guardrail validates it. Honest limitation: the store records *asserted* identity —
it does not itself authenticate the human. That trust boundary is unchanged from
today and lives in the platform + role script, not the state layer.

---

## `rad-deliver` as a harness spine, calling the ports

This is the audit's step-1 prototype, written against the ports instead of
against git. The 336 lines of prose collapse to a short deterministic driver with
the model called only at MODEL points.

```js
// rad-deliver — control flow is CODE; the model is called only at MODEL points.
const feature = args.feature
const state = openState()        // adapter from config: 'git' | 'eventlog' | 'sqlite'
const docs  = openArtifacts()    // adapter from config: 'git' | 'fs' | …

// ── DET gate: approval. The HUMAN (or proxy) decided earlier; here we enforce it. ──
const g = state.gate(feature, 'approved')
if (!g.passed) {
  log(`Blocked: ${g.reason}`)
  return { stopped: 'gate', gate: 'approved' }   // pause — do not automate the decision away
}

const plan = state.plan(feature)
state.append({ feature, type: 'deliver-started', actor: whoami(), ts: now() })

// ── DET wave loop — retry/escalation policy is code; implementation is the MODEL call ──
await pipeline(plan.waves, async (wave) => {
  let attempt = 0, result
  do {
    attempt++
    result = await agent(implementPrompt(wave, plan), {
      label:  `wave-${wave.n}:try-${attempt}`,
      schema: WAVE_RESULT,                 // structured output — model never re-parses text
    })
    state.append({ feature, type: 'wave-attempt', actor: whoami(), ts: now(),
                   data: { wave: wave.n, attempt, status: result.status } })
  } while (result.status !== 'complete' && attempt < 3)   // ← DET retry policy, was prose

  if (result.status !== 'complete') {                     // ← DET escalation, was prose
    state.append({ feature, type: 'wave-failed', actor: whoami(), ts: now(),
                   data: { wave: wave.n } })
    throw new Error(`Wave ${wave.n} failed after ${attempt} attempts`)
  }
  state.append({ feature, type: 'wave-complete', actor: whoami(), ts: now(),
                 data: { wave: wave.n } })
  return result
})

// ── DET post-checks: existing bash guardrails (asset b), called by path, unchanged ──
sh('scripts/check-scope.sh',  feature)     // exit code = pass/fail
sh('scripts/check-tests.sh',  feature)
sh('scripts/open-pr.sh',      feature)
state.append({ feature, type: 'pr-opened', actor: whoami(), ts: now() })
```

What is deliberately *absent*: no `git`, no `jq`, no state file paths, no
string-parsing of a `Status:` line. The only git left is inside the bash
guardrails and behind the `git` state adapter.

---

## How the design serves the four priorities

**1 — Small team; non-engineers commit but no slop (→ full automation).**
Gates are deterministic predicates in code, not prose a model might skip. A
non-engineer runs `/rad-deliver`; `gate()` refuses unless an architect-attributed
`approved` event exists. Slop is caught by the bash guardrails wired as
non-skippable steps that fail the run on a bad exit code regardless of who
triggered it. The automation path is built in: swap a policy adapter that emits
the gate-satisfying event automatically when conditions hold — same `gate()` call,
no harness change.

**2 — Lean toward speed, never sacrifice quality.** Speed comes from
`pipeline()`/`parallel()` concurrency and from `schema` removing
re-derivation/re-parsing — *not* from skipping checks. Gates and guardrails are
the quality floor and are un-bypassable in the control flow. Proxy approval
removes the *human-scheduling* bottleneck without lowering the *judgment* bar.

**3 — Deterministic > probabilistic.** All control flow — retry counts,
escalation, sequencing, gate logic, listing — is code. The probabilistic surface
shrinks to exactly the ~8 MODEL calls, each boxed by an output `schema`. Because
state is a pure fold over an append-only log, resume/replay is deterministic and
unit-testable with **zero git**: feed a list of events, assert the phase.

**4 — Drop-in / portable / upgradable.** The ports are the portability story:
- **Drop-in:** ship the `git` adapter first → today's behavior byte-for-byte,
  zero migration, full reuse of scripts + artifacts.
- **Portable:** swap state from branch-tips → event log → SQLite by changing one
  config line and adding one adapter file. Harness code never moves. Bash scripts
  are called by path, portable across adapters and across a future Agent-SDK
  harness.
- **Upgradable:** a new RAD version ships new *harness* code; your `StateStore`
  data and adapters are untouched. State and logic version independently.

**This dissolves the parked blocker (audit open question #1).** You no longer have
to answer "are we married to git?" before writing code. Write against the port,
ship on the git adapter, and the coupling decision becomes a deferrable one-file
adapter swap — decided later with a running system in hand.

---

## Honest costs

- **The port must not leak git semantics.** Expose phases and events, never SHAs
  or branch names, or you re-couple through the interface. One careful design pass
  before coding.
- **One canonical source, enforced.** "Log is canonical, doc is projection" only
  holds if nothing hand-edits status into the doc. Dropping the `Status:` field
  (Decision 2) is what makes this enforceable rather than aspirational.
- **Append concurrency.** A plain JSONL log is fine for single-machine,
  single-user RAD. The moment concurrency or a dashboard is real, you want the
  SQLite adapter — which is precisely why the port earns its keep.
- **Two languages at one seam.** JS orchestrates, bash guards. Portable and
  reuses tested code, but the boundary is exit-codes + stderr, not typed returns.
  A thin `sh()` wrapper marshals it.

---

## Recommended first build (unchanged from the audit, now port-aware)

1. **`StateStore` + `ArtifactStore` interfaces** and a **`git` adapter** that
   reproduces today's branch-tip behavior exactly. Pure refactor target: no
   behavior change, fully testable via the event fold.
2. **`rad-deliver` spine** against the ports (the loop above): `pipeline()` over
   waves, `agent()` per task with the `WAVE_RESULT` schema, deterministic
   retry/gate/log, existing `scripts/*.sh` via `sh()`.
3. **Proxy-aware `approved` event** wired into `gate('approved')`, preserving
   `--on-behalf-of` with a full `recordedBy` audit trail.
4. Only then consider an **event-log adapter** as the second `StateStore`
   implementation, and flip the default when proven.

---

## Open / deferred

- **Event-log adapter file format** (single `events.jsonl` per repo vs. per
  feature; ordering/compaction) — deferred until step 4.
- **Policy-adapter design for auto-approval** — the automation endgame; scoped
  only after the human-gated spine is proven.
- **Readability for a non-engineer architect** (audit open question #2) — the
  `history()` trail + rendered projections are the proposed offset; validate with
  a real architect once the spine renders status.
