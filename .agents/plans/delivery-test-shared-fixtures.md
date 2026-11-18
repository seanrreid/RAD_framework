# Plan: delivery test shared fixtures (Plan J: share planFor, squashBody and write between two tests, #331)
Created: 2026-11-18
Author: developer
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-11-18T20:13:31.376Z
Recorded-By: sean@torchcodelab.com
Branch: rad/delivery-test-shared-fixtures
Issue: 331
Source-Author: seanrreid (OWNER)
Source-Comments: 0 total, 0 non-collaborator

## Context
`harness/test/delivery-history.test.js` and `harness/test/insights-rework-load.test.js` each define `planFor`, `squashBody` and `write` with byte-identical bodies. `squashBody` encodes the commit-body format that `readDeliveryHistory` parses to find the deliver slug, so two copies can drift; drift would fail the 4i golden loudly, so this is a low-urgency tidy. Measured: the other helpers do not fit one shared form: `git` asserts on exit status and returns trimmed stdout in `delivery-history.test.js` but takes a date, sets author env and throws in `insights-rework-load.test.js`, and `commit` and `deliver` differ in signature for the same reason, so they stay local. `harness/test/generate.test.js` has an unrelated `planFor(root)`; it is not touched. `node --test harness/test/*.test.js` (see `scripts/verify-all.sh`) only picks up `*.test.js`, and `scripts/lint-function-length.mjs` excludes `test`, so a helper module named without `.test.js` is neither run as a test nor linted.

## Scope
| In scope | Out of scope |
|---|---|
| A shared `harness/test/delivery-fixtures.js` exporting `planFor`, `squashBody`, `write`, with a test that pins their exact output | The `git`, `commit` and `deliver` helpers (their signatures and failure modes differ) |
| Both tests import the three helpers and drop their copies | The 29 other `function write` copies across `harness/test/` and `generate.test.js`'s unrelated `planFor` |
| | Any change to `readDeliveryHistory`, the 4i module or the goldens |

## Acceptance Criteria
1. `harness/test/delivery-fixtures.js` exports `planFor(title, paths)`, `squashBody(slug)` and `write(root, rel, content)` whose output is byte-identical to the two current copies, pinned by `harness/test/delivery-fixtures.test.js` with literal expected strings.
2. `delivery-history.test.js` and `insights-rework-load.test.js` import those three helpers and define none locally; every import that becomes unused is removed.
3. Both tests pass with their assertions unchanged, and `harness/test/fixtures/insights-parity/golden.txt` is unchanged.
4. The helper file is not named `*.test.js`, so `node --test harness/test/*.test.js` does not run it as a test, and `squashBody`'s output is still parsed by `readDeliveryHistory` (covered by the existing tests).
5. `bash scripts/verify-all.sh` passes.

## Agent Scope
Developer role, no architect-only agents. Research was done directly (the issue, both test headers and helper blocks, the `*.test.js` glob in `scripts/verify-all.sh`, the function-length lint scope, a grep for other `planFor`/`squashBody` users).

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/test/delivery-fixtures.js | 1-30 | New: shared `planFor`, `squashBody`, `write` |
| harness/test/delivery-fixtures.test.js | 1-40 | New: pins the helpers' exact output |
| harness/test/delivery-history.test.js | 1-31 | Import the helpers; delete the local `planFor` and `write` |
| harness/test/delivery-history.test.js | 54-56 | Delete the local `squashBody` |
| harness/test/insights-rework-load.test.js | 1-37 | Import the helpers; delete the local `planFor`, `squashBody` and `write` |

## Program Design
```
// harness/test/delivery-fixtures.js
export const planFor = (title, paths) => `# Plan: ${title}\n\n## Files in Scope\n...`   // body unchanged
export const squashBody = (slug) => `* plan: x\n\n* approve: ${slug}\n\nPlan: .agents/plans/${slug}.md\n\n* deliver(${slug}): begin execution`
export function write(root, rel, content)   // mkdir -p the parent, then writeFileSync
```
Added files: `harness/test/delivery-fixtures.js`, `harness/test/delivery-fixtures.test.js`. Changed: the two tests. Deleted: three duplicated helpers per test. No `scripts/` change, no generated copies.

## Execution Notes

### Do Not Touch
- harness/delivery-history.js, harness/insights-rework-load.js and harness/test/fixtures/insights-parity/golden.txt: behavior and the goldens are the contract; never regenerate the golden.
- Every other test file in `harness/test/`.

### Key Files
- harness/test/delivery-history.test.js and harness/test/insights-rework-load.test.js - the helper blocks to replace (`planFor` lines 12-18 and 17-23, `squashBody` lines 55 and 24).

### Reminders
- Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800 RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- A failed deliver stop (`class=failed`) cannot be resumed: fix, re-approve from the preserved worktree if the plan changed, remove the worktree, re-run `rad deliver` without `--resume`.
- Copy the three helper bodies byte-for-byte from the current tests before deleting anything; the new test's expected strings must come from that capture, not from the new module.
- The shared file must not end in `.test.js`.
- Every file a task may change is declared above; if another is needed, stop and report.

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (the test pins the module).

#### Task 1.1: Add the shared module and pin it
File: harness/test/delivery-fixtures.js:1-30, harness/test/delivery-fixtures.test.js:1-40
What: Create the module with the three helpers copied byte-for-byte from the current tests. Write the test with literal expected strings captured from the old copies. Edge cases, each a test: `planFor` with no paths (an empty table body, as `delta` uses `[]`), one path, several paths; `squashBody` for a plain slug and a slug containing a hyphen and digits; `write` creating a nested parent that does not exist and overwriting an existing file.
Validate: AC#1, AC#4 - `node --test harness/test/delivery-fixtures.test.js` passes; the file name does not match `*.test.js`.

### Wave 2 — sequential
Depends on: Wave 1 complete
Verify: exec bash scripts/verify-all.sh

#### Task 2.1: Adopt the shared helpers in delivery-history.test.js
File: harness/test/delivery-history.test.js:1-31, harness/test/delivery-history.test.js:54-56
What: Import `planFor`, `squashBody`, `write` from `./delivery-fixtures.js`; delete the three local definitions; remove imports (`mkdirSync`, `writeFileSync`, `dirname`) only if nothing else in the file still uses them. Edge case: the file's own tests must pass without assertion edits.
Validate: AC#2, AC#3 - `node --test harness/test/delivery-history.test.js` passes unchanged.

#### Task 2.2: Adopt the shared helpers in insights-rework-load.test.js
File: harness/test/insights-rework-load.test.js:1-37
What: Same replacement. Edge case: the 4i golden parity tests must pass with the golden file untouched (`git diff` on `golden.txt` is empty).
Validate: AC#2, AC#3 - `node --test harness/test/insights-rework-load.test.js` passes unchanged; AC#5 - `bash scripts/verify-all.sh` passes (the wave's Verify line).

## Tests to Write
- [ ] `planFor` (no, one, several paths), `squashBody` (plain and hyphen/digit slug), `write` (nested parent, overwrite) - harness/test/delivery-fixtures.test.js

## Non-Goals
- Unifying `git`, `commit` and `deliver`; their date handling and failure modes differ.
- Deduplicating the other `write` copies in `harness/test/` or touching `generate.test.js`.
- Changing what any test asserts or any golden.

## Out-of-Scope Dependencies
None

## Risks
- A helper not named `*.test.js` is invisible to the `node --test` glob; if someone renames it to `.test.js` it will run as an empty test file. The file-name AC guards this.
- Byte drift while copying `planFor`'s template literal (trailing newline) would pass the new test only if its expected string was captured from the module; the Reminders require capturing from the old copies.
