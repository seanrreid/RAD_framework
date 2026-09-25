# Plan: Wave-Attempt Durability
Created: 2026-09-25
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-09-25T19:37:07.139Z
Recorded-By: sean@torchcodelab.com
Branch: rad/wave-attempt-durability
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/119
Issue-Title: Record the wave attempt BEFORE running it: a crash mid-wave leaves no event, so resume re-runs blind and the dead attempt escapes the attempt and token budgets

## Context

`harness/spine.js` calls `runWave` and only appends `wave-attempt` after it
returns. A crash, kill, sleep or CI eviction during the agent run (up to the
deadline) leaves **no event**. Resume then re-runs the wave blind
(`priorFailure: null`), the dead attempt never counts toward `MAX_ATTEMPTS`, and
the lifetime token budget never sees it. The attempt loop (`for attempt = 1…`) and
the doom-loop fingerprint (`lastPrint`) are also purely in-memory and reset on
**every** run, so a crash loop, or an operator killing a run at minute 9 each time,
bypasses both breakers.

Research found two gaps the issue didn't mention. `wave-attempt` records neither
its `attempt` number nor the failure fingerprint, and the fingerprint's input (the
in-memory `gated` categories and summary) is never recorded. So today's logs can't
support seeding either one. This plan starts recording both, additively.

**Architect decisions (2026-09-25, recorded on #119):**
1. `wave-started` is appended **before** `runWave`. On resume, an orphan (a `wave-started` with no matching `wave-attempt`) converges **idempotently** into a synthetic `wave-attempt` with `outcome: 'fail-timeout'` and `reason: 'orphaned'`. The existing matrix routes it to `surface`: stop and hand to the operator.
2. Resume seeds the attempt counter and the doom-loop fingerprint from the log for **all** waves, counting attempts **since the wave's last terminal `wave-failed`**. A crash or kill carries over; a deliberate operator re-run after a terminal stop gets a fresh budget.
3. #67 is **not** a prerequisite. Instead, this plan carries a replay-style regression test: historical-shaped logs whose routing and gate decisions must be identical before and after.

## Scope

| In scope | Out of scope |
|---|---|
| Append `wave-started` before `runWave` (after pre-wave hooks pass) | Recovering the crashed agent's in-flight work or token spend |
| Record `attempt` and `fingerprint` on `wave-attempt` (additive keys) | Changing `fingerprint.js`'s hash, `matrix.yaml`, `gates.js` or `transitions.js` |
| Converge orphans on resume into `fail-timeout` routed to `surface`, idempotently | Attendedness-aware classification (#108) |
| Seed attempt count and `lastPrint` from attempts since the last terminal stop | Rebuilding a full `priorFailure` excerpt for a resumed first attempt |
| Pure read-side helpers in `events.js`; a replay-style regression test | #67's matrix and gates replay tooling |
| Update the docs' "byte-for-byte identical event sequence" claims | Changing any `/rad-insights` fold's result shape |

## Acceptance Criteria

1. The spine appends `wave-started {wave, attempt}` immediately before each `runWave` call, **after** the pre-wave hooks pass. A vetoed attempt appends no `wave-started`. `model` is included only when the wave declares one, and is absent otherwise.
2. Every new `wave-attempt` records `data.attempt` (its 1-based number within the wave). When the resolved action is `retry` or `revision`, it also records `data.fingerprint`, the same digest the doom-loop compares. The key is absent otherwise. Every other existing field is unchanged.
3. Two pure helpers are added to `harness/events.js`:
   - `findOrphanAttempts(history)` returns every `{wave, attempt}` whose `wave-started` has no later `wave-attempt` with the same wave and attempt. For legacy `wave-attempt`s without `data.attempt`, the attempt number is inferred by counting per wave.
   - `priorAttemptState(history, wave)` returns `{ attempts, lastPrint }` counted over that wave's attempts **since its last terminal `wave-failed`**. `lastPrint` is the fingerprint of the last such attempt if one was recorded, and `null` otherwise.

   Both return a well-defined empty result on `[]`, null or non-array input, and never throw.
4. On resume, each orphan is converged before the wave's attempt loop. The spine appends a synthetic `wave-attempt {wave, attempt, outcome:'fail-timeout', reason:'orphaned'}`, routes it through `resolveOutcome` (giving `surface`), and appends `wave-failed {wave, action:'surface', reason:'orphaned'}`, returning the existing matrix terminal. A second resume appends **no** second synthetic event.
5. On resume, a wave's attempt counter starts after the attempts recorded since its last terminal `wave-failed`, so a wave with 2 such attempts gets `MAX_ATTEMPTS - 2` more. `lastPrint` is seeded from `priorAttemptState`, so an identical failure fingerprint across a restart triggers the doom-loop stop. After a terminal stop, a re-run gets the full budget. Logs without `data.fingerprint` seed `lastPrint = null` and can never trip a doom-loop.
6. A new replay-style regression test uses committed historical-shaped fixture logs (approvals only; a legacy delivery without `attempt` or `fingerprint`; a hook veto; each matrix outcome). It asserts that `reduce`, `resumeFrom`, `evaluateGate('approved')` and `resolveOutcome` for every recorded outcome, plus `outcomeCounts` / `retryCounts` / `failReasonCounts`, produce the same values as committed literals captured **before** the spine change. It passes unchanged after.
7. The three spine tests that assert exact event-type sequences are updated deliberately to include `wave-started`, with commit-message rationale, and no other existing test's expectations change. CLAUDE.md and the docs no longer claim a byte-for-byte identical event sequence without noting `wave-started`. `docs/flue-vs-rad.md` records #119 as resolved. `npm test --prefix harness` and every `scripts/test-*.sh` pass.

## Agent Scope

No agents were called. Research was one Explore sub-agent (10 of 10 searches)
covering `spine.js` (resume, wave and attempt loops, hooks, record, matrix,
doom-loop, terminals), `fingerprint.js`, the `events.js` folds, `transitions.js`,
`matrix.yaml`, the resume, spine and cost tests, and every doc making the
byte-for-byte claim.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/events.js | 18-50 | JSDoc: `wave-started`; `attempt` / `fingerprint` / `reason:'orphaned'` keys |
| harness/events.js | 680-800 | `findOrphanAttempts`, `priorAttemptState` |
| harness/test/events.test.js | 890-1000 | Helper unit tests |
| harness/test/replay-regression.test.js | new | Replay-style before/after regression test |
| harness/test/fixtures/replay/historical.jsonl | new | Historical-shaped fixture log(s) |
| harness/spine.js | 260-650 | `wave-started`; record `attempt` / `fingerprint`; orphan convergence; seeding |
| harness/test/spine.test.js | 100-170 | Update two exact-sequence tests |
| harness/test/spine.test.js | 755-780 | Update the hooks-absent snapshot |
| harness/test/resume.test.js | 90-245 | Crash and re-run, idempotence, seeding, cross-run doom-loop, terminal reset |
| CLAUDE.md | 205-215 | Verify section: byte-for-byte claim notes `wave-started` |
| CLAUDE.md | 385-395 | Hooks section: same |
| docs/harness-and-framework.md | 155-165 | Hooks byte-for-byte claim |
| docs/flue-vs-rad.md | 75-115 | Record #119 resolved |
| docs/behavior-map-deliver-gate.md | 78-86 | Spine line anchors |
| docs/harness-state-store.md | 290-310 | Event vocabulary |

## Program Design

```js
// harness/events.js (pure, read-side)
/** @returns {Array<{wave:number, attempt:number}>} */
export function findOrphanAttempts(history)
/** @returns {{ attempts:number, lastPrint:string|null }} counted since the wave's last terminal wave-failed */
export function priorAttemptState(history, wave)
```

```
deliverSpine
  ├─ resume: completed = resumeFrom(history); spent = totalUsage(history)
  └─ for wave (not completed):
       ├─ token-budget check (unchanged)
       ├─ orphans = findOrphanAttempts(history).filter(o => o.wave === wave.n)
       │    └─ for each: append wave-attempt{wave, attempt, outcome:'fail-timeout', reason:'orphaned'}
       │                 resolveOutcome('implement','fail-timeout') → surface
       │                 append wave-failed{wave, action:'surface', reason:'orphaned'} → return (matrix terminal)
       ├─ { attempts, lastPrint } = priorAttemptState(history, wave.n)
       └─ for attempt = attempts+1 .. maxAttempts:
            ├─ pre-wave hooks (veto → unchanged path, no wave-started)
            ├─ append wave-started{wave, attempt[, model]}
            ├─ runWave(...)
            ├─ gates → append wave-attempt{…, attempt[, fingerprint when retry/revision]}
            └─ matrix → advance / retry+doom-loop (lastPrint seeded) / terminal
```

No files are moved or deleted. New: `harness/test/replay-regression.test.js` and a fixture log.

## Execution Notes

### Do Not Touch
- `harness/fingerprint.js`: its hash must stay stable so recorded fingerprints stay comparable.
- `harness/matrix.yaml`, `harness/matrix.js`: `fail-timeout → surface` already exists, so there's no new outcome or action.
- `harness/gates.js`, `harness/transitions.js`: no rule changes (research confirmed `wave-started` is legal in every non-terminal phase).
- The public result shapes of every existing `events.js` fold.
- `harness/adapters/**`, `scripts/**`.

### Key Files
- `harness/spine.js`: `MAX_ATTEMPTS`, `capturePriorFailure`, the resume and budget seed (`resumeFrom`, `totalUsage`, the precedent for seeding from the log), the wave loop (per-wave `lastPrint` / `priorFailure` reset), the attempt loop, the pre-wave hook, the `runWave` call, the `wave-attempt` append (with its optional-key spread pattern), the matrix, the retry / doom-loop path and the terminal `wave-failed` paths.
- `harness/fingerprint.js`: the digest function (read-only).
- `harness/events.js`: `PHASE_BY_TYPE` (keep `wave-started` out, following the audit-only precedent of `capture-failed`), `resumeFrom`, the private pair collector, and the type JSDoc.
- `harness/test/resume.test.js`: `makeSeededState` (the append pushes into the seeded array, so a second `deliverSpine` sees the first run's events).
- `harness/test/spine.test.js`: the exact-sequence tests (~L105, ~L158) and the hooks-absent snapshot (~L765).

### Reminders
- **Terminal reset:** count only attempts after the wave's last `wave-failed`. A crashed run never wrote one, so its attempts carry over.
- **Legacy logs:** a `wave-attempt` without `attempt` gets an inferred ordinal. Without `fingerprint`, `lastPrint` is null and no doom-loop is possible.
- Optional keys are spread, never set to `undefined`.
- **Write the replay-regression test and its literals first (Wave 1), against today's code**, so it's a genuine "before" baseline.
- A crashed attempt's token spend is unrecoverable. Document that the lifetime budget under-counts it.
- Grep `spine.test.js` for any deepEqual of a whole `wave-attempt` `data` object before adding keys. Such tests change only deliberately, with rationale.
- `harness/` is self-protected.

## Wave Plan

### Wave 1 — parallel
Verify: npm test --prefix harness

Read-side foundations. Both tasks run against today's spine.

#### Task 1.1: Orphan and prior-attempt helpers
File: harness/events.js:18-50, harness/events.js:680-800, harness/test/events.test.js:890-1000
What: Add `findOrphanAttempts(history)` and `priorAttemptState(history, wave)` as specified in AC#3. They are pure, return empty results on invalid input, and never throw. The attempt ordinal comes from `data.attempt` when present, otherwise from counting that wave's attempts in order. `priorAttemptState` counts only attempts after the wave's last `wave-failed`, and `lastPrint` is the last such attempt's `data.fingerprint` or `null`. Update the type JSDoc for `wave-started` and the new keys. Unit tests (inline histories, deepFreeze):
- an orphan found;
- a converged orphan (followed by a synthetic `wave-attempt`) no longer found, proving idempotence;
- legacy attempts with inferred ordinals;
- a terminal `wave-failed` resets the count;
- a fingerprint is picked up;
- legacy logs give a null `lastPrint`;
- invalid input.

Validate: AC#3 — `npm test --prefix harness` passes, including the new cases; no existing fold's values change.

#### Task 1.2: Replay-style regression baseline
File: harness/test/replay-regression.test.js, harness/test/fixtures/replay/historical.jsonl
What: Commit historical-shaped fixture logs: approvals only, a legacy delivery without `attempt` or `fingerprint` with retries and a terminal, a hook veto, and each matrix outcome. The test loads them and asserts that `reduce` (phase), `resumeFrom`, `evaluateGate('approved', …)`, `resolveOutcome('implement', outcome)` for every recorded `wave-attempt` outcome, and `outcomeCounts` / `retryCounts` / `failReasonCounts` equal **hand-written literals** computed from the fixture (each commented with its derivation). Use the real `loadMatrix()` / `loadGates()`. This test must pass on today's code and stay unchanged through Wave 2.
Validate: AC#6 (baseline half) — `npm test --prefix harness` passes with the new test.

### Wave 2 — sequential
Depends on: Wave 1 complete (the spine uses the helpers; the regression baseline is committed first)
Verify: npm test --prefix harness

#### Task 2.1: Record wave-started, attempt and fingerprint
File: harness/spine.js:260-650, harness/test/spine.test.js:100-170, harness/test/spine.test.js:755-780
What: Immediately before `runWave`, after the pre-wave hooks pass, append `wave-started {wave, attempt}`, plus `model` spread only when the wave declares one. Add `attempt` to every `wave-attempt`'s data. When the resolved action is `retry` or `revision`, add `fingerprint` (the digest already computed for the doom-loop comparison, so compute it before the append or restructure minimally). Update the three exact-sequence and snapshot tests (~L105, ~L158, ~L765) to include `wave-started`, and fix any whole-`data` deepEqual the new keys break, each deliberately with the rationale in the commit message. The replay-regression test must pass **unchanged**.
Validate: AC#1, AC#2, AC#7 (test half) — `npm test --prefix harness` passes; `git diff` of `replay-regression.test.js` and its fixtures is empty.

#### Task 2.2: Orphan convergence and resume seeding
File: harness/spine.js:260-650, harness/test/resume.test.js:90-245
What: Per wave, after the skip and token-budget checks, converge each orphan from `findOrphanAttempts` as in AC#4: append the synthetic `wave-attempt`, route it through `resolveOutcome` to `surface`, append `wave-failed {wave, action:'surface', reason:'orphaned'}`, and return the existing matrix terminal. Then seed the attempt counter start and `lastPrint` from `priorAttemptState` (AC#5). Resume tests using `makeSeededState`:
- `runWave` throws after `wave-started`; re-running converges exactly one orphan and surfaces;
- a third run appends no second synthetic event and, after the terminal stop, re-runs the wave with a fresh budget;
- a wave with 2 recorded attempts and no terminal gets `MAX_ATTEMPTS - 2` attempts;
- an identical recorded fingerprint plus the same failure after restart triggers the doom-loop stop;
- a legacy log without fingerprints never doom-loops on resume.

The replay-regression test must still pass unchanged.
Validate: AC#4, AC#5 — `npm test --prefix harness` passes, including the new resume cases; replay-regression unchanged.

### Wave 3 — sequential
Depends on: Wave 2 complete
Verify: npm test --prefix harness && for t in scripts/test-*.sh; do bash "$t" >/dev/null || exit 1; done

#### Task 3.1: Docs and claims
File: CLAUDE.md:205-215, CLAUDE.md:385-395, docs/harness-and-framework.md:155-165, docs/flue-vs-rad.md:75-115, docs/behavior-map-deliver-gate.md:78-86, docs/harness-state-store.md:290-310
What:
- **CLAUDE.md (Verify and Hooks sections) and `harness-and-framework.md`:** keep the "absent feature adds nothing" guarantee, but state that since #119 every run's sequence includes `wave-started` before each agent run, so the comparison is against a run of the same version.
- **`flue-vs-rad.md`:** record that #119 closed the gap (record-before-run, orphan converge-then-classify, budgets seeded across restarts), and note the one remaining limitation: a crashed attempt's token spend is unrecorded.
- **`behavior-map-deliver-gate.md`:** refresh the spine line anchors.
- **`harness-state-store.md`:** add `wave-started` and the `orphaned` reason to the event vocabulary.

Validate: AC#7 (docs half) — each claim updated; all tests pass.

## Tests to Write
- [ ] findOrphanAttempts and priorAttemptState cover orphans, idempotence, legacy ordinals, terminal reset and fingerprint seeding — harness/test/events.test.js
- [ ] historical-shaped logs produce identical routing, gate and fold decisions before and after — harness/test/replay-regression.test.js
- [ ] crash after wave-started converges one orphan, surfaces, and never duplicates; re-run after the stop gets a fresh budget — harness/test/resume.test.js
- [ ] seeded attempt counter and cross-restart doom-loop; legacy logs never doom-loop — harness/test/resume.test.js

## Non-Goals
- Recovering a crashed attempt's work or token usage.
- Attendedness-aware routing for orphans (#108): they always surface.
- Rebuilding a full `priorFailure` excerpt for the first attempt after a resume.
- Building #67's matrix and gates replay tooling.

## Out-of-Scope Dependencies
None. Every file is architect-writable.

## Risks
- **Every deliver's event sequence changes** (`wave-started`). It's additive, and every fold filters by exact type (confirmed). The "byte-for-byte" doc claims are reworded (AC#7), and the replay-regression test proves historical-shaped logs route identically.
- **Seeding changes resume behaviour.** A crash or kill no longer grants a fresh budget or clears the doom-loop. This is intended and closes the bypass. A deliberate re-run after a terminal stop still gets a full budget.
- **Orphan surfacing interrupts an unattended re-run after a crash** by design (decision 1). The operator re-runs, and the terminal stop resets the budget.
- **The synthetic orphan `wave-attempt` feeds the insights folds** (+1 retry, +1 `fail-timeout`, and the terminal outcome for that wave). That's accurate, since the attempt did happen. Its usage contributes 0, so the lifetime token budget under-counts crashed spend. This is documented.
- **Spine refactor risk** in the attempt loop. It's mitigated by the replay-regression test and the unchanged-expectations rule for every other test.

## Issue Gaps

- **`attempt` and `fingerprint` are recorded on `wave-attempt`.** #119 assumed it could match orphans by (wave, attempt) and seed the doom-loop, but today's `wave-attempt` records neither and the fingerprint input is never persisted. Both are added as additive keys; legacy logs infer ordinals and never doom-loop. *Verify: agree?*
- **`wave-started` goes after the pre-wave hooks pass.** A vetoed attempt never ran, so it records no `wave-started`. #119 didn't address hooks. *Verify: agree?*
- **The orphan's `wave-failed` carries `reason: 'orphaned'`.** Matrix-terminal `wave-failed` events normally have no `reason`. Adding it makes `failReasonCounts` report orphans instead of `unknown`. *Verify: agree?*
- **`wave-started` stays out of `PHASE_BY_TYPE`**, following the audit-only precedent. `deliver-started` already sets in-progress, so the fold is identical either way. *Verify: agree?*
- **Architect decisions 1–3 and the terminal-reset rule** are recorded on #119 (2026-09-25).
