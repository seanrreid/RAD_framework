# Plan: Refactor contract.js Under the Function-Length Ratchet (#252, part 1 of 6)
Created: 2026-10-13
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-13T13:05:50.117Z
Recorded-By: sean@torchcodelab.com
Branch: rad/refactor-contract-js
Adopted-From: #252 part 1 of 6 (refactor harness/adapters/agent/contract.js; the issue stays open until all six plans land)
Issue-Title: Refactor over-long core functions (runOneWave, createGitStateStore, deliverCommand, ...)

## Context
The function-length ratchet (#259) baselines 24 functions over the ~40-line rule. #252 is decomposed into six behavior-preserving plans, lowest risk first. This is plan 1: the three offenders in `harness/adapters/agent/contract.js`, a file of pure string-in/string-out functions with direct unit tests:

| Function | Lines |
|---|---|
| `buildWavePrompt` | 132 |
| `classifyError` | 78 |
| `parseWaveResult` | 55 |

The work is **behavior-preserving**. To make "preserving" checkable and not just claimed, Wave 1 adds a **characterization test** that records today's outputs for a broad matrix of inputs, generated from the *unmodified* code. Wave 2 refactors; the same test must pass byte-for-byte afterwards. Existing tests are not edited, moved or deleted.

**Header note.** This plan deliberately carries no `Issue:` header. The deliver PR would otherwise link #252 and could close it after one of six plans; `Adopted-From` is a free-form description instead.

**A quirk to preserve, not fix.** `classifyError` compares the *raw* `err.name` to `'enoent'` and `'syntaxerror'` (the keyword checks use a lowercased haystack, these two comparisons do not). Real names such as `'SyntaxError'` therefore never match the second, so a `SyntaxError` is classified `model` only when its message contains `unexpected token`, `malformed` or `invalid json`. Fixing that is a behavior change and out of scope; the characterization test pins it, and the quirk is raised in Issue Gaps for the architect to decide separately.

## Scope
| In scope | Out of scope |
|---|---|
| Splitting `buildWavePrompt`, `classifyError` and `parseWaveResult` into small named helpers inside `contract.js` | Any change to outputs, exports, signatures or error behavior |
| A characterization test and its golden data | Editing, moving or deleting any existing test |
| Regenerating the lint baseline so the three entries disappear | The other 21 offenders (plans 2-6) |
| | Fixing the `name === 'enoent'` / `'syntaxerror'` quirk |

## Acceptance Criteria
1. **Characterization recorded first.** `harness/test/contract-characterization.test.js` exercises `buildWavePrompt`, `classifyError` and `parseWaveResult` over the input matrices in Task 1.1, comparing each result to `harness/test/fixtures/contract-golden.json`. The golden file is generated from the unmodified `contract.js` (Wave 1) and is not regenerated after Wave 2 begins.
2. **Prompt is byte-identical.** After the refactor, `buildWavePrompt` returns exactly the golden string for every recorded input, including the empty-list, prior-failure, operator-context, verification and fence-length cases.
3. **Classification is identical.** `classifyError` returns the golden bucket for every recorded input, including `null`, `undefined`, a string error, numeric statuses (400, 401, 403, 404, 429, 500, 599), string codes, mixed-keyword messages whose result depends on the check order, and the raw-name cases `'enoent'`, `'ENOENT'`, `'syntaxerror'` and `'SyntaxError'`.
4. **Parsing is identical.** `parseWaveResult` returns the golden object for every recorded block, including no tasks, an unknown task status, duplicate and indented top-level `status:` lines, tab indentation, a field before any title, CRLF line endings and trailing whitespace.
5. **Public surface unchanged.** The module's exports, their names and signatures are unchanged; no file outside `contract.js` and the new test files is modified other than the baseline.
6. **Ratchet shrinks.** After `--write-baseline`, the three `contract.js` entries are gone, no new `contract.js` entry appears (every extracted helper is 40 lines or fewer), and `node scripts/lint-function-length.mjs` exits 0.
7. **Existing tests untouched.** `git diff` shows no change to `harness/test/agent-contract.test.js` or any other existing test file, and the whole existing suite passes.
8. **Full suite passes.** `scripts/verify-all.sh` passes on the delivered branch.

## Agent Scope
No sub-agents were called. Research was inline (6 tool calls): the outline of `contract.js`, the three functions, their existing tests and consumers (`pr-body.js`, `spine.js`, `cli.js`, the three adapters), and the invariant registry (no anchors on this file).

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/adapters/agent/contract.js | 187-325 | `buildWavePrompt` and new section helpers |
| harness/adapters/agent/contract.js | 340-412 | `parseWaveResult` and new line-parsing helpers |
| harness/adapters/agent/contract.js | 598-686 | `classifyError` and new classification helpers |
| harness/test/contract-characterization.test.js | 1-220 | New. Input matrices and comparison to the golden file |
| harness/test/fixtures/contract-golden.json | 1-1 | New. Golden outputs generated from the unmodified code |
| scripts/lint-function-length-baseline.txt | 1-45 | Regenerated with `--write-baseline` |

## Execution Notes

### Do Not Touch
- Every existing test file, including harness/test/agent-contract.test.js
- harness/adapters/agent/command.js, sdk.js, acp.js, harness/spine.js, harness/cli.js, harness/pr-body.js (consumers; their imports must keep working unchanged)
- scripts/lint-function-length.mjs

### Key Files
- harness/adapters/agent/contract.js — the three target functions; `renderPriorFailure`, `renderOperatorContext`, `renderVerification` and `fenceFor` already show the helper style to follow
- harness/test/agent-contract.test.js — the existing tests; read for coverage, do not edit
- scripts/lint-function-length.mjs and scripts/lint-function-length-baseline.txt — the ratchet

### Reminders
- harness/ is self-protected: architect approval and the last-wave full-suite Verify. Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800` AND `RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- **Wave 1 must not edit `contract.js`.** The golden file records the current behavior; generating it after any refactor would defeat the point.
- Keep every new helper in `contract.js` (no new module): extracting across files is a larger change than this plan, and keeps the invariant registry's literal-symbol anchors safe.
- Static prompt text moves into module-level constants and small render functions; the template's whitespace, blank lines and ordering must be byte-identical. Where a template literal embeds `${...}`, keep the interpolation points identical.
- In `classifyError` keep the check order (resource, permanent, transient, model, default permanent) and keep the two raw-name comparisons exactly as they are.
- In `parseWaveResult` keep the top-level-versus-indented `status:` rule and the "unknown status becomes `blocked_code`" rule exactly.
- Run `node scripts/lint-function-length.mjs` before finishing Wave 2 to confirm no new helper exceeds 40 lines; the baseline is regenerated only in Wave 3.
- A task with no behavior change has no new tests to write beyond the characterization test; the Validate fields say so.

## Program Design

Helper signatures (all module-private in `contract.js`; names are a guide, the executor may refine them while keeping every function at 40 lines or fewer):

```js
// buildWavePrompt
renderBulletBlock(lines, emptyText = '(none)')   // -> string  ('- a\n- b' or emptyText)
renderAcceptanceCriteria(acceptanceCriteria)     // -> string  ('- AC#1: ...' or '(see plan file)')
renderTaskBlocks(tasks, waveNumber)              // -> string
renderTaskInstructions(feature, waveNumber)      // -> string  (the "For each task" section)
renderReturnFormat(waveNumber)                   // -> string  (the WAVE_RESULT section)
const PROMPT_GUARDRAILS_SECTION = '...'          // static text, byte-identical

// classifyError
errorContext(err)                                // -> { numericStatus, name, haystack }
isResourceError(ctx) / isPermanentError(ctx) / isTransientError(ctx) / isModelError(ctx)  // -> boolean
const RESOURCE_KEYWORDS / PERMANENT_KEYWORDS / TRANSIENT_KEYWORDS / MODEL_KEYWORDS        // string[]

// parseWaveResult
isTopLevelStatus(line, trimmed)                  // -> boolean
startTask(trimmed)                               // -> task object with default fields
applyTaskField(task, line, trimmed)              // -> void (status / commit / concern / error)
normalizeWaveStatus(status)                      // -> 'complete' | 'failed'
```

Call stack:

```
buildWavePrompt -> renderBulletBlock x3, renderAcceptanceCriteria, renderTaskBlocks,
                   renderVerification / renderPriorFailure / renderOperatorContext (existing),
                   renderTaskInstructions, renderReturnFormat
classifyError   -> errorContext -> isResourceError -> isPermanentError -> isTransientError -> isModelError -> 'permanent'
parseWaveResult -> per line: isTopLevelStatus | startTask | applyTaskField -> normalizeWaveStatus
```

File tree diff:

```
harness/adapters/agent/contract.js                    3 functions split into ~15 helpers
harness/test/contract-characterization.test.js        NEW
harness/test/fixtures/contract-golden.json            NEW
scripts/lint-function-length-baseline.txt             - 3 entries
```

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (1.2 generates data used by 1.1's assertions).
Verify: node --test harness/test/contract-characterization.test.js

#### Task 1.1: Characterization test
File: harness/test/contract-characterization.test.js:1-220
What: Write a test that builds three input matrices in code and compares each function's output to `contract-golden.json` with `assert.deepStrictEqual` (prompts compared as exact strings). `buildWavePrompt` matrix, at least 14 cases: minimal wave; each of `doNotTouch`, `keyFiles`, `reminders` empty and non-empty; acceptance criteria empty and present; several tasks with `files` array, `file` string, `title` versus `name` fallback, and missing fields; wave id taken from `n`, `number`, `id`, and none (`?`); `type: 'parallel'`; a prior failure; an operator context; a Verify command with a timeout; no Verify; a feature name containing backticks. `classifyError` matrix, at least 35 cases as listed in AC#3. `parseWaveResult` matrix, at least 15 blocks as listed in AC#4. A `UPDATE_GOLDEN=1` mode writes the golden file; without it the test only reads and compares.
Validate: AC#1 — every matrix entry has a golden entry and a named assertion; a deliberately wrong golden value makes the test fail (checked once by hand and not committed).

#### Task 1.2: Generate the golden file
File: harness/test/fixtures/contract-golden.json:1-1
What: Run the test once with `UPDATE_GOLDEN=1` against the **unmodified** `contract.js` to write `contract-golden.json`; commit it. Then run the test without the variable and confirm it passes.
Validate: AC#1 — the golden file exists and the test passes against the unmodified code; `git diff` shows `contract.js` untouched in this wave.

### Wave 2 — sequential
Tasks in this wave must run in sequence (each edits `contract.js`).
Verify: npm test --prefix harness

#### Task 2.1: Split buildWavePrompt
File: harness/adapters/agent/contract.js:187-325
What: Replace the body with small helpers: a bullet-list renderer shared by the Do Not Touch, Key Files and Reminders blocks (with the `(none)` fallback), an acceptance-criteria renderer (with the `(see plan file)` fallback), a task-block renderer, and module-level constants or small render functions for the static header, the Guardrail Extensions section, the per-task instructions (interpolating `feature` and `waveNumber`) and the return format (interpolating `waveNumber`). `buildWavePrompt` assembles them in the original order. Each function 40 lines or fewer.
Validate: AC#2, AC#5, AC#7 — the characterization test and the existing `buildWavePrompt` tests pass unchanged; no behavior change, so no new tests.

#### Task 2.2: Split classifyError
File: harness/adapters/agent/contract.js:598-686
What: Extract an error-context helper (numeric status, raw name, lowercased haystack) and one small predicate per bucket (resource, permanent, transient, model), keeping the keyword lists as named module-level constants. `classifyError` applies them in the original order and falls back to `permanent`. Preserve the raw-name comparisons exactly.
Validate: AC#3, AC#5, AC#7 — the characterization test and the existing `classifyError` tests pass unchanged; no behavior change, so no new tests.

#### Task 2.3: Split parseWaveResult
File: harness/adapters/agent/contract.js:340-412
What: Extract helpers for recognizing the top-level status line, starting a new task from a `- title:` line, and applying one task field line (status, commit, concern, error) from a small field table, plus the final wave-status normalization. `parseWaveResult` loops over lines and delegates. Preserve the top-level-versus-indented status rule and the unknown-status-to-`blocked_code` rule.
Validate: AC#4, AC#5, AC#7 — the characterization test and the existing `parseWaveResult` tests pass unchanged; no behavior change, so no new tests.

### Wave 3 — sequential
Tasks in this wave must run in sequence.
Verify: exec bash scripts/verify-all.sh

#### Task 3.1: Refresh the ratchet baseline
File: scripts/lint-function-length-baseline.txt:1-45
What: Run `node scripts/lint-function-length.mjs --write-baseline` and commit the result. Confirm the three `contract.js` entries are gone and nothing else in the file changed except their removal, then confirm `node scripts/lint-function-length.mjs` exits 0.
Validate: AC#6 — the baseline diff only removes those three lines; the lint exits 0.

#### Task 3.2: Full-suite check
File: scripts/lint-function-length-baseline.txt:1-45
What: No further edit. The wave's Verify runs the full suite.
Validate: AC#8 — `scripts/verify-all.sh` passes.

## Tests to Write
- [ ] Characterization of `buildWavePrompt`, `classifyError` and `parseWaveResult` against golden data from the unmodified code — harness/test/contract-characterization.test.js

## Non-Goals
- Changing any output, export or error behavior
- Fixing the `'enoent'` / `'syntaxerror'` raw-name quirk
- Editing, moving or deleting an existing test
- Refactoring anything outside `contract.js`

## Out-of-Scope Dependencies
None.

## Risks
- The prompt template is a long literal with significant whitespace; a stray blank line or a changed interpolation point changes the prompt every agent receives. The byte-for-byte golden comparison across 14+ variants is the control.
- The golden matrix can only catch inputs it contains. The matrices deliberately include the order-dependent and quirk cases, but an input class not listed would go unchecked; the full existing suite (1,500+ tests) is the second net.
- The golden file is generated from the current code: if Wave 1 runs after any `contract.js` edit, the refactor would be certified against itself. The Reminders and the Task 1.2 Validate guard this.
- The new characterization test file is added in a PR that the test-weakening guard inspects; adding a test file does not trigger it, but the golden data contains skip-marker-free strings only.
- Other open work that touches `contract.js` would conflict; none is planned (the next plans touch other files).

## Issue Gaps
- ASSUMPTION: no `Issue:` header, so the deliver PR does not carry a closing reference to #252; the issue is closed by hand after plan 6. The cost is that `plan-open` cannot label the issue.
- ASSUMPTION: the quirk where `classifyError` compares the raw name to `'enoent'` and `'syntaxerror'` is preserved. It looks unintended (a real `SyntaxError` is classified `permanent` unless its message matches), but changing it alters retry behavior, so it should be a separate decision and issue.
- ASSUMPTION: the golden file is one JSON file (a single declared path) holding all three matrices' outputs, not a directory of fixtures, so Files in Scope can name it exactly.
- ASSUMPTION: matrix sizes in Task 1.1 are minimums; the executor may add cases.
- ASSUMPTION: line ranges are from the current file and may shift by a few lines; the executor should stay within the three functions and their helpers.
