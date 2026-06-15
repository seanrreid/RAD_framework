# Plan: Wave-Lifecycle Hooks for the Deliver Spine
Created: 2026-06-15
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-06-15T19:09:35.886Z
Branch: rad/wave-lifecycle-hooks

## Context
The deliver spine (`harness/spine.js`, `deliverSpine` lines 58–264) runs the wave
loop with one hard-coded operator extension point: the per-wave `check-tests.sh`
gate (line ~148) that demotes a `success` outcome to `fail-tests`. There is no
general way for an operator to observe or guard wave lifecycle moments. This plan
adds a deterministic **hook runner** that fires operator-supplied scripts at six
wave/outcome-level lifecycle points, generalizing the existing per-wave veto
rather than duplicating it. Hooks are plain scripts — never model-driven steering.
Backward-compatible: with no `scripts/hooks/` dir, the spine behaves byte-for-byte
as today.

## Scope
| In scope | Out of scope |
|---|---|
| New `harness/hook-runner.js` (discovery, invocation, observe/veto execution) | Per-task hooks (tasks are opaque inside the single `runWave` call) |
| Wiring 6 lifecycle points into `deliverSpine` | Any change to `matrix.yaml` vocabulary (reuses the existing 7 outcomes) |
| observe (fail-open) + veto (fail-closed) execution with events.jsonl provenance | Modifying the wave prompt / `buildWavePrompt` (hooks are post-wave, not pre-wave manipulation) |
| `scripts/hooks/` convention-dir config surface + invocation contract | Multi-provider `command`-adapter cookbook (#1, separate branch) |
| New hook event types + operator docs | Model-driven steering / in-loop self-correction (forbidden) |

## Acceptance Criteria
1. With no `scripts/hooks/` dir present, `deliverSpine` produces an identical
   event sequence to today (backward-compatibility snapshot).
2. An executable **observe** hook runs at its lifecycle point and emits a
   `hook-observed` event; its non-zero exit or crash emits `hook-failed` but never
   changes wave flow (observe = fail-open).
3. An executable **veto** hook at `post-wave` emits a fixed-vocabulary outcome on
   stdout that replaces the wave outcome and reroutes via the existing
   `resolveOutcome('implement', …)`; a `pre-wave` veto aborts before `runWave`.
4. A veto hook that crashes, exits non-zero without a token, or prints a token not
   in the fixed vocabulary is treated **fail-closed** (the wave aborts via a fixed
   outcome) — never silently allowed.
5. A veto-originated outcome is recorded in `events.jsonl` with hook provenance
   (`source`/`point`/hook name), distinguishable from an agent-emitted outcome.
6. Hooks within a point run in deterministic lexical filename order; the first
   veto short-circuits the remaining hooks at that point.
7. `harness/matrix.yaml` is unchanged — veto uses only the existing 7-outcome
   vocabulary; an unknown (phase, outcome) still throws (no new matrix rows).
8. The config surface (`scripts/hooks/<point>/`, optional `RAD_HOOKS_DIR`) and the
   invocation contract (argv/env/stdout/exit codes, ordering, fail-open vs
   fail-closed) are documented.

## Agent Scope
Architect-only feature (whole-spine, determinism boundary). Agents consulted:
- `spine-integration-orchestrator` → `spine-mapper` — spine + matrix call sites.
- `hook-runtime-orchestrator` → `hook-surface-mapper` — event writer, post-check
  pattern, config surface.

No out-of-scope dependencies — all target files are within architect scope.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/hook-runner.js | 1-170 | NEW — discovery in `scripts/hooks/<point>/`, argv/env/stdout invocation via injected `sh`, observe/veto classification, fail-open/fail-closed semantics; injectable for tests |
| harness/spine.js | 130-260 | Inject `runHooks` (default no-op) and fire it at the 6 lifecycle points; route a `post-wave`/`pre-wave` veto outcome through `resolveOutcome`; emit hook events |
| harness/events.js | 16-73 | Add `hook-observed`, `hook-veto`, `hook-failed` to the Event typedef + `PHASE_BY_TYPE` |
| harness/adapters/git-state-store.js | 227-260 | Permit the new hook event types in `append()` shape/transition validation |
| harness/test/hook-runner.test.js | 1-180 | NEW — unit tests: discovery order, observe fail-open, veto fail-closed, vocabulary validation, provenance |
| harness/test/spine.test.js | 560-710 | Extend — hooks fire per point; veto reroute; backward-compat (no-dir) event-sequence snapshot |
| scripts/hooks/README.md | 1-120 | NEW — convention dir, 6 points, observe vs veto, invocation contract, ordering, fail semantics, `.sample` example hooks |
| CLAUDE.md | 230-250 | Add `### Wave-Lifecycle Hooks` under RAD Configuration |

## Execution Notes

### Do Not Touch
- `harness/matrix.yaml` — vocabulary is frozen (AC#7); veto reuses existing outcomes.
- `harness/adapters/agent/contract.js` — the wave prompt contract; hooks are
  post-wave observation/veto, never pre-wave prompt manipulation.

### Key Files
- `harness/spine.js` — `deliverSpine` lines 58–264; the wave loop and all insertion points.
- `harness/events.js` — pure event model + `PHASE_BY_TYPE` fold (lines 16–73).
- `harness/adapters/git-state-store.js` — `append()` (227–248) is the only event mutation.
- `harness/matrix.js` — `resolveOutcome(phase, outcome, matrix)` (54–69); veto outcomes flow through it unchanged.
- `scripts/check-tests.sh` — the existing per-wave veto; the pattern the runner generalizes (argv `$1`=feature, exit 0=pass/non-zero=fail).
- `harness/cli.js` — env-knob convention (`RAD_TOKEN_BUDGET` ~400, `RAD_WORKTREE` ~409) for `RAD_HOOKS_DIR`.

### Reminders
- The default injected `runHooks` MUST be a no-op when `scripts/hooks/` is absent —
  AC#1 (byte-for-byte) is the backward-compat guard; assert it with an event snapshot.
- Veto outcomes must be validated against the fixed vocabulary BEFORE reaching
  `resolveOutcome` — an unknown outcome would throw in the matrix; catch upstream
  and treat fail-closed (AC#4), do not let it crash the spine.
- First-veto-wins: short-circuit remaining hooks at a point once one vetoes (AC#6).
- Hooks run via the injected `sh` helper (like `check-tests.sh`), never `child_process` directly — keeps tests hermetic.

## Wave Plan

### Wave 1 — sequential
The runner is built and its event vocabulary registered before any spine wiring.

#### Task 1.1: Build the hook runner module
File: harness/hook-runner.js:1-170
What: Create a pure, injectable `createHookRunner({ sh, now, hooksDir })` returning
`runHooks(point, ctx)`. Discover executable scripts under `scripts/hooks/<point>/`
(absent dir → empty → no-op). Run them in lexical filename order via injected `sh`,
passing context as argv (`$1`=feature, `$2`=wave, `$3`=point, `$4`=current-outcome)
plus `RAD_HOOK_*` env. Classify points: veto-capable = `pre-wave`, `post-wave`;
observe-only = `on-outcome`, `on-retry`, `on-error`, `wave-complete`. Read stdout
for a veto outcome token; validate against the fixed 7-outcome vocabulary.
Validate: AC#2, AC#3, AC#6 — observe/veto execution and lexical ordering.

#### Task 1.2: Register hook event types
File: harness/events.js:16-73, harness/adapters/git-state-store.js:227-260
What: Add `hook-observed`, `hook-veto`, `hook-failed` to the Event typedef and
`PHASE_BY_TYPE`, and permit them in `append()` shape/transition validation. Define
the `data` shape carrying provenance (`point`, `hook`, `outcome`, `source:'hook'`).
Validate: AC#5 — provenance fields exist and persist through `append()`.

#### Task 1.3: Unit-test the runner
File: harness/test/hook-runner.test.js:1-180
What: `node:test` + `assert/strict`. Cover: absent dir → no-op; lexical order;
observe non-zero exit → `hook-failed`, flow unchanged (fail-open); veto token
replaces outcome; crash/empty/invalid token → fail-closed; provenance in emitted
events. Stub `sh` and `now` like `spine.test.js`.
Validate: AC#2, AC#4, AC#6 — runner semantics in isolation.

### Wave 2 — sequential
Depends on: Wave 1 complete

#### Task 2.1: Wire the runner into the spine (observe + emit)
File: harness/spine.js:130-260
What: Inject `runHooks` (default no-op). Fire it at: `pre-wave` (before `runWave`,
~138), `post-wave` (after result, before the per-wave gate, ~145), `on-outcome`
(after `resolveOutcome`, before dispatch, ~183), `on-retry` (retry/revision branch,
197–220), `on-error` (wave-failed emit sites, 222–236), `wave-complete` (177–194).
Emit `hook-observed`/`hook-failed`. Observe failures never alter flow.
Validate: AC#2 — hooks fire at each point and observe is fail-open.

#### Task 2.2: Deliver-start hook pre-flight
File: harness/spine.js:130-260
What: At deliver-start (near the `deliver-started` emit, line ~78), discover and
validate the hook dir once (scripts present + executable). An unreadable/invalid
hooks dir surfaces early rather than mid-wave. No-op when the dir is absent.
Validate: AC#1 — absent dir changes nothing; invalid dir surfaces deterministically.

#### Task 2.3: Spine integration + backward-compat tests
File: harness/test/spine.test.js:560-710
What: Extend with: hooks fire at all six points (fake `sh` records calls); and the
backward-compat snapshot — with no hooks dir, the appended event sequence is
byte-for-byte identical to the current happy-path test.
Validate: AC#1, AC#2 — integration and the no-regression snapshot.

### Wave 3 — sequential
Depends on: Wave 2 complete

#### Task 3.1: Veto path through resolveOutcome
File: harness/spine.js:130-260
What: When a `post-wave` veto returns a valid outcome token, replace the wave
outcome and route it through the existing `resolveOutcome('implement', outcome)` —
generalizing the `check-tests.sh` demotion. A `pre-wave` veto aborts before
`runWave`. Validate the token against the fixed vocabulary upstream of the matrix;
invalid/crash → fail-closed (abort). First-veto-wins short-circuit.
Validate: AC#3, AC#4, AC#7 — reroute via existing vocabulary; fail-closed; matrix untouched.

#### Task 3.2: Veto provenance in the event log
File: harness/spine.js:130-260
What: On a veto, append a `hook-veto` event and tag the resulting
`wave-attempt`/`wave-failed` data with `source:'hook'`, `point`, and hook name, so a
veto-originated outcome is distinguishable from an agent-emitted one.
Validate: AC#5 — provenance recorded and distinguishable.

#### Task 3.3: Veto-path tests
File: harness/test/spine.test.js:560-710
What: post-wave veto reroutes outcome; pre-wave veto aborts before `runWave` (assert
`runWave` not called); crash/invalid token → fail-closed abort; observe-only points
cannot veto (a token there is ignored, flow unchanged); provenance asserted.
Validate: AC#3, AC#4, AC#5 — veto behavior and safety.

### Wave 4 — sequential
Depends on: Wave 3 complete

#### Task 4.1: Convention-dir reference + sample hooks
File: scripts/hooks/README.md:1-120
What: Document the `scripts/hooks/<point>/` layout, the six points, observe vs
veto classification, the invocation contract (argv/env/stdout/exit codes), lexical
ordering + first-veto-wins, and fail-open (observe) vs fail-closed (veto). Include a
`.sample` observe hook and a `.sample` veto hook (non-executable, won't run).
Validate: AC#8 — config surface and contract documented.

#### Task 4.2: CLAUDE.md configuration block
File: CLAUDE.md:230-250
What: Add `### Wave-Lifecycle Hooks` under RAD Configuration: the convention dir,
`RAD_HOOKS_DIR` override, the six points, observe/veto + fail semantics, and the
backward-compat guarantee (absent dir = today's behavior). Cross-link
`scripts/hooks/README.md`.
Validate: AC#8 — operator-facing configuration documented.

## Tests to Write
- [ ] Runner: absent dir is a no-op — harness/test/hook-runner.test.js
- [ ] Runner: lexical order + first-veto-wins — harness/test/hook-runner.test.js
- [ ] Runner: observe non-zero exit → hook-failed, fail-open — harness/test/hook-runner.test.js
- [ ] Runner: veto crash/empty/invalid token → fail-closed — harness/test/hook-runner.test.js
- [ ] Runner: provenance fields in emitted events — harness/test/hook-runner.test.js
- [ ] Spine: backward-compat event-sequence snapshot (no hooks dir) — harness/test/spine.test.js
- [ ] Spine: hooks fire at all six lifecycle points — harness/test/spine.test.js
- [ ] Spine: post-wave veto reroutes via resolveOutcome — harness/test/spine.test.js
- [ ] Spine: pre-wave veto aborts before runWave — harness/test/spine.test.js
- [ ] Spine: veto provenance distinguishable from agent outcome — harness/test/spine.test.js

## Non-Goals
- Per-task hooks — tasks are opaque inside the single `runWave` call; not feasible spine-side.
- New matrix outcomes — the 7-outcome vocabulary is frozen; veto reuses it.
- Model-driven steering, in-loop self-correction, or any agent-intelligence behavior.
- A config-file loader — the convention dir + optional env override is the whole surface.
- Multi-provider command-adapter recipes (#1) — separate branch.

## Out-of-Scope Dependencies
None — all files are within architect scope.

## Risks
- **Backward-compat regression.** The no-op default path must be exact; AC#1's
  byte-for-byte event snapshot is the guard. Highest-priority test.
- **Veto reaching the matrix with an invalid outcome** would throw in
  `resolveOutcome`. Mitigation: validate the token upstream and treat unknown as
  fail-closed (AC#4) before the matrix lookup.
- **Context-budget warning expected.** Files-in-Scope sums above the 800-line
  advisory threshold — this is a foundational spine change touching runner, spine,
  events, store, tests, and docs. Reviewed and accepted; still well under the
  1500-line error bound.
- **Ordering determinism** depends on lexical filename sort; documented so operators
  can prefix with numbers (`10-`, `20-`) like `run-parts`.
