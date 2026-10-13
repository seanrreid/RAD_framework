# Plan: Refactor the Long cli.js Commands Under the Function-Length Ratchet (#252, part 5 of 6)
Created: 2026-10-13
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-13T15:16:36.822Z
Recorded-By: sean@torchcodelab.com
Branch: rad/refactor-cli-commands
Adopted-From: #252 part 5 of 6 (refactor five offenders in harness/cli.js; the issue stays open until plan 6 lands)
Issue-Title: Refactor over-long core functions (runOneWave, createGitStateStore, deliverCommand, ...)
Source-Author: none (no source issue)
Source-Comments: none

## Context
Plan 5 of the six-plan decomposition of #252 (plans 1-4 merged as #261, #263, #264, #265). Five offenders remain in `harness/cli.js` (4,688 lines):

| Function | Lines | What it is |
|---|---|---|
| `deliverCommand` | 215 | The `rad deliver` entry point: a sequence of early-exit phases, then the spine call and the wrap-up |
| `architectureApproveCommand` | 81 | `rad architecture-approve`: argument checks, identity resolution, the store write |
| `parsePlanCtx` | 52 | Pure: turns plan text into the context the spine and adapters need |
| `gateCommand` | 48 | `rad gate`: parse, evaluate (disk or stdin), print the result line |
| `writePlanStatus` | 46 | Private: writes the human-readable approval mirror into the plan header (used by `rad approve`) |

The work is **behavior-preserving**. The safety net matches plans 1-4, adapted to command handlers whose observable behavior is an exit code, the text written to stdout and stderr, and the files and events written: Wave 1 records a **characterization test from the unmodified `cli.js`**; Waves 2 and 3 refactor; the same test must pass unchanged. No existing test is edited, moved or deleted.

**What is hard here.** `deliverCommand`'s behavior depends on the *order* of its phases: argument and config refusals happen before any worktree exists or event is appended; a delivered rerun short-circuits before `--resume` is considered; the unarmed-budget warning is written after setup and before any wave runs; setup failures preserve the worktree. Moving a phase can change which refusal wins or whether an event is written. The characterization therefore records the order of side effects (stdout and stderr text in sequence, events appended), not just the final exit code.

**Header note.** No `Issue:` header, so the deliver PR does not carry a closing reference to #252 (closed by hand after plan 6).

## Scope
| In scope | Out of scope |
|---|---|
| Splitting the five offenders into small named helpers inside `cli.js` | Any change to exit codes, output text, ordering of side effects, exports or signatures |
| A characterization test and its golden data | Editing, moving or deleting any existing test |
| Regenerating the lint baseline so the five entries disappear | Splitting `cli.js` into several files, or moving commands to modules |
| | `spine.js` (plan 6) and the other 2 offenders |

## Acceptance Criteria
1. **Characterization recorded first.** `harness/test/cli-commands-characterization.test.js` runs the scenario sets in Tasks 1.1 and 1.2 against `harness/test/fixtures/cli-commands-golden.json`, generated from the unmodified `cli.js` in Wave 1 and not regenerated after Wave 2 begins.
2. **`parsePlanCtx` identical.** For a matrix of synthetic plan texts (no header, with and without `Branch:`, with and without the Acceptance Criteria section and its numbered lines, each Execution Notes sub-section present, empty and absent, waves with `Verify:`, `Model:` and `Capabilities:` lines, tasks, `Tests to Write` lines promised and unpromised, malformed capability lines, plan-level capabilities, and the verify-timeout environment variable unset, valid and malformed), the returned object equals the golden record exactly (deep equality, including key presence).
3. **Plan-header mirror identical.** For `rad approve` runs that exercise `writePlanStatus` (direct and proxy approval; `Status:` present and absent; each of `Approved-By`, `Approved-At`, `Recorded-By` and `Approval-Evidence` already present and absent; a delivered feature keeping its status via the re-approval path; a plan with no header block at all; trailing newline present and absent), the plan file's exact text afterwards and the command's output equal the golden record.
4. **`rad gate` identical.** For `gateCommand` (argument errors, missing feature or gate name, an unknown gate, a missing or empty log, an approved log, a log with several events, and the `--stdin` form with valid, empty and malformed JSONL), the exit code and the exact stdout and stderr equal the golden record, and no file is written.
5. **`rad architecture-approve` identical.** For `architectureApproveCommand` (argument errors, a missing slug, `--evidence` without `--on-behalf-of`, an undetermined git identity, direct and proxy mode, a failed role check), the exit code, the exact stdout and stderr, and the `_architecture` event log text equal the golden record.
6. **`rad deliver` identical in order and content.** For `deliverCommand` scenarios covering: `--help`; bad arguments; no feature; each agent-selection refusal; an invalid failed-attempts cap; an invalid configuration; an invalid hooks directory; a delivered rerun; a refused `--resume`; a setup failure; the unarmed-budget warning; a prepare or finish port failure; a spine that throws; an ok run with evidence; an ok run the log does not evidence; and each stop class, the exit code, the exact stdout and stderr *in the order written*, and the resulting event log equal the golden record, with no worktree or event created for the refusals that precede setup.
7. **Public surface unchanged.** `cli.js` exports the same names with the same signatures (`parsePlanCtx`, `deliverCommand`, `gateCommand`, `architectureApproveCommand` among them); no file outside `cli.js`, the new test files and the baseline is modified.
8. **Ratchet shrinks.** After `--write-baseline`, the five `cli.js` entries are gone, no new entry for `cli.js` appears (every helper is 40 lines or fewer), and `node scripts/lint-function-length.mjs` exits 0.
9. **Invariants intact.** `bash scripts/lint-invariants.sh` passes.
10. **Existing tests untouched.** `git diff` shows no change to any existing test file, and the whole existing suite passes.
11. **Full suite passes.** `scripts/verify-all.sh` passes on the delivered branch.

## Agent Scope
No sub-agents were called. Research was inline (8 tool calls): the baseline entries for `cli.js`, and a full read of `deliverCommand`, `parsePlanCtx`, `writePlanStatus`, `architectureApproveCommand` and `gateCommand`.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/cli.js | 790-855 | `parsePlanCtx` split into section parsers |
| harness/cli.js | 1960-2200 | `deliverCommand` split into phase helpers; the spine call's argument object built by a helper |
| harness/cli.js | 2200-2262 | `writePlanStatus` split into header-field helpers |
| harness/cli.js | 2640-2745 | `architectureApproveCommand` split into argument, identity and write helpers |
| harness/cli.js | 2880-2960 | `gateCommand` split into parse, evaluate and report helpers |
| harness/test/cli-commands-characterization.test.js | 1-300 | New. The scenario sets and the comparison to the golden file |
| harness/test/fixtures/cli-commands-golden.json | 1-1 | New. Golden results generated from the unmodified `cli.js` |
| scripts/lint-function-length-baseline.txt | 1-45 | Regenerated with `--write-baseline` |

## Execution Notes

### Do Not Touch
- Every existing test file, including cli.test.js and the cli-*.test.js files
- harness/spine.js, harness/plan-open.js, harness/provenance.js and every other module (cli.js's imports and the calls it makes must stay as they are)
- harness/evals/, scripts/lint-function-length.mjs, docs/invariants.yaml

### Key Files
- harness/cli.js — the five functions; `parseDeliverArgs`, `selectDeliverAgent`, `loadDeliverConfig`, `resolveResume`, `setupWorktreeRun`, `setupMainRun`, `reportStop`, `completionEvidence` and the other existing helpers `deliverCommand` already uses
- harness/test/cli.test.js — the existing command tests and their ctx and stub patterns (read, do not edit)
- harness/evals/lib/fixture.js — `createFixture` builds a real temporary git repository with an origin, copied scripts and an approved plan; a good basis for the `deliverCommand` scenarios
- harness/evals/delivery.eval.js — shows how a scripted agent drives a delivery

### Reminders
- harness/ is self-protected: architect approval and the last-wave full-suite Verify. Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800` AND `RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- **Wave 1 must not edit `cli.js`.** The golden data records current behavior; generating it after any refactor defeats the point.
- Make the characterization deterministic: capture `process.stdout.write` and `process.stderr.write` into one ordered list of `{ stream, text }`; replace temporary directory paths with `<REPO>` or `<ROOT>`; replace timestamps with `<TS>` and commit hashes with `<SHA>`; set or clear every environment variable a scenario depends on (`RAD_WORKTREE`, `RAD_TOKEN_BUDGET`, `RAD_AGENT`, `RAD_AGENT_CMD`, `RAD_MAX_FAILED_ATTEMPTS`, `RAD_HOOKS_DIR`, `RAD_VERIFY_TIMEOUT_SECONDS`, `RAD_SYNC`) and restore them in a `finally`.
- `deliverCommand` scenarios that reach the spine use a temporary git repository with an origin (as `createFixture` does) and an injected `ctx.runWave` that returns a scripted result, so no model or network is used. Scenarios that stop before setup need no repository beyond a plan.
- Keep the **order of side effects** in `deliverCommand` exactly: help, argument parse, feature check, config load, agent selection, failed-attempts cap, invalid-config refusal, hooks-directory check, delivered short-circuit, resume eligibility, setup (worktree or main), matrix load, token-budget parse and warning, work branch, script context, prepare port, finish port (with worktree preservation on failure), hook runner, the spine call inside its `try`, evidence, cleanup, the final reports.
- Keep the spine call's argument object identical key for key, including the conditional `...(resume ? { resume } : {})`.
- `parsePlanCtx` is exported and used by `rad approve`, `rad deliver`, `rad capabilities` and others: keep it a pure function of its text and the environment, with the same key set in the same order.
- Run `node scripts/lint-function-length.mjs` before finishing each refactor wave; the baseline is regenerated only in Wave 4.

## Program Design

Helper signatures (module-private to `cli.js`; names are a guide, the executor may refine them while keeping every function at 40 lines or fewer):

```js
// parsePlanCtx
parseBranchHeader(text)                  // -> string
parseAcceptanceCriteria(text)            // -> string[]
parseExecutionNotes(text)                // -> { doNotTouch, keyFiles, reminders }

// writePlanStatus
upsertHeaderField(lines, state, key, value)   // keeps the anchor logic; state = { anchor }
planStatusFields(fields)                       // -> ordered [key, value] pairs to upsert

// gateCommand
evaluateGateRequest(parsed, repoRoot, sh)      // -> gate result (throws for the caller to report)
formatGateLine(feature, name, result, stdin)   // -> the structured stdout line

// architectureApproveCommand
checkArchitectureArgs(parsed)                  // -> exit code | null
resolveArchitectIdentity(parsed, runningUser)  // -> { architect, recordedBy, proxy } | { code }
formatArchitectureLine(slug, architect, recordedBy, ts, proxy) // -> string

// deliverCommand  (phases return { code } to exit early, or the data the next phase needs)
validateDeliverRequest(argv, ctx)        // help, parse, feature check
resolveDeliverSettings(ctx, parsed)      // config, agent selection, caps, hooks dir
resolveDeliverMode(ctx, parsed, sh)      // delivered short-circuit and resume eligibility
buildSpineArgs(run)                      // the argument object for deliverSpine
runSpine(run)                            // the try/catch around deliverSpine
concludeDeliver(run, result)             // evidence, cleanup, final report and exit code
```

Call stack (deliver):

```
deliverCommand -> validateDeliverRequest -> resolveDeliverSettings -> resolveDeliverMode
               -> setup (existing helpers) -> budget parse and warning -> ports -> runSpine(buildSpineArgs)
               -> concludeDeliver -> reportStop (existing)
```

File tree diff:

```
harness/cli.js                                       5 offenders split into ~16 helpers
harness/test/cli-commands-characterization.test.js   NEW
harness/test/fixtures/cli-commands-golden.json       NEW
scripts/lint-function-length-baseline.txt            - 5 entries
```

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (1.3 generates the data the assertions use).
Verify: node --test harness/test/cli-commands-characterization.test.js

#### Task 1.1: Characterize the four smaller functions
File: harness/test/cli-commands-characterization.test.js:1-300
What: Write the first half of the test: the `parsePlanCtx` matrix (AC#2), the plan-header mirror via `approveCommand` (AC#3), `gateCommand` (AC#4) and `architectureApproveCommand` (AC#5), each in process with captured output, stub `sh` and temporary directories as in the Reminders, comparing to the golden file. An `UPDATE_GOLDEN=1` mode writes the golden data; without it the test only reads and compares.
Validate: AC#1, AC#2, AC#3, AC#4, AC#5 — every scenario has a golden entry and a named assertion; a deliberately wrong golden value makes the test fail (checked once by hand, not committed).

#### Task 1.2: Characterize deliverCommand
File: harness/test/cli-commands-characterization.test.js:1-300
What: Write the second half: the `deliverCommand` scenarios of AC#6, recording the ordered output, the exit code and the event log text per scenario, using real temporary repositories for the scenarios that reach setup or the spine and an injected `runWave`. Include at least one scenario per stop class and one scenario per refusal that must precede setup (asserting no worktree directory and no events file exists afterwards).
Validate: AC#1, AC#6 — every scenario has a golden entry and a named assertion.

#### Task 1.3: Generate the golden file
File: harness/test/fixtures/cli-commands-golden.json:1-1
What: Run the test once with `UPDATE_GOLDEN=1` against the **unmodified** `cli.js` to write `cli-commands-golden.json`, commit it, then run the test without the variable twice in a row and confirm both pass (to catch non-determinism).
Validate: AC#1 — the golden file exists, the test passes on two consecutive runs, and `git diff` shows `cli.js` untouched in this wave.

### Wave 2 — sequential
Tasks in this wave must run in sequence (each edits `cli.js`).
Verify: npm test --prefix harness

#### Task 2.1: Split parsePlanCtx and writePlanStatus
File: harness/cli.js:790-855, harness/cli.js:2200-2262
What: Extract `parseBranchHeader`, `parseAcceptanceCriteria` and `parseExecutionNotes` from `parsePlanCtx`, which keeps its return object with the same keys in the same order; extract the header-field upsert logic from `writePlanStatus` into helpers that preserve the anchor behavior (new fields inserted after the last header line touched), the `keepStatus` rule and the proxy and non-proxy branches.
Validate: AC#2, AC#3, AC#7, AC#10 — the characterization test and the existing tests pass unchanged; no behavior change, so no new tests.

#### Task 2.2: Split gateCommand and architectureApproveCommand
File: harness/cli.js:2640-2745, harness/cli.js:2880-2960
What: Extract the argument checks, identity resolution and result formatting helpers listed in Program Design. Each command keeps its exact messages, usage lines and order of checks.
Validate: AC#4, AC#5, AC#7, AC#10 — the characterization test and the existing tests pass unchanged; no behavior change, so no new tests.

### Wave 3 — sequential
Tasks in this wave must run in sequence.
Verify: npm test --prefix harness

#### Task 3.1: Split deliverCommand into phases
File: harness/cli.js:1960-2200
What: Extract the pre-setup phases (`validateDeliverRequest`, `resolveDeliverSettings`, `resolveDeliverMode`) and the post-spine phase (`concludeDeliver`), preserving the order in the Reminders and the early-return codes. Each phase either returns `{ code }` to stop or the data the next phase needs. `deliverCommand` becomes a short sequence.
Validate: AC#6, AC#7, AC#9, AC#10 — the characterization test (including the order of output and the "nothing created before setup" assertions) and the existing deliver tests pass unchanged; no behavior change, so no new tests.

#### Task 3.2: Extract the spine call
File: harness/cli.js:1960-2200
What: Move the `deliverSpine` argument object into `buildSpineArgs(run)` and the `try`/`catch` around the call into `runSpine(run)`, keeping every key, every comment that states a constraint, the conditional `resume` key, and the catch behavior (preserve the worktree, sanitize the message, print `unexpected error`, return 1).
Validate: AC#6, AC#7, AC#10 — the characterization test, the delivery evals and the existing tests pass unchanged; no behavior change, so no new tests.

### Wave 4 — sequential
Tasks in this wave must run in sequence.
Verify: exec bash scripts/verify-all.sh

#### Task 4.1: Refresh the ratchet baseline
File: scripts/lint-function-length-baseline.txt:1-45
What: Run `node scripts/lint-function-length.mjs --write-baseline` and commit the result. Confirm the diff only removes the five `cli.js` entries, that no new `cli.js` entry appears, and that `node scripts/lint-function-length.mjs` exits 0.
Validate: AC#8 — the baseline diff only removes those lines; the lint exits 0.

#### Task 4.2: Full-suite check
File: scripts/lint-function-length-baseline.txt:1-45
What: No further edit. The wave's Verify runs the full suite.
Validate: AC#11 — `scripts/verify-all.sh` passes.

## Tests to Write
- [ ] Characterization of `parsePlanCtx`, the plan-header mirror, `gateCommand`, `architectureApproveCommand` and `deliverCommand` (exit codes, ordered output, files and events) against golden data from the unmodified `cli.js` — harness/test/cli-commands-characterization.test.js

## Non-Goals
- Changing any exit code, message, ordering of side effects, export or signature
- Editing, moving or deleting an existing test
- Splitting `cli.js` into several files
- Refactoring `spine.js` or any module other than `cli.js`

## Out-of-Scope Dependencies
None.

## Risks
- `deliverCommand` is the main entry point of the harness and its behavior is ordered side effects. A phase moved before or after another can change which refusal wins or whether an event or worktree is created; the ordered-output golden record and the "nothing created before setup" assertions are the controls, with the delivery evals and the 4,000-line `cli.test.js` as the second net.
- The `deliverCommand` scenarios need real git repositories and are slower than the earlier characterizations; the test must stay deterministic and complete well within the suite's time. Two consecutive passing runs are required before the golden file is committed.
- The matrices can only catch inputs they contain; the full existing suite is the second net.
- A golden file generated after any `cli.js` edit would certify the refactor against itself; Wave 1 must not touch `cli.js`.
- `cli.js` is large and shared; any other open work touching it would conflict. None is planned (plan 6 touches `spine.js`).

## Issue Gaps
- ASSUMPTION: no `Issue:` header, so the deliver PR does not close #252; the issue is closed by hand after plan 6.
- ASSUMPTION: `writePlanStatus` is private, so it is characterized only through `rad approve`; its helpers stay private to `cli.js`.
- ASSUMPTION: scenarios that reach the spine use an injected scripted `runWave`; the real adapters are covered by the earlier plans' characterizations.
- ASSUMPTION: the scenario lists in AC#2-AC#6 are minimums; the executor may add cases, and may choose in-process calls or a subprocess for a scenario as long as the recorded output is the same.
- ASSUMPTION: line ranges are from the current file and may shift by a few lines; the executor should stay within the five functions and their helpers.
