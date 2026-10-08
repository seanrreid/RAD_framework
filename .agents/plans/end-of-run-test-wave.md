# Plan: End-of-Run Test Wave and tests-missing Stop (#186 part 3c-ii)
Created: 2026-10-08
Author: architect
Status: complete
Completed-At: 2026-10-08T14:02:17Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-08T13:43:32.882Z
Recorded-By: sean@torchcodelab.com
Branch: rad/end-of-run-test-wave
Issue: 186
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/186
Issue-Title: Codex parity for state-changing RAD workflow

## Context
3c-i (PR #207) scoped the per-wave test gate. After wave k, `rad deliver` checks only the Tests-to-Write files promised by waves 1..k; a wave promises a file when one of its tasks lists the path on its `File:` line. That left a gap: Tests-to-Write files that **no** wave promises are never checked during `rad deliver`.

On 2026-10-08 the user decided (3c Q2) to close it with one extra wave at the end of the run:
- If unpromised files are still missing after the last plan wave, run **wave N+1** through the normal wave machinery. Its tasks are the missing files, its events are marked `kind: 'tests'`, and it runs at most once.
- Then check again. If files are still missing, stop with `tests-missing` (class `failed`), listing them.
- The PR body marks that wave "(test wave)".

## Scope
| In scope | Out of scope |
|---|---|
| The spine's optional `testWave` option: a synthetic wave N+1 run through the existing wave body | Populating `wave.tasks` for regular plan waves |
| The final guard and the new `tests-missing` stop | Changing the per-wave gate from 3c-i |
| cli: `unpromisedTests` and a `missingTests` port rooted at the run root | Test-wave capabilities beyond the existing defaults |
| PR body: "(test wave)" marker | The deliver skill (3d) |
| Docs | |

## Acceptance Criteria
1. **The spine option.** `deliverSpine` accepts an optional `testWave = { paths: string[], missing: (paths) => string[] }` (default `null`).
   - **`paths`** are the resolved Tests-to-Write paths that no wave promises.
   - **`missing(paths)`** returns the subset not present in the run root. It is a pure port the cli supplies.
   - **Without `testWave`,** every event, call and result is exactly as today.
2. **The synthetic wave.** After the last plan wave, the spine checks `testWave.missing(testWave.paths)`.
   - **Nothing missing:** no test wave runs and no event is appended.
   - **Files missing:** it runs wave `n = (highest plan wave n) + 1` through the **same** per-wave body as plan waves: approval re-check, token budget, hooks, attempts, matrix, doom loop, per-wave gate and `wave-complete`. That body is factored into a helper the loop calls, rather than duplicated.
   - **The synthetic wave object** is `{ n, type: 'sequential', kind: 'tests', tasks }`. There is one task per missing path: `{ title: 'Write <path>', files: [path], what: 'Write the test file <path> listed in the plan\'s Tests to Write.', validate: '<path> exists' }`.
   - **Its `wave-started` event** carries `kind: 'tests'`.
   - **Its presence gate** checks the plan's promised union plus the synthetic wave's paths. A gate failure demotes to `fail-tests` and retries through the matrix like any wave.
   - **At most once:** if the history already holds `wave-complete` for wave N+1 (on resume), it isn't run again.
   - **Result count:** `{ ok: true, waves }` still reports the plan wave count, so `deliverCompleted` is unchanged.
3. **The final guard.** When `testWave` is supplied, the spine runs `testWave.missing(testWave.paths)` once more after the plan waves and any test wave, before the approval-during-run guard and the post-checks. If anything is missing it calls `stopRun({ stopped: 'tests-missing', ok: false, reason: '<comma-separated paths>' })`. `STOP_TABLE` gains `tests-missing`: class `failed`, decision "test files still missing after the test wave: {detail}; write them on the branch and re-run rad deliver".
4. **cli wiring.**
   - `parsePlanCtx` gains `unpromisedTests`: the resolved `testsToWritePaths` paths that appear in no wave's `testsByWave` list, de-duplicated and in plan order. Unresolvable lines are excluded.
   - `rad deliver` passes `testWave: { paths: planCtx.unpromisedTests, missing }`, where `missing` checks `existsSync(join(root, path))` for each path. When `unpromisedTests` is empty, it passes `null`.
   - The test wave runs with the default model and the plan-level capabilities; no per-wave `Capabilities:` or model line applies to it.
5. **PR body.** pr-body.js renders `### Wave N (test wave)` when that wave's `wave-started` events carry `kind: 'tests'`. Everything else in the body is unchanged.
6. **Tests.**
   - The new `harness/test/spine-test-wave.test.js` (spine-test fakes) covers:
     - no `testWave` → unchanged;
     - nothing missing → no test wave and no events;
     - missing → wave N+1 runs with the right synthetic tasks and `kind: 'tests'`, then advances;
     - its gate failing → `fail-tests` and a retry through the matrix;
     - still missing after a completed test wave → a `tests-missing` stop that lists the paths;
     - resume with N+1 already complete → not re-run, and the final guard still runs;
     - the result's `waves` stays the plan count.
   - stops.test.js covers the `tests-missing` row.
   - pr-body.test.js covers the "(test wave)" marker.
   - cli.test.js covers `parsePlanCtx` `unpromisedTests` and a real deliver where an unpromised file is missing and an injected `runWave` writes it in wave N+1 (exit 0).
   - Every existing harness test, eval and `scripts/test-*.sh` passes. List any changed assertion.
7. **Docs.**
   - docs/rad-wave-contract.md: the `tests-missing` row in the stop table, and a "Test wave" paragraph after "Between-wave checks" replacing 3c-i's "a follow-up" note.
   - docs/rad-cli.md: the per-wave test gate subsection describes the test wave and the stop, and the `rad pr-body` sample shows the marker.

## Agent Scope
Research came from the 3c sub-agent survey (spine loop, wave prompt fields, stops, pr-body rendering, tests, docs) and targeted greps after #207 merged. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/spine.js | 340-385 | Read: `promisedUpTo`, `presenceGate` (3c-i) |
| harness/spine.js | 515-535 | `appendWaveStarted`: carry `kind` |
| harness/spine.js | 600-725 | Options doc and signature: `testWave` |
| harness/spine.js | 735-1210 | Factor the per-wave body into a helper; run the synthetic wave; final guard |
| harness/stops.js | 40-95 | `tests-missing` row |
| harness/cli.js | 665-735 | `parsePlanCtx`: `unpromisedTests` |
| harness/cli.js | 1855-1875 | `deliverSpine` call: pass `testWave` |
| harness/pr-body.js | 80-150 | "(test wave)" marker |
| harness/test/spine-test-wave.test.js | 1-1 | New (AC#6) |
| harness/test/spine-test-scope.test.js | 1-60 | Read only: fakes to copy |
| harness/test/stops.test.js | 80-160 | `tests-missing` row cases |
| harness/test/pr-body.test.js | 1-1 | Marker case (append) |
| harness/test/cli.test.js | 1-1 | `unpromisedTests` and test-wave deliver cases (append) |
| docs/rad-wave-contract.md | 350-460 | Stop row; Test wave paragraph |
| docs/rad-cli.md | 585-615 | Per-wave test gate: test wave and stop |
| docs/rad-cli.md | 435-460 | pr-body sample: the marker |

## Execution Notes

### Do Not Touch
- scripts/check-tests-present.sh, harness/plan-tasks.js: shipped in 3c-i
- harness/transitions.js, harness/gates.*, harness/adapters/git-state-store.js
- harness/adapters/agent/*: the synthetic wave supplies the fields `buildWavePrompt` already reads
- harness/evals/lib/fixture.js: its default plan's Tests-to-Write file is pre-written, so no test wave runs

### Key Files
- harness/spine.js: the wave loop (784 to ~1205), `presenceGate`/`promisedUpTo` (367-385), `appendWaveStarted` (518), the approval-during-run guard (1209), the return (1245)
- harness/adapters/agent/contract.js `buildWavePrompt` (158-280): reads `wave.n`, `wave.type`, `wave.tasks[].title/files/what/validate`
- harness/cli.js `parseTestsByWave` (672-679), `parsePlanCtx` (~688-735), the `deliverSpine` call (~1866)
- harness/pr-body.js `waveNumbers` (85), `waveBlock` (139)

### Reminders
- **Refactor the loop body by moving it.** Extract it into a helper with identical behavior, then call it for both plan waves and the synthetic wave. The ~100 existing spine tests are the safety net; none should change.
- **No `testWave` means byte-identical behavior,** with no new events or calls.
- **The synthetic wave is appended to the iteration, not to `plan.waves`.** `deliverCompleted` and the result's `waves` count stay at the plan's wave count.
- **Fail closed:** the final guard runs whenever `testWave` is supplied, including on resume.
- **Helpers stay under ~40 lines** where practical. The extracted wave body may stay large, but it must not grow.

## Program Design
```js
deliverSpine({ …, testWave = null })   // { paths, missing } | null
runOneWave(wave, loopCtx)              // the extracted per-wave body → a stop result | null (advanced)
syntheticTestWave(n, missingPaths)     // → { n, type:'sequential', kind:'tests', tasks }
```
```
for wave of plan waves: stop = runOneWave(wave) → return stop
if testWave:
  missing = testWave.missing(paths)
  if missing.length && !completed.has(N+1): stop = runOneWave(syntheticTestWave(N+1, missing)) → return stop
  still = testWave.missing(paths); still.length → stopRun(tests-missing, still)
approval-during-run guard → post-checks → pr-opened → afterPr
```

## Wave Plan

### Wave 1 — parallel

#### Task 1.1: Spine test wave and final guard
File: harness/spine.js:340-385, 515-535, 600-725, 735-1210, harness/stops.js:40-95, harness/test/spine-test-wave.test.js:1-1, harness/test/stops.test.js:80-160
What: Implement AC#1, AC#2 and AC#3. Extract the per-wave body into `runOneWave` by moving it with no behavior change, then add the synthetic wave and the final guard. Add the `tests-missing` row and its stops.test.js cases. Write spine-test-wave.test.js covering every spine case in AC#6.
Validate: AC#1, AC#2, AC#3, AC#6 — `node --test harness/test/spine*.test.js harness/test/resume.test.js harness/test/stops.test.js` passes, with no existing assertion changed

#### Task 1.2: PR body marker
File: harness/pr-body.js:80-150, harness/test/pr-body.test.js:1-1
What: Implement AC#5 and its pr-body.test.js case. The existing snapshot must not change.
Validate: AC#5, AC#6 — `node --test harness/test/pr-body.test.js` passes

### Wave 2 — sequential

#### Task 2.1: CLI wiring
File: harness/cli.js:665-735, 1855-1875, harness/test/cli.test.js:1-1
What: Implement AC#4 and the cli.test.js cases from AC#6.
Validate: AC#4, AC#6 — `node --test harness/test/*.test.js`, `node --test harness/evals/*.eval.js` and every `scripts/test-*.sh` pass (report the counts)

### Wave 3 — parallel

#### Task 3.1: Docs
File: docs/rad-wave-contract.md:350-460, docs/rad-cli.md:585-615, 435-460
What: Write AC#7.
Validate: AC#7 — `grep -n 'tests-missing' docs/rad-wave-contract.md docs/rad-cli.md` matches in both files; `grep -n 'test wave' docs/rad-cli.md` matches

## Tests to Write
- [ ] Synthetic test wave, final guard, resume, unchanged without the option — harness/test/spine-test-wave.test.js
- [ ] tests-missing stop row — harness/test/stops.test.js
- [ ] "(test wave)" marker — harness/test/pr-body.test.js
- [ ] unpromisedTests and the test-wave deliver — harness/test/cli.test.js

## Non-Goals
- Populating `wave.tasks` for regular plan waves.
- Per-wave capabilities or a model override for the test wave.
- Running the test wave more than once per feature.
- The deliver skill (3d).

## Out-of-Scope Dependencies
None

## Risks
- **The loop-body refactor touches the busiest code in the harness.** Mitigation: move the body with no changes, and the full existing spine suite must pass unchanged before anything is added.
- **The test-wave agent only gets paths.** Tasks carry the path and a generic "what", while the plan file carries the detail; agents read the plan, as they already do for regular waves.
- **The final guard adds a filesystem check to every run that has unpromised tests.** It's cheap (`existsSync` per path).
- **Self-protected paths** (`harness/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — the final guard uses the cli's `missing` port (`existsSync` under the run root),** not the script. The paths are already resolved by `testsToWritePaths`, which has a parity test with the bash rule.
- **Assumption — on resume, a test wave that already completed is not re-run.** The final guard still checks, so a deleted file gives `tests-missing`, not a second test wave.
- **Assumption — the result's `waves` stays the plan count,** so `deliverCompleted` and `waves=` output keep their meaning. The test wave shows in the event log and the PR body.
- **Assumption — the synthetic task text is generic.** The plan's Tests to Write line already describes each test, and the agent reads the plan.
