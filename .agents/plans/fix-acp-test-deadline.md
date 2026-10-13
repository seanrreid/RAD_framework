# Plan: Make the ACP Timeout Tests Robust Under Load (#275)
Created: 2026-10-13
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-13T20:25:19.864Z
Recorded-By: sean@torchcodelab.com
Branch: rad/fix-acp-test-deadline
Issue: 275
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/275
Issue-Title: ACP test 'ignore-cancel times out at prompt' flakes under load (400 ms deadline expires during initialize)
Source-Author: seanrreid (OWNER)
Source-Comments: 0 total, 0 non-collaborator

## Context
`checkAcpAgent: ignore-cancel times out at prompt and the process is still killed` (`harness/test/acp-adapter.test.js`, ~line 380) fails intermittently when the machine is busy. `checkAcpAgent` applies **one** wall-clock deadline to the whole check (spawn, handshake and prompt), the test sets it to 400 ms (`SHORT_DEADLINE_MS`) and asserts the check that timed out was `prompt`. Under load the fake agent's Node cold start plus handshake can exceed 400 ms, the deadline expires during `initialize`, and the assertion reads `expected 'prompt', actual 'initialize'`. It is a test-timing defect, not a product bug.

**Measured on 2026-10-13** (6 parallel copies of the test, 48 runs per value, in a scratch checkout): `SHORT_DEADLINE_MS` 400 failed 5 of 48 (10.4%); 800 failed 0 of 48; 1500 failed 0 of 48. Alone it passes 25 of 25.

The same constant is shared by three other tests (a hung turn, an ignored cancel and SIGTERM, a grandchild-hang shutdown). They assert only the outcome, so under load they can pass without exercising the hang-at-prompt path they claim to test (the wrong-reason pattern from #269). A larger deadline lets the handshake finish first for all four.

There is precedent in this file: the complete-check test already uses a roomier grace on loaded machines (#230).

This is also the **first delivery through the usage wrapper** (the repository's agent command became `node scripts/claude-usage.mjs` in #274), so its `wave-attempt` events are the real-world check that usage is now recorded.

## Scope
| In scope | Out of scope |
|---|---|
| `SHORT_DEADLINE_MS` and the places that depend on its value, in `acp-adapter.test.js` | Any change to `acp.js` or product behavior |
| A diagnostic message on the step-name assertion | The other timing constants in the file (`FAST`, the 2000 ms grace) |
| | Making the per-step deadlines independent (a product change) |

## Acceptance Criteria
1. **One larger constant.** `SHORT_DEADLINE_MS` is 1500 and every use of it (the hung-turn, ignored-cancel, grandchild-hang and `checkAcpAgent` tests) is unchanged apart from the value.
2. **Messages cannot drift.** The two assertions that match `timed out after 400ms` (the wave message and the `acp-check` message) build their regular expressions from `SHORT_DEADLINE_MS` instead of a literal, so a future change to the constant cannot silently break them.
3. **A useful failure.** The assertion `lastCheck(report).name === 'prompt'` carries a message saying the deadline expired during the named step and that a slow machine may need a larger `SHORT_DEADLINE_MS`.
4. **The flake is gone.** Running the test `checkAcpAgent: ignore-cancel times out at prompt` in 6 parallel copies for 8 rounds (48 runs) produces 0 failures.
5. **Nothing else changes.** No other assertion in the file is edited; no test is removed, renamed or skipped (the file still has the same number of tests); no file other than `harness/test/acp-adapter.test.js` is modified.
6. **Full suite passes.** `scripts/verify-all.sh` passes on the delivered branch.

## Agent Scope
No sub-agents were called. Research was inline (9 tool calls): the test and its helpers, how the check applies its deadline, every use of the constant, and a measured comparison of 400, 800 and 1500 ms under load in a scratch checkout (removed; the repository was not modified).

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/test/acp-adapter.test.js | 15-22, 178-194, 214-222, 378-388 | The constant, the two message matchers, the diagnostic message |

## Execution Notes

### Do Not Touch
- harness/adapters/agent/acp.js and every other file
- Every test in `acp-adapter.test.js` other than the four that use the constant and the matchers named in AC#2

### Key Files
- harness/test/acp-adapter.test.js — `SHORT_DEADLINE_MS` (~line 20), its uses at ~181, ~189, ~217 and ~382, the matchers at ~183 and ~385

### Reminders
- `harness/` is self-protected: architect approval and the last-wave full-suite Verify. Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800` AND `RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- Write the stress loop as a throwaway shell command and do not commit it: 8 rounds of 6 parallel `node --test --test-name-pattern="checkAcpAgent: ignore-cancel times out at prompt" harness/test/acp-adapter.test.js` runs, counting non-zero exits. Report the count in the task note.
- Keep a short comment on the constant saying why it is 1500 (the handshake must finish before the deadline on a loaded machine; measured) and referencing #275.
- A larger deadline makes each of the four tests take about 1.1 s longer; that is accepted.

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence.
Verify: exec bash scripts/verify-all.sh

#### Task 1.1: Raise the deadline and tie the messages to it
File: harness/test/acp-adapter.test.js:15-22, harness/test/acp-adapter.test.js:178-194, harness/test/acp-adapter.test.js:214-222, harness/test/acp-adapter.test.js:378-388
What: Change `SHORT_DEADLINE_MS` to 1500 with the comment from the Reminders. Replace the literal `/wave timed out after 400ms/` and `/acp-check timed out after 400ms/` with regular expressions built from `SHORT_DEADLINE_MS`. Add the diagnostic message of AC#3 to the `name === 'prompt'` assertion. Do not touch any other line.
Validate: AC#1, AC#2, AC#3, AC#5 — `git diff` shows only those changes in that one file; the test file's test count is unchanged; `node --test harness/test/acp-adapter.test.js` passes.

#### Task 1.2: Stress and full-suite check
File: harness/test/acp-adapter.test.js:15-22
What: No further edit. Run the stress loop of the Reminders and record that the failures are 0 of 48. The wave's Verify then runs the full suite.
Validate: AC#4, AC#6 — 0 failures in 48 loaded runs; `scripts/verify-all.sh` passes.

## Tests to Write
- None new. This plan changes a timing constant and assertion messages in an existing test; the stress loop of AC#4 is the verification, and a flaky-test fix has no separate unit under test.

## Non-Goals
- Changing `acp.js` or making its deadlines per step
- Retuning any other timing constant in the file
- Adding retries to the tests (a retry would hide the cause)

## Out-of-Scope Dependencies
None.

## Risks
- The four affected tests each run about 1.1 s longer, so the file takes about 4.4 s longer in total.
- 1500 ms is measured-safe on this machine under 6-way parallel load, not a guarantee on every CI runner. If it flakes there, the diagnostic message of AC#3 says exactly why, and the constant is one number.
- The other three tests would still pass if the deadline hit during the handshake; the larger value makes that unlikely but does not assert it. A stronger assertion that the prompt step was reached would need a trace marker from the fake agent and is left to a later change if it ever matters.

## Issue Gaps
- ASSUMPTION: 1500 ms rather than 800 ms, because both measured clean and the larger value leaves a wider margin for slower CI runners at a cost of about 2.8 s more across the four tests.
- ASSUMPTION: no `Issue:`-closing behavior is relied on; the issue is closed by hand after merge.
- ASSUMPTION: line ranges are from the current file and may shift by a few lines; the executor should stay within the named areas.
