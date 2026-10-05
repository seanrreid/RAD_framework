# Plan: Command Adapter Survives an Agent That Skips stdin (#177)
Created: 2026-10-05
Author: architect
Status: complete
Completed-At: 2026-10-05T18:36:20Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-05T18:20:12.175Z
Recorded-By: sean@torchcodelab.com
Branch: rad/command-stdin-epipe
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/177
Issue-Title: command adapter crashes with uncaught EPIPE when the agent CLI exits without reading stdin

## Context

`spawnOnce` in `harness/adapters/agent/command.js` (lines 196-247) writes the prompt to the child's stdin (lines 242-245). Nothing listens for `'error'` on `child.stdin`.

If the agent CLI exits before reading stdin, the write fails with `EPIPE`. Node raises that as an **uncaught exception**, and the whole `rad deliver`, `rad review` or preflight process dies. Instead, the child's non-zero exit should be classified as a failed attempt. A mid-wave crash leaves a `wave-started` event with no matching `wave-attempt`, an orphan that `--resume` then has to clean up.

Real triggers are an agent that exits early on an auth failure, a bad flag or a broken wrapper.

**Evidence:**
- CI on PR #176 (Linux): `write EPIPE` from `command.js:243`, as an `uncaughtException`.
- The test there passed on macOS only because the pipe buffer (64 KiB) absorbed the small prompt.
- #176 worked around it in the test; this plan fixes the adapter.

## Scope

| In scope | Out of scope |
|---|---|
| A stdin `'error'` handler in `spawnOnce`, covering waves, `rad review` and preflight, which all share it | Changing exit classification (`describeExitFailure`) |
| Regression tests with a prompt larger than the pipe buffer | Partial-read agents (they already work) |

## Acceptance Criteria

1. `spawnOnce` attaches an `'error'` listener to `child.stdin` before writing.
   - **`EPIPE`:** the agent closed stdin early. This is expected, not fatal. The promise still settles from the child's `'close'` event with its real exit code and output, and nothing is thrown or rejected.
   - **Any other stdin error:** the promise rejects with `command adapter: writing the prompt to the agent's stdin failed: <code or message>`. Errors are never swallowed.
   - The EPIPE case is named in a constant (for example `STDIN_CLOSED_EARLY_CODE = 'EPIPE'`), with a comment stating the constraint.
2. **Regression tests** in `harness/test/agent-adapters.test.js`:
   - **`runCommandPrompt`:** a child that exits without reading stdin, given a prompt of at least 1 MiB (well past any pipe buffer), resolves with that child's exit code (`true` gives 0, `false` gives 1) and does not throw.
   - **`createCommandAdapter` `runWave`:** the same child and a prompt of at least 1 MiB give a failed-attempt result (no WAVE_RESULT block → `fail-protocol` or the adapter's existing classification for that case), with no uncaught exception.
   - **Pinning against the old code:** each test fails against today's `command.js`, on both macOS and Linux. Check this once by hand by reverting the handler, and say so in the WAVE_RESULT.
3. Every suite stays green:
   - harness tests and evals;
   - every `scripts/test-*.sh` under both `bash` and `/bin/bash`;
   - `lint-shell-safety`, `lint-invariants`.

## Agent Scope

No mapper agents were used. The defect site was read directly (`command.js` 186-247, `spawnOnce`), and so were the adapter's test entry points (`runCommandPrompt` and `probeCommand` tests in `agent-adapters.test.js`).

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/adapters/agent/command.js | 30-75 | Named constant |
| harness/adapters/agent/command.js | 186-250 | stdin `'error'` handler in `spawnOnce` |
| harness/test/agent-adapters.test.js | 1170-1240 | EPIPE regression tests (append) |

## Execution Notes

### Do Not Touch
- `ENV_ALLOW_LIST` and `buildChildEnv` (the env allow-list invariant)
- `describeExitFailure`, `tokenizeCommand`, the output cap, `killOnAbort`
- harness/cli.js, harness/spine.js, harness/evals/

### Key Files
- `harness/adapters/agent/command.js`: `spawnOnce`, `runCommandPrompt`, `createCommandAdapter`
- `harness/test/agent-adapters.test.js`: existing `runCommandPrompt` / `probeCommand` test idioms (temp dirs, inline node scripts as `cmd`)

### Reminders
- **Never swallow errors.** Only `EPIPE` is expected; every other stdin error rejects with context.
- **The promise settles once.** The `'close'` event resolves it, so don't resolve early from the stdin handler.
- **No en dashes.**

## Wave Plan

### Wave 1 — sequential

#### Task 1.1: Handle stdin EPIPE in spawnOnce
File: harness/adapters/agent/command.js:30-75, harness/adapters/agent/command.js:186-250, harness/test/agent-adapters.test.js:1170-1240
What: Implement AC#1 and AC#2.
Validate: AC#1, AC#2, AC#3. Edge cases:
- the child exits 0 without reading;
- the child exits 1 without reading;
- a prompt larger than the pipe buffer;
- a `{prompt}` placeholder (nothing is written to stdin, so the handler is a no-op);
- a non-EPIPE stdin error, simulated by destroying the stream with a custom error, which must reject.

Commands:
- `npm test --prefix harness`;
- `node --test harness/evals/*.eval.js`;
- every `scripts/test-*.sh` under both shells;
- `scripts/lint-shell-safety.sh`, `scripts/lint-invariants.sh`.

## Tests to Write
- [ ] stdin EPIPE regression cases — harness/test/agent-adapters.test.js

## Non-Goals
- Retrying or reclassifying an agent that exits early. Its exit code already drives the existing classification.
- Streaming the prompt in chunks.

## Out-of-Scope Dependencies
None.

## Risks
- **Platform-dependent test.** Whether `EPIPE` fires depends on timing. A 1 MiB prompt makes it certain once the child has exited, on both platforms.
- **Self-protected path:** `harness/` triggers an advisory lint warning by design.

## Issue Gaps
- None. The issue states the defect, the evidence and the fix.
