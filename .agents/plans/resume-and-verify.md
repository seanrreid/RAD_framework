# Plan: Resume and Per-Wave Verify
Created: 2026-06-10
Author: architect
Status: pending-review
Branch: rad/resume-and-verify

## Context

Two robustness gaps in the deliver spine, both surfaced by the Harness Engineering
Guide review. (1) **No crash-resume:** `deliverSpine` always loops from the approval
gate and replays every wave from the top; the append-only `events.jsonl` already
records `wave-complete` events, but nothing folds them back into "wave 3 of 5 already
advanced," so a crash mid-deliver re-runs finished waves. (2) **Late verification:**
the post-checks (`check-scope`, `check-tests`, `open-pr`) run only **after all waves**,
so a regression introduced in wave 2 isn't caught until wave 5 finishes — the most
expensive failure mode in agentic delivery (late rework loops).

This plan adds a pure `resumeFrom` fold so re-running a deliver skips already-advanced
waves, and moves the test gate into the per-wave advance path so a regression is caught
at the wave that caused it. It is the `resume-and-verify` follow-on named in
`model-agnostic-wave-adapters`; it sequences **after** that plan so the spine is edited
once on top of the adapter interface. It coordinates with — but does not depend on —
Decision 2 (the resume fold reads wave-progress events, not the approval authority).

## Scope

| In scope | Out of scope |
|---|---|
| A pure `resumeFrom(history)` fold returning the set of already-advanced wave numbers | Changing the approval gate or Decision 2 (events.jsonl as sole *approval* authority) |
| `deliverSpine` skips already-advanced waves on re-run (idempotent resume) | The agent-adapter interface (delivered by `model-agnostic-wave-adapters`) |
| Per-wave `check-tests` gate: run after a wave advances, before the next wave starts | Token-usage / model-tiering / budget breaker (the `cost-frugality-layer` plan) |
| A single cumulative-state verification on resume before continuing (cost-aware) | Adding new matrix outcomes — reuse the existing `fail-tests` outcome |
| Keep `check-scope` + `open-pr` as end-of-deliver post-checks | Changing `gates`, `transitions`, or `fingerprint` policy |

## Acceptance Criteria
1. A pure `resumeFrom(history)` fold computes the set of already-advanced wave numbers
   from `wave-complete` events with no I/O and tolerates an empty/partial log.
2. On re-run for a feature with prior `wave-complete` events, `deliverSpine` skips those
   waves instead of replaying them; completed waves are not re-executed and their commits
   are not duplicated (idempotent resume).
3. A deliver that crashed mid-wave-3 resumes at wave 3 (waves 1–2 skipped) when re-run.
4. After a wave advances, the spine runs the test gate (`scripts/check-tests.sh` for the
   feature) before starting the next wave; a non-zero result is treated as the existing
   `fail-tests` outcome and re-enters the matrix for that wave (retry/revision), so a
   regression blocks at the wave that introduced it.
5. On resume, the spine runs the test gate **once** to verify cumulative prior work is
   green before executing the next wave — it does **not** re-run every completed wave's
   gate (cost-aware "verify, don't trust").
6. End-of-deliver post-checks still run `check-scope` and `open-pr`; `check-tests` moves
   into the per-wave path. Existing `spine`/`matrix` tests stay green; new tests cover
   resume idempotency and the per-wave gate.

## Agent Scope
Reuses this session's Explore research (covered `spine.js`, `events.js`, `matrix.yaml`,
and `check-tests.sh` invocation). No per-role agents; no out-of-scope agent dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/events.js | 100-139 | Add pure `resumeFrom(history)` fold (set of advanced wave numbers from `wave-complete` events); extend the reduce/projection without breaking the existing fold |
| harness/spine.js | 54-176 | Skip already-advanced waves via `resumeFrom`; run the per-wave `check-tests` gate after advance and map a non-zero result to `fail-tests`; run the cumulative verify once on resume; drop `check-tests` from the end `POST_CHECKS` (keep `check-scope`, `open-pr`) |
| harness/test/resume.test.js | 140 | New — `resumeFrom` fold unit tests + resume idempotency (crash after wave 2 → resume at 3, no duplicate commits/events) |
| harness/test/spine.test.js | 1-200 | Extend — per-wave gate blocks a wave-2 regression at wave 2; end post-checks still run scope + pr; resume cumulative-verify runs once |
| docs/wave-execution.md | append | Document resume semantics and the per-wave test gate |

## Execution Notes

### Do Not Touch
- harness/gates.js, harness/transitions.js, harness/fingerprint.js — pure, model-neutral; keep policy unchanged.
- harness/matrix.yaml / matrix.js — reuse the existing `fail-tests` outcome; do not add new outcomes.
- scripts/check-tests.sh / check-scope.sh — called via the injected `sh` boundary, never modified.

### Key Files
- harness/spine.js — the deliver loop; `POST_CHECKS`, the per-wave attempt loop, and the matrix dispatch are all here.
- harness/events.js — the event typedef + `reduce` fold; `resumeFrom` is a sibling fold over the same history.
- harness/test/spine.test.js — shows how `runWave`/`sh`/`state` are faked; mirror for resume + gate tests.

### Reminders
- Sequence after `model-agnostic-wave-adapters` so `spine.js` is edited once on top of the adapter interface.
- The resume fold must be a pure function of `history` — no clock, no I/O — so it stays deterministic and testable.
- The per-wave gate reuses the existing `fail-tests` outcome → existing matrix routing applies; no matrix edit.
- Resume verify is a single cumulative `check-tests`, not a per-completed-wave replay — keep it cheap.

## Wave Plan

### Wave 1 — sequential
Tasks must run in sequence (1.2 consumes 1.1's fold).

#### Task 1.1: Add the `resumeFrom` fold
File: harness/events.js:100-139
What: Add `resumeFrom(history) -> Set<number>` returning the wave numbers that have a
`wave-complete` event, as a pure fold over the existing log. Tolerate empty/partial history.
Validate: AC#1 — unit test: empty log → empty set; a log with `wave-complete` for waves
1–2 → `{1,2}`.

#### Task 1.2: Skip advanced waves in the spine
File: harness/spine.js:54-176
What: Before the wave loop, compute `resumeFrom(state.history(feature))`; `continue` past
any wave whose `n` is in the set without calling `runWave` or appending duplicate events.
Validate: AC#2, AC#3 — re-run after a mid-wave-3 crash resumes at wave 3; waves 1–2 are
not re-executed and produce no duplicate commits/events.

### Wave 2 — sequential
Depends on: Wave 1 complete.

#### Task 2.1: Per-wave test gate + resume verify
File: harness/spine.js:54-176
What: After a wave advances, run `sh('scripts/check-tests.sh', feature)`; a non-zero status
is handled as a `fail-tests` outcome that re-enters the matrix for that wave (retry/revision),
not an advance. On resume, run the gate once before the first executed wave to verify
cumulative prior work. Remove `check-tests` from the end `POST_CHECKS` (keep `check-scope`,
`open-pr`).
Validate: AC#4, AC#5, AC#6 — a failing wave-2 test gate blocks at wave 2; resume runs the
gate exactly once; end post-checks still run scope + pr.

### Wave 3 — sequential
Depends on: Wave 2 complete.

#### Task 3.1: Tests
File: harness/test/resume.test.js:1-140
What: Cover `resumeFrom` (empty / partial / full), resume idempotency (crash after wave 2 →
resume at 3, no duplicate commits/events), the per-wave gate blocking a wave-2 regression,
the single resume verify, and that end post-checks still run scope + pr. Confirm the existing
suite stays green.
Validate: AC#2, AC#4, AC#6 — `npm test` green across the full suite.

## Tests to Write
- [ ] `resumeFrom` empty/partial/full history → correct advanced-wave set — harness/test/resume.test.js
- [ ] resume idempotency: crash after wave 2 → resume at 3, no duplicate commits/events — harness/test/resume.test.js
- [ ] per-wave gate: failing wave-2 tests block at wave 2 (routes `fail-tests`) — harness/test/spine.test.js
- [ ] resume runs the cumulative verify exactly once — harness/test/spine.test.js
- [ ] end post-checks still run `check-scope` + `open-pr` after `check-tests` moves — harness/test/spine.test.js

## Non-Goals
- The crash-resume *step-API* (`rad next` / `rad record-wave`, host-owned loop) — this plan keeps `deliverSpine` in charge and only makes it resumable.
- Any cost/token instrumentation — that is the `cost-frugality-layer` plan.
- New matrix outcomes or event types beyond `resumeFrom`'s read of existing `wave-complete` events.

## Out-of-Scope Dependencies
Sequences after `model-agnostic-wave-adapters` (the adapter interface). No architect-only
agents required.

## Risks
- The resume fold must exactly match how `deliverSpine` defines "advanced" — if it keys off
  the wrong event type, a half-done wave could be skipped. Mitigation: AC#3 pins the
  crash-mid-wave-3 case with a test, and resume keys strictly off `wave-complete`.
- Moving `check-tests` into the per-wave path increases per-deliver test runs; the cost-aware
  single resume verify (AC#5) bounds this, and catching regressions early is net cost-positive.
