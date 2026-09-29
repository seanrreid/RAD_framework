# Plan: Deliver Stop Contract (typed terminals, needs-decision exit, between-wave checks)
Created: 2026-09-28
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-09-29T14:54:08.158Z
Recorded-By: sean@torchcodelab.com
Branch: rad/deliver-stop-contract
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/77, https://github.com/seanrreid/RAD_framework/issues/108
Issue-Title: Autonomous-mode stop contract (#77) + Attendedness as a dimension of the stop-condition matrix (#108)

## Context

#77 asks for a provider-neutral **stop contract** for deliver runs: completion worked out numerically from observable state, plus an enumerated set of conditions that stop the run for a person. #108 asks for "attendedness" as a new matrix dimension, so that unattended runs terminate and report instead of parking on `surface`. #36 (cumulative attempt cap) was folded into #77 on 2026-09-28.

**What research found:**
- **The spine already runs wave-to-wave with no confirmation.** It never pauses and returns a terminal result object (`harness/spine.js:396-787`).
- **`surface` never parks.** It returns `{stopped:'matrix', action:'surface'}`, the same shape as `abort` (`spine.js:728-752`), and `rad deliver` exits **1 for every stop** (`cli.js:754-792`). #108's failure mode (a run paused forever) can't happen. The real gap is that a caller **can't tell "a human must decide" from "this failed"** without parsing stderr, and nothing records which decision is needed.
- **There's no run-level terminal event,** only wave-level `wave-failed`, plus `pr-opened` on success. `pr-opened` establishes the terminal `delivered` phase, and no event may follow it (`transitions.js:67-73`, `events.js:151`).
- **Existing breakers:** per-wave attempts (3), the doom-loop fingerprint, `RAD_TOKEN_BUDGET`, the verify timeout (124 → `fail-timeout` → `surface`), orphan convergence (#119) and hook vetoes.
- **Missing breakers:** a cross-wave cumulative attempt cap, a between-wave approval re-check (the gate is checked once, at `spine.js:350-352`), and a between-wave scope check (`check-scope.sh` runs only as an end post-check, `spine.js:778-783`).
- **RAD has no revoke event.** Nothing can withdraw an approval. So "approval regressed mid-run" in practice means the plan was edited after approval (a fingerprint mismatch), which `rad deliver` never checks today. Only `check-plan-approved.sh` and CI do. A gate-fold re-check also future-proofs the run against a revoke event added later.

**Architect decisions (2026-09-28):**
1. **Typed terminals, no attendedness input (#108 reshaped).** Every run is unattended-safe, because the harness never parks. Every stop after `deliver-started` appends one audit-only **`deliver-stopped`** event `{class, reason, wave?, action?, outcome?, decision}`, where `class` is `needs-decision` or `failed`. `matrix.yaml` is **untouched**. The `/rad-deliver` skill remains the attended wrapper.
2. **Exit codes:** `0` complete, `1` failed, `2` usage/config (existing), **`3` needs a human decision**.
3. **New v1 stop conditions:**
   - an **approval re-check between waves** (gate fold + plan fingerprint)
   - a **scope check between waves** (demotes the wave to `fail-scope`)
   - an opt-in **cumulative failed-attempt cap**, `RAD_MAX_FAILED_ATTEMPTS`

   A wall-clock ceiling is **not** in v1. A CI-failure cap belongs to a CI-watch loop, since it runs after deliver has ended, and stays out of scope.
4. **Captured straight into this plan.** Program Design is the design record.

## Scope

| In scope | Out of scope |
|---|---|
| `harness/stops.js`: exhaustive `(stopped, action)` → `{class, decision}` classification | Any `matrix.yaml`/`gates.yaml` change, or an attended/unattended input |
| Spine appends `deliver-stopped` at every post-start terminal | A run-level wall-clock ceiling |
| Between-wave approval re-check via an injected `approvalIntact` port | A CI-failure cap; `/rad-deliver` skill changes |
| Between-wave `check-scope.sh` (demote to `fail-scope`) | Dormant resume / operator reply as resume context (#95) |
| `RAD_MAX_FAILED_ATTEMPTS` cumulative cap | A revoke-approval verb |
| `rad deliver` exit 3, `class=` on the stderr line, completion fold before exit 0 | Changing existing breaker semantics (maxAttempts, doom-loop, token budget) |
| Docs: stop contract in `docs/rad-wave-contract.md`, `docs/harness-state-store.md`, CLAUDE.md | |

## Acceptance Criteria

1. `classifyStop(result)` in `harness/stops.js` maps every terminal result shape the spine can return to exactly one `{class, reason, decision}`, following the classification table in Program Design. An unknown `stopped` value, or an unknown `action` for `stopped:'matrix'` / `'hook-veto'`, **throws** (no default), the same as `resolveOutcome`. A test enumerates every spine terminal.
2. For every terminal after `deliver-started` (matrix abort or surface, doom-loop, maxAttempts `budget`, `token-budget`, `post-check`, `hook-veto`, orphan, and the new `approval-changed` and `failed-attempt-cap` stops), the spine appends **exactly one** `deliver-stopped` event as the last event of the run, carrying `class`, `reason`, `decision` and, where known, `wave` / `action` / `outcome`.
   - A pre-start gate failure still appends nothing.
   - A successful run appends no `deliver-stopped`, and its event sequence is deep-equal to today's.
   - `deliver-stopped` establishes no phase: it is absent from `PHASE_BY_TYPE`, and appending after it is legal.
3. Before each wave after the first, the spine re-evaluates `state.gate(feature, 'approved')` and calls the injected `approvalIntact()` port.
   - If either fails, the run stops with `stopped:'approval-changed'`, class `needs-decision` and a "re-approve" decision, **before** the wave starts, so no `wave-started` is appended.
   - The default port always passes, so existing tests and injected callers are unaffected.
4. After a wave's agent result is success, and after any declared `Verify:` passes, the spine runs `sh('scripts/check-scope.sh', feature)`.
   - A non-zero exit demotes the attempt to outcome `fail-scope` (recorded on its `wave-attempt`). The existing matrix routes that to `abort` → class `failed`.
   - The end post-check is kept. Exit 0 changes nothing, and events stay deep-equal to today's.
5. With `maxFailedAttempts` (from `RAD_MAX_FAILED_ATTEMPTS`) set to a positive integer, the spine stops **before** the next attempt once the number of non-success `wave-attempt` events since the most recent `deliver-stopped` (or since the start of the log if there isn't one) reaches the cap. The stop is `stopped:'failed-attempt-cap'` with `{failed, cap}`, class `needs-decision`.
   - Unset means off.
   - A malformed value (non-integer, zero, negative) makes `rad deliver` **exit 2** before any event is appended, never a silent fallback.
6. `rad deliver`:
   - exits **3** for any `needs-decision` stop, **1** for `failed`, and **0** only when the spine returned `ok` **and** the pure `deliverCompleted(history, waveCount)` fold confirms it
   - the fold requires, after the latest `deliver-started`, a `wave-complete` for every wave 1..N and a `pr-opened`; if `ok` is not confirmed by the fold, the result is exit 1 with `completion not evidenced`
   - the stderr failure line gains `class=<class>` and `decision="<text>"`
   - `approvalIntact` is implemented by recomputing `planFingerprint` of the plan on disk and comparing it to the latest `approved` event's `data.fingerprint`; a legacy event with no fingerprint passes, matching `check-plan-approved.sh`
7. `docs/rad-wave-contract.md` gains a "Stop contract" section: completion criteria, the classification table, exit codes, the evaluation rule (only observable state counts), and the statement that the harness never parks, so attended vs unattended is the caller's concern. `docs/harness-state-store.md` documents `deliver-stopped` as audit-only. CLAUDE.md documents `RAD_MAX_FAILED_ATTEMPTS` and the exit codes.
8. `npm test --prefix harness` and every `scripts/test-*.sh` pass. Every existing spine test passes unmodified, except for sequence assertions on failing runs, which gain the trailing `deliver-stopped`. Those are updated deliberately and listed in the commit message.

## Agent Scope

- `spine-mapper` (architect): the matrix table and action vocabulary, the terminal shapes and events for every stop, the breaker inventory with units, the absent conditions, the `deliverSpine` parameter seam and `resolveOutcome`'s signature.
- `Explore` (read-only): the `rad deliver` result → exit mapping (`cli.js:740-792`), the absence of any attended/CI signal, the skill's attended escalation, the docs' current wording, CI (nothing runs deliver unattended), event-log samples (no real `surface` stop yet), and related issues (#95 open, #13 closed, #67 open, #90 closed).
- Direct reads, confirmed by grep: the gate call (`spine.js:346-360`), the post-checks (`:772-788`), `PHASE_BY_TYPE` (`events.js:132-160`), transition rule (a) (`transitions.js:60-82`), and the token-budget env parse (`cli.js:714-717`).
- Out-of-scope dependencies: none. The author is the architect; `harness/` is self-protected.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/stops.js | 1-120 | New: `STOP_CLASSES`, `classifyStop` (exhaustive, throws on unknown) |
| harness/test/stops.test.js | 1-160 | New: every terminal shape classified; unknown throws |
| harness/spine.js | 30-90 | Constants; import `classifyStop` |
| harness/spine.js | 300-360 | JSDoc + params `approvalIntact`, `maxFailedAttempts` |
| harness/spine.js | 390-790 | `deliver-stopped` at every terminal; approval re-check; scope demotion; failed-attempt cap |
| harness/test/spine.test.js | 1-60 | Update failing-run sequence assertions to include the trailing `deliver-stopped` |
| harness/test/spine.test.js | 1540-1576 | Append tests for AC#2-5 |
| harness/events.js | 16-71 | Typedef: `deliver-stopped` |
| harness/events.js | 132-160 | Comment: `deliver-stopped` is audit-only (absent from `PHASE_BY_TYPE`) |
| harness/events.js | 960-981 | `deliverCompleted(history, waveCount)` pure fold |
| harness/test/events.test.js | 1040-1100 | `deliverCompleted` tests |
| harness/cli.js | 80-100 | `NEEDS_DECISION_EXIT_CODE = 3` |
| harness/cli.js | 700-800 | Parse `RAD_MAX_FAILED_ATTEMPTS`; `approvalIntact` port; exit mapping; completion fold; stderr `class=`/`decision=` |
| harness/test/cli.test.js | 440-499 | Exit 3 / 1 / 0 and malformed-cap exit 2 tests |
| docs/rad-wave-contract.md | 180-254 | New "Stop contract" section |
| docs/harness-state-store.md | 220-300 | `deliver-stopped`, classification, between-wave checks |
| CLAUDE.md | 164-192 | `RAD_MAX_FAILED_ATTEMPTS` + deliver exit codes |

## Program Design

### 1. Classification table (the contract — `harness/stops.js`)

| `stopped` (spine result) | `action` | class | `decision` (template) |
|---|---|---|---|
| `matrix` | `surface` | needs-decision | `wave {w}: {outcome} — non-deterministic failure (e.g. timeout/orphaned attempt); retry, raise the limit, or split the wave` |
| `matrix` | `abort` | failed | `wave {w}: {outcome} — the work is wrong for the plan; fix the plan or the code and re-run` |
| `hook-veto` | `surface` / `abort` | same as the `matrix` rows | `… vetoed by hook {hook} at {point}` |
| `doom-loop` | — | failed | `wave {w} failed identically twice — a retry cannot fix it` |
| `budget` (maxAttempts) | — | failed | `wave {w} exhausted its attempts` |
| `post-check` | — | failed | `post-check {check} exited {status}` |
| `token-budget` | — | needs-decision | `token budget {budget} reached (spent {spent}); raise RAD_TOKEN_BUDGET or stop` |
| `failed-attempt-cap` | — | needs-decision | `{failed} failed attempts reached RAD_MAX_FAILED_ATTEMPTS={cap}; raise the cap, re-plan, or stop` |
| `approval-changed` | — | needs-decision | `the plan changed since approval (or approval no longer holds); re-approve before re-running` |
| `gate` (pre-start) | — | needs-decision | `plan not approved; run /rad-approve` (no event: nothing started) |

The rule behind the table: `needs-decision` means a limit or policy a human can lift, or a non-deterministic condition. `failed` means a deterministic check showed the work is wrong. Unknown `stopped` values or actions throw.

### 2. Signatures introduced or altered

```js
// harness/stops.js — new
export const STOP_CLASSES = Object.freeze({ NEEDS_DECISION: 'needs-decision', FAILED: 'failed' });
export function classifyStop(result) /* → { class, reason, decision } ; throws on unknown */

// harness/spine.js — additive params (defaults preserve today's behavior)
deliverSpine({ …, approvalIntact = () => ({ ok: true }), maxFailedAttempts = null })

// new terminal result shapes
{ stopped: 'approval-changed', ok: false, wave, reason }
{ stopped: 'failed-attempt-cap', ok: false, wave, failed, cap }

// harness/events.js — new audit-only event (absent from PHASE_BY_TYPE) + read fold
{ type: 'deliver-stopped', actor: 'harness', data: { class, reason, decision, wave?, action?, outcome? } }
export function deliverCompleted(history, waveCount) /* → boolean */
```

### 3. Control-flow sketch

```
deliverSpine
 ├─ gate (unchanged; pre-start stop appends nothing)
 ├─ deliver-started
 └─ for each wave
     ├─ [wave > first] gate re-check + approvalIntact()  ─✗→ stop approval-changed      ← NEW
     ├─ token budget (unchanged)
     └─ for each attempt
         ├─ failed-attempt cap reached?  ─✗→ stop failed-attempt-cap                    ← NEW
         ├─ pre-wave hooks · wave-started · runWave · Verify (unchanged)
         ├─ success → check-scope.sh ≠0 → outcome := fail-scope                          ← NEW
         └─ resolveOutcome (matrix, unchanged) → advance | retry | abort | surface
 every post-start terminal ─→ append deliver-stopped(classifyStop(result)) ─→ return      ← NEW
 success → post-checks → pr-opened → { ok: true }   (unchanged; no deliver-stopped)

rad deliver (cli)
 ok && deliverCompleted(history, N) → exit 0
 classifyStop(result).class == needs-decision → exit 3   ← NEW
 otherwise → exit 1   (stderr: … class=… decision="…")
```

### 4. File-tree diff

```
harness/stops.js                    A
harness/test/stops.test.js          A
harness/spine.js, cli.js, events.js M
harness/test/{spine,cli,events}.test.js  M
docs/rad-wave-contract.md, docs/harness-state-store.md, CLAUDE.md  M
```

## Execution Notes

### Do Not Touch
- harness/matrix.yaml, harness/matrix.js, harness/gates.yaml, harness/gates.js, harness/transitions.js, harness/plan-fingerprint.js
- scripts/** (the spine calls `check-scope.sh` through the existing `sh` port; no script changes)
- .claude/commands/team/rad-deliver.md

### Key Files
- harness/spine.js: the terminal return sites (`:402-411`, `:448-467`, `:696-708`, `:728-752`, `:755-773`, `:778-783`), the gate (`:350`), the verify demotion (`:540-600`) to mirror for scope, `appendWaveStarted`, and #119's `priorAttemptState` seeding
- harness/matrix.js: `resolveOutcome` (call it; never change it)
- harness/events.js: `PHASE_BY_TYPE`, and the read-helper blocks (`:289`, `:884`)
- harness/cli.js: `deliverCommand` (`:660-792`), `USAGE_EXIT_CODE`, the `RAD_VERIFY_TIMEOUT_SECONDS` / preflight strict-parse pattern for exit 2, and `planFingerprint`
- harness/test/spine.test.js: the fakes (`state`, `sh`, `runWave`, `now`) and the existing sequence assertions

### Reminders
- **Success runs must be deep-equal to today.** No new events, no new `sh` calls that append anything. The between-wave scope check adds an `sh` call, but appends nothing when it passes. Say so in a test.
- **One `deliver-stopped` per stopped run, always last.** Append it through a single helper at every post-start return site, so no path can skip it. Add a test that enumerates all terminals.
- **Fail closed:** `classifyStop` throws on unknown input, and the spine must not swallow that throw.
- **No attendedness input anywhere.** If a design point seems to need one, stop and report `blocked_spec`.
- **The cap counts non-success `wave-attempt`s since the latest `deliver-stopped`,** so a re-run after a stop gets a fresh budget, consistent with #119's "since the last terminal stop".
- CLAUDE.md conventions: functions under ~40 lines, named constants, never swallow errors, comments state constraints.

## Wave Plan

### Wave 1 — sequential
Verify: npm test --prefix harness
Tasks in this wave must run in sequence (the spine imports the classifier).

#### Task 1.1: Stop classification module
File: harness/stops.js:1-120, harness/test/stops.test.js:1-160
What: Create `stops.js` with `STOP_CLASSES`, the Program Design table as a frozen data structure, and `classifyStop(result)`. It returns `{class, reason, decision}`, with the decision templated from result fields, and throws `Error('classifyStop: unknown stopped/action …')` on unknown input.
- `reason` = the specific cause: the matrix `outcome` for `matrix` / `hook-veto`, otherwise the `stopped` value (`doom-loop`, `token-budget`, and so on).
- Include the `approval-changed` and `failed-attempt-cap` shapes now, even though the spine emits them in Wave 2.

Tests:
- one per table row, including `hook-veto` × both actions
- templating with missing optional fields (e.g. no `wave`)
- unknown `stopped`, unknown `action`, a `null` / non-object result: each throws
Validate: AC#1 — `npm test --prefix harness`.

#### Task 1.2: deliver-stopped at every terminal
File: harness/spine.js:30-90, 390-790, harness/events.js:16-71, 132-160, harness/test/spine.test.js:1-60, 1540-1576
What:
- Add a `stopRun(result)` helper that appends `deliver-stopped` with `classifyStop(result)` plus the result's `wave` / `action` / `outcome` (only the keys present), then returns the result.
- Route **every** post-`deliver-started` return through it: token-budget, hook-veto, doom-loop, matrix abort/surface (including orphan), budget exhaustion and post-check.
- The pre-start gate path appends nothing, and the success path is unchanged.
- In `events.js`, add `deliver-stopped` to the typedef, and a comment in `PHASE_BY_TYPE` saying it's audit-only and deliberately absent (like `capture-failed`).
- Update the existing spine tests that assert full event sequences for failing runs so they expect the trailing `deliver-stopped`. List each one in the commit message.

Append tests:
- each terminal ends with exactly one `deliver-stopped` with the right class
- the success sequence is deep-equal to a baseline captured before the change
- the gate stop appends nothing
- appending after `deliver-stopped` (a re-run) is legal
Validate: AC#2, AC#8 — `npm test --prefix harness`.

### Wave 2 — sequential
Verify: npm test --prefix harness
Tasks in this wave must run in sequence (all three touch the spine loop).

#### Task 2.1: Between-wave approval re-check
File: harness/spine.js:300-360, 390-470, harness/test/spine.test.js:1540-1576
What: Add a `approvalIntact = () => ({ ok: true })` param with JSDoc. Before every wave except the first, and before the token-budget check, re-run `state.gate(feature, 'approved')` and `approvalIntact()`.
- On failure, return `stopRun({ stopped: 'approval-changed', ok: false, wave: wave.n, reason })`, with no `wave-started`.
- A throwing port is treated as not intact (fail closed), with its message in `reason`.

Tests:
- the gate flipping to failed before wave 2 stops with `approval-changed`, no wave-2 `wave-started`, and one `deliver-stopped` with class needs-decision
- the port returning `{ok:false}` behaves the same
- a throwing port behaves the same
- the default port gives a sequence identical to baseline
- a single-wave plan never calls the port
Validate: AC#3 — `npm test --prefix harness`.

#### Task 2.2: Between-wave scope check
File: harness/spine.js:540-660, harness/test/spine.test.js:1540-1576
What: After an attempt's outcome is `success`, including after a declared Verify has passed, call `sh('scripts/check-scope.sh', feature)`. On non-zero, set the attempt outcome to `fail-scope` before recording `wave-attempt` and resolving through the matrix, mirroring the Verify demotion. Keep the end post-check. Tests:
- a scope failure after wave 1 gives `wave-attempt` outcome `fail-scope`, matrix `abort`, and `deliver-stopped` class `failed`, with wave 2 never run
- scope passing gives events deep-equal to baseline (the `sh` fake records the extra call, but no event changes)
- a scope check after a failed attempt is never called
Validate: AC#4 — `npm test --prefix harness`.

#### Task 2.3: Cumulative failed-attempt cap
File: harness/spine.js:300-360, 420-470, harness/test/spine.test.js:1540-1576
What: Add a `maxFailedAttempts = null` param. Before each attempt, when it's a positive integer, count the non-success `wave-attempt`s in the history after the latest `deliver-stopped` (or from the start). At or above the cap, return `stopRun({ stopped: 'failed-attempt-cap', ok: false, wave, failed, cap })`, with no `wave-started`. Extract the count as a small pure helper. Tests:
- with a cap of 2, two failing attempts across waves stop before the third attempt
- the cap counts across waves, not per wave
- a prior `deliver-stopped` resets the count
- `null` / off gives baseline
- success attempts are not counted
Validate: AC#5 (spine part) — `npm test --prefix harness`.

### Wave 3 — parallel
Verify: npm test --prefix harness && for t in scripts/test-*.sh; do bash "$t" >/dev/null || exit 1; done
Tasks in this wave can run in parallel (code vs docs).

#### Task 3.1: rad deliver exit codes, completion fold, cap parsing, approval port
File: harness/cli.js:80-100, 700-800, harness/events.js:960-981, harness/test/cli.test.js:440-499, harness/test/events.test.js:1040-1100
What:
- **Constant:** `NEEDS_DECISION_EXIT_CODE = 3`.
- **Cap parsing:** read `RAD_MAX_FAILED_ATTEMPTS` with the strict parse. Unset means `null`, and malformed means exit 2 with a message before any event.
- **Approval port:** build `approvalIntact` by re-reading the plan file, computing `planFingerprint(text).hash`, and comparing it to the latest `approved` event's `data.fingerprint`. A missing fingerprint passes. A read error returns `{ok:false, reason}`.
- **Spine call:** pass both to `deliverSpine`.
- **Exit mapping:**
  - `ok` and `deliverCompleted(history, waves.length)` gives 0.
  - `ok` without fold confirmation gives 1 with `completion not evidenced`.
  - Otherwise use `classifyStop(result).class`: `needs-decision` gives 3, `failed` gives 1.
  - Append `class=` and `decision="…"` to the stderr line.
- **Completion fold:** add `deliverCompleted` to the `events.js` read helpers. Pure, never throws, false on bad input.

Tests:
- a `surface` terminal gives exit 3, and the stderr line has `class=needs-decision`
- an `abort` gives 1
- `ok` gives 0
- `ok` with a history missing a `wave-complete` gives 1
- a malformed cap (`abc`, `0`, `-1`) gives exit 2 and no events
- a plan edited between waves (the fake `runWave` rewrites the plan file) gives exit 3 with `approval-changed`
- the fold: complete, missing wave, missing `pr-opened`, `pr-opened` before the latest `deliver-started`, `[]` / `null`
Validate: AC#5, AC#6 — `npm test --prefix harness`.

#### Task 3.2: Stop-contract docs
File: docs/rad-wave-contract.md:180-254, docs/harness-state-store.md:220-300, CLAUDE.md:164-192
What:
- **`rad-wave-contract.md`:** add a "Stop contract" section. It covers:
  - completion criteria: every wave has a `wave-complete`, `pr-opened` exists, and the fold confirms it; agent claims are not evidence
  - the classification table
  - exit codes 0 / 1 / 2 / 3
  - the evaluation rule: only observable state counts
  - the between-wave checks
  - `RAD_MAX_FAILED_ATTEMPTS`
  - the statement that the harness never parks, so an unattended caller uses the exit code and a `/rad-deliver` session is the attended wrapper
- **`harness-state-store.md`:** document `deliver-stopped` as audit-only (absent from `PHASE_BY_TYPE`, so a re-run after it is legal). Note that `surface` is a terminal return, not a pause.
- **CLAUDE.md "Cost & Frugality":** add `RAD_MAX_FAILED_ATTEMPTS` (opt-in; a malformed value exits 2), plus one line on deliver exit codes.

Tables and code examples go in fenced blocks where they contain `|`. This task has no unit-testable surface (docs).
Validate: AC#7 — read-through.

## Tests to Write
- [ ] classifyStop: every table row, templating, unknown/malformed input throws — harness/test/stops.test.js
- [ ] deliver-stopped: exactly one, last, correct class for every terminal; success deep-equal; gate appends nothing — harness/test/spine.test.js
- [ ] approval re-check: gate flip / port false / port throws stop before the wave; default and single-wave unaffected — harness/test/spine.test.js
- [ ] scope demotion to fail-scope → abort; passing scope unchanged — harness/test/spine.test.js
- [ ] failed-attempt cap: cross-wave count, reset after deliver-stopped, off by default — harness/test/spine.test.js
- [ ] deliverCompleted fold cases — harness/test/events.test.js
- [ ] rad deliver exit 3 / 1 / 0, completion not evidenced, malformed cap exit 2, plan edited mid-run — harness/test/cli.test.js

## Non-Goals
- An attended/unattended input, or any `matrix.yaml` / `gates.yaml` change.
- A wall-clock ceiling (not selected for v1) and a CI-failure cap (runs after deliver ends; belongs to a CI-watch loop).
- Dormant resume with the operator's reply as resume context (#95), and a revoke-approval verb.
- Changing the `/rad-deliver` skill or any existing breaker's semantics.

## Out-of-Scope Dependencies
None

## Risks
- **Existing failing-run tests change** because every stop now ends with `deliver-stopped`. This is deliberate (AC#8). Success sequences stay deep-equal, and each updated test is listed in its commit.
- **Exit 1 becomes 3 for surface-class stops.** No caller in this repo branches on deliver's exit code (the skill doesn't call the harness, and CI doesn't run deliver), but external operator scripts could. This is documented in CLAUDE.md and the contract doc.
- **The between-wave scope check adds one `sh` spawn per successful wave.** That costs time, not correctness, and it catches drift a whole wave earlier.
- **The plan fingerprint re-check reads the plan file mid-run.** A wave that legitimately edits the plan doc would now stop the run. That's intended: the plan is the approved contract, and a Status-header edit is excluded from the fingerprint by construction.
- **#67 (matrix replay check)** isn't affected, because the matrix is unchanged.

## Issue Gaps
- **[DECIDED — architect]** Typed terminals, no attendedness input; exit 3 means needs-decision. v1 conditions: approval re-check, scope check, opt-in failed-attempt cap. No wall-clock ceiling. Captured straight into this plan.
- **[ASSUMPTION — #77]** "Approval regressed mid-run" is implemented as a gate-fold re-check plus a plan-fingerprint comparison, because RAD has no revoke event. The gate re-check future-proofs against a revoke event added later.
- **[ASSUMPTION — #77]** The classification rule: `needs-decision` means a human can lift a limit or a non-deterministic condition occurred; `failed` means a deterministic check showed the work is wrong. `token-budget` is needs-decision and `doom-loop` is failed, per the Program Design table. The architect should review that table at approval.
- **[ASSUMPTION — #77]** Completion is `pr-opened` plus a `wave-complete` for every wave after the latest `deliver-started`, checked by a pure fold before exit 0. #77's "green checks on the PR" happens after deliver ends and is out of scope.
- **[ASSUMPTION — #36]** The failed-attempt cap counts non-success `wave-attempt`s since the latest `deliver-stopped`, so a deliberate re-run after a stop gets a fresh budget.
- **[ASSUMPTION — #108]** #108's acceptance criteria about an attendedness input and matrix rows no longer apply under decision 1. Its core requirement is met: every surface-class stop has a non-hanging, reporting terminal that records the outcome, the wave, and the human decision it's blocked on.
