# Research: Wave-Lifecycle Hooks for the Deliver Spine
Created: 2026-06-15
Author: architect
Status: pending-design
Source: inline (Strands harness-sdk comparison — strands-agents/harness-sdk)

## Project Summary
Add deterministic, operator-supplied lifecycle **hooks** to the RAD deliver
spine: named extension points where an operator hangs a deterministic script
(lint, guardrail, trace emitter) at known moments in the wave loop. The
*taxonomy* is borrowed from Strands harness-sdk's hook model; the *mechanism* is
not — RAD hooks are deterministic scripts, never model-driven steering or in-loop
self-correction. Purely additive and backward-compatible: absent any registered
hook, the spine behaves exactly as it does today.

## Key Requirements
- Expose lifecycle extension points anchored to **real** spine call sites (see map).
- Lay out the central design decision — **observe-only vs observe+veto** — with
  trade-offs. Do NOT pre-decide; this is `/rad-design`'s call.
- De-duplicate against existing mechanisms (events.jsonl, lint-plan.sh, post-checks);
  ship only what is genuinely net-new.
- Configuration surface consistent with RAD's env-driven, config-file-free style.
- Fold-in: record the stop-condition vocabulary review as a decision-on-the-record.

## Domains

| Domain | Description | Sensitivity |
|--------|-------------|-------------|
| Deliver spine | `harness/spine.js` — the wave loop; where hooks fire | architect-only |
| Wave contract | `harness/adapters/agent/contract.js` — agent boundary, task opacity | architect-only |
| Stop-condition matrix | `harness/matrix.js` + `matrix.yaml` — outcome→action policy | architect-only |
| Event log | `events.jsonl` writer — existing observability spine | architect-only |
| Config surface | env vars / hooks dir / CLAUDE.md RAD Configuration block | open |

> Whole-spine work touching the matrix and gate flow is **architect-only** — it
> sits on the determinism boundary that is the framework's core invariant
> (see issue #13, harness-substrate-direction).

## Lifecycle Extension Points (grounded in the spine)

Source map from a read-only exploration of `harness/spine.js`,
`harness/adapters/agent/contract.js`, `harness/matrix.js`, `matrix.yaml`.

| Hook point | Anchor (file:line) | Fires |
|------------|--------------------|-------|
| `pre-wave` | before `await runWave(wave)` — `spine.js:138` | before a wave attempt runs |
| `post-wave` | after `result` captured, before per-wave gate — `spine.js:145` | wave returned, outcome not yet gated |
| `on-outcome` | after `resolveOutcome('implement', …)`, before action dispatch — `spine.js:183–185` | matrix action resolved, not yet acted on |
| `on-retry` | retry/revision branch — `spine.js:197–220` | a wave is about to be re-run (also where the doom-loop breaker lives) |
| `on-error` | `wave-failed` emit sites — `spine.js:116, 204, 223, 241` | a terminal/abort/surface failure is recorded |
| `wave-complete` | existing emit site — `spine.js:186–192` | a wave advanced |

### Dropped: `pre-task` / `post-task` — infeasible spine-side (decision)
Tasks live **entirely inside** the agent's single `runWave` call (`spine.js:138`).
The spine only ever sees the aggregate `outcome` string + parsed `tasks` metadata
returned via the WAVE_RESULT block (`contract.js` `parseWaveResult` →
`resultToOutcome`). There is no spine-side seam at task granularity. Per-task
hooks would require either changing the agent/wave protocol or a second model call
per task — both out of scope and boundary-crossing. **Taxonomy is wave- and
outcome-level only.**

## Central Design Decision (for /rad-design — do NOT pre-decide)

**Observe-only vs Observe+veto.**

- **Observe-only** — a hook receives the lifecycle context and may log / trace /
  append to `events.jsonl`, but **cannot** change control flow. The spine ignores
  the hook's exit status for routing. Safest; a pure extension of the observability
  spine; zero interaction with `resolveOutcome`.
- **Observe+veto** — a hook may *additionally* emit a matrix outcome (e.g.
  `fail-scope`), acting as a deterministic guardrail that can fail a wave. This
  means a hook can feed the `implement` phase of `matrix.yaml` and reroute via
  `resolveOutcome` (abort/revision/surface). More power; introduces a new authority
  that can change delivery routing, so it must (a) be constrained to the fixed
  outcome vocabulary, and (b) record its veto in `events.jsonl` with provenance.

Trade-off axes design must weigh: routing authority vs blast radius; whether a
veto outcome is distinguishable in the matrix from an agent-emitted one;
idempotency/ordering when multiple hooks fire at one point; failure semantics of
the hook script itself (a crashing observe-only hook must not fail the wave; a
crashing veto hook — fail-closed or fail-open?).

## Relationship to Existing Mechanisms (avoid duplication)

| Existing | What it already does | Net-new for hooks |
|----------|----------------------|-------------------|
| `events.jsonl` | Emits `deliver-started`, `wave-attempt`, `wave-complete`, `wave-failed`, `pr-opened` | Hooks could *consume* these or add operator-defined events; the writer is the integration point, not a competitor |
| `scripts/lint-plan.sh` | **Plan-stage** advisory lint (structure/AC/budget); standalone, not spine-invoked | Hooks are **deliver-stage**; no overlap — different lifecycle phase |
| Post-checks (`check-scope.sh`, `open-pr.sh`) | Run once at end of wave loop (`spine.js:254–259`); already halt on non-zero | A `pre-post-check` seam could generalize this, but post-checks already exist — design should decide whether hooks *subsume* or *complement* them |
| Per-wave gate (`check-tests.sh`) | Runs after each advancing wave; demotes outcome to `fail-tests` on failure (`spine.js:148`) | This is effectively a **hard-coded observe+veto hook already**. Strong prior art for the veto model — design should reconcile the hook system with it rather than duplicate it |

> Notable: the per-wave `check-tests.sh` gate is already a built-in veto. The hooks
> feature partly **generalizes a pattern the spine already hard-codes**. This is the
> strongest argument that observe+veto is natural here — and that hooks should not
> reinvent what the gate does.

## Configuration Surface (options for /rad-design)

Must match RAD's existing env-driven, config-file-free adapter selection
(`RAD_AGENT`, `RAD_AGENT_CMD`, `RAD_WORKTREE`, `RAD_HIGH_RISK_PATTERNS`).

- **A. Convention dir** — `scripts/hooks/<point>.sh` (e.g. `pre-wave.sh`);
  present-and-executable ⇒ runs. Zero config; discoverable; matches the
  `scripts/` post-check pattern. Recommended starting point.
- **B. Env registration** — `RAD_HOOK_PRE_WAVE=<path>` etc. Explicit, opt-in,
  consistent with the env knobs, but verbose across six points.
- **C. CLAUDE.md RAD Configuration block** — a `### Hooks` section listing point→script.
  Visible/reviewable, but reintroduces a config-file loader the framework has
  deliberately avoided.

Design should also settle: hook invocation contract (what context is passed —
argv? env? stdin JSON?), exit-code semantics, and the per-point vs global ordering.

## Fold-in Decision: Stop-Condition Vocabulary — KEEP AS-IS

Reviewed the matrix outcome set: `success | fail-tests | fail-scope |
fail-protocol | fail-timeout | no-changes | abort-user`. **Recommendation: keep
the 7-outcome set unchanged.** Rationale for rejecting candidate additions, on the
record:

- **`fail-build`** (compile/typecheck distinct from test failure) — would resolve
  to the **same action** as `fail-tests` (`revision`). A distinct outcome that maps
  to an identical action earns no routing value and violates the "ship no row no
  code path needs" principle in `matrix.yaml`. Rejected.
- **`partial`** (some tasks pass, some fail in a wave) — already represented: the
  wave-level roll-up reduces mixed task statuses to a single `failed`/outcome via
  `resultToOutcome`. A `partial` outcome would have no distinct action and would
  duplicate the existing roll-up. Rejected.

This is a decision-on-the-record, **not an increment** — no matrix change ships
from this research.

## Constraints
- Hooks are **deterministic operator scripts** — no model-driven steering, no
  in-loop self-correction (hard line from issue #13 / harness-substrate-direction).
- Backward-compatible: no registered hook ⇒ today's behavior, byte-for-byte.
- Honors the existing wave contract (`docs/rad-wave-contract.md`) and the fixed
  matrix vocabulary — a veto hook may only emit a string already in the set.
- Out of scope: multi-provider `command`-adapter cookbook (#1) — separate branch.

## Open Questions
- Observe-only vs observe+veto (the central decision above) — for `/rad-design`.
- Does the hooks system **subsume** the hard-coded `check-tests.sh` per-wave gate
  and the end-of-loop post-checks, or sit alongside them?
- Config surface A/B/C and the hook invocation contract (argv vs env vs stdin).
- Hook failure semantics: fail-open vs fail-closed, per hook class.
- Ordering/idempotency when multiple scripts register at one point.

## Team

architect: sean@torchcodelab.com
developers: none
designers: none

## Platform

platform: github
default_branch: main
