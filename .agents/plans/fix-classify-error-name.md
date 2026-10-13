# Plan: Classify Errors by Their Lowercased Name, So a Real SyntaxError Is a Model Error (#260)
Created: 2026-10-13
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-13T17:42:53.339Z
Recorded-By: sean@torchcodelab.com
Branch: rad/fix-classify-error-name
Issue: 260
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/260
Issue-Title: classifyError compares the raw error name, so a real SyntaxError is classified permanent, not model
Source-Author: seanrreid (OWNER)
Source-Comments: 1 total, 0 non-collaborator

## Context
`classifyError` (`harness/adapters/agent/contract.js`) builds a lowercased keyword haystack from the error name, message and string code, but two of its checks compare the **raw, un-lowercased** `err.name` to lowercase literals: `name === 'enoent'` in the permanent check and `name === 'syntaxerror'` in the model check. Real names are `'Error'` or `'SyntaxError'`, so the second comparison never matches a genuine `SyntaxError`. Such an error is classified `model` only when its message happens to contain `malformed`, `invalid json`, `invalid-json` or `unexpected token`; otherwise it falls to the default `permanent`. Verified on 2026-10-13: `JSON.parse('{')` fails with a `SyntaxError` whose message ("Expected property name or '}' in JSON ...") has none of those keywords, and it is classified `permanent`.

**Impact, stated accurately** (the issue's first draft overstated it; corrected on the issue): `classifyError` has one production consumer, `sdk.js` `runWithRetry`, which only asks whether the bucket is `transient`. `permanent`, `model` and `resource` all lead to the same terminal failure there, and the command and ACP adapters do not call it. So this fix changes **no observable adapter behavior today**. It makes the returned label match the documented bucket meanings (`model` = the model produced something unusable, "malformed / invalid JSON"), so a future adapter that treats `model` differently does not inherit a wrong label. The `enoent` comparison is harmless (an `ENOENT` falls to the same default) and is fixed only for consistency.

**Decision (architect, 2026-10-13): fix the label.** Both name comparisons use the lowercased name. The precedence order is unchanged (resource, permanent, transient, model, default permanent).

**Golden data changes on purpose.** Plan 1 (#261) pinned today's behavior, including the quirk, in `contract-golden.json` (65 `classifyError` entries). Exactly two entries must change: `raw name SyntaxError` and `raw name SyntaxError with message`, both from `permanent` to `model`. Every other entry must stay identical; that is the proof the fix is as narrow as intended.

**Also fixed in passing (comment only).** Plan 1's refactor left `classifyError`'s doc comment sitting above the keyword constants, so it documents `RESOURCE_KEYWORDS` and not the function. It moves back above `classifyError`.

## Scope
| In scope | Out of scope |
|---|---|
| Compare the lowercased name in the permanent and model checks | Making `model`, `resource` or `permanent` produce different handling in any adapter |
| Explicit tests for the new behavior and the unchanged precedence | The command and ACP adapters, which do not use `classifyError` |
| Updating exactly the two golden entries, reviewed as a diff | Any other change to the golden data or to keyword lists |
| Moving the misplaced doc comment back to `classifyError` | `backoffWithJitter`, `withTimeout` and the rest of `contract.js` |

## Acceptance Criteria
1. **A real SyntaxError is a model error.** `classifyError` returns `model` for an error whose name is `SyntaxError` and whose message contains none of the resource, permanent or transient keywords, including the failure from `JSON.parse('{')` and a `new SyntaxError('bad input')`.
2. **Name matching is case-insensitive.** An error named `SyntaxError`, `syntaxerror` or `SYNTAXERROR` is `model`; an error named `ENOENT`, `enoent` or `Enoent` is `permanent` (the same result it had before, now by an explicit match).
3. **Precedence is unchanged.** A `SyntaxError` whose message contains a resource keyword is `resource`, a permanent keyword is `permanent`, and a transient keyword (or a transient numeric status) is `transient`; a numeric `401` status still beats a `SyntaxError` name; the default for an unknown error stays `permanent`.
4. **Nothing else changes.** After regenerating the golden file, `git diff` of `contract-golden.json` shows exactly two changed `classifyError` values, `raw name SyntaxError` and `raw name SyntaxError with message`, each `permanent` to `model`, and no other change in any section.
5. **Adapters unchanged.** The adapter characterization test and the existing SDK adapter tests pass unchanged: `sdk.js` still retries only `transient`.
6. **The doc comment is back.** The `classifyError` doc comment sits directly above `classifyError`; the comment claiming the raw name is deliberate is gone or states the new behavior; the keyword constants keep their own one-line comment.
7. **Ratchet intact.** `node scripts/lint-function-length.mjs` exits 0 with the empty baseline (every helper stays at 40 lines or fewer).
8. **Full suite passes.** `scripts/verify-all.sh` passes on the delivered branch.

## Agent Scope
No sub-agents were called. Research was inline (7 tool calls): every consumer of `classifyError`, the documented bucket meanings, the current helpers in `contract.js`, the golden entries and the characterization case table for the raw-name cases, and the existing `classifyError` tests.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/adapters/agent/contract.js | 596-720 | `errorContext` returns the lowercased name; the permanent and model checks use it; the doc comment moves back above `classifyError` |
| harness/test/agent-contract.test.js | 144-180 | New tests next to the existing `classifyError` tests (existing tests unchanged) |
| harness/test/contract-characterization.test.js | 150-165 | Update any comment that describes the raw-name quirk as deliberate; no scenario is removed |
| harness/test/fixtures/contract-golden.json | 1-1 | Regenerated; exactly two `classifyError` values change |

## Execution Notes

### Do Not Touch
- harness/adapters/agent/sdk.js, command.js, acp.js and the rest of `contract.js` outside `classifyError` and its helpers
- Every existing test in agent-contract.test.js (new tests are added beside them; none is edited, moved, skipped or deleted)
- The golden sections `buildWavePrompt` and `parseWaveResult`, and every `classifyError` golden entry other than the two named

### Key Files
- harness/adapters/agent/contract.js — `errorContext`, `isPermanentError`, `isModelError`, `classifyError` (~598-720)
- harness/test/contract-characterization.test.js — the case table (`withName(...)` cases around line 157) and the `UPDATE_GOLDEN=1` mode
- docs/rad-wave-contract.md (~578) — step 3 names the buckets; no change needed

### Reminders
- harness/ is self-protected: architect approval and the last-wave full-suite Verify. Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800` AND `RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- The characterization test will fail after the fix until the golden file is regenerated; that is expected and happens inside the same wave (Task 1.3). Regenerate with `UPDATE_GOLDEN=1`, then **inspect `git diff` of the golden file** and confirm exactly the two intended values changed before committing. If any other value changed, stop and report; do not commit it.
- Keep the check order exactly: resource, permanent, transient, model, default permanent.
- Keep `includesAny`, the keyword lists and the numeric-status sets as they are.
- The new tests belong beside the existing ones; do not modify an existing assertion.

## Program Design

```js
// harness/adapters/agent/contract.js (module-private helpers; classifyError's signature is unchanged)
errorContext(err)            // -> { numericStatus, name, lowerName, haystack }   (lowerName = name.toLowerCase())
isPermanentError(ctx)        // ... || ctx.lowerName === 'enoent'
isModelError(ctx)            // includesAny(haystack, MODEL_KEYWORDS) || ctx.lowerName === 'syntaxerror'
export function classifyError(err)   // order: resource, permanent, transient, model, default 'permanent'
```

File tree diff:

```
harness/adapters/agent/contract.js                      errorContext + two comparisons + doc comment moved
harness/test/agent-contract.test.js                     + new classifyError tests
harness/test/contract-characterization.test.js          comment wording only
harness/test/fixtures/contract-golden.json              2 values changed
```

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (1.2 tests the change from 1.1; 1.3 regenerates data that depends on it).
Verify: exec bash scripts/verify-all.sh

#### Task 1.1: Compare the lowercased name
File: harness/adapters/agent/contract.js:596-720
What: Add `lowerName` (the name lowercased) to the object `errorContext` returns, and use it in place of the raw `name` in the `enoent` check of `isPermanentError` and the `syntaxerror` check of `isModelError`. Remove the "deliberately against the un-lowercased name" comment. Move the doc comment currently above `RESOURCE_KEYWORDS` back directly above `classifyError`, and give the keyword constants a one-line comment of their own. No other change.
Validate: AC#1, AC#2, AC#3, AC#6, AC#7 — covered by the tests in Task 1.2 and the characterization data in Task 1.3; `node scripts/lint-function-length.mjs` exits 0.

#### Task 1.2: Tests for the new behavior
File: harness/test/agent-contract.test.js:144-180
What: Add tests beside the existing `classifyError` tests: a `SyntaxError` from `JSON.parse('{')` is `model`; `new SyntaxError('bad input')` is `model`; names `SyntaxError`, `syntaxerror` and `SYNTAXERROR` are `model`; names `ENOENT`, `enoent` and `Enoent` are `permanent`; a `SyntaxError('token limit reached')` is `resource`, `SyntaxError('forbidden')` is `permanent`, `SyntaxError('timeout')` and a `SyntaxError` with status `503` are `transient`; a `SyntaxError` with status `401` is `permanent`; an error with name `TypeError` and a keyword-free message stays `permanent`; `null`, `undefined`, a plain string and `{}` keep their current buckets. Do not edit any existing assertion.
Validate: AC#1, AC#2, AC#3 — each case is a named assertion; edge cases (`null`, `undefined`, string, empty object, mixed-case names) are explicit.

#### Task 1.3: Update the golden data, narrowly
File: harness/test/fixtures/contract-golden.json:1-1, harness/test/contract-characterization.test.js:150-165
What: Run `UPDATE_GOLDEN=1 node --test harness/test/contract-characterization.test.js` to regenerate the golden file, then review `git diff` of the golden file and confirm exactly two values changed (`raw name SyntaxError` and `raw name SyntaxError with message`, `permanent` to `model`) and nothing in `buildWavePrompt` or `parseWaveResult`. Update any comment in the characterization test that calls the raw-name behavior deliberate; keep every scenario. Run the test without the variable twice and confirm both pass.
Validate: AC#4, AC#5, AC#8 — the golden diff is exactly the two intended values; the adapter characterization test and the SDK adapter tests pass unchanged; the wave's full-suite Verify (`scripts/verify-all.sh`) passes.

## Tests to Write
- [ ] `classifyError` cases for SyntaxError, name case-insensitivity, unchanged precedence and degenerate inputs — harness/test/agent-contract.test.js

## Non-Goals
- Changing how any adapter reacts to `model`, `resource` or `permanent`
- Adding keywords or changing the numeric status sets
- Editing, moving, skipping or deleting any existing test or assertion
- Any change to `sdk.js`, `command.js` or `acp.js`

## Out-of-Scope Dependencies
None.

## Risks
- The change is a classification label for a function with one consumer that only distinguishes `transient`, so the production risk is very low. The golden diff check (exactly two values) and the adapter characterization (unchanged) are the controls.
- The fix updates golden data that plan 1 pinned on purpose to protect a refactor. That protection exists to catch accidental change; this change is deliberate, narrow and reviewed as a diff.
- A future adapter that begins to treat `model` differently would now see genuine `SyntaxError`s in that bucket; that is the intended behavior.

## Issue Gaps
- ASSUMPTION: every `SyntaxError` is `model`, including one raised by an adapter's own bug (not by model output). The documented meaning of `model` is "malformed / invalid JSON", and since all non-transient buckets behave the same today, mislabeling a code bug as `model` has no current effect.
- ASSUMPTION: moving the misplaced doc comment back is in scope because it is in the same function and is comment-only.
- ASSUMPTION: line ranges are from the current file and may shift by a few lines; the executor should stay within `classifyError` and its helpers.
