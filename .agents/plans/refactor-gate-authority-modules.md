# Plan: Refactor the Gate, Transition, Hook and Worktree Modules Under the Ratchet (#252, part 4 of 6)
Created: 2026-10-13
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-13T14:49:52.228Z
Recorded-By: sean@torchcodelab.com
Branch: rad/refactor-gate-authority-modules
Adopted-From: #252 part 4 of 6 (refactor harness/gates.js, transitions.js, hook-runner.js and adapters/worktree.js; the issue stays open until all six plans land)
Issue-Title: Refactor over-long core functions (runOneWave, createGitStateStore, deliverCommand, ...)
Source-Author: none (no source issue)
Source-Comments: none

## Context
Plan 4 of the six-plan decomposition of #252 (plans 1-3 merged as #261, #263, #264). The ratchet baselines five offenders in four small files:

| Function | File | Lines | Role |
|---|---|---|---|
| `validateTransition` | `transitions.js` | 73 | The legal-move rules for the event log (approval authority) |
| `evaluateGate` | `gates.js` | 46 | "The only gate fold": decides whether `deliver` may run |
| `createHookRunner` and its inner `runHooks` | `hook-runner.js` | 121 and 101 | Runs operator hooks; veto points fail closed, observe points fail open |
| `makeWorktreeLifecycle` | `adapters/worktree.js` | 54 | Translates worktree lifecycle intents into script calls |

`transitions.js` and `gates.js` are the approval-gate authority, so this plan is the most security-relevant of the six. The work is **behavior-preserving**, and the safety net is the same shape as plans 1-3, tightened for authority code: Wave 1 adds a **characterization test recorded from the unmodified modules**, and for the pure rule code (`validateTransition`, `evaluateGate`) it is **exhaustive**: a generated cross-product of event types, history phases, fingerprint states and role presence, not a hand-picked sample. Waves 2 and 3 refactor; the same test must pass unchanged. No existing test is edited, moved or deleted.

The gate-authority files (Wave 2) and the hook and worktree files (Wave 3) are refactored in separate waves so a failure is attributable.

**Header note.** No `Issue:` header, so the deliver PR does not carry a closing reference to #252 (closed by hand after plan 6).

**Anchors that must survive.** `docs/invariants.yaml` anchors: in `gates.js` the literal `export function evaluateGate` and the error text `No gate rule declared for gate`; in `hook-runner.js` the symbols `VETO_ABORT_OUTCOME` and `createHookRunner`. `scripts/lint-invariants.sh` fails if any disappears.

## Scope
| In scope | Out of scope |
|---|---|
| Splitting the five offenders into small named helpers inside their own files | Any change to results, thrown errors or messages, the `rule` names on `TransitionError`, exports or signatures |
| A characterization test (exhaustive for the pure rule code) and its golden data | Editing, moving or deleting any existing test |
| Regenerating the lint baseline so the five entries (and the nested one) disappear | The other 7 offenders (plans 5-6) |
| | `gates.yaml`, `matrix.yaml` and every rule's meaning |

## Acceptance Criteria
1. **Characterization recorded first.** `harness/test/core-characterization.test.js` runs the scenario sets in Tasks 1.1-1.3 against `harness/test/fixtures/core-golden.json`, generated from the unmodified modules in Wave 1 and not regenerated after Wave 2 begins.
2. **Transitions identical, exhaustively.** For every combination in the generated cross-product (each known event type; histories representing no events, planned, approved, in-progress, delivered and done; with and without prior evaluator output; prior approval with no fingerprint, the same fingerprint and a different fingerprint; the new event with no fingerprint, the same and a different one; with and without a frozen `role`; plus a missing or `null` `currentState`), `validateTransition` returns normally or throws a `TransitionError` with exactly the golden message and `rule`. The rule that wins when several apply is part of the record.
3. **Gate evaluation identical, exhaustively.** For every combination of rule presence, supported and unsupported `condition`, history shape (array, non-array, containing `null` entries), matching event with and without `recordedBy`, role matches and mismatches, with and without a `roleOf` override, and the first-match case with two matching events, `evaluateGate` returns exactly the golden result or throws exactly the golden error. The default-rules path (reading the real `gates.yaml`) is recorded too.
4. **Hook runner identical.** For every veto-capable point and every observe-only point, plus an unknown point, with scripted hook results (clean exit with `success`, with each other vocabulary token, with an out-of-vocabulary token, with empty stdout, non-zero exit, a thrown error, a non-numeric status, non-string stdout; one hook and several in order), `runHooks` returns exactly the golden result, including first-veto-wins, observe fail-open and the recorded `failures`; the `sh` calls (hook, argv, env) equal the golden record.
5. **Worktree lifecycle identical.** `create`, `complete`, `preserve`, `reactivate` and `readMarker` produce the golden script arguments (with and without an explicit directory), return values, error messages (script failure with stderr, with stdout only, with no output; no marker; wrong marker status; malformed marker) and marker file contents.
6. **Public surface unchanged.** Each module's exports (including `OUTCOME_VOCAB`, `VETO_POINTS`, `OBSERVE_POINTS`, `VETO_ABORT_OUTCOME`, `TransitionError`) and signatures are unchanged; no file outside the four modules, the new test files and the baseline is modified.
7. **Anchors intact.** `bash scripts/lint-invariants.sh` passes.
8. **Ratchet shrinks.** After `--write-baseline`, the five offenders and the nested `runHooks` entry are gone, no new entry for these files appears (every helper is 40 lines or fewer), and `node scripts/lint-function-length.mjs` exits 0.
9. **Existing tests untouched.** `git diff` shows no change to any existing test file, and the whole existing suite passes.
10. **Full suite passes.** `scripts/verify-all.sh` passes on the delivered branch.

## Agent Scope
No sub-agents were called. Research was inline (8 tool calls): the baseline entries and sizes of the four files, the invariant anchors, and a full read of `evaluateGate`, `validateTransition`, `createHookRunner` and `makeWorktreeLifecycle`.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/transitions.js | 40-136 | `validateTransition` split into one helper per rule, applied in the same order |
| harness/gates.js | 55-122 | `evaluateGate` split into rule lookup, match and result-building helpers |
| harness/hook-runner.js | 100-251 | `createHookRunner` and `runHooks` hoisted into module-level helpers |
| harness/adapters/worktree.js | 14-102 | `makeWorktreeLifecycle` methods hoisted into module-level helpers |
| harness/test/core-characterization.test.js | 1-280 | New. The generators, scenario sets and comparison to the golden file |
| harness/test/fixtures/core-golden.json | 1-1 | New. Golden results generated from the unmodified modules |
| scripts/lint-function-length-baseline.txt | 1-45 | Regenerated with `--write-baseline` |

## Execution Notes

### Do Not Touch
- Every existing test file, including the gate, transition, hook-runner and worktree tests
- harness/gates.yaml, harness/matrix.yaml, harness/events.js, harness/spine.js, harness/cli.js and the other consumers (their imports and call shapes must keep working)
- scripts/worktree-lifecycle.sh, scripts/lint-function-length.mjs, docs/invariants.yaml

### Key Files
- harness/transitions.js — `validateTransition` (~64), `TransitionError`, `EVALUATOR_TYPES`, `TERMINAL_PHASES`
- harness/gates.js — `evaluateGate` (~77), `eventHasRole`, `loadGates`
- harness/hook-runner.js — `createHookRunner` (~120), `parseOutcomeToken`, `defaultDiscover`, the exported vocabularies
- harness/adapters/worktree.js — `makeWorktreeLifecycle` (~30), `readMarker`, `withDir`
- docs/invariants.yaml — the anchors listed in Context

### Reminders
- harness/ is self-protected: architect approval and the last-wave full-suite Verify. Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800` AND `RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- **Wave 1 must not edit any of the four modules.** The golden data records current behavior; generating it after any refactor defeats the point.
- **Generate the pure-rule cross-products in code**, not by hand: build the event-type list from the typedef in `harness/events.js` (and add an unknown type), build histories for each phase with the events `phaseOf` needs, and iterate every combination. Record each outcome as a short stable string (`ok`, or `throw:<rule>:<message>`); the golden file may be large and is stored on one line.
- Make everything else deterministic: stub `sh`, `discover` and the clock; use temporary directories for the worktree marker scenarios and replace their paths with `<DIR>`; never record a time or a pid.
- In `validateTransition` keep the rule order (a) terminal, (b) wave-complete, (c) revision-requested, (d) duplicate approved, (e) missing role, the first throw winning, and keep every message and `rule` string.
- In `evaluateGate` keep the order: rule lookup (and its error), destructuring, history normalization, the `condition` check, then the first matching event; keep the `satisfiedBy` object's conditional `recordedBy` spread.
- In `runHooks` keep first-veto-wins (stop at the first veto), observe-point fail-open, the exact `failures` reasons (`threw`, `exit N`, `empty-stdout`, `bad-token:<t>`) and the call `sh(hook, argv, { env })`.
- `loadGates()` as a default parameter is evaluated per call; do not hoist it.
- Run `node scripts/lint-function-length.mjs` before finishing each refactor wave; the baseline is regenerated only in Wave 4.

## Program Design

Helper signatures (module-private; names are a guide, the executor may refine them while keeping every function at 40 lines or fewer):

```js
// transitions.js  (each returns void or throws TransitionError, applied in order)
checkAfterTerminal(event, phase)
checkWaveComplete(event, phase)
checkRevisionRequested(event, history)
checkDuplicateApproved(event, history)
checkApprovedHasRole(event)

// gates.js
requireRule(gates, name)                       // -> rule | throws "No gate rule declared for gate '<name>'"
requireSupportedCondition(name, rule)          // -> void | throws the unsupported-condition error
findSatisfyingEvent(events, rule, roleOf)      // -> first matching event | undefined
satisfiedResult(rule, match)                   // -> { passed: true, ... }
unsatisfiedResult(rule)                        // -> { passed: false, ... }

// hook-runner.js
hookInputs(point, ctx)                         // -> { argv, env }
invokeHook(sh, hook, argv, env)                // -> { threw, status, stdout }
applyObservedHook(result, hook, run)           // fail-open: record ran/failures
applyVetoHook(result, hook, run)               // fail-closed: returns true when the loop must stop
runHooksAt(deps, point, ctx)                   // module-level body of runHooks

// adapters/worktree.js
runLifecycleScript(sh, args)                   // -> result | throws the failure message
createWorktree(sh, feature, branch)            // -> dir
removeWorktree(sh, feature, dir) / preserveWorktree(sh, feature, dir)
reactivateWorktree(dir)                        // -> dir
```

Call stack:

```
append (store) -> validateTransition -> checkAfterTerminal -> checkWaveComplete -> checkRevisionRequested
                                        -> checkDuplicateApproved -> checkApprovedHasRole
gate (store)   -> evaluateGate -> requireRule -> requireSupportedCondition -> findSatisfyingEvent
                                  -> satisfiedResult | unsatisfiedResult
spine          -> createHookRunner().runHooks -> runHooksAt -> hookInputs -> (invokeHook -> applyObservedHook | applyVetoHook)*
spine          -> makeWorktreeLifecycle(...).create/complete/preserve/reactivate -> runLifecycleScript
```

File tree diff:

```
harness/transitions.js, gates.js, hook-runner.js, adapters/worktree.js   5 offenders split into ~18 helpers
harness/test/core-characterization.test.js                               NEW
harness/test/fixtures/core-golden.json                                   NEW
scripts/lint-function-length-baseline.txt                                - 6 entries
```

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (1.3 generates the data the assertions use).
Verify: node --test harness/test/core-characterization.test.js

#### Task 1.1: Pure-rule characterization (transitions and gates)
File: harness/test/core-characterization.test.js:1-280
What: Write the two exhaustive halves. For `validateTransition`, generate the cross-product described in AC#2 and compare each recorded outcome string to `core-golden.json`, including the cases that pin the rule order (an event that violates two rules at once) and the `#228` re-approval after delivery (legal) versus after `done` (illegal). For `evaluateGate`, generate the cross-product described in AC#3 using explicit rule objects (so no disk read), plus a small set that calls it with the default rules from the real `gates.yaml`; record results and thrown error messages.
Validate: AC#1, AC#2, AC#3 — every generated combination has a golden entry; a deliberately wrong golden value makes the test fail (checked once by hand, not committed).

#### Task 1.2: Hook runner and worktree characterization
File: harness/test/core-characterization.test.js:1-280
What: Write the `createHookRunner` scenarios (AC#4) with a stub `sh` that returns scripted results or throws and a stub `discover`, recording the result and the `sh` call records; and the worktree scenarios (AC#5) with a stub `sh` and temporary directories for the marker, recording script arguments, return values, error messages and marker file text.
Validate: AC#1, AC#4, AC#5 — every scenario has a golden entry and an assertion.

#### Task 1.3: Generate the golden file
File: harness/test/fixtures/core-golden.json:1-1
What: Add an `UPDATE_GOLDEN=1` mode, run the test once with it against the **unmodified** modules to write `core-golden.json`, commit it, then run the test without the variable twice in a row and confirm both pass.
Validate: AC#1 — the golden file exists, the test passes on two consecutive runs, and `git diff` shows the four modules untouched in this wave.

### Wave 2 — sequential
Tasks in this wave must run in sequence (each edits one authority file).
Verify: npm test --prefix harness

#### Task 2.1: Split validateTransition
File: harness/transitions.js:40-136
What: Extract `checkAfterTerminal`, `checkWaveComplete`, `checkRevisionRequested`, `checkDuplicateApproved` and `checkApprovedHasRole` as in Program Design. `validateTransition` computes `history` and `phase` as today and calls the five in order. Keep every message, every `rule` string and the `{ event, rule }` payload.
Validate: AC#2, AC#6, AC#9 — the exhaustive transition characterization and the existing transition tests pass unchanged; no behavior change, so no new tests.

#### Task 2.2: Split evaluateGate
File: harness/gates.js:55-122
What: Extract `requireRule`, `requireSupportedCondition`, `findSatisfyingEvent`, `satisfiedResult` and `unsatisfiedResult`. `evaluateGate` keeps its signature and default parameters (including `gates = loadGates()` evaluated per call) and the order in the Reminders; `export function evaluateGate` stays a literal in the file.
Validate: AC#3, AC#6, AC#7, AC#9 — the exhaustive gate characterization and the existing gate tests pass unchanged; `scripts/lint-invariants.sh` passes; no behavior change, so no new tests.

### Wave 3 — sequential
Tasks in this wave must run in sequence.
Verify: npm test --prefix harness

#### Task 3.1: Split the hook runner
File: harness/hook-runner.js:100-251
What: Hoist `runHooks` into a module-level `runHooksAt(deps, point, ctx)` with the helpers `hookInputs`, `invokeHook`, `applyObservedHook` and `applyVetoHook`; `createHookRunner` keeps its options and defaults and returns `{ runHooks }`. Keep `VETO_ABORT_OUTCOME` and the final `export { ... }` line exactly.
Validate: AC#4, AC#6, AC#7, AC#9 — the characterization and existing hook tests pass unchanged; `scripts/lint-invariants.sh` passes; no behavior change, so no new tests.

#### Task 3.2: Split the worktree lifecycle
File: harness/adapters/worktree.js:14-102
What: Hoist the four lifecycle methods and the `run` helper into module-level functions that take `sh`; `makeWorktreeLifecycle` keeps its ports and returns the same object (`create`, `complete`, `preserve`, `reactivate`, `readMarker`), still ignoring `now` as today.
Validate: AC#5, AC#6, AC#9 — the characterization and existing worktree tests pass unchanged; no behavior change, so no new tests.

### Wave 4 — sequential
Tasks in this wave must run in sequence.
Verify: exec bash scripts/verify-all.sh

#### Task 4.1: Refresh the ratchet baseline
File: scripts/lint-function-length-baseline.txt:1-45
What: Run `node scripts/lint-function-length.mjs --write-baseline` and commit the result. Confirm the diff only removes entries for the four modules, that no new entry for them appears, and that `node scripts/lint-function-length.mjs` exits 0.
Validate: AC#8 — the baseline diff only removes those lines; the lint exits 0.

#### Task 4.2: Full-suite check
File: scripts/lint-function-length-baseline.txt:1-45
What: No further edit. The wave's Verify runs the full suite.
Validate: AC#10 — `scripts/verify-all.sh` passes.

## Tests to Write
- [ ] Exhaustive characterization of `validateTransition` and `evaluateGate`, and scenario characterization of the hook runner and worktree lifecycle, against golden data from the unmodified modules — harness/test/core-characterization.test.js

## Non-Goals
- Changing any rule, message, `rule` name, result shape, export or signature
- Editing, moving or deleting an existing test
- Refactoring anything outside the four modules
- Changing `gates.yaml`, the matrix or any hook point vocabulary

## Out-of-Scope Dependencies
None.

## Risks
- These are the approval-gate rules. A wrong early return or a reordered check could let an illegal event through or block a legal one; the exhaustive cross-product, the recorded winning rule, and the existing tests are the controls.
- The cross-product is built from the event types known today. A type added later is not covered; the generator reads the typedef so it grows with it, but the golden file does not regenerate itself.
- The golden file for the pure rule code can be large (hundreds of KB on one line); that is acceptable because it is a single declared path and reviewers read the generator, not the data.
- `runHooks` ordering (first-veto-wins, `break` semantics) is subtle control flow; the hook scenarios pin it, and the spine's own tests exercise it end to end.
- A golden file generated after any module edit would certify the refactor against itself; Wave 1 must not touch the modules.

## Issue Gaps
- ASSUMPTION: no `Issue:` header, so the deliver PR does not close #252; the issue is closed by hand after plan 6.
- ASSUMPTION: five separate rule-check helpers in `transitions.js` are acceptable even though the original is one function; the order of application, the first throw winning, is the behavior to preserve.
- ASSUMPTION: "exhaustive" means every combination of the dimensions listed in AC#2 and AC#3, not every possible event payload; fields the rules never read are not varied.
- ASSUMPTION: the worktree module's `now` port stays unused (`void now`) as today.
- ASSUMPTION: line ranges are from the current files and may shift by a few lines; the executor should stay within the named functions and their helpers.
