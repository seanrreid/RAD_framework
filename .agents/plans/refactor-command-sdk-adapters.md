# Plan: Refactor the Command and SDK Adapters Under the Function-Length Ratchet (#252, part 2 of 6)
Created: 2026-10-13
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-13T13:54:51.060Z
Recorded-By: sean@torchcodelab.com
Branch: rad/refactor-command-sdk-adapters
Adopted-From: #252 part 2 of 6 (refactor harness/adapters/agent/command.js and sdk.js; the issue stays open until all six plans land)
Issue-Title: Refactor over-long core functions (runOneWave, createGitStateStore, deliverCommand, ...)
Source-Author: none (no source issue)
Source-Comments: none

## Context
Plan 2 of the six-plan decomposition of #252 (plan 1, `contract.js`, merged as #261). The ratchet baselines five offenders in the two agent adapters:

| Function | File | Lines |
|---|---|---|
| `createRunWave` | `sdk.js` | 176 |
| `createCommandAdapter` | `command.js` | 120 |
| `spawnOnce` (and its Promise-executor callback) | `command.js` | 64 (+ 62 nested) |
| `runQueryOnce` (and its drain callback) | `sdk.js` | 62 (+ 45 nested) |

All five are factory closures or process-handling code, so they are riskier than plan 1's pure functions. The work is **behavior-preserving**, and the safety net is the same shape as plan 1, adapted to process and SDK code: Wave 1 adds a **characterization test** that runs both adapters over a matrix of scenarios (real child processes for the command adapter, an injected fake `query` for the SDK adapter) and records the results as golden data from the *unmodified* code. Waves 2 and 3 refactor one adapter each; the same test must pass unchanged. The 58 existing adapter tests and the kill-path tests are not edited, moved or deleted.

**Header note.** No `Issue:` header, so the deliver PR does not carry a closing reference to #252 (closed by hand after plan 6).

**Anchors that must survive.** `docs/invariants.yaml` anchors these literal strings: in `command.js` `ENV_ALLOW_LIST`, `export async function runCommandPrompt` and `export function buildChildEnv`; in `sdk.js` `allowedTools: [...allowedTools]`. `scripts/lint-invariants.sh` fails if any disappears, so helpers must keep them exactly (the SDK options object stays one expression containing that text).

## Scope
| In scope | Out of scope |
|---|---|
| Splitting the five offenders into small named helpers inside `command.js` and `sdk.js` | Any change to results, exports, signatures, events or error messages |
| A characterization test and its golden data | Editing, moving or deleting any existing test |
| Regenerating the lint baseline so the five entries (and nested ones) disappear | The other 16 offenders (plans 3-6) |
| | The process-group, env allow-list and timeout behavior (pinned, not changed) |

## Acceptance Criteria
1. **Characterization recorded first.** `harness/test/adapter-characterization.test.js` runs the scenario matrices in Tasks 1.1 and 1.2 against `harness/test/fixtures/adapter-golden.json`, generated from the unmodified adapters in Wave 1 and not regenerated after Wave 2 begins.
2. **Command adapter identical.** After the `command.js` refactor, `createCommandAdapter`'s `runWave`, `probeCommand` and `runCommandPrompt` return exactly the golden results for every recorded scenario: success with and without usage, malformed usage line, a block only on the reprompt, no block after the reprompt, non-zero exit with a block, with stderr, with stdout only and with no output, ENOENT, whitespace-only command, wave timeout, output-cap overflow, `{model}` and `{prompt}` tokens, and a prompt written to stdin that the agent never reads.
3. **SDK adapter identical.** After the `sdk.js` refactor, `createRunWave`'s `runWave` returns exactly the golden result for every recorded scenario: success through assistant text and through a result string, usage normalization, an error result with and without a key in the message, a transient error then success, transient errors exhausting the retries, permanent, model and resource errors, a timeout with and without captured usage, a block only on the reprompt, no block after the reprompt, per-wave model override, and the three capability cases (unconstrained, constrained, unmappable).
4. **What reaches the SDK is identical.** For each SDK scenario the recorded `query` options (everything except the `abortController` object and the env values) equal the golden record, including `allowedTools`, `model`, `cwd`, `maxTurns`, `permissionMode`, `tools` and `persistSession`.
5. **Retry behavior identical.** The number of `sleep` calls per SDK scenario equals the golden count; delay values are not compared (they are random).
6. **Process behavior preserved.** `spawnOptions`, `trackGroup`, `untrackGroup` and `signalGroup` are called at the same points as before, with the same arguments; `command-adapter-kill.test.js` and the ACP kill tests pass unchanged.
7. **Anchors intact.** `bash scripts/lint-invariants.sh` passes.
8. **Public surface unchanged.** Exports, names and signatures of both modules are unchanged; no file outside `command.js`, `sdk.js`, the new test files and the baseline is modified.
9. **Ratchet shrinks.** After `--write-baseline`, the five offenders and their nested entries are gone from the baseline, no new `command.js` or `sdk.js` entry appears (every helper is 40 lines or fewer), and `node scripts/lint-function-length.mjs` exits 0.
10. **Existing tests untouched.** `git diff` shows no change to any existing test file, and the whole existing suite passes.
11. **Full suite passes.** `scripts/verify-all.sh` passes on the delivered branch.

## Agent Scope
No sub-agents were called. Research was inline (8 tool calls): the outline of `command.js`, `spawnOnce` and `createCommandAdapter`, the whole of `sdk.js`, the invariant anchors on both files, and the existing adapter tests (58 in `agent-adapters.test.js`).

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/adapters/agent/command.js | 175-264 | `spawnOnce` and its Promise executor split into helpers |
| harness/adapters/agent/command.js | 345-477 | `createCommandAdapter` split into module-level helpers |
| harness/adapters/agent/sdk.js | 60-271 | `createRunWave`, `runQueryOnce`, `runWithRetry` and `runWave` split into helpers |
| harness/test/adapter-characterization.test.js | 1-260 | New. Both scenario matrices and the comparison to the golden file |
| harness/test/fixtures/adapter-golden.json | 1-1 | New. Golden results generated from the unmodified adapters |
| scripts/lint-function-length-baseline.txt | 1-45 | Regenerated with `--write-baseline` |

## Execution Notes

### Do Not Touch
- Every existing test file, including agent-adapters.test.js, command-adapter-kill.test.js and acp-adapter.test.js
- harness/adapters/agent/process-group.js, acp.js, contract.js (contract.js was refactored in plan 1)
- harness/spine.js, harness/cli.js and other consumers (their imports must keep working unchanged)
- scripts/lint-function-length.mjs, docs/invariants.yaml

### Key Files
- harness/adapters/agent/command.js — `spawnOnce` (~188), `probeCommand`, `runCommandPrompt`, `createCommandAdapter` (~358); the process-group calls from #255
- harness/adapters/agent/sdk.js — `createRunWave` (~96) and its inner `runQueryOnce`, `runWithRetry`, `runWave`
- harness/test/agent-adapters.test.js — the existing coverage; read for the fake-agent patterns, do not edit
- docs/invariants.yaml — the anchors listed in Context
- harness/test/command-adapter-kill.test.js — process-group behavior that must keep passing

### Reminders
- harness/ is self-protected: architect approval and the last-wave full-suite Verify. Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800` AND `RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- **Wave 1 must not edit `command.js` or `sdk.js`.** The golden data records current behavior; generating it after any refactor defeats the point.
- Make the characterization deterministic: normalize the temporary directory path to `<TMP>`, never record pids, timings, or `Math.random` output; use short `timeoutMs` values with an explicit `killGraceMs` for the timeout scenario; inject a recording no-op `sleep` for the SDK adapter.
- Fake agents for the command adapter are small Node scripts written to a temporary directory; a scenario argument selects the behavior, and a marker file in the temporary directory lets a fake agent behave differently on its second invocation (the reprompt case). Always kill or clean up in a `finally`.
- Keep helpers in the same file (no new module) so the invariant anchors and imports stay valid. Keep `allowedTools: [...allowedTools]` as a literal in the SDK options object.
- Keep the order in which `spawnOnce` attaches its handlers: spawn, then group tracking, then abort handling, then stdout/stderr capture, `error`/`close`, the `stdin` error handler, then the prompt write and `stdin.end()`.
- In the SDK adapter keep the order of checks in `runWithRetry`: classify, sanitize, the `_isRadTimeout` terminal, the transient retry, then the terminal failure; keep `_usage` attachment on thrown errors.
- Run `node scripts/lint-function-length.mjs` before finishing each refactor wave; the baseline is regenerated only in Wave 4.

## Program Design

Helper signatures (module-private; names are a guide, the executor may refine them while keeping every function at 40 lines or fewer):

```js
// command.js
extractUsage(stdout)                              // hoisted from the closure; pure
startAgentProcess(cmd, prompt, repoRoot, model)   // -> { child, usedPlaceholder } | throws/rejects as today
captureOutput(child, state, onOverflow)           // wires stdout/stderr capture and the 10 MB cap
wireSettle(child, state, resolve, reject)         // 'error' and 'close' handlers, untrack on both
feedPrompt(child, prompt, usedPlaceholder, reject)// stdin error handler, write, end
classifyRunFailure(run, waveId)                   // -> terminal result | null  (truncated, non-zero exit)
runCommandOnce(ctx, prompt, waveId, model)        // -> { stdout, terminal }   (was the inner runCommand)
runWithReprompt(attempt, prompt, waveId)          // first attempt, one reprompt, then fail-protocol

// sdk.js
buildQueryOptions(ctx, effectiveModel, allowedTools, abortController) // keeps `allowedTools: [...allowedTools]`
collectAssistantText(message)                     // -> string
applyResultMessage(message, state)                // usage + result text; throws on is_error
drainQuery(sdkQuery, state)                       // -> { text, usage }
runQueryOnce(ctx, prompt, runOpts)                // withTimeout + _usage attachment
runWithRetry(ctx, prompt, waveId, runOpts)        // classify, retry, terminal results
```

Call stack (command):

```
runWave -> buildWavePrompt -> runWithReprompt -> runCommandOnce -> spawnOnce(startAgentProcess, captureOutput, wireSettle, feedPrompt)
                                                                -> classifyRunFailure -> extractWaveResultBlock / parseWaveResult / toWaveResult
```

Call stack (SDK):

```
runWave -> buildWavePrompt -> waveAllowedTools -> runWithRetry -> runQueryOnce -> drainQuery(collectAssistantText, applyResultMessage)
```

File tree diff:

```
harness/adapters/agent/command.js, sdk.js            5 offenders split into ~14 helpers
harness/test/adapter-characterization.test.js        NEW
harness/test/fixtures/adapter-golden.json            NEW
scripts/lint-function-length-baseline.txt            - the five offenders and their nested entries
```

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (1.3 generates the data the assertions use).
Verify: node --test harness/test/adapter-characterization.test.js

#### Task 1.1: Command-adapter characterization
File: harness/test/adapter-characterization.test.js:1-260
What: Write the command-adapter half. Build small fake-agent scripts in a temporary directory and run the real `createCommandAdapter`, `probeCommand` and `runCommandPrompt` over the scenarios in AC#2, comparing each normalized result to the golden file. A `{model}` and `{prompt}` scenario has the fake agent echo its argv into a task title so the golden record shows what reached the child. An `UPDATE_GOLDEN=1` mode writes the golden data; without it the test only reads and compares.
Validate: AC#1, AC#2 — every scenario has a golden entry and a named assertion; a deliberately wrong golden value makes the test fail (checked once by hand, not committed).

#### Task 1.2: SDK-adapter characterization
File: harness/test/adapter-characterization.test.js:1-260
What: Write the SDK half in the same file. Drive `createRunWave` with an injected fake `query` (an async generator replaying a scripted message list, with a scripted throw for the error scenarios) and a recording no-op `sleep`, over the scenarios in AC#3. For each scenario record the result, the number of `sleep` calls, and the `query` options as in AC#4 (omit the `abortController` object and env values; record the env keys only).
Validate: AC#1, AC#3, AC#4, AC#5 — every scenario has a golden entry and a named assertion.

#### Task 1.3: Generate the golden file
File: harness/test/fixtures/adapter-golden.json:1-1
What: Run the test once with `UPDATE_GOLDEN=1` against the **unmodified** adapters to write `adapter-golden.json`, commit it, then run the test without the variable and confirm it passes twice in a row (to catch non-determinism).
Validate: AC#1 — the golden file exists, the test passes on two consecutive runs, and `git diff` shows `command.js` and `sdk.js` untouched in this wave.

### Wave 2 — sequential
Tasks in this wave must run in sequence (each edits `command.js`).
Verify: npm test --prefix harness

#### Task 2.1: Split spawnOnce
File: harness/adapters/agent/command.js:175-264
What: Split the Promise executor into `startAgentProcess`, `captureOutput`, `wireSettle` and `feedPrompt` as in Program Design, keeping the handler order and the process-group calls (`spawnOptions`, `trackGroup`, `untrackGroup`, `signalGroup`) exactly as in the Reminders. `spawnOnce` assembles them inside the Promise.
Validate: AC#2, AC#6, AC#8, AC#10 — the characterization test, `command-adapter-kill.test.js` and the existing adapter tests pass unchanged; no behavior change, so no new tests.

#### Task 2.2: Split createCommandAdapter
File: harness/adapters/agent/command.js:345-477
What: Hoist `extractUsage` to module level; move the inner `runCommand` to a module-level `runCommandOnce` that takes the adapter settings in a context object; extract `classifyRunFailure` for the post-run branches and `runWithReprompt` for the first-attempt/reprompt/fail-protocol flow. `createCommandAdapter` validates `cmd` and returns the `runWave` closure.
Validate: AC#2, AC#7, AC#8, AC#10 — the characterization test and existing tests pass unchanged; `scripts/lint-invariants.sh` passes (the three `command.js` anchors survive); no behavior change, so no new tests.

### Wave 3 — sequential
Tasks in this wave must run in sequence (each edits `sdk.js`).
Verify: npm test --prefix harness

#### Task 3.1: Split runQueryOnce
File: harness/adapters/agent/sdk.js:60-271
What: Extract `buildQueryOptions` (keeping `allowedTools: [...allowedTools]` as a literal), `collectAssistantText`, `applyResultMessage` and `drainQuery`; `runQueryOnce` keeps the `withTimeout` call and the `_usage` attachment on the error path.
Validate: AC#3, AC#4, AC#7, AC#8, AC#10 — the characterization test and existing tests pass unchanged; `scripts/lint-invariants.sh` passes; no behavior change, so no new tests.

#### Task 3.2: Split createRunWave
File: harness/adapters/agent/sdk.js:60-271
What: Move `runWithRetry` and the `runWave` flow into module-level functions that take a context object (`apiKey`, `repoRoot`, `maxTurns`, `timeoutMs`, `query`, `delay`, `model`), preserving the check order in the Reminders and the single reprompt. `createRunWave` builds the context and returns `runWave`.
Validate: AC#3, AC#5, AC#8, AC#10 — the characterization test (including the retry counts) and existing tests pass unchanged; no behavior change, so no new tests.

### Wave 4 — sequential
Tasks in this wave must run in sequence.
Verify: exec bash scripts/verify-all.sh

#### Task 4.1: Refresh the ratchet baseline
File: scripts/lint-function-length-baseline.txt:1-45
What: Run `node scripts/lint-function-length.mjs --write-baseline` and commit the result. Confirm the diff only removes entries for `command.js` and `sdk.js`, that no new entry for those files appears, and that `node scripts/lint-function-length.mjs` exits 0.
Validate: AC#9 — the baseline diff only removes those entries; the lint exits 0.

#### Task 4.2: Full-suite check
File: scripts/lint-function-length-baseline.txt:1-45
What: No further edit. The wave's Verify runs the full suite.
Validate: AC#11 — `scripts/verify-all.sh` passes.

## Tests to Write
- [ ] Characterization of the command adapter, `probeCommand`, `runCommandPrompt` and the SDK adapter against golden data from the unmodified code — harness/test/adapter-characterization.test.js

## Non-Goals
- Changing any result, export, event or error message
- Editing, moving or deleting an existing test
- Refactoring anything outside `command.js` and `sdk.js`
- Changing process-group, timeout, env allow-list or retry behavior

## Out-of-Scope Dependencies
None.

## Risks
- `spawnOnce` is event-handler ordering code: moving a handler can change which event settles the Promise first. The Reminders fix the order, and the existing kill, EPIPE and truncation tests are the second net beyond the characterization test.
- The characterization test spawns real processes and an 11 MB output scenario; it must stay deterministic and fast enough not to flake the suite. Two consecutive passing runs are required before the golden file is committed.
- The matrices can only catch inputs they contain; the full existing suite (1,500+ tests, including the adapter tests) is the second net.
- A golden file generated after any adapter edit would certify the refactor against itself; Wave 1 must not touch the adapters.
- The ACP adapter shares `buildChildEnv`, `KILL_GRACE_MS` and related exports with `command.js`; the unchanged exports and the ACP tests guard that.

## Issue Gaps
- ASSUMPTION: no `Issue:` header, so the deliver PR does not close #252; the issue is closed by hand after plan 6.
- ASSUMPTION: the scenario lists in AC#2 and AC#3 are minimums; the executor may add cases.
- ASSUMPTION: "identical results" means deep-equal after normalizing the temporary directory path; message text that embeds a pid or a timing is excluded from the golden data by construction.
- ASSUMPTION: a context object passed to module-level helpers is an acceptable replacement for closure variables in the factories; it keeps the same behavior and public signatures.
- ASSUMPTION: line ranges are from the current files and may shift by a few lines; the executor should stay within the named functions and their helpers.
