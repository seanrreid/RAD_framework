# Plan: Wave-Scoped Test Presence Gate (#186 part 3c-i)
Created: 2026-10-08
Author: architect
Status: pending-review
Branch: rad/wave-scoped-test-gate
Issue: 186
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/186
Issue-Title: Codex parity for state-changing RAD workflow

## Context
After every wave, `rad deliver` runs `scripts/check-tests-present.sh` as a gate (spine.js:904-918). The gate gets only the plan path (`SCRIPT_ARGS`, cli.js:301), so it checks **every** file in the plan's Tests to Write, not just the files that wave was meant to write. The resume-verify check (spine.js:761-767) does the same.

That causes a latent bug. If a later wave creates a test file, every earlier wave fails the gate, is demoted to `fail-tests`, and is retried until the budget or the doom-loop breaker stops the run. The comment at spine.js:336 says the gate blocks "AT the wave that promised it"; the code doesn't do that. It also means the planned 3c test wave could never run, because a missing Tests-to-Write file can't survive past the last wave.

The user decided on 2026-10-08 (3c Q1) to scope the gate. After each wave, it checks only the test files promised by the waves completed so far. A wave promises a file when the path appears in the `File:` line of one of its tasks.

3c is split in two:
- **3c-i (this plan)** scopes the gate.
- **3c-ii** adds the end-of-run test wave N+1 for files no wave promised (Q2, decided) and the `tests-missing` stop.

## Scope
| In scope | Out of scope |
|---|---|
| `taskFilesByWave(text)`: the task `File:` paths grouped by wave | The end-of-run test wave and the `tests-missing` stop (3c-ii) |
| `check-tests-present.sh --only <path>...`: a backward-compatible filter | Changing how plans are parsed for `state.plan()` |
| cli computes `testsByWave` and passes it to the spine | The prose `/rad-deliver` and `/rad-review` calls (they keep the single-argument form) |
| The spine gate and resume-verify check only the promised files when `testsByWave` is supplied | |
| Docs: the per-wave test gate | |

## Acceptance Criteria
1. **Tasks grouped by wave.** `taskFilesByWave(text)` in plan-tasks.js returns `Map<waveNumber, string[]>`: the `File:` paths of the tasks under each `### Wave N` heading.
   - Paths are parsed with the existing `parseFileLine`; only the first `File:` line of a task counts, as in `taskFilesFromPlanText`.
   - Tasks before any wave heading are ignored.
   - Non-string input throws `TypeError`.
   - `taskFilesFromPlanText` is unchanged.
2. **The script filter.** `scripts/check-tests-present.sh <plan> [--only <path>...]`:
   - **Without `--only`:** behavior and output are exactly as today.
   - **With `--only`:**
     - only the Tests-to-Write files whose resolved path is in the `--only` list are checked;
     - other lines, including unresolvable ones, are ignored;
     - when no listed path is in Tests to Write, it prints `✓ Test check passed: <plan> (no promised tests yet)` and exits 0;
     - a missing filtered file exits 1 with the existing "Missing" output.
   - `--only` with no paths is a usage error (exit 2), as is an unknown flag.
3. **cli wiring.** `parsePlanCtx` gains `testsByWave: Record<number, string[]>`, built from `taskFilesByWave` intersected with `testsToWritePaths(...)` (resolved paths only). A wave keeps a test file only if one of its tasks lists that exact path. `rad deliver` passes `testsByWave` to `deliverSpine`. In `SCRIPT_ARGS`, `check-tests-present.sh` becomes `(c, only) => [c.planPath, ...(Array.isArray(only) ? ['--only', ...only] : [])]`.
4. **The spine.** `deliverSpine` accepts an optional `testsByWave` (default `null`).
   - **Supplied:** after wave k, the gate checks the union of the promised files of waves 1..k (the plan's waves numbered ≤ k). If that union is empty, the gate is skipped (no `sh` call) and the wave advances. Otherwise it calls `sh('scripts/check-tests-present.sh', promisedPaths)`.
   - **Resume-verify:** it checks the union of the completed waves' promised files in the same way, skipped when empty.
   - **Absent (`null`):** every call and argument is exactly as today (`sh(script, feature)`), so all existing spine tests pass unchanged.
   - The spine.js:336 comment matches the new behavior.
5. **Tests.**
   - plan-tasks.test.js covers `taskFilesByWave`: two waves, a task with several files, a task outside any wave, and a non-string input.
   - `scripts/test-check-tests-present.sh` gains:
     - `--only` with the listed file present (exit 0) and missing (exit 1);
     - `--only` for a path not in Tests to Write (exit 0, "no promised tests yet");
     - `--only` filtering out an unresolvable line (exit 0);
     - `--only` with no paths and an unknown flag (each exit 2).
   - The new `harness/test/spine-test-scope.test.js` uses the spine-test fakes. It covers:
     - a test file promised by wave 2 doesn't fail wave 1 (the regression);
     - a wave that promised a file and didn't write it fails at that wave (`fail-tests`);
     - the union grows across waves;
     - an empty union skips the gate;
     - resume-verify checks only the completed waves' files;
     - an absent `testsByWave` keeps the legacy `sh(script, feature)` call.
   - cli.test.js: `parsePlanCtx` builds `testsByWave` (a Tests-to-Write file promised by wave 2, one promised by no wave), and the real-deliver argv test asserts `--only` when a wave promised a test.
   - Every existing harness test, eval and `scripts/test-*.sh` passes. List any changed assertion.
6. **Docs.** docs/rad-wave-contract.md "Between-wave checks" describes the per-wave test gate: promised files only, the empty-union skip, and that files no wave promised are left to the end of the run (3c-ii). docs/rad-cli.md documents `check-tests-present.sh --only` wherever the script is described for `rad deliver`.

## Agent Scope
Research came from a read-only sub-agent survey of the spine gate and resume-verify, `parsePlan` and plan-tasks.js, the script port and SCRIPT_ARGS, check-tests-present.sh and its callers, the affected tests and evals, and the docs. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/plan-tasks.js | 1-54 | `taskFilesByWave` |
| harness/test/plan-tasks.test.js | 1-1 | New `taskFilesByWave` cases (append) |
| harness/pr-body.js | 105-130 | Read only: `testsToWritePaths` |
| scripts/check-tests-present.sh | 1-112 | `--only` filter |
| scripts/test-check-tests-present.sh | 1-196 | New `--only` cases |
| harness/cli.js | 296-310 | `SCRIPT_ARGS` check-tests-present entry |
| harness/cli.js | 660-715 | `parsePlanCtx`: `testsByWave` |
| harness/cli.js | 1815-1850 | `deliverSpine` call: pass `testsByWave` |
| harness/spine.js | 330-340 | POST_CHECKS comment |
| harness/spine.js | 565-665 | Options doc and signature: `testsByWave` |
| harness/spine.js | 755-770 | Resume-verify uses the completed waves' union |
| harness/spine.js | 900-920 | Per-wave gate uses the union of waves 1..k |
| harness/test/spine-test-scope.test.js | 1-1 | New (AC#5) |
| harness/test/spine-prepare.test.js | 20-70 | Read only: fakes to copy |
| harness/test/cli.test.js | 1410-1435 | The argv assertion for check-tests-present |
| harness/test/cli.test.js | 540-560 | Read: `seedApprovedTwoWavePlan` |
| docs/rad-wave-contract.md | 425-445 | Between-wave checks: the per-wave test gate |
| docs/rad-cli.md | 595-612 | Deliver: the test gate and `--only` |

## Execution Notes

### Do Not Touch
- harness/adapters/git-state-store.js (`parsePlan`): `state.plan()` keeps returning `{ n, heading }` waves
- harness/stops.js: there is no new stop in this part
- .claude/commands/team/rad-deliver.md, .claude/commands/team/rad-review.md, .rad/skills/*, .agents/skills/*: the prose callers keep the single-argument form
- harness/evals/lib/fixture.js: its default plan promises no test from a wave, so the gate is skipped there; don't change it

### Key Files
- harness/spine.js: the gate (904-918), resume-verify (761-767), the wave loop (734+), the `waveVerify` option as the pattern for a per-wave map
- harness/cli.js `parsePlanCtx` (669-710), `parseWaveVerify` (575-595) as the per-wave parsing pattern, `SCRIPT_ARGS` (299-309), `makeSpineScriptPort` (1655-1661: `sh(join(repoRoot, script), build(scriptCtx, arg), { cwd: root })`)
- harness/plan-tasks.js `TASK_HEADER`, `parseFileLine`, `taskFilesFromPlanText`
- scripts/check-tests-present.sh: parsing loop 37-62, empty-section rule 64-69

### Reminders
- **Backward compatibility is the contract.** No `--only` means today's script behavior. No `testsByWave` means today's spine calls. The prose callers and the ~100 existing spine tests rely on it.
- **Paths match exactly,** after the same resolution both sides use: backticks stripped, trimmed, one annotation stripped.
- **Fail closed:** a gate the spine runs and that returns non-zero still demotes to `fail-tests`. Skipping is allowed only for an empty promised set.
- **Helpers stay under ~40 lines, with named constants.**

## Program Design
```js
// harness/plan-tasks.js
export function taskFilesByWave(text)            // → Map<number, string[]>
// harness/cli.js
parsePlanCtx(text).testsByWave                    // Record<number, string[]>, test paths each wave promised
// harness/spine.js
deliverSpine({ …, testsByWave = null })
promisedUpTo(testsByWave, waves, k)               // union of promised paths for plan waves with n <= k
```
```
wave k advances → testsByWave ? (union empty ? skip : sh(check-tests-present, union)) : sh(check-tests-present, feature)
SCRIPT_ARGS: (c, only) => [planPath, ...(Array.isArray(only) ? ['--only', ...only] : [])]
```

## Wave Plan

### Wave 1 — parallel

#### Task 1.1: taskFilesByWave
File: harness/plan-tasks.js:1-54, harness/test/plan-tasks.test.js:1-1
What: Implement AC#1 and its plan-tasks.test.js cases (append to the existing file).
Validate: AC#1, AC#5 — `node --test harness/test/plan-tasks.test.js` passes

#### Task 1.2: check-tests-present.sh --only
File: scripts/check-tests-present.sh:1-112, scripts/test-check-tests-present.sh:1-196
What: Implement AC#2 and its script test cases. Keep the no-flag path byte-for-byte unchanged in behavior and output.
Validate: AC#2, AC#5 — `bash scripts/test-check-tests-present.sh` passes, existing cases included; `bash scripts/test-script-hardening.sh` passes

#### Task 1.3: Spine scoping
File: harness/spine.js:330-340, 565-665, 755-770, 900-920, harness/test/spine-test-scope.test.js:1-1
What: Implement AC#4 with a small `promisedUpTo` helper, and write spine-test-scope.test.js covering every spine case in AC#5.
Validate: AC#4, AC#5 — `node --test harness/test/spine-test-scope.test.js harness/test/spine.test.js harness/test/resume.test.js` passes

### Wave 2 — sequential

#### Task 2.1: CLI wiring
File: harness/cli.js:296-310, 660-715, 1815-1850, harness/test/cli.test.js:1410-1435
What: Implement AC#3, using `taskFilesByWave` from plan-tasks.js and `testsToWritePaths` from pr-body.js. Update the argv assertion and add the `parsePlanCtx` `testsByWave` cases.
Validate: AC#3, AC#5 — `node --test harness/test/*.test.js` and `node --test harness/evals/*.eval.js` pass, and every `scripts/test-*.sh` passes (report the counts)

### Wave 3 — parallel

#### Task 3.1: Docs
File: docs/rad-wave-contract.md:425-445, docs/rad-cli.md:595-612
What: Write AC#6.
Validate: AC#6 — `grep -n 'promised' docs/rad-wave-contract.md` matches and `grep -n -- '--only' docs/rad-cli.md` matches

## Tests to Write
- [ ] Spine gate scoped to promised files; regression for a later-wave test file — harness/test/spine-test-scope.test.js
- [ ] taskFilesByWave cases — harness/test/plan-tasks.test.js
- [ ] check-tests-present.sh --only cases — scripts/test-check-tests-present.sh

## Non-Goals
- The end-of-run test wave for files no wave promised, and the `tests-missing` stop (3c-ii).
- Populating `wave.tasks` for agent prompts from the plan.
- Changing the prose deliver and review callers of `check-tests-present.sh`.

## Out-of-Scope Dependencies
None

## Risks
- **Until 3c-ii lands, nothing checks files that no wave promised.** Today they're checked after every wave; after this part, nothing checks them during `rad deliver`. `rad pr-body` and the prose review still list them as missing. Mitigation: 3c-ii follows directly. The PR body's Tests to Write section already shows ✗ for a missing file.
- **Path matching is exact.** A task `File:` path written differently from the Tests-to-Write path (for example `./harness/…`) counts as not promised. It then falls to the end of the run instead of failing early, which is the safe direction.
- **Self-protected paths** (`harness/`, `scripts/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — a wave promises a test file only through its tasks' `File:` lines.** Tests to Write lines carry no wave number, so `File:` is the only per-wave link in the plan format.
- **Assumption — an empty promised set skips the gate entirely,** rather than calling the script with an empty filter. That saves a process call and keeps `--only` with no paths a usage error.
- **Assumption — `--only` ignores unresolvable lines.** They can't be promised by path; the end-of-run check (3c-ii) still reports them.
- **Assumption — cli resolves Tests-to-Write paths with `testsToWritePaths`** from pr-body.js, which mirrors the bash rule and has a parity test, rather than duplicating the parser.
