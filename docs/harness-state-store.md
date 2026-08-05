# RAD Harness — The StateStore Design

> Status: draft for discussion
> Branch: `rad/harness-audit`
> Companion to: `harness-audit.md` (which recommends *migrate, not rebuild*)
> Question being answered: *How do we migrate RAD's orchestration into code without
> marrying the design to git — and in a way that serves speed, quality,
> determinism, and portability at once?*
> Prior art: validated and refined against **[WorkOS Case](https://github.com/workos/case)**,
> a production harness that ships this exact pattern (see "Prior art" at the end).

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

  // WRITE — the ONLY mutation in the whole system.
  // Validates legality BEFORE persisting: an illegal transition throws
  // TransitionError and is never written (see Decision 4).
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

Per the readability requirement (Decision 5), gate *rules* are declared in the
same kind of human-readable file as the matrix — e.g. `gates.yaml` mapping a gate
name to its required event type, `requiredRole`, and pass condition. `gate()`
loads and evaluates them; an architect can read and change a gate without touching
JS.

### Decision 2 — `Status:` leaves the plan doc (confirmed)

The log is canonical; the doc's status is a **rendered projection**, not a stored
field. A hand-editable `Status:` line would reintroduce a second source of truth
and the desync bugs that come with it. `/rad-status` and any header rendering
read `phase(feature)` and project it; nobody writes status into the file.

### Decision 3 — two ports, not one (confirmed)

Combining State and Artifacts into one store is less code today but re-fuses
exactly the thing we are separating. Two ports lets state move to a log/DB while
documents stay in git — independently, each a one-file adapter swap.

### Decision 4 — `append()` validates the transition before persisting (from Case)

`gate()` answers *"may I proceed past this point?"* — a forward check at a gate.
It does **not** answer *"was this state change even legal?"* Those are different
questions, and a robust state machine needs both. So `append()` runs a
`validateTransition(event, currentState)` check first and **throws rather than
writes** on an illegal move. Examples of illegal moves that should never reach
the log:

- any event after a terminal `done`/`delivered` event for the feature;
- `wave-complete` for a feature whose `phase` is not `in-progress`;
- a `revision-requested` with no preceding reviewer/verifier output;
- a duplicate `approved` that would silently shadow an earlier authority.

This is the **enforcement teeth** for the whole model: `gate()` is proceed-time,
transition-validation is record-time, and together they make an invalid history
*unrepresentable* rather than merely *discouraged*. WorkOS Case implements exactly
this — its `EventAppender.append()` calls `validateTransition()` and raises
`LifecycleValidationError` (e.g. *"Cannot append events after pipeline end,"*
*"Cannot request revision without evaluator output"*) before the event is ever
written to the log. We adopt the same record-time guard.

### Decision 5 — readability is a hard requirement; policy lives in declarative files (confirmed)

A JS harness is less auditable by a non-engineer architect than today's prose
commands (audit open question #2). Rather than accept that as a cost, we make
readability a **hard requirement**: all *policy* — the stop-condition matrix and
the gate rules — lives in declarative `*.yaml`/markdown files that an architect
reads and edits directly. The JS *loads and applies* them; it never *contains*
them. The `history()` event trail and rendered status projections cover the
runtime-observability half. The line we hold: control *flow* may be code, but
control *policy* must be human-readable. (See the matrix and gate sections.)

### Decision 6 — the event log is git-tracked, per-feature JSONL (confirmed)

Where the log lives matters because RAD is a **team** tool, unlike single-operator
Case. State must travel between teammates, so we keep git as the cheap sync
transport — but only as *transport*, not as the state cell:

- **Git-tracked, not git-ignored.** The event log is a committed file on the work
  branch, so `git push`/`pull` keeps the whole team on one board. (Case
  git-ignores its log because it is single-operator and only the output PR needs
  to travel — the opposite of our priority #1.) This decouples state from the
  branch-tip/`Status:`-string model *without* losing free team sync, and the port
  still permits a SQLite/service adapter later when real concurrency demands it.
- **JSONL, reusing the `findings.jsonl` precedent.** One JSON object per line:
  appends are cheap and crash-tolerant (a half-written final line is skipped, not
  fatal), the log is streamable (`tail -f`, `jq -c`) for a live `rad-status`, and
  diffs stay clean. RAD already runs this format in `.agents/findings.jsonl`; the
  event log is its sibling (per-feature lifecycle state vs. cross-cycle findings).
- **One file per feature**, not one global log — different features are different
  files, which avoids merge contention on concurrent appends across branches.

Format roles across RAD, for clarity:

| Format | Used for | Why |
|---|---|---|
| **JSONL** | event log (new), `findings.jsonl` (exists) | append-only streams; crash-tolerant; streamable |
| **YAML / markdown (declarative)** | stop-condition matrix, gate rules | human-read/edited *policy* — satisfies Decision 5 |
| **Markdown (narrative)** | plans, research, architecture | human-authored documents (the ArtifactStore) |

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

## The stop-condition matrix — the core of deterministic control flow (from Case)

The audit's first instinct was a wave loop that says *"retry at most twice, then
escalate."* That ad-hoc policy is exactly the prose-as-control-flow we are trying
to leave behind. The disciplined form — and the single highest-leverage borrow
from WorkOS Case — is a **unified, exhaustiveness-tested stop-condition matrix**:
every `(phase, outcome)` pair maps to exactly one declared action, with **no
default fallthrough**.

**Readability is a hard requirement (settled), so the matrix is a declarative
file, not inline JS.** The policy lives in a `matrix.yaml` (or markdown table) a
non-engineer architect reads and edits; `resolveOutcome()` *loads* it. The JS is
only the lookup, never the policy.

```yaml
# matrix.yaml — the ONLY place a "what happens next" decision lives.
# A test asserts every applicable (phase, outcome) pair has an entry; a missing
# pair fails CI. Outcomes: success | fail-tests | fail-scope | fail-protocol
#                          | fail-timeout | no-changes | abort-user
# Actions:  advance | retry | revision | abort | skip-to | surface
implement:
  success:       { action: advance,  to: verify }
  fail-tests:    { action: revision }
  fail-scope:    { action: abort }
  no-changes:    { action: abort }
  fail-timeout:  { action: surface }
  abort-user:    { action: abort }
```

```ts
// JS is the lookup only — it carries no policy of its own.
const matrix = loadMatrix('matrix.yaml')
function resolveOutcome(phase: Phase, outcome: Outcome): { action: Action; to?: Phase }
```

Case proves the pattern out in `src/dag/outcome-table.ts`, kept in sync with a
human-readable `docs/failure-matrix.md` by an exhaustiveness test that forbids a
`default` branch. We push it one step further to satisfy the readability
requirement: the human-readable file *is* the source, not a doc that must be kept
in sync with code. The payoff is precisely priority #3 (**deterministic >
probabilistic**) — no failure mode is ever resolved by model judgment or prose the
model might mis-apply — and priority #1 readability: the entire policy is one
declarative table an architect can audit and change without reading JS.

Two refinements we take from Case alongside the table:

- **Failure fingerprinting (doom-loop breaker).** Before spending a retry/revision,
  hash the failure (`SHA-256` of failed-check categories + error summary). If a
  cycle produces a fingerprint identical to the previous one, the work is provably
  stuck — `abort` immediately instead of burning the remaining budget. This is
  strictly better than a fixed retry count.
- **Bounded revision budget.** Reviewer/verifier failures route back to the
  implementer as structured feedback (`revision`), capped (Case uses two cycles),
  with the fingerprint breaker as the early-exit.

## `rad-deliver` as a harness spine, calling the ports

This is the audit's step-1 prototype, written against the ports and driven by the
matrix instead of an inline retry count. The 336 lines of prose collapse to a
short deterministic driver with the model called only at MODEL points.

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

// ── DET wave loop — the MATRIX decides what happens next, not an inline counter ──
await pipeline(plan.waves, async (wave) => {
  let lastPrint = null
  while (true) {
    const result = await agent(implementPrompt(wave, plan), {
      label:  `wave-${wave.n}`,
      schema: WAVE_RESULT,                 // structured output — model never re-parses text
    })
    state.append({ feature, type: 'wave-attempt', actor: whoami(), ts: now(),
                   data: { wave: wave.n, outcome: result.outcome } })

    // Doom-loop breaker: identical failure twice in a row ⇒ provably stuck.
    const print = fingerprint(result)       // SHA-256 of failed categories + summary
    if (print === lastPrint) {
      state.append({ feature, type: 'wave-failed', actor: whoami(), ts: now(),
                     data: { wave: wave.n, reason: 'doom-loop' } })
      throw new Error(`Wave ${wave.n}: identical failure twice — aborting`)
    }
    lastPrint = print

    const { action } = resolveOutcome('implement', result.outcome)  // ← the matrix, not prose
    switch (action) {
      case 'advance':
        state.append({ feature, type: 'wave-complete', actor: whoami(), ts: now(),
                       data: { wave: wave.n } })
        return result
      case 'retry':
      case 'revision':
        continue                            // loop; budget enforced inside resolveOutcome
      case 'abort':
      case 'surface':
        state.append({ feature, type: 'wave-failed', actor: whoami(), ts: now(),
                       data: { wave: wave.n, action } })
        throw new Error(`Wave ${wave.n}: ${action} per stop-condition matrix`)
    }
  }
})

// ── DET post-checks: existing bash guardrails (asset b), called by path, unchanged ──
sh('scripts/check-scope.sh',          feature)     // exit code = pass/fail
sh('scripts/check-tests-present.sh',  feature)
sh('scripts/open-pr.sh',              feature)
state.append({ feature, type: 'pr-opened', actor: whoami(), ts: now() })
```

What is deliberately *absent*: no `git`, no `jq`, no state file paths, no
string-parsing of a `Status:` line, and no hand-rolled retry arithmetic. The only
git left is inside the bash guardrails and behind the `git` state adapter; every
"what next" decision lives in the one tested matrix.

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
4. **The `(phase, outcome) → action` matrix** as `resolveOutcome()` plus its
   exhaustiveness test and the failure-fingerprint breaker — the deterministic
   heart of the wave loop (from Case).
5. **The event-log adapter is the target, not a someday-maybe** (see the hinge
   note below). Build it as the second `StateStore` implementation and flip the
   default once the git adapter has proven the spine end-to-end.

---

## On the git-coupling hinge (audit open question #1)

The audit parked the question *"are we married to git for state?"* This design's
answer, sharpened by prior art: **no — and the event log is where we are headed,
not merely where we could go.**

WorkOS Case is the strongest available data point. Facing the same choice, it does
**not** store run state on git branch tips or in git history at all — it keeps an
append-only event log under a **git-ignored `.case/<task-slug>/events/` directory**
and lets git hold only the output PR. A peer who pushed this furthest *decoupled
state from git entirely.* That is exactly our `eventlog` adapter, and it is the
direction our own portability priority (#4) already points.

So the two-port seam still does its job — ship on the `git` adapter for a
zero-migration drop-in — but we treat the **event-log adapter as the destination**
and the git adapter as the bootstrap that proves the harness before we cut state's
tie to the branch-tip/`Status:`-string model.

**One deliberate divergence from Case (settled — Decision 6):** Case *git-ignores*
its event log because it is single-operator and only the PR needs to travel. RAD
is a team tool (priority #1), so the event log is **git-tracked** — a committed,
per-feature `events.jsonl` on the work branch. We keep git as the cheap sync
*transport* (the whole team sees one board via push/pull) while moving the state
*model* into the log behind the port. That is the distinction that resolves the
hinge: we are not married to git as the *state cell*, but we still lean on git as
the *transport* until team scale justifies a SQLite/service adapter. The hinge is
no longer blocking *and* no longer genuinely open.

---

## Settled this round

- **State transport** — git-tracked, per-feature `events.jsonl` (Decision 6), not
  git-ignored like Case. Resolves the audit's "event-log adapter file format"
  open item.
- **Readability** — hard requirement; matrix + gate rules in declarative
  YAML/markdown the harness loads (Decision 5). Resolves audit open question #2.
- **State target** — event-log adapter is the destination; git adapter is the
  bootstrap (the hinge note above). Resolves audit open question #1.

## Open / deferred

- **Policy-adapter design for auto-approval** — the automation endgame; scoped
  only after the human-gated spine is proven.
- **Log compaction / ordering at scale** — a per-feature `events.jsonl` is fine
  for now; revisit compaction and a SQLite/service adapter only when team
  concurrency or a dashboard makes the git-tracked file the bottleneck.
- **Matrix/gate schema** — the exact YAML shape for `matrix.yaml` and `gates.yaml`
  (and their exhaustiveness/validation tests) — pinned down during the spine build.

---

## Prior art: WorkOS Case

**[WorkOS Case](https://github.com/workos/case)** ("the reliability layer for
agent-authored pull requests") is a production harness in the same species as RAD,
and it independently shipped the core of this design. It is the strongest
validation that the "third way" is real rather than speculative, and the source of
three refinements folded into this doc.

**What it validates (we were already aligned):**

- *"A deterministic TypeScript pipeline executor for phase transitions. The LLMs
  do the work inside each phase; TypeScript decides which phase runs next."* — the
  audit's thesis, in production.
- **Append-only event log + reducer.** `src/events/reducer.ts` folds events into
  state (`reduceEvents`), exactly our "state is a pure fold over `history()`."
- **Doc/state split (our Decision 2).** Case separates human intent (`task.md`)
  from machine state (`task.json`), and *regenerates* the machine file from the
  fold via `src/events/projections.ts` — status is a projection, never
  hand-edited.

**What we borrowed (the three refinements):**

1. **The stop-condition matrix** (`src/dag/outcome-table.ts` +
   `docs/failure-matrix.md`): every `(phase, outcome)` pair maps to one of
   `advance | retry | revision | abort | skip-to | surface`, exhaustiveness-tested
   with no default fallthrough. Promoted here from a footnote to the deterministic
   heart of the wave loop.
2. **Record-time transition validation** (`src/events/appender.ts` calls
   `validateTransition`, raising `LifecycleValidationError`): adopted as Decision 4
   — `append()` rejects illegal transitions before persisting.
3. **Failure fingerprinting** (SHA-256 of failed categories + summary) as a
   doom-loop breaker, replacing a fixed retry count.

**Where Case diverges — and what it tells us:**

- **State is not on git branch tips.** Case keeps the event log in a git-ignored
  `.case/` directory; git holds only the output PR. This is the empirical basis for
  treating our `eventlog` adapter as the destination (see the hinge note above).
- **Human approval between phases is an explicit non-goal.** Case leans
  fix-forward — mechanical evidence gates (`tested` / `reviewed` markers checked
  before a PR is opened) plus a retrospective learning loop — rather than a
  blocking human approval step. RAD deliberately keeps the `rad-approve` human gate
  (priority #1: no slop). Case is the far end of the same automation path our
  `gate()`-plus-policy-adapter design reaches toward: as enforced gates and
  evidence mature, the human gate can be relaxed *one gate at a time* without a
  rewrite. We are choosing a more gated point on that spectrum *today*, by design,
  not by limitation.

**Other Case ideas noted for later** (not yet adopted): `[enforced]` vs
`[advisory]` golden principles with literal check commands (turns prose
conventions into scriptable gates — a natural extension of `scripts/check-*.sh`);
profiles (`standard` vs `tiny`, skipping verification for trivial changes — a speed
lever); per-role model configuration; and the retrospective → escalate-to-docs/
playbooks/enforcement loop (a more developed form of RAD's `findings.jsonl` +
`/rad-insights`).
