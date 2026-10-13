# Plan: Refactor the Deliver Spine Under the Function-Length Ratchet (#252, part 6 of 6)
Created: 2026-10-13
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-13T16:04:14.416Z
Recorded-By: sean@torchcodelab.com
Branch: rad/refactor-spine
Adopted-From: #252 part 6 of 6 (refactor the last two offenders, harness/spine.js runOneWave and deliverSpine; closes the issue's refactor scope)
Issue-Title: Refactor over-long core functions (runOneWave, createGitStateStore, deliverCommand, ...)
Source-Author: none (no source issue)
Source-Comments: none

## Context
Plan 6 of 6, the last of the decomposition of #252 (plans 1-5 merged as #261, #263, #264, #265, #266). Two baselined offenders remain in the whole codebase, both in `harness/spine.js`:

| Function | Lines | What it is |
|---|---|---|
| `runOneWave` | 425 | The per-wave body: approval re-check, budget, resume-verify, orphan convergence, then the bounded attempt loop (pre-wave hook, agent call around the push guard, post-wave hook, presence/Verify/scope gates, push-guard demotion, matrix action, attempt record, outcome hooks, advance/retry/stop) |
| `deliverSpine` | 160 | The run: approval gate, `deliver-started`, prepare, resume seeding, the wave loop, the end-of-run test wave, the approval-during-run guard, post-checks, `pr-opened` and the finish steps |

This is the core control flow of the harness, so this is the highest-risk plan of the six. Most of both functions is explanatory comments around small blocks, and the structure is already stage-like, so the refactor is a matter of cutting along existing seams. The safety net is the strongest of the six and has a different shape from plans 1-5: the spine takes all its collaborators as injected ports (state store, `sh`, `runWave`, hook runner, clock), so Wave 1 records, for a **systematic grid of scenarios**, a single **ordered timeline** of everything the spine does (each event appended, each `sh` call, each hook call, each `runWave` call with its attempt context, and the terminal result), generated from the *unmodified* spine. Waves 2 and 3 refactor; the same grid must produce the same timelines. To avoid the multi-megabyte golden file of plan 4, the golden data stores a hash of every scenario's timeline plus a few dozen pinned full transcripts for human reading.

**Header note.** This plan deliberately carries no `Issue:` header (the deliver PR would otherwise close #252 on merge). After this plan merges, #252's refactor scope is done and the issue is closed by hand.

**Literal strings in `spine.js` that other things depend on (must survive verbatim).** `docs/invariants.yaml` anchors these as literal substrings, and `scripts/lint-invariants.sh` fails if one disappears: `state.gate(feature, 'approved')`, `approvalChangeReason`, `'approval-changed'`, the comment text `Approval re-check fires before EVERY wave`, `export function approvedDuringRun`, `SCOPE_FAIL_OUTCOME`, `safeVetoOutcome`, `'fail-timeout' : 'fail-tests'`, `pushGuardDemotion`, `PUSH_GUARD_SCRIPT`. The adversarial evals in `harness/evals/approval.eval.js` also patch literal `spine.js` text to prove their gates are load-bearing, and fail with "anchor not found" if it moves (as plan 5 learned): the two-line `if (!g.passed) {` / `    return { stopped: 'gate'` in `deliverSpine`; `for (const wave of waves) {` (the **first** occurrence in the file must stay the one in `deliverSpine`, because `String.replace` patches only the first); `const reason = await approvalChangeReason({ state, feature, approvalIntact });`; and `if (!Array.isArray(history)) return [];` followed by `  let start = -1;` in `approvedDuringRun` (untouched by this plan).

## Scope
| In scope | Out of scope |
|---|---|
| Splitting `runOneWave` and `deliverSpine` into small named helpers inside `spine.js` | Any change to events, event order, results, stop reasons, exports or signatures |
| A characterization test (a scenario grid, an ordered timeline per scenario) and its golden data | Editing, moving or deleting any existing test, or changing any eval other than as a last resort named in the Risks |
| Regenerating the lint baseline, which becomes empty | The matrix, the gate rules and every helper already under 40 lines |

## Acceptance Criteria
1. **Characterization recorded first.** `harness/test/spine-characterization.test.js` runs the scenario grid in Tasks 1.1-1.2 against `harness/test/fixtures/spine-golden.json`, generated from the unmodified spine in Wave 1 and not regenerated after Wave 2 begins.
2. **One ordered timeline per scenario.** A scenario's recorded timeline is a single ordered list of the spine's observable calls: every `state.append` (event type and data, with timestamps replaced by a constant), every `state.gate`, `state.plan` and `state.history` read, every `sh` call (script and arguments), every hook invocation (point and context), every `prepare` and `finish` call, and every `runWave` call (wave, attempt context including whether a prior failure and operator context are present), ending with the terminal result. Identical timelines mean identical behavior, including the order of events relative to hook and shell calls.
3. **The grid is systematic.** It covers: every sequence of wave outcomes of length 1 to 3 over the outcomes `success`, `fail-tests`, `fail-scope`, `fail-timeout`, `fail-protocol` and `abort-user`, against the default matrix; crossed with the gate configurations (no gates, presence gate failing, `Verify:` passing, failing and timing out, scope gate failing, push guard seeing a moved tip, push guard unable to read the tip); plus targeted scenarios for: pre-wave and post-wave hook vetoes (and an observe-point failure), the token budget (under, at and over), the failed-attempt cap, a doom loop (identical failure twice), exhausted attempts, resumed runs (completed waves skipped, orphaned attempt, operator context on the first call only, resume-verify failing), `prepare` and `finish` ports failing before and after the PR, the end-of-run test wave (present, missing tests), an approval that changes before a wave and one recorded during the last wave, a blocked approval gate, and multi-wave plans where the second wave fails.
4. **Timelines are compared by hash, with pinned transcripts.** `spine-golden.json` stores, for every scenario, a hash of its canonical timeline; and the full timelines for at least 40 pinned scenarios chosen to cover every stop reason and every branch of the attempt loop. On a mismatch the test prints the scenario id and writes the actual timeline to a temporary file for diffing. The golden file stays under 300 KB.
5. **Behavior identical.** After the refactor, every scenario's timeline hash equals the golden hash, and every pinned transcript equals the golden transcript exactly.
6. **Anchors intact.** `bash scripts/lint-invariants.sh` passes and the ten strings in Context are present in `spine.js` verbatim. The four patched fragments in Context still occur as written, and `for (const wave of waves) {` still first occurs in `deliverSpine`.
7. **Evals still prove their gates.** `node --test harness/evals/*.eval.js` passes in full, including every `[mutated]` case.
8. **Public surface unchanged.** `spine.js` exports the same names with the same signatures (`deliverSpine`, `approvedDuringRun`, `failedAttemptsSinceStop`, `promisedUpTo`, `buildTestWave` among them) and `deliverSpine` keeps its parameter list and defaults; no file outside `spine.js`, the new test files and the baseline is modified.
9. **Ratchet empties.** After `--write-baseline`, the baseline contains no entries, no helper in `spine.js` exceeds 40 lines, and `node scripts/lint-function-length.mjs` exits 0.
10. **Existing tests untouched.** `git diff` shows no change to any existing test file, and the whole existing suite passes.
11. **Full suite passes.** `scripts/verify-all.sh` passes on the delivered branch.

## Agent Scope
No sub-agents were called. Research was inline (10 tool calls): the baseline entries, the whole of `runOneWave` and `deliverSpine`, the outline of `spine.js`, the invariant anchors on the file and every eval that patches its text.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/spine.js | 695-1135 | `runOneWave` split into stage helpers |
| harness/spine.js | 1136-1403 | `deliverSpine` split into setup, loop-state and finish helpers |
| harness/test/spine-characterization.test.js | 1-350 | New. Fake ports, the scenario grid, the timeline recorder and the comparison |
| harness/test/fixtures/spine-golden.json | 1-1 | New. Per-scenario hashes and pinned full transcripts, generated from the unmodified spine |
| scripts/lint-function-length-baseline.txt | 1-45 | Regenerated with `--write-baseline` (becomes empty) |

## Execution Notes

### Do Not Touch
- Every existing test file, including spine.test.js, spine-finish.test.js, spine-prepare.test.js, spine-test-wave.test.js, spine-wave-tasks.test.js and cost.test.js
- harness/evals/ (every eval anchor into `spine.js` must keep matching; if one cannot, stop and report rather than edit the eval)
- harness/matrix.yaml, harness/events.js, harness/transitions.js, harness/gates.js, harness/hook-runner.js and every other module; the code in `cli.js` that calls `deliverSpine`
- scripts/lint-function-length.mjs, docs/invariants.yaml

### Key Files
- harness/spine.js — `runOneWave` (~702), `deliverSpine` (~1244), and the helpers they use (`stopRun`, `approvalChangeReason`, `convergeOrphans`, `fireHooks`, `capturePriorFailure`, `scopeDemotion`, `pushGuardDemotion`, `wavePresenceGate`, `runPrepare`, `runFinishStep`, `runTestWaveAndGuard`)
- harness/test/spine.test.js and spine-finish.test.js — the existing fake state store, `sh` and `runWave` patterns to copy (read, do not edit)
- harness/evals/approval.eval.js (lines ~82, ~138, ~303) and docs/invariants.yaml — the literal-text dependencies listed in Context
- harness/matrix.yaml — the stop-condition matrix the scenarios run against

### Reminders
- harness/ is self-protected: architect approval and the last-wave full-suite Verify. Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800` AND `RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- **Wave 1 must not edit `spine.js`.** The golden data records current behavior; generating it after any refactor defeats the point.
- **Run the evals after every refactor task**, not only `npm test`: Waves 2 and 3 Verify both. An anchor break shows up only there.
- Make everything deterministic: an in-memory state store that applies the real `validateTransition` and `reduce` (copy the helper from the existing spine tests), a clock that returns a constant timestamp, a scripted `sh`, `runWave` and `runHooks`, no filesystem and no processes. Canonicalize each timeline with sorted keys before hashing.
- Keep the **order of observable calls** in every stage: in an attempt, cap check, `pre-wave` hook, `wave-started`, the push-guard tip read, `runWave`, the second tip read, the push-check record, `post-wave` hook, the presence or veto branch, Verify, scope, push-guard demotion, the matrix action, the `wave-attempt` event, the budget accumulation, `on-outcome`, then advance, retry or stop.
- Keep the run-wide counters (`spent`, `failedAttempts`, `resumeVerified`, `operatorContextPending`) as fields of `loop` mutated in place; helpers must read and write them there.
- Keep `fireHooks`, `stopRun` and the other already-small helpers unchanged.
- Keep functions at 40 lines or fewer; comments that state a constraint stay with the code they describe and move with it. Run `node scripts/lint-function-length.mjs` before finishing each refactor wave.
- The baseline is regenerated only in Wave 4, and it should end empty.

## Program Design

Helper signatures (module-private; names are a guide, the executor may refine them while keeping every function at 40 lines or fewer and every Context string verbatim):

```js
// runOneWave stages
preWaveStop(wave, loop)                 // approval re-check, budget, resume-verify, orphan convergence -> stop | null
attemptCapStop(wave, loop)              // failed-attempt cap -> stop | null
preWaveVetoStop(wave, loop)             // pre-wave hook veto: hook-veto, matrix, wave-failed -> stop | null
invokeWave(wave, loop, attemptCtx)      // push-guard tip reads around runWave; records push-check; -> { result, tipBefore, tipAfter }
applyPostWaveGates(wave, loop, ran)     // post-wave veto, or presence then Verify then scope -> { outcome, gated, gateOutput, vetoSource, verifyEvidence }
recordAttempt(wave, loop, attempt, ran, gates)   // push-guard demotion, matrix action, fingerprint, wave-attempt event, counters -> { action, outcome, print }
advanceWave(wave, loop, outcome)        // wave-complete hooks and event
retryOrStop(wave, loop, step, state)    // retry/revision: on-retry, doom-loop, prior-failure capture; or terminal abort/surface
exhaustedStop(wave, loop)               // budget-exhausted: on-error, wave-failed, stop

// deliverSpine stages (the gate check, the wave `for` loop and the final result stay inside deliverSpine)
startRun(args)                          // deliver-started, run-resumed, hook pre-flight, prepare -> stop | null
seedRun(args, state)                    // plan waves, history, completed, spent, failedAttempts, operatorContextPending
buildLoop(args, seed)                   // the `loop` object handed to runOneWave
approvalDuringRunStop(state, feature, waves, stopCtx)   // last-wave approval guard -> stop | null
runPostChecks(args, stopCtx)            // finish.beforePr and the POST_CHECKS loop -> stop | null
finishRun(args, waves)                  // pr-opened, finish.afterPr -> result
```

Call stack:

```
deliverSpine -> state.gate (anchor stays inline) -> startRun -> seedRun -> buildLoop
             -> for (const wave of waves) (anchor stays inline) -> runOneWave
                   -> preWaveStop -> [attempt loop: attemptCapStop -> preWaveVetoStop -> invokeWave
                      -> applyPostWaveGates -> recordAttempt -> advanceWave | retryOrStop] -> exhaustedStop
             -> runTestWaveAndGuard (existing) -> approvalDuringRunStop -> runPostChecks -> finishRun
```

File tree diff:

```
harness/spine.js                                 runOneWave and deliverSpine split into ~15 helpers
harness/test/spine-characterization.test.js      NEW
harness/test/fixtures/spine-golden.json          NEW
scripts/lint-function-length-baseline.txt        - 2 entries (file empty)
```

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (1.3 generates the data the assertions use).
Verify: node --test harness/test/spine-characterization.test.js

#### Task 1.1: The recording harness
File: harness/test/spine-characterization.test.js:1-350
What: Write the fake ports and the timeline recorder: an in-memory state store using the real `validateTransition` and `reduce`, a constant clock, a scripted `sh` keyed by script path, a scripted `runWave` that returns the next outcome in a scenario's sequence (and records its arguments), a scripted `runHooks`, `prepare` and `finish` ports, and a recorder that appends one entry per observable call (AC#2) to a single ordered list. Add the canonicalization (sorted keys, constant timestamps) and the SHA-256 hash of a timeline. Run the unmodified `deliverSpine` against the real default matrix.
Validate: AC#1, AC#2 — a trivial scenario (one wave, `success`) produces the expected ordered timeline when read by hand.

#### Task 1.2: The scenario grid and comparison
File: harness/test/spine-characterization.test.js:1-350
What: Generate the grid of AC#3 in code: all outcome sequences of length 1 to 3 over the six outcomes, crossed with the seven gate configurations, plus the targeted scenarios, each with a stable string id. Compare each scenario's timeline hash to the golden hash, and each pinned scenario's full timeline to its golden transcript. On a mismatch print the id and write the actual timeline to a temporary file. An `UPDATE_GOLDEN=1` mode writes the golden file; without it the test only reads and compares. Choose at least 40 pinned scenarios that together exercise every stop reason (`gate`, `approval-changed`, `token-budget`, `resume-verify`, `failed-attempt-cap`, `hook-veto`, `doom-loop`, `matrix`, `budget`, the orphan stop, prepare and finish failures, `tests-missing`, `post-check`) and every branch of the attempt loop.
Validate: AC#1, AC#3, AC#4 — every scenario has a golden entry; a deliberately wrong golden hash makes the test fail (checked once by hand, not committed).

#### Task 1.3: Generate the golden file
File: harness/test/fixtures/spine-golden.json:1-1
What: Run the test once with `UPDATE_GOLDEN=1` against the **unmodified** `spine.js` to write `spine-golden.json`, commit it, check that it is under 300 KB, then run the test without the variable twice in a row and confirm both pass.
Validate: AC#1, AC#4 — the golden file exists and is small enough, the test passes on two consecutive runs, and `git diff` shows `spine.js` untouched in this wave.

### Wave 2 — sequential
Tasks in this wave must run in sequence (each edits `runOneWave`).
Verify: npm test --prefix harness && node --test harness/evals/*.eval.js && bash scripts/lint-invariants.sh

#### Task 2.1: Extract the pre-attempt stages
File: harness/spine.js:695-1135
What: Extract `preWaveStop` (approval re-check, token budget, resume-verify, orphan convergence, in that order, keeping the `Approval re-check fires before EVERY wave` comment and the literal `const reason = await approvalChangeReason({ state, feature, approvalIntact });`), `attemptCapStop`, `preWaveVetoStop` and `invokeWave` (tip reads around `runWave` and the push-check record). `runOneWave` calls them in the original order inside the same `for` loop over attempts.
Validate: AC#5, AC#6, AC#7, AC#10 — the characterization test, the evals and the existing tests pass unchanged; no behavior change, so no new tests.

#### Task 2.2: Extract the gates and the attempt record
File: harness/spine.js:695-1135
What: Extract `applyPostWaveGates` (the post-wave veto branch, the presence gate, the Verify gate keeping the literal `'fail-timeout' : 'fail-tests'`, the scope demotion) and `recordAttempt` (push-guard demotion keeping `pushGuardDemotion`, the matrix action, the fingerprint, the `wave-attempt` event and the budget and failed-attempt counters). Gate results that were local variables become fields of the returned object; keep the comments that state constraints.
Validate: AC#5, AC#6, AC#7, AC#10 — the characterization test, the evals and the existing tests pass unchanged; no behavior change, so no new tests.

#### Task 2.3: Extract the dispatch and the stops
File: harness/spine.js:695-1135
What: Extract `advanceWave`, `retryOrStop` (the on-retry hook, the doom-loop breaker and its `on-error` hook and `wave-failed` event, the prior-failure capture, and the terminal abort or surface branch) and `exhaustedStop`. `runOneWave` becomes the pre-wave stage plus the attempt loop that delegates each step and returns the first stop or `null`.
Validate: AC#5, AC#6, AC#7, AC#10 — the characterization test, the evals and the existing tests pass unchanged; `runOneWave` is 40 lines or fewer; no behavior change, so no new tests.

### Wave 3 — sequential
Tasks in this wave must run in sequence.
Verify: npm test --prefix harness && node --test harness/evals/*.eval.js && bash scripts/lint-invariants.sh

#### Task 3.1: Split deliverSpine
File: harness/spine.js:1136-1403
What: Extract `startRun`, `seedRun`, `buildLoop`, `approvalDuringRunStop`, `runPostChecks` and `finishRun` as in Program Design. Keep the approval-gate check with its `state.gate(feature, 'approved')` call and the two-line `if (!g.passed) {` / `return { stopped: 'gate'` text, and the `for (const wave of waves) {` loop, inline in `deliverSpine`; keep `deliverSpine`'s parameter list and defaults character for character. `for (const wave of waves) {` must still first occur in `deliverSpine`.
Validate: AC#5, AC#6, AC#7, AC#8, AC#10 — the characterization test, the evals and the existing tests pass unchanged; `deliverSpine` is 40 lines or fewer; no behavior change, so no new tests.

### Wave 4 — sequential
Tasks in this wave must run in sequence.
Verify: exec bash scripts/verify-all.sh

#### Task 4.1: Empty the ratchet baseline
File: scripts/lint-function-length-baseline.txt:1-45
What: Run `node scripts/lint-function-length.mjs --write-baseline` and commit the result. Confirm the diff removes exactly the two `spine.js` entries, that no new entry appears, that the baseline now holds no entries (only its header comment), and that `node scripts/lint-function-length.mjs` exits 0.
Validate: AC#9 — the baseline diff only removes those two lines; the lint exits 0 with an empty baseline.

#### Task 4.2: Full-suite check
File: scripts/lint-function-length-baseline.txt:1-45
What: No further edit. The wave's Verify runs the full suite.
Validate: AC#11 — `scripts/verify-all.sh` passes.

## Tests to Write
- [ ] A systematic scenario grid over `deliverSpine`/`runOneWave` with an ordered timeline per scenario, compared by hash plus pinned transcripts, against golden data from the unmodified spine — harness/test/spine-characterization.test.js

## Non-Goals
- Changing any event, its order, a stop reason, a result shape, an export or a signature
- Editing, moving or deleting an existing test or eval
- Moving code out of `spine.js` or splitting it into modules
- Changing the matrix, the gate rules or any already-small helper

## Out-of-Scope Dependencies
None.

## Risks
- This is the core control flow. A reordered call, a counter updated in the wrong place, or a lost early return could change which events are written or when a run stops. The ordered timeline with hashes over a systematic grid, the pinned transcripts, the evals and the large existing spine test suite are the layered controls.
- The grid covers outcome sequences of length up to 3, which is the default attempt budget; behavior with a larger `maxAttempts` is not enumerated beyond the targeted scenarios.
- The evals patch literal `spine.js` text. If an anchor cannot be preserved, the executor must stop and report; the plan does not authorize editing evals (plan 5 needed a plan amendment for exactly this).
- `for (const wave of waves) {` must first occur in `deliverSpine`; a new loop of that exact shape in a helper above it would redirect an eval's mutation to the wrong place and would only be noticed through the evals, which Waves 2 and 3 run.
- A golden file generated after any `spine.js` edit would certify the refactor against itself; Wave 1 must not touch `spine.js`.
- The in-memory state store in the test must apply the same transition rules as the real store, or the timelines would not reflect real behavior; the existing spine tests use the same technique.

## Issue Gaps
- ASSUMPTION: no `Issue:` header, so the deliver PR does not close #252; the issue is closed by hand after this plan merges, as its refactor scope is then complete.
- ASSUMPTION: hashing every scenario's timeline, with pinned full transcripts for human reading, is an acceptable substitute for storing every transcript (it keeps the golden file small after plan 4's 3 MB file).
- ASSUMPTION: the scenario grid enumerates outcome sequences up to length 3; the exact gate configurations and targeted scenarios in AC#3 are minimums the executor may extend.
- ASSUMPTION: a helper that returns "stop or null" is an acceptable way to cut the attempt loop, because the original already returns the first stop and `null` on advance.
- ASSUMPTION: line ranges are from the current file and may shift by a few lines; the executor should stay within the two functions and their helpers.
