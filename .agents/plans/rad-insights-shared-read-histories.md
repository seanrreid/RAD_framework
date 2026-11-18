# Plan: rad-insights shared readHistories (Plan I: consolidate the feature->events reader, #330)
Created: 2026-11-18
Author: developer
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-11-18T16:59:58.942Z
Recorded-By: sean@torchcodelab.com
Branch: rad/rad-insights-shared-read-histories
Issue: 330
Source-Author: seanrreid (OWNER)
Source-Comments: 0 total, 0 non-collaborator

## Context
Three insights modules each build a `{ feature: events[] }` map. `harness/insights-prompt-surfaces.js` exports `readHistories` (`listFeatures` + `readHistory`, features sorted, fail-closed); `harness/insights-rework-load.js` has a local copy with the same behavior (a loop instead of `Object.fromEntries`); `harness/insights-human-corrections.js` has a third that walks `readdirSync` unsorted and parses with `parseEventLog` from `harness/human-corrections.js`. Measured differences for the third: `parseEventLog` throws `<log>: line N: malformed JSON (<message>)` where `readHistory` lets the raw `JSON.parse` error through, and it skips whitespace-only lines where `readHistory` skips only empty ones; `harness/test/insights-human-corrections.test.js` asserts `/events\.jsonl: line 1: malformed JSON/`. Nothing else in the repo calls `readHistories` (grep over `.js`, `.sh`, `.md` outside plans and logs), so moving it breaks no importer. `harness/insights-state.js` (49 lines) already exports `listFeatures`, `readHistory` and `readAllHistory`.

## Scope
| In scope | Out of scope |
|---|---|
| Export one `readHistories(stateDir)` from `harness/insights-state.js`, with tests | The other modules that loop `listFeatures` + `readHistory` for a per-feature fold (blocked-reasons, blocked-files, cycle-time, reliability, usage-cost) |
| Use it in `insights-prompt-surfaces.js` and `insights-rework-load.js`, deleting their copies | Changing any module's output, error text or ordering |
| Keep `insights-human-corrections.js` on its own reader and say why in a comment | Making `readHistory` and `parseEventLog` agree on error text or blank-line handling |

## Acceptance Criteria
1. `harness/insights-state.js` exports `readHistories(stateDir)` returning `{ <feature>: events[] }` with keys in sorted feature order, for exactly the features `listFeatures` returns, each parsed by `readHistory` (so a malformed line throws the JSON error and a valid-JSON non-object line throws an error naming the file and 1-based line); a missing state dir returns `{}`.
2. `insights-prompt-surfaces.js` and `insights-rework-load.js` import `readHistories` from `insights-state.js` and define none of their own; `insights-prompt-surfaces.js` no longer exports one; every import that becomes unused is removed. Their existing parity and edge tests pass unchanged, so output is byte-identical.
3. `insights-human-corrections.js` keeps its own reader, and a comment above it states why it does not use the shared helper (its `<log>: line N: malformed JSON (...)` error text and skip-whitespace-only-lines behavior are asserted by its tests); its tests and goldens pass unchanged.
4. `harness/test/insights-state.test.js` covers `readHistories`: missing dir, empty log (feature present with `[]`), a dir without a log skipped, sorted keys, a malformed line throwing, and a JSON-null line failing closed with the file and line in the message.
5. `bash scripts/verify-all.sh` passes.

## Agent Scope
Developer role, no architect-only agents. Research was done directly (the issue, the three readers, `parseEventLog`, the human-corrections test assertions, a repo-wide grep for `readHistories`).

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/insights-state.js | 38-49 | Add the shared `readHistories` export |
| harness/test/insights-state.test.js | 60-89 | Add the `readHistories` tests |
| harness/insights-prompt-surfaces.js | 10-14, 100-116 | Import the shared helper, delete the local export |
| harness/insights-rework-load.js | 12-42 | Import the shared helper, delete the local copy |
| harness/insights-human-corrections.js | 17-30 | Comment only: why this reader stays separate |

## Program Design
```
// harness/insights-state.js
/** Every feature's events keyed by feature, sorted; fail-closed per readHistory. */
export function readHistories(stateDir) {
  return Object.fromEntries(listFeatures(stateDir).map((f) => [f, readHistory(stateDir, f)]));
}
```
Added files: none. Changed: the state module and its test, two fold modules, one comment. Deleted: two local functions. No generated copies and no skill text change.

## Execution Notes

### Do Not Touch
- harness/human-corrections.js (`parseEventLog`), harness/delivery-history.js and every fold's output: behavior is the contract.
- harness/test/fixtures/insights-parity/golden.txt: the goldens must keep passing unchanged, not be regenerated.

### Key Files
- harness/insights-state.js - the home of the helper; `listFeatures` returns sorted names only for dirs that hold an events.jsonl.
- harness/test/insights-prompt-surfaces.test.js, harness/test/insights-rework-load.test.js, harness/test/insights-human-corrections.test.js - the parity and edge tests that must pass unchanged.

### Reminders
- Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800 RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- A failed deliver stop (`class=failed`) cannot be resumed: fix, re-approve from the preserved worktree if the plan changed, remove the worktree, re-run `rad deliver` without `--resume`.
- Function-length lint caps functions at 40 lines.
- Do not edit the parity tests or goldens to make a change pass; if one fails, stop and report.
- Every file a task may change is declared above. If another file is needed, stop and report.

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (tests first, then the helper).

#### Task 1.1: Add the shared helper and its tests
File: harness/insights-state.js:38-49, harness/test/insights-state.test.js:60-89
What: Export `readHistories(stateDir)` as in Program Design. Add tests for AC#4's cases. Edge cases, each its own test: missing state dir (`{}`), an empty log (key present with `[]`), a dir without a log (skipped), keys sorted regardless of directory creation order, a malformed line (throws), a valid-JSON `null` line (throws naming the file and line 1), and a log that mixes valid and non-object lines (throws at the first bad line).
Validate: AC#1, AC#4 - `node --test harness/test/insights-state.test.js` passes.

### Wave 2 — sequential
Depends on: Wave 1 complete
Verify: exec bash scripts/verify-all.sh

#### Task 2.1: Adopt the helper in prompt-surfaces and rework-load
File: harness/insights-prompt-surfaces.js:10-14, harness/insights-prompt-surfaces.js:100-116, harness/insights-rework-load.js:12-42
What: Replace the local `readHistories` in both modules with the import from `insights-state.js`; drop the `export` from prompt-surfaces (no other importer); remove imports that become unused (`listFeatures`, `readHistory`) only if nothing else in the file uses them. Edge case: run each module's tests before and after and compare outputs; a changed output means stop and report.
Validate: AC#2 - `node --test harness/test/insights-prompt-surfaces.test.js harness/test/insights-rework-load.test.js` passes unchanged.

#### Task 2.2: Document why human-corrections keeps its own reader
File: harness/insights-human-corrections.js:17-30
What: Add a short comment above its `readHistories` naming the two deliberate differences from the shared helper (error text from `parseEventLog`; whitespace-only lines are skipped) and pointing at the test that asserts the error text. Change no code.
Validate: AC#3 - `node --test harness/test/insights-human-corrections.test.js` passes unchanged and `git diff` for the file shows only comment lines; AC#5 - `bash scripts/verify-all.sh` passes (the wave's Verify line).

## Tests to Write
- [ ] `readHistories`: missing dir, empty log, dir without a log, sorted keys, malformed line, JSON-null line, mixed valid and non-object - harness/test/insights-state.test.js

## Non-Goals
- Folding `insights-human-corrections.js` into the shared helper: that needs `readHistory` and `parseEventLog` to agree on error text and blank-line handling, which changes pinned output.
- Replacing the per-feature `listFeatures` + `readHistory` loops in the other fold modules; they do not build a map and gain nothing from it.
- Any change to the findings-line reader duplicated in `insights-human-corrections.js` (a separate concern from the events reader).

## Out-of-Scope Dependencies
None

## Risks
- `readHistories` in prompt-surfaces was an export; a caller outside the repo's `.js`, `.sh` and `.md` files would break. The repo grep found none.
- The rework-load copy uses a loop and the other `Object.fromEntries`; both yield identical key order because `listFeatures` is sorted. The unchanged parity tests are the check.
