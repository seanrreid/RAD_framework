# Plan: CLI Symlink Gate Fix (fail-closed main-module guard)
Created: 2026-09-30
Author: architect
Status: pending-review
Branch: rad/cli-symlink-gate-fix
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/168
Issue-Title: Approval gate fails open when harness/cli.js is invoked via a symlinked path (main-module guard)

## Context

**This is a fail-open bypass of RAD's core approval gate.** `harness/cli.js` only runs `main()` when `fileURLToPath(import.meta.url) === process.argv[1]` (`cli.js:2745` on main). `import.meta.url` is the file's real path, and `argv[1]` is the path as invoked. Invoked through a **symlinked path**, the CLI runs nothing and exits **0** with no output.

`scripts/check-plan-approved.sh` runs `node "$CLI" gate <feature> approved` (finding `cli.js` relative to its own, possibly symlinked, location) and passes that exit code straight through. It's called by the `/rad-deliver` PreToolUse hook. So on any checkout reached through a symlink, **every plan reads as approved**, including features that don't exist.

**Reproduced (2026-09-30):**
- A symlinked checkout: `node <link>/harness/cli.js gate no-such-feature approved` exits **0** with no output.
- The real path: exit 1, `passed=false`.

Found while delivering #87a: its fixture tests hit the silent no-op through macOS `/var` → `/private/var` temp dirs.

## Scope

| In scope | Out of scope |
|---|---|
| Main-module guard compares real paths | Any other CLI behavior |
| `check-plan-approved.sh` requires the gate's `passed=true` line (fail-closed on silent exit 0) | Reworking how scripts locate the CLI |
| `get-default-branch.sh` treats exit 0 with empty output as an error | Other `config get` callers (they already fail on empty required data) |
| Regression tests + a symlinked-checkout eval case + a registry anchor | |

## Acceptance Criteria

1. The CLI's main-module guard compares `realpathSync(process.argv[1])` with `realpathSync(fileURLToPath(import.meta.url))`, falling back to the raw comparison only if `realpathSync` throws. Invoked through a symlinked path, every verb runs exactly as through the real path.
2. `scripts/check-plan-approved.sh` treats the gate as passed **only** when the CLI exits 0 **and** its stdout contains `passed=true`. Exit 0 with empty or non-matching output is a refusal: exit 1, with the reason `rad gate produced no verdict`.
3. `scripts/get-default-branch.sh`: a `config get default_branch` that exits 0 with empty output is an error (exit 1, named reason), never an empty branch name.
4. The tests cover the following:
   - **`harness/test/cli.test.js`:** spawning `node <symlink-to-repo>/harness/cli.js gate no-such-feature approved` exits 1 with `passed=false`, and a symlinked `config validate` produces output.
   - **`scripts/test-check-plan-approved.sh`:** a stubbed CLI that exits 0 silently → exit 1 and "no verdict".
   - **`harness/evals/approval.eval.js` `gate-hook-via-symlinked-checkout`:** the deliver-gate hook, invoked through a symlinked path to an **unapproved** fixture, blocks with exit 2. Its mutation restores the old string-compare guard in the fixture's `cli.js`, and the `[mutated]` twin passes the unapproved plan, so its assertion fails.
5. `docs/invariants.yaml` `unapproved-deliver-cannot-run` gains an anchor on the realpath guard and on the `passed=true` check, and `scripts/lint-invariants.sh` passes.
6. Every suite stays green: harness tests, evals, every shell test under both shells, `lint-shell-safety`, `lint-invariants`.

## Agent Scope

No mapper agents were used. The defect was reproduced directly (a symlinked `rad gate` exits 0 silently), and the call path was read: `check-plan-approved.sh` → `node "$CLI" gate`; `deliver-gate-hook.mjs` → `check-plan-approved.sh`.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/cli.js | 2740-2760 | Realpath-based main-module guard |
| harness/test/cli.test.js | 1700-1760 | Symlinked-invocation tests (append) |
| scripts/check-plan-approved.sh | 125-145 | Require `passed=true` in the gate output |
| scripts/test-check-plan-approved.sh | 200-260 | Silent-exit-0 stub case (append) |
| scripts/get-default-branch.sh | 1-60 | Empty output with exit 0 is an error |
| harness/evals/approval.eval.js | 240-300 | `gate-hook-via-symlinked-checkout` case (append) |
| docs/invariants.yaml | 1-40 | Anchors on the guard and the verdict check |

## Execution Notes

### Do Not Touch
- harness/gates.js and the gate fold; every other `cli.js` verb
- scripts/deliver-gate-hook.mjs (it inherits the fix through `check-plan-approved.sh`)

### Key Files
- harness/cli.js — the main-module guard at the end of the file
- scripts/check-plan-approved.sh — the `node "$CLI" gate … approved --stdin` call and its exit handling
- harness/evals/lib/fixture.js — `createFixture` (the eval creates a symlink to `fx.root` inside `fx.base`)

### Reminders
- **Deliver after #169 (#87a) merges, and rebase first.** Both touch `harness/cli.js` and `scripts/get-default-branch.sh`.
- **Fail-closed at the gate boundary:** a verb that always prints a verdict and prints nothing is a failure, never a pass.
- **Shell-safety lint and bash 3.2** portability for script changes.

## Wave Plan

### Wave 1 — parallel
Tasks in this wave can run in parallel (disjoint files).

#### Task 1.1: Realpath main-module guard
File: harness/cli.js:2740-2760, harness/test/cli.test.js:1700-1760
What: Implement AC#1 and the `cli.test.js` part of AC#4.
Validate: AC#1, AC#4 — `npm test --prefix harness`; the manual reproduction now exits 1 through the symlink.

#### Task 1.2: Fail-closed verdict checks in scripts
File: scripts/check-plan-approved.sh:125-145, scripts/test-check-plan-approved.sh:200-260, scripts/get-default-branch.sh:1-60
What: Implement AC#2, AC#3 and the script part of AC#4.
Validate: AC#2, AC#3, AC#4 — `bash scripts/test-check-plan-approved.sh && /bin/bash scripts/test-check-plan-approved.sh`; `scripts/lint-shell-safety.sh` shows no `✗`.

### Wave 2 — sequential
The eval and the registry, after both fixes exist.

#### Task 2.1: Symlinked-checkout eval + registry
File: harness/evals/approval.eval.js:240-300, docs/invariants.yaml:1-40
What: Implement the eval part of AC#4, and AC#5.
Validate: AC#4, AC#5, AC#6 — `node --test harness/evals/approval.eval.js` (including `[mutated]`); `scripts/lint-invariants.sh` exits 0; the full suite is green.

## Tests to Write
- [ ] Symlinked CLI invocation — harness/test/cli.test.js
- [ ] Silent-exit-0 gate refusal — scripts/test-check-plan-approved.sh
- [ ] gate-hook-via-symlinked-checkout eval — harness/evals/approval.eval.js

## Non-Goals
- Changing how scripts locate the CLI (for example, by resolving `SCRIPT_DIR` with `pwd -P`). The guard fix makes symlinked invocation correct, and the verdict check makes silence fail closed.
- Auditing every other script that calls the CLI. The ones that gate (`check-plan-approved.sh`) or supply gate inputs (`get-default-branch.sh`) are covered here.

## Out-of-Scope Dependencies
None. All paths are architect-owned, and the author is the architect.

## Risks
- **Output-format coupling.** `check-plan-approved.sh` now depends on the gate's `passed=true` token. That's already the stable, documented `rad gate` output format, and the registry anchors it.
- **Self-protected paths:** `harness/` and `scripts/` trigger advisory lint warnings by design.

## Issue Gaps
- **ASSUMPTION — defence in depth.** It fixes the guard (the root cause) and also makes the gate consumer fail closed on silence, so any future silent-exit regression still refuses.
- **ASSUMPTION — sequencing.** It's delivered after #169 (#87a) merges, to avoid conflicts in `cli.js` and `get-default-branch.sh`.
