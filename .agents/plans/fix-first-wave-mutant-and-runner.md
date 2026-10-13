# Plan: Fix the First-Wave Approval Mutant and Make the Eval Runner Reject Crashing Mutants (#269)
Created: 2026-10-13
Author: architect
Status: pending-review
Branch: rad/fix-first-wave-mutant-and-runner
Issue: 269
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/269
Issue-Title: deliver-after-plan-edit [mutated] is killed by a ReferenceError, not by the first-wave approval gate it targets
Source-Author: seanrreid (OWNER)
Source-Comments: 0 total, 0 non-collaborator

## Context
The adversarial evals prove each guard is load-bearing with a `[mutated]` twin: it disables the guard in the fixture copy and must make the case's assertion fail. #269 found that the `deliver-after-plan-edit [mutated]` twin dies for the wrong reason. Its two patches to `harness/spine.js` land in different functions (the first `for (const wave of waves) {` is in `promisedUnion`, line ~357; the approval check is in `preWaveStop`, line ~740), so `firstWaveOfRun` is declared in one function and read in another and the first wave throws `ReferenceError: firstWaveOfRun is not defined`. It broke when #208 extracted the per-wave body from the loop.

**Evidence gathered while planning (2026-10-13), all in scratch checkouts:**
- Running every eval with a crash detector added to a scratch copy of the runner flagged **exactly one** of the 69 tests, this one (`crash text: is not defined`). So hardening the runner will not break any other mutant.
- Replacing the two patches with **one** patch in `preWaveStop` that keeps its state on the `loop` object makes the mutated run behave as the mutant is meant to: exit 0, no `deliver-stopped`, the adversary agent ran, and `wave-started`, `wave-attempt`, `wave-complete` events. The edited plan is delivered because the first wave skips the re-check, which is the old #151 bug the twin is supposed to restore, and the case's assertions (stop reason `approval-changed`, agent did not run) fail for the right reason, with no crash text. The current broken mutant, by contrast, exits 1, never starts a wave, and its stderr contains the crash.

**What this plan does:** (1) re-anchors the mutant to one patch; (2) moves the "did the mutant crash?" judgment into the shared runner as a small testable function, so a crashing mutant fails loudly for every present and future case, instead of being counted as killed; (3) removes the duplicate crash pattern #271 added to `delivery.eval.js`; (4) documents the rule.

## Scope
| In scope | Out of scope |
|---|---|
| The `deliver-after-plan-edit` mutation: one patch in `preWaveStop` | Any change to `spine.js` or any product code |
| `judgeMutatedRun` and `CRASH_PATTERN` in the eval runner, used for every `[mutated]` twin | Changing any other case's assertions or mutations |
| `delivery.eval.js` imports the shared pattern instead of defining its own | The live lane |
| Unit tests for the new runner function; one doc sentence | Reworking how cases register or run |

## Acceptance Criteria
1. **One patch, right place.** The `deliver-after-plan-edit` mutation makes a single `patch` call on `const reason = await approvalChangeReason({ state, feature, approvalIntact });`, replacing it with a version that skips the check for the run's first wave using state stored on `loop`; the `for (const wave of waves) {` patch is gone.
2. **The mutant dies for the right reason.** With that mutation, the mutated run delivers the first wave despite the edited plan (no `approval-changed` stop, the adversary ran) and the case's assertion fails; no crash text appears in its stderr. (Checked in the implementation by running the case and inspecting the mutated result; the runner check of AC#3 then guards it permanently.)
3. **The runner rejects crashing mutants.** The runner exports `CRASH_PATTERN` and a function `findMutantCrash(result)` that walks a result object for any `stderr` string matching the pattern (ignoring `stdout`, `events` and all other fields) and returns the first match or `null`; and `judgeMutatedRun`, which for a `[mutated]` twin throws "the mutant crashed (<match>) instead of failing its assertion — fix the mutation anchor" when a crash is found, throws the existing "assertion still passed with the guard removed" error when the assertion passes, and otherwise returns normally. `runCase` uses it for every mutated twin.
4. **No other mutant breaks.** `node --test harness/evals/*.eval.js` reports 69 tests with the same 55 passing, 0 failing and 14 skipped as before this plan.
5. **One crash pattern.** `delivery.eval.js` imports `CRASH_PATTERN` from the runner and its local definition is removed; the four test-weakening cases behave exactly as before.
6. **Unit-tested.** `harness/test/eval-runner.test.js` covers `findMutantCrash` and `judgeMutatedRun` with the edge cases in Task 1.1 and passes.
7. **Documented.** `docs/evals.md` states in the mutation rule that a mutant must fail its assertion and not crash, and that the runner enforces it.
8. **Full suite passes.** `scripts/verify-all.sh` passes on the delivered branch.

## Agent Scope
No sub-agents were called. Research was inline (7 tool calls): the runner and the broken mutation, `preWaveStop`, a crash scan of all 69 tests, and two instrumented scratch runs comparing the fixed and current mutants. All experiments used scratch checkouts that were removed; the repository was not modified.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/evals/lib/runner.js | 20-35, 36-60 | Export `CRASH_PATTERN`, `findMutantCrash` and `judgeMutatedRun`; `runCase` calls the latter for mutated twins |
| harness/evals/approval.eval.js | 125-145 | Replace the two patches with one |
| harness/evals/delivery.eval.js | 30-40 | Import `CRASH_PATTERN` from the runner and remove the local constant |
| harness/test/eval-runner.test.js | 1-120 | New. Unit tests for the two new runner functions |
| docs/evals.md | 13-30 | One sentence in the mutation rule |

## Execution Notes

### Do Not Touch
- harness/spine.js and every other product module (the mutation is applied to a fixture copy; the real file is never edited)
- Every other case's `assert` and `mutate`, and the existing assertions in all eval files
- harness/evals/lib/fixture.js

### Key Files
- harness/evals/lib/runner.js — `runCase` (~37) and `defineCases`
- harness/evals/approval.eval.js — the `deliver-after-plan-edit` case and its `patch` and `assumeUnchanged` helpers
- harness/spine.js — `preWaveStop` (~732): `loop` is the function's parameter and is in scope at the approval line
- harness/evals/delivery.eval.js — the test-weakening block added in #271 defines `CRASH_PATTERN` and uses it in `deliverThenScopeCheck`
- docs/evals.md — the "Mutation rule" paragraph

### Reminders
- harness/ is self-protected: architect approval and the last-wave full-suite Verify. Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800` AND `RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- The mutation text for `preWaveStop` that was tried and works: replace the approval line with `const reason = loop.firstWaveSeen ? await approvalChangeReason({ state, feature, approvalIntact }) : (loop.firstWaveSeen = true, null);`. Keep the `assumeUnchanged(root, spine)` call.
- `findMutantCrash` scans only `stderr` strings, anywhere in a nested result (`result.stderr`, `result.cli.stderr`, `result.hook.stderr`, arrays), and skips `events`; it must tolerate `null`, `undefined`, primitives, arrays and cycles-free nested objects.
- The pattern to start from: `ReferenceError|TypeError|SyntaxError|RangeError|command not found|unbound variable|Cannot find module|is not a function|is not defined`. The crash scan above found no false positive on any existing mutant with this list.
- `judgeMutatedRun` must run the crash check before the assertion, so a crashing mutant is reported as a crash, not as a kill.
- Importing `runner.js` from a unit test must not register or run any eval case (registration happens only inside `defineCases`).
- Keep each new function at 40 lines or fewer (the ratchet baseline is empty).

## Program Design

```js
// harness/evals/lib/runner.js
export const CRASH_PATTERN = /ReferenceError|TypeError|SyntaxError|RangeError|command not found|unbound variable|Cannot find module|is not a function|is not defined/;
export function findMutantCrash(result)                 // -> first matching stderr fragment | null
export async function judgeMutatedRun({ id, result, assertFn })
  // crash found            -> throws "<id> [mutated]: the mutant crashed (<match>) instead of failing its assertion — fix the mutation anchor"
  // assertion passes       -> throws "<id> [mutated]: assertion still passed with the guard removed — it does not test the guard"
  // assertion throws       -> returns (the mutant was killed by its assertion)
// runCase(c, { mutated }) calls judgeMutatedRun for the mutated twin; the unmutated path is unchanged.
```

Call stack:

```
defineCases -> test(`${id} [mutated]`) -> runCase(c, { mutated: true }) -> createFixture -> c.mutate -> c.act
            -> judgeMutatedRun({ id, result, assertFn: () => c.assert(fx, result) })
                 -> findMutantCrash(result) -> crash? throw
                 -> assertFn() -> passes? throw : return
```

File tree diff:

```
harness/evals/lib/runner.js          + CRASH_PATTERN, findMutantCrash, judgeMutatedRun; runCase uses it
harness/evals/approval.eval.js       first-wave mutation: 2 patches -> 1
harness/evals/delivery.eval.js       local CRASH_PATTERN -> import
harness/test/eval-runner.test.js     NEW
docs/evals.md                        + one sentence
```

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (1.2 and 1.3 use the runner from 1.1).
Verify: exec bash scripts/verify-all.sh

#### Task 1.1: The runner check and its unit tests
File: harness/evals/lib/runner.js:20-60, harness/test/eval-runner.test.js:1-120
What: Add `CRASH_PATTERN`, `findMutantCrash` and `judgeMutatedRun` as specified in Program Design and make `runCase` use `judgeMutatedRun` for the mutated twin, leaving the unmutated path exactly as it is. Write `eval-runner.test.js` covering: a crash in `result.stderr`; in a nested `result.cli.stderr` and `result.hook.stderr`; inside an array; each pattern alternative; crash text only in `stdout` or in `events` is ignored; an ordinary stderr such as `rad deliver: failed feature=x` is not a crash; `null`, `undefined`, a string, a number and an empty object return `null`; `judgeMutatedRun` rejects a crashing result without running the assertion, rejects when the assertion passes, and resolves when the assertion throws; and the crash message names the case id and the matched fragment.
Validate: AC#3, AC#6 — every listed case is a named assertion; edge cases (null, undefined, primitives, nested, array, stdout-only) are explicit.

#### Task 1.2: Re-anchor the first-wave mutant
File: harness/evals/approval.eval.js:125-145
What: In the `deliver-after-plan-edit` case, delete the `for (const wave of waves) {` patch and replace the second patch with the single `preWaveStop` patch from the Reminders, keeping `assumeUnchanged`. Update the comment above `mutate` to say the exemption is restored in `preWaveStop`. Run the case, and confirm with a temporary local print (not committed) that the mutated run delivered the first wave with the adversary having run and no crash text.
Validate: AC#1, AC#2, AC#4 — the case and its `[mutated]` twin pass; the observed mutated behavior matches AC#2.

#### Task 1.3: One crash pattern, and the doc sentence
File: harness/evals/delivery.eval.js:30-40, docs/evals.md:13-30
What: Replace the local `CRASH_PATTERN` constant in the test-weakening block with an import from `./lib/runner.js` and delete the local definition; its two uses in `deliverThenScopeCheck` are unchanged. Add to the "Mutation rule" paragraph of `docs/evals.md` that a mutant must fail its assertion and must not crash, and that the runner fails a twin whose result carries crash text.
Validate: AC#4, AC#5, AC#7, AC#8 — the scripted lane still reports 69 tests, 55 passing, 0 failing, 14 skipped; the full suite passes.

## Tests to Write
- [ ] `findMutantCrash` and `judgeMutatedRun`, including nested, array, stdout-only and degenerate inputs — harness/test/eval-runner.test.js

## Non-Goals
- Any change to product code
- Auditing every mutant's semantics beyond the crash scan already done (it found one)
- Live-lane changes

## Out-of-Scope Dependencies
None.

## Risks
- The crash scan only inspects `stderr` strings in the returned result; a mutant that crashes inside a helper whose output the case does not return would not be seen. The scan of all 69 tests found one, and cases that return no stderr are unaffected.
- The shared pattern includes phrases such as `is not a function` and `is not defined` that a future legitimate mutant's output might contain; such a twin would fail loudly with a clear message, which is the intended failure mode.
- The mutation edits a fixture copy of `spine.js`; if `preWaveStop`'s approval line is reworded, the `patch` helper throws "anchor not found" (fail-closed), which is the intended signal.

## Issue Gaps
- ASSUMPTION: the first wave of a run is identified by state on `loop` (`firstWaveSeen`), which `deliverSpine` creates once per run, matching the old #151 behavior of exempting the run's first wave.
- ASSUMPTION: scanning `stderr` only (not `stdout`) is enough, because process crashes and shell errors go to stderr.
- ASSUMPTION: sharing one `CRASH_PATTERN` between the runner and the test-weakening cases is acceptable even though the runner's list is broader than the one #271 defined.
- ASSUMPTION: line ranges are from the current files and may shift by a few lines; the executor should stay within the named areas.
