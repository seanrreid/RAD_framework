# Plan: Refactor the Git State Store Under the Function-Length Ratchet (#252, part 3 of 6)
Created: 2026-10-13
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-13T14:15:55.503Z
Recorded-By: sean@torchcodelab.com
Branch: rad/refactor-git-state-store
Adopted-From: #252 part 3 of 6 (refactor harness/adapters/git-state-store.js; the issue stays open until all six plans land)
Issue-Title: Refactor over-long core functions (runOneWave, createGitStateStore, deliverCommand, ...)
Source-Author: none (no source issue)
Source-Comments: none

## Context
Plan 3 of the six-plan decomposition of #252 (plan 1 `contract.js` merged as #261; plan 2 the adapters merged as #263). The ratchet baselines three offenders in `harness/adapters/git-state-store.js`:

| Function | Lines |
|---|---|
| `createGitStateStore` | 384 |
| `createGitStateStore>recordArchitectureApproved` | 43 |
| `createGitStateStore>list` | 41 |

`createGitStateStore` is a factory closure whose length is dominated by doc comments around ten small methods (`append`, `history`, `phase`, `plan`, `gate`, `list`, `recordApproval`, `recordArchitectureApproved`, `recordOwnerClaimed`, `recordOwnerReleased`) that share `repoRoot`, `sh`, `roleConfigRoot` and a lazily cached gate evaluator. The refactor hoists each method to a module-level function that takes a small context object, with the doc comments moving with them, and shares the duplicated pieces (the role check, the owner claim/release body). The factory then builds the context and returns the same ten methods.

**Why this file needs care.** It is the writer of the append-only event log and records approvals, the gate authority. The event lines it writes (including key order) and the `sh` calls its role checks make are depended on by the gate fold, the fingerprint checks and CI. The work is **behavior-preserving**, and the safety net is the same shape as plans 1 and 2: Wave 1 adds a **characterization test** recorded from the *unmodified* store; Wave 2 refactors; the same test must pass unchanged. The 22 store tests and the approval-authority and owner-event tests are not edited, moved or deleted.

**Header note.** No `Issue:` header, so the deliver PR does not carry a closing reference to #252 (closed by hand after plan 6).

**Anchor that must survive.** `docs/invariants.yaml` anchors the literal `appendFileSync` in this file ("the writer only appends"). The append stays a single `appendFileSync` call.

## Scope
| In scope | Out of scope |
|---|---|
| Hoisting the ten methods to module-level functions with a context object; sharing the role check and the owner-event body | Any change to the returned object's keys, signatures, event shapes, error messages or write order |
| A characterization test and its golden data | Editing, moving or deleting any existing test |
| Regenerating the lint baseline so the three entries disappear | The other 12 offenders (plans 4-6) |
| | `parsePlan`, `readEvents`, `defaultSh` and the validation helpers (already under 40 lines; untouched) |

## Acceptance Criteria
1. **Characterization recorded first.** `harness/test/store-characterization.test.js` runs the scenario matrix in Task 1.1 against `harness/test/fixtures/store-golden.json`, generated from the unmodified store in Wave 1 and not regenerated after Wave 2 begins.
2. **Event log is byte-identical.** For every writing scenario (`append`, `recordApproval`, `recordArchitectureApproved`, `recordOwnerClaimed`, `recordOwnerReleased`) the resulting `events.jsonl` content, line for line including key order, equals the golden record.
3. **Errors are identical.** Every refused call (missing or unsafe feature, missing event fields, illegal transition, failed role check, invalid waivers, invalid high-risk pattern, missing git identity) throws the same error type and message as in the golden record and writes nothing.
4. **Shell calls are identical.** For each scenario the recorded `sh` calls (command, arguments and `cwd`, in order) equal the golden record, with the role check receiving `[requiredRole, roleConfigRoot, actor]`.
5. **Reads are identical.** `history`, `phase`, `plan` (including a missing plan and a malformed log tail) and `gate` (with an injected evaluator, and with the real lazily imported one) return the golden values; `list` returns the golden set of descriptors, compared sorted by feature because directory order differs between platforms, including the phase filter, `README.md` exclusion and unsafe-name exclusion.
6. **Public surface unchanged.** `createGitStateStore` returns an object with exactly the ten keys it has today; the module still exports `createGitStateStore`, `defaultSh` and `isSafeFeature`; no file outside `git-state-store.js`, the new test files and the baseline is modified.
7. **Anchor intact.** `bash scripts/lint-invariants.sh` passes (the literal `appendFileSync` is still in the file).
8. **Ratchet shrinks.** After `--write-baseline`, the three `git-state-store.js` entries are gone, no new entry for the file appears (every helper is 40 lines or fewer), and `node scripts/lint-function-length.mjs` exits 0.
9. **Existing tests untouched.** `git diff` shows no change to any existing test file, and the whole existing suite passes.
10. **Full suite passes.** `scripts/verify-all.sh` passes on the delivered branch.

## Agent Scope
No sub-agents were called. Research was inline (7 tool calls): the whole of `createGitStateStore`, the invariant anchors on the file, its 22 dedicated tests and the other tests and consumers (`cli.js` creates a store in eight places; `plan-status.js` once).

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/adapters/git-state-store.js | 240-643 | `createGitStateStore` and its ten methods hoisted into module-level functions with a context object; shared helpers |
| harness/test/store-characterization.test.js | 1-250 | New. The scenario matrix and the comparison to the golden file |
| harness/test/fixtures/store-golden.json | 1-1 | New. Golden results, event logs and `sh` call records generated from the unmodified store |
| scripts/lint-function-length-baseline.txt | 1-45 | Regenerated with `--write-baseline` |

## Execution Notes

### Do Not Touch
- Every existing test file, including git-state-store.test.js, approval-authority-recording.test.js and portable-process-memory.test.js
- harness/events.js, harness/transitions.js, harness/gates.js, harness/gates.yaml (the store calls them; they are not changed)
- harness/cli.js, harness/plan-status.js and the other consumers (their imports and call shapes must keep working unchanged)
- scripts/lint-function-length.mjs, docs/invariants.yaml

### Key Files
- harness/adapters/git-state-store.js — the whole file; `createGitStateStore` starts at line 258
- harness/test/git-state-store.test.js — the existing 22 tests; read for the fixture and stub patterns, do not edit
- harness/test/approval-authority-recording.test.js — approval-write expectations
- docs/invariants.yaml (line ~118) — the `appendFileSync` anchor

### Reminders
- harness/ is self-protected: architect approval and the last-wave full-suite Verify. Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800` AND `RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- **Wave 1 must not edit `git-state-store.js`.** The golden data records current behavior; generating it after any refactor defeats the point.
- Make the characterization deterministic: pass an explicit `ts` to every write so no clock reads occur, except for the one scenario that checks `append` stamps an ISO timestamp when none is given (assert the shape, and normalize it to `<TS>` in the golden record); use a temporary repository directory per scenario; replace that path with `<REPO>` in recorded `sh` calls and error messages.
- Compare event logs as the exact file text. Compare `list` output sorted by `feature`.
- A stub `sh` records every call and answers `check-role.sh` with a configurable status and `git config user.email` with a configurable value; the lazy-import `gate` scenario uses the real `gates.js`, which needs `js-yaml` (vendored; no install step).
- Keep the single `appendFileSync(file, JSON.stringify(stamped) + '\n', 'utf8')` call and the `mkdirSync` before it exactly as they are.
- Keep the validation order inside every method (argument checks, then role check, then event construction, then `append`), because earlier failures must not be masked by later ones.
- Keep the lazy `import('../gates.js')` relative to this file's directory; the cached evaluator must still be resolved at most once per store.
- Keep functions at 40 lines or fewer, including the hoisted doc comments only if they sit outside the function body (comments above a function are not counted).
- Run `node scripts/lint-function-length.mjs` before finishing Wave 2; the baseline is regenerated only in Wave 3.

## Program Design

Helper signatures (module-private; names are a guide, the executor may refine them while keeping every function at 40 lines or fewer):

```js
// context: { repoRoot, sh, roleConfigRoot, evaluateGate }  (evaluateGate is the lazily cached evaluator)
readHistory(ctx, feature)                       // -> events        (assertSafeFeature + readEvents)
appendEvent(ctx, event)                         // -> void          (validate, reduce, validateTransition, stamp, appendFileSync)
phaseFor(ctx, feature)                          // -> phase
readPlan(ctx, feature)                          // -> parsed plan | null
evaluateNamedGate(ctx, feature, name)           // -> Promise<gate result>  (lazy import, cached on ctx)
listFeatures(ctx, filter)                       // -> descriptors   (uses collectFeatureNames)
collectFeatureNames(repoRoot)                   // -> Set<string>   (state dirs, then plan docs)
requireRole(ctx, role, identity, label)         // -> void | throws (the shared check-role.sh call and error text)
buildApprovalEvent(args, nowIso)                // -> event         (data keys only when provided)
recordApprovalFor(ctx, args)                    // -> void
recordArchitectureApprovedFor(ctx, args)        // -> void
resolveGitIdentity(ctx)                         // -> string | throws
recordOwnerEvent(ctx, type, args)               // -> { holder, ts }   (shared by claim and release)
```

Call stack:

```
createGitStateStore -> builds ctx -> returns { append, history, phase, plan, gate, list,
                                               recordApproval, recordArchitectureApproved,
                                               recordOwnerClaimed, recordOwnerReleased }
recordApprovalFor / recordArchitectureApprovedFor -> requireRole -> appendEvent
recordOwnerEvent -> resolveGitIdentity (when no actor) -> appendEvent
```

File tree diff:

```
harness/adapters/git-state-store.js              createGitStateStore + 2 nested offenders -> ~13 module-level helpers
harness/test/store-characterization.test.js      NEW
harness/test/fixtures/store-golden.json          NEW
scripts/lint-function-length-baseline.txt        - 3 entries
```

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (1.2 generates the data the assertions use).
Verify: node --test harness/test/store-characterization.test.js

#### Task 1.1: Store characterization test
File: harness/test/store-characterization.test.js:1-250
What: Write a test that builds a temporary repository per scenario, runs the real `createGitStateStore` with a recording stub `sh`, and compares each scenario's observed result (return value, thrown error type and message, the exact `events.jsonl` text, the `sh` call records) to `store-golden.json`. Scenarios: `append` (legal event, explicit `ts`, no `ts` stamped as an ISO string, missing event, missing feature, missing type, missing actor, unsafe feature, an illegal transition such as a duplicate approval or a post-terminal event); `history` and `phase` (empty, populated, a log with a partial last line, unsafe feature); `plan` (no plan, a plan with acceptance criteria, waves and files); `gate` (injected evaluator receiving the right arguments, and the real lazily imported evaluator before and after an approval); `list` (state-only, plan-only, both, `README.md`, unsafe names, the phase filter; compared sorted); `recordApproval` (bare; with evidence; fingerprint; valid, empty and invalid waivers; valid and invalid high-risk pattern; `recordedBy` proxy; explicit `ts`; failed role check; missing feature; missing actor); `recordArchitectureApproved` (full, with evidence, `recordedBy` default, failed role check, missing slug, missing `onBehalfOf`, and the written log being `_architecture`); `recordOwnerClaimed` and `recordOwnerReleased` (explicit actor, git identity resolved through the stub, missing identity, a claim on a delivered feature, return values). An `UPDATE_GOLDEN=1` mode writes the golden file; without it the test only reads and compares.
Validate: AC#1, AC#2, AC#3, AC#4, AC#5 — every scenario has a golden entry and a named assertion; a deliberately wrong golden value makes the test fail (checked once by hand, not committed).

#### Task 1.2: Generate the golden file
File: harness/test/fixtures/store-golden.json:1-1
What: Run the test once with `UPDATE_GOLDEN=1` against the **unmodified** store to write `store-golden.json`, commit it, then run the test without the variable twice in a row and confirm both pass (to catch non-determinism).
Validate: AC#1 — the golden file exists, the test passes on two consecutive runs, and `git diff` shows `git-state-store.js` untouched in this wave.

### Wave 2 — sequential
Tasks in this wave must run in sequence (each edits `git-state-store.js`).
Verify: npm test --prefix harness

#### Task 2.1: Hoist the read and append methods
File: harness/adapters/git-state-store.js:240-643
What: Introduce the context object and hoist `history`, `append`, `phase`, `plan` and `gate` to module-level `readHistory`, `appendEvent`, `phaseFor`, `readPlan` and `evaluateNamedGate`, moving each doc comment with its function. `evaluateNamedGate` keeps the lazy, cached `import('../gates.js')` on the context. `appendEvent` keeps the single `appendFileSync` call and the order: shape checks, `assertSafeFeature`, history, `reduce`, `validateTransition`, stamp, `mkdirSync`, write.
Validate: AC#2, AC#3, AC#5, AC#7, AC#9 — the characterization test and the existing store tests pass unchanged; no behavior change, so no new tests.

#### Task 2.2: Split list
File: harness/adapters/git-state-store.js:240-643
What: Hoist `list` to `listFeatures`, extracting `collectFeatureNames` (state directories first, then plan docs, with the same `isSafeFeature` and `README.md` filters and the same insertion order) so each function is 40 lines or fewer.
Validate: AC#5, AC#9 — the characterization test (compared sorted) and the existing tests pass unchanged; no behavior change, so no new tests.

#### Task 2.3: Hoist the recording methods and finish the factory
File: harness/adapters/git-state-store.js:240-643
What: Extract `requireRole` (the `check-role.sh` call and its error text, parameterized by the label that distinguishes `recordApproval` from `recordArchitectureApproved`), `buildApprovalEvent`, `recordApprovalFor`, `recordArchitectureApprovedFor`, `resolveGitIdentity` and `recordOwnerEvent` (shared by claim and release). `createGitStateStore` checks `repoRoot`, builds the context and returns the ten methods as thin wrappers.
Validate: AC#2, AC#3, AC#4, AC#6, AC#7, AC#9 — the characterization test (event lines, errors, `sh` calls) and the existing tests pass unchanged; `scripts/lint-invariants.sh` passes; no behavior change, so no new tests.

### Wave 3 — sequential
Tasks in this wave must run in sequence.
Verify: exec bash scripts/verify-all.sh

#### Task 3.1: Refresh the ratchet baseline
File: scripts/lint-function-length-baseline.txt:1-45
What: Run `node scripts/lint-function-length.mjs --write-baseline` and commit the result. Confirm the diff only removes the three `git-state-store.js` entries, that no new entry for the file appears, and that `node scripts/lint-function-length.mjs` exits 0.
Validate: AC#8 — the baseline diff only removes those lines; the lint exits 0.

#### Task 3.2: Full-suite check
File: scripts/lint-function-length-baseline.txt:1-45
What: No further edit. The wave's Verify runs the full suite.
Validate: AC#10 — `scripts/verify-all.sh` passes.

## Tests to Write
- [ ] Characterization of every store method (event-log text, errors, `sh` calls, reads) against golden data from the unmodified store — harness/test/store-characterization.test.js

## Non-Goals
- Changing any event shape, key order, error message, write order or the returned object's keys
- Editing, moving or deleting an existing test
- Refactoring anything outside `git-state-store.js`
- Touching the validation helpers or `parsePlan`

## Out-of-Scope Dependencies
None.

## Risks
- This file writes the approval authority. A change in key order or event shape could invalidate the gate fold or the fingerprint check; the byte-identical event-log comparison is the control, with the 22 existing store tests and the approval-authority tests as the second net.
- Moving the lazily cached gate evaluator from a closure variable to a context property must keep "resolved at most once per store". The `gate` scenarios exercise both the injected and the lazily imported path.
- `list` order depends on `readdirSync`, which differs between macOS and Linux; the characterization compares sorted, so it cannot catch an ordering change. The plan keeps the insertion order by construction (state directories, then plans) and the existing tests are the net.
- The matrices can only catch inputs they contain; the full existing suite is the second net.
- A golden file generated after any store edit would certify the refactor against itself; Wave 1 must not touch the store.

## Issue Gaps
- ASSUMPTION: no `Issue:` header, so the deliver PR does not close #252; the issue is closed by hand after plan 6.
- ASSUMPTION: the "hoisted doc comments" move with their functions; comment lines above a function are not counted by the ratchet, only lines inside it.
- ASSUMPTION: a small context object passed to module-level helpers replaces the closure variables; public behavior and signatures are unchanged.
- ASSUMPTION: `list`'s ordering is not asserted by any consumer (the characterization compares sorted); if some consumer depends on the platform's directory order, that is already platform-dependent behavior.
- ASSUMPTION: line ranges are from the current file and may shift by a few lines; the executor should stay within the named functions and their helpers.
