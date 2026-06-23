# Plan: Portable / Semi-Centralized Process Memory
Created: 2026-06-23
Author: architect
Status: complete
Completed-At: 2026-06-23T17:55:00Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-06-23T17:45:45.858Z
Recorded-By: sean@torchcodelab.com
Branch: rad/portable-process-memory

## Context
RAD's hard process state already lives in git-tracked append-only event logs
(`.agents/state/<feature>/events.jsonl`), folded by a pure gate (`harness/gates.js`).
But sync is undisciplined: work strands on one machine when a `rad/` branch or its
events never get pushed. This plan makes that state reliably portable by folding plain-git
sync into the state-mutating verbs, adding handoff ownership events, and refusing to fold
a diverged branch tip — all without touching the purity of `evaluateGate`.

## Scope
| In scope | Out of scope |
|---|---|
| Plain-git push-on-write + fetch-tip-on-read folded into `rad approve`/`deliver` | Host-API (gh/glab) calls — the mirror/display layer stays untouched |
| `owner-claimed`/`owner-released` data-only events as a branch-level lock | New wave outcomes/phases or matrix vocabulary |
| Fail-closed divergence tripwire on the write path | Auto-merge / CRDT reconciliation of diverged tips |
| `RAD_SYNC` opt-in config surface (env + docs) | The soft user-following recall store (separate feature) |

## Acceptance Criteria
<!-- Numbered, testable outcomes. Every Wave task's Validate: field must cite one. -->
1. With `RAD_SYNC` enabled, a state-mutating verb (`rad approve`/`deliver`) pushes the
   work-branch tip to `origin` via **plain git only** (no gh/glab); a push failure
   (e.g. offline) is best-effort and never blocks or fails the local operation.
2. With `RAD_SYNC` enabled, a gate-read fetches the work-branch tip before folding, so an
   approval recorded on another machine is honored without a manual pull.
3. `owner-claimed`/`owner-released` events append with write-time-frozen provenance and
   fold as a branch-level lock; `evaluateGate` stays a pure fold with **no new
   special-case branches and no network inside the fold**.
4. On a diverged branch tip, a write verb **refuses to fold the gate** and surfaces the
   conflicting holder (fail-closed); a clean (non-diverged) tip proceeds unchanged.
5. `RAD_SYNC` is opt-in and documented; **unset reproduces today's behavior
   byte-for-byte** (no push, no fetch, no new events).

## Agent Scope
Research delegated to a single Explore sub-agent (architect role). Feature domains map to
the architect-only agents `sync-transport-orchestrator`/`sync-surface-mapper` (transport)
and `event-fold-orchestrator`/`event-fold-mapper` (fold). No out-of-scope agents required.

## Files in Scope
<!-- Lines must be a range or a single number. Linter sums these for context budget. -->
| File | Lines | Change |
|------|-------|--------|
| scripts/git-sync.sh | 1-70 | NEW plain-git transport helper: best-effort push of the branch tip; fetch of the work-branch tip; offline-fail-safe (always exits 0 on push failure, signals divergence on fetch) |
| harness/events.js | 15-29 | Add `owner-claimed`/`owner-released` to the Event typedef as data-only events (no new phase routing) |
| .env.example | 1-52 | Add `RAD_SYNC` opt-in block (default OFF) mirroring the existing `RAD_WORKTREE`/`RAD_TOKEN_BUDGET` convention |
| CLAUDE.md | 200-237 | Document `RAD_SYNC` under `### RAD Configuration` (opt-in, plain-git-only, offline-fail-safe, unset = today's behavior) |
| harness/adapters/git-state-store.js | 228-255, 343-427 | After a successful `append`/`recordApproval`, invoke the transport helper to push best-effort (gated by `RAD_SYNC`); add `recordOwnerClaimed`/`recordOwnerReleased` writers freezing provenance once at write-time |
| scripts/check-plan-approved.sh | 47-69 | Before resolving events from the branch tip, fetch the tip (gated by `RAD_SYNC`); reuse the existing platform-agnostic `git show origin/<branch>` idiom |
| scripts/checkout-plan.sh | 40-54 | Divergence tripwire: when local tip ≠ `origin` tip on a write path, refuse and surface the conflicting holder instead of `pull --ff-only` failing opaquely |
| harness/cli.js | 307-349, 627-798 | Wire sync into `approveCommand`/`deliverCommand` (push after record, fetch before gate-read); add `owner-claim`/`owner-release` subcommands; surface divergence refusal to the user |
| harness/test/portable-process-memory.test.js | 1-1 | NEW test file (project convention is `harness/test/`, not `__tests__/`) — covers AC#1–5 |
| .agents/research/portable-process-memory.md | 1-1 | Research artifact (`/rad-research` output) shipping with the feature |
| .agents/architecture/portable-process-memory.md | 1-1 | Architecture artifact (`/rad-design` output) shipping with the feature |
| .claude/agents/portable-memory-parent-orchestrator.md | 1-1 | Generated agent definition for this feature |
| .claude/agents/sync-transport-orchestrator.md | 1-1 | Generated agent definition for this feature |
| .claude/agents/sync-surface-mapper.md | 1-1 | Generated agent definition for this feature |
| .claude/agents/event-fold-orchestrator.md | 1-1 | Generated agent definition for this feature |
| .claude/agents/event-fold-mapper.md | 1-1 | Generated agent definition for this feature |

## Execution Notes

### Do Not Touch
- harness/gates.js — `evaluateGate` MUST stay a pure fold; no network, no special-case branches (AC#3).
- harness/matrix.yaml, harness/matrix.js — frozen outcome vocabulary; sync adds no outcomes.
- harness/spine.js — wave control flow; sync hooks attach at the cli.js boundary, never inline in the spine.
- harness/transitions.js — record-time validation; ownership events flow through `validateTransition` as data-only, no new rules.

### Key Files
- harness/adapters/git-state-store.js — the append + recordApproval write path; where push-on-write and the ownership writers attach.
- scripts/check-plan-approved.sh — documents the platform-agnostic `git show origin/<branch>` gate-read idiom to reuse for fetch-on-read.
- scripts/checkout-plan.sh — the shared fetch/checkout/ff-only idiom; the divergence tripwire extends its existing "fail loudly on divergence" behavior.

### Reminders
- Plain git only on the sync path — never call `scripts/detect-platform.sh` or gh/glab synchronously.
- Inherit the user's existing git credentials; never prompt for or store credentials.
- Feature/branch interpolation must pass the existing `isSafeFeature` regex before any shell use.
- `RAD_SYNC` unset must short-circuit every new code path (AC#5) — guard at the top of each hook.

## Wave Plan

### Wave 1 — parallel
Tasks in this wave can run in parallel (independent foundations).

#### Task 1.1: Plain-git transport helper
File: scripts/git-sync.sh:1-70
What: New script with two subcommands — `push <branch>` (best-effort `git push`; exit 0 even on failure, emit a warning) and `fetch-tip <branch>` (fetch the work-branch tip, report divergence via exit code/stdout). Plain git only; inherits user credentials; offline-fail-safe.
Validate: AC#1 — push failure exits 0 and never blocks; helper uses only `git`, no gh/glab.

#### Task 1.2: RAD_SYNC config surface
File: .env.example:1-52
What: Add an opt-in `RAD_SYNC` block (default OFF) following the `RAD_WORKTREE`/`RAD_TOKEN_BUDGET` doc convention; note plain-git-only and offline-fail-safe semantics.
Validate: AC#5 — config is opt-in; documented default reproduces today's behavior.

#### Task 1.3: Ownership event types
File: harness/events.js:15-29
What: Add `owner-claimed`/`owner-released` to the Event typedef as data-only events (provenance carried in `event.data`, no new phase in `PHASE_BY_TYPE`, no routing into `resolveOutcome`).
Validate: AC#3 — ownership events exist as data-only history entries; the fold is unaffected.

### Wave 2 — sequential
Depends on: Wave 1 complete (transport helper + config + event types exist)

#### Task 2.1: Push-on-write
File: harness/adapters/git-state-store.js:228-255
What: After a successful `append`/`recordApproval`, invoke `git-sync.sh push` (gated by `RAD_SYNC`) so `rad approve`/`deliver` publish the tip best-effort; surface the call at the `harness/cli.js` `approveCommand`/`deliverCommand` boundary (627-798), never in the fold.
Validate: AC#1 — an approve with `RAD_SYNC` on pushes the tip; offline push does not fail the verb.

#### Task 2.2: Fetch-tip-on-read
File: scripts/check-plan-approved.sh:47-69
What: Before resolving events from the branch tip in the gate-read, fetch the tip (gated by `RAD_SYNC`) reusing the platform-agnostic `git show origin/<branch>` idiom, so a remote approval is honored; invoked from the `harness/cli.js` gate-read path (307-349).
Validate: AC#2 — a gate-read after enabling sync honors an approval recorded on another machine.

### Wave 3 — sequential
Depends on: Wave 2 complete (sync wiring in place)

#### Task 3.1: Ownership claim/release + lock fold
File: harness/adapters/git-state-store.js:343-427
What: Add `recordOwnerClaimed`/`recordOwnerReleased` writers (freeze provenance once at write-time, mirroring `recordApproval`); expose `owner-claim`/`owner-release` subcommands at the `harness/cli.js` boundary (627-798) treating the branch as a single-writer lock — without adding branches to `evaluateGate`.
Validate: AC#3 — claim/release fold as a lock with frozen provenance; `evaluateGate` stays pure.

#### Task 3.2: Fail-closed divergence tripwire
File: scripts/checkout-plan.sh:40-54
What: On a write path, when the local tip ≠ `origin` tip, refuse the operation and surface the conflicting holder (from the latest `owner-claimed`) instead of an opaque `pull --ff-only` failure. A clean tip proceeds unchanged.
Validate: AC#4 — diverged tip refuses and names the holder; non-diverged tip proceeds.

### Wave 4 — sequential
Depends on: Wave 3 complete

#### Task 4.1: Test coverage
File: harness/test/portable-process-memory.test.js:1-1
What: Add tests for the five ACs (push best-effort/offline, fetch-on-read honors remote approval, ownership lock fold + `evaluateGate` purity, divergence refusal surfaces holder, `RAD_SYNC` unset = byte-for-byte today). Match the existing harness test layout/runner.
Validate: AC#1, AC#2, AC#3, AC#4, AC#5 — each AC has at least one passing test.

## Tests to Write
- [ ] Push is best-effort: simulated offline push fails but the verb still succeeds — harness/test/portable-process-memory.test.js
- [ ] Fetch-on-read honors a remote-recorded approval — harness/test/portable-process-memory.test.js
- [ ] `owner-claimed`/`owner-released` fold as a lock; `evaluateGate` output unchanged (purity) — harness/test/portable-process-memory.test.js
- [ ] Divergence tripwire refuses a write and surfaces the holder — harness/test/portable-process-memory.test.js
- [ ] `RAD_SYNC` unset → no push, no fetch, no new events (byte-for-byte) — harness/test/portable-process-memory.test.js

## Non-Goals
- No host-API (gh/glab) calls on the sync path — plain git only; the mirror/display layer is untouched.
- No auto-merge, CRDT, or concurrent multi-writer reconciliation of a diverged tip — divergence is a fail-closed tripwire only.
- No changes to the gate fold, matrix vocabulary, or wave-spine control flow.
- No soft/recall memory store or procedural counters — that is a separate feature.

## Out-of-Scope Dependencies
None — all touched surfaces are within the architect-only agent scope for this feature.

## Risks
- **Fold purity regression:** wiring sync near the gate risks leaking network into `evaluateGate`. Mitigation: all sync attaches at the cli.js/script boundary; `harness/gates.js` is in Do Not Touch (AC#3).
- **Backward-compat regression:** a missed `RAD_SYNC` guard could change default behavior. Mitigation: AC#5 byte-for-byte test; guard at the top of every new hook.
- **Offline false-failure:** a push error must never surface as a verb failure. Mitigation: helper exits 0 on push failure (AC#1); covered by test.
- **Credential surprise:** relying on inherited git credentials means clear messaging when absent; v1 scopes only error-messaging, not credential management.

## Session Notes

- 2026-06-23: Full cycle research→design→plan→approve→deliver in one session. Delivered all 4 waves (8 tasks) + tests. ACs covered: AC#1 (push best-effort/offline), AC#2 (fetch-on-read honors remote approval), AC#3 (ownership lock fold + evaluateGate purity), AC#4 (fail-closed divergence tripwire), AC#5 (RAD_SYNC unset = byte-for-byte) — all 5 covered, none deferred. Concerns: none (all tasks `complete`). Invariants held: `harness/gates.js` untouched; matrix/spine/transitions untouched; 186/186 tests green. Deliver-time fixups: corrected test dir convention (`harness/test/`, not `__tests__/`) and declared `/rad-design` artifacts in Files-in-Scope (check-scope only auto-allows .agents/{logs,plans,state}). Deferred to v2 (Non-Goals): soft user-following recall store + Elastic-style procedural counters; stale-lock release policy (timeout/force-claim); on-by-default sync. Next: architect review + merge of PR #43.
