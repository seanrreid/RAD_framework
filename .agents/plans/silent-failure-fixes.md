# Plan: Silent-Failure Fixes (empty scope table, missing blocker script)
Created: 2026-09-28
Author: architect
Status: complete
Completed-At: 2026-09-28T16:32:27Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-09-28T16:21:28.554Z
Recorded-By: sean@torchcodelab.com
Branch: rad/silent-failure-fixes
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/145, https://github.com/seanrreid/RAD_framework/issues/142
Issue-Title: lint-plan.sh exits 1 with no output on an empty Files in Scope table (#145) + defaultSh maps a missing script to exit 1, so rad approve mislabels it (#142)

## Context

Both bugs are failures that report the wrong reason, or none at all. That breaks the CLAUDE.md convention that every failure path logs its reason with context. Both already fail closed, so neither is a safety hole.

- **#145.** `plan_files_in_scope` (`scripts/lib/plan-paths.sh:44-57`) pipes the table through `grep -v`. With a header but no data rows, `grep -v` gets no input and exits 1. Under `set -euo pipefail`, `DECLARED_IN_SCOPE=$(plan_files_in_scope …)` (`lint-plan.sh:279`) then aborts lint **with no output**.
  - It's the only unguarded helper call in lint; every other one uses `|| rc=$?`.
  - The other callers (`plan_scope_paths`, and through it `plan_high_risk_findings` and `plan_light_violations`) already absorb this benign exit 1.
  - Fix it in the helper: an empty table succeeds with no output, and an unreadable plan still fails. Lint then reports an empty table as an explicit error, because a plan with no declared scope can't be scope-checked.
- **#142.** `defaultSh` (`harness/adapters/git-state-store.js:54-70`) returns `status: 1` when the spawn itself fails (`err.status` isn't a number, e.g. ENOENT). `approveCommand`'s blocker check treats exit 1 as "unresolved approval blockers" (`cli.js:894`), so a missing `check-approval-blockers.sh` gets the wrong message.
  - No other harness caller branches on exit 1 specifically; `cli.js:475, 900, 1012, 1026`, `spine.js`, `worktree.js` and `git-state-store.js:409, 475` all test `!== 0`.
  - So `defaultSh` can report spawn failures with the shell's own codes, `127` for not found and `126` for not executable, without changing any other caller's behaviour.
  - `hook-runner.js:180` sets its own `status: 1` for a *thrown* error. That's fail-closed by design and out of scope.

## Scope

| In scope | Out of scope |
|---|---|
| `plan_files_in_scope`: empty table succeeds with no output; unreadable plan fails | Other helpers' return codes, and `check-scope.sh` |
| `lint-plan.sh`: explicit error for a Files in Scope table with no rows | `hook-runner.js`'s own thrown-error fallback |
| `defaultSh`: 127 (ENOENT) / 126 (EACCES) for spawn failures; real exit codes unchanged | Any caller's exit-code branching (all already correct once `defaultSh` stops folding into 1) |
| Regression tests for both | Other plans' lint output (re-lint shows no drift) |

## Acceptance Criteria

1. `plan_files_in_scope` on a plan whose Files in Scope table has no data rows prints nothing and **returns 0**. On a missing or unreadable plan it returns non-zero with a stderr message. On a normal table its output is byte-identical to today's.
2. `lint-plan.sh` on a plan with a `## Files in Scope` header but no data rows prints `✗ Files in Scope table has no rows — declare every file the plan changes` under Errors and exits 1. It never exits non-zero without output. A plan with rows gives output identical to today's.
3. `defaultSh` returns `status: 127` when the executable doesn't exist (ENOENT), `126` when it exists but isn't executable (EACCES), and the real exit code whenever the process ran. It still returns `1` for any other spawn failure. `stderr` names the failure.
4. With `defaultSh` and a repo root where `scripts/check-approval-blockers.sh` is missing, `rad approve` refuses with `rad approve: refused — approval blocker check failed (exit 127: …)` and writes nothing. A real exit 1 from the script still gives `refused — unresolved approval blockers`.
5. Every `scripts/test-*.sh` passes under `bash` and `/bin/bash` 3.2, and `npm test --prefix harness` passes. Re-linting every `.agents/plans/*.md` with `main`'s lint and this branch's lint gives identical output and exit codes.

## Agent Scope

- Direct reads, confirmed by grep:
  - `defaultSh` (`git-state-store.js:46-70`) and every harness status consumer (`cli.js:475, 894, 900, 1012, 1026`; `spine.js:416, 536, 565, 780`; `worktree.js:28`; `git-state-store.js:409, 475`; `hook-runner.js:180`)
  - `plan_files_in_scope` and its callers (`plan-paths.sh:44-82, 364-374`; `lint-plan.sh:229, 252, 279, 392`)
  - lint's `set -euo pipefail` and command substitutions (`lint-plan.sh:11, 48-540`)
- Earlier in this session `approval-command-mapper` (architect) mapped `approveCommand`'s refusal flow and the `sh` port, and `lint-surface-mapper` (architect) mapped lint conventions.
- Out-of-scope dependencies: none. The author is the architect; `harness/` and `scripts/` are self-protected.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| scripts/lib/plan-paths.sh | 44-57 | `plan_files_in_scope`: empty table → exit 0; unreadable → fail |
| scripts/lint-plan.sh | 100-112 | Error for a Files in Scope table with no rows |
| scripts/lint-plan.sh | 276-282 | Guard the `DECLARED_IN_SCOPE` substitution fail-closed |
| scripts/test-plan-paths.sh | 640-666 | Empty-table and unreadable cases |
| scripts/test-lint-plan.sh | 920-949 | Empty-table lint case |
| harness/adapters/git-state-store.js | 44-70 | `defaultSh` spawn-failure codes 127/126 |
| harness/test/git-state-store.test.js | 280-293 | `defaultSh` ENOENT / EACCES / real-exit tests |
| harness/test/approval-authority-recording.test.js | 560-589 | Missing blocker script → "check failed", no write |

## Program Design

### 1. Signatures altered

```js
// harness/adapters/git-state-store.js — same signature, sharper status on spawn failure
defaultSh(file, args, opts) → { status, stdout, stderr }
//   process ran        → its real exit code (unchanged)
//   ENOENT (not found) → 127   ← was 1
//   EACCES (not exec)  → 126   ← was 1
//   other spawn error  → 1     (unchanged)
```

```bash
# scripts/lib/plan-paths.sh — same output, fixed exit code
plan_files_in_scope <plan>   # empty table → no output, exit 0 (was 1); unreadable → non-zero + stderr
```

### 2. Control-flow sketch

```
rad approve → sh(check-approval-blockers.sh)
   missing script: defaultSh → 127 → cli.js:900 branch → "blocker check failed (exit 127: …)"   ← FIXED
   real exit 1               → cli.js:894 branch → "unresolved approval blockers"              [unchanged]

lint-plan.sh (set -euo pipefail)
   Files in Scope header + 0 rows → ERRORS+=("Files in Scope table has no rows …") → exit 1 with output   ← FIXED
```

### 3. File-tree diff

```
scripts/lib/plan-paths.sh, scripts/lint-plan.sh                     M
scripts/test-plan-paths.sh, scripts/test-lint-plan.sh               M
harness/adapters/git-state-store.js                                 M
harness/test/git-state-store.test.js, approval-authority-recording.test.js  M
```

## Execution Notes

### Do Not Touch
- harness/cli.js (its branching is already correct once `defaultSh` stops folding spawn failures into 1)
- harness/hook-runner.js, harness/spine.js, harness/adapters/worktree.js
- scripts/check-scope.sh, scripts/check-approval-blockers.sh, and every other helper in scripts/lib/plan-paths.sh

### Key Files
- harness/adapters/git-state-store.js — `defaultSh` and its JSDoc
- scripts/lib/plan-paths.sh — `plan_files_in_scope`, `require_readable_plan`
- scripts/lint-plan.sh — the Files in Scope section checks and the `:279` substitution
- harness/test/approval-authority-recording.test.js — the refusal test pattern and how existing tests build a temp `repoRoot`

### Reminders
- Don't turn the benign empty result into a swallowed error with a bare `|| true`. Make the pipeline succeed on empty input, e.g. `{ grep -v … || [ $? -eq 1 ]; }`, so real grep errors (exit 2 or more) still propagate. State that in a comment.
- `defaultSh` must keep returning the real exit code whenever the child ran; only map codes when `err.status` isn't a number. Use `err.code === 'ENOENT'` / `'EACCES'`.
- Bash 3.2: run the shell tests under `/bin/bash`.
- Re-lint every existing plan with `main`'s lint and this branch's lint (temp copies, not a stash); the output must be identical (AC#5).

## Wave Plan

### Wave 1 — parallel
Verify: for t in scripts/test-*.sh; do bash "$t" >/dev/null || exit 1; /bin/bash "$t" >/dev/null || exit 1; done && npm test --prefix harness
Tasks in this wave can run in parallel (disjoint files: scripts/ vs harness/).

#### Task 1.1: Empty Files in Scope table fails loudly
File: scripts/lib/plan-paths.sh:44-57, scripts/lint-plan.sh:100-112, 276-282, scripts/test-plan-paths.sh:640-666, scripts/test-lint-plan.sh:920-949
What:
- **`plan_files_in_scope`:** check the plan is readable first (non-zero + stderr otherwise), and make the `grep -v` filter treat "no lines" (exit 1) as success while still propagating exit 2 or more. Leave the output unchanged.
- **Lint:** when `## Files in Scope` exists and `plan_files_in_scope` prints nothing, add the AC#2 error.
- **Guard the `:279` substitution** with `|| rc=$?` and an ERROR with context on a non-zero result, matching the other helper calls.
- **Tests:** in `test-plan-paths.sh`, an empty table gives exit 0 and no output; an unreadable or missing plan gives non-zero; a normal table's output is unchanged. In `test-lint-plan.sh`, an empty table gives the named error, exit 1 and non-empty output, under both shells.
- **Re-lint** every `.agents/plans/*.md` with `main`'s lint and this branch's lint, and report.
Validate: AC#1, AC#2, AC#5 — both shell test files under `bash` and `/bin/bash`, every `scripts/test-*.sh`, and the re-lint report.

#### Task 1.2: defaultSh reports spawn failures as 127/126
File: harness/adapters/git-state-store.js:44-70, harness/test/git-state-store.test.js:280-293, harness/test/approval-authority-recording.test.js:560-589
What:
- In the `catch`: when `err.status` is a number, keep it (unchanged). Otherwise map `err.code === 'ENOENT'` to `127` and `'EACCES'` to `126`, and anything else to `1`. Use named constants. Set `stderr` to include `err.code` and the message.
- Update the JSDoc.
- **Tests:**
  - `defaultSh('/nonexistent/x')` gives 127.
  - A temp file without the executable bit gives 126.
  - A script that exits 3 gives 3, and one that exits 1 gives 1.
  - In `approval-authority-recording`: with the real `defaultSh` (no `sh` injected) and a temp `repoRoot` with no `scripts/check-approval-blockers.sh`, `approveCommand` returns 1. Stderr matches `approval blocker check failed (exit 127`, no `events.jsonl` exists, and the plan Status is unchanged.

  Reuse the existing temp-repo helpers, and route the role check the way the existing tests do.
Validate: AC#3, AC#4 — `npm test --prefix harness`.

## Tests to Write
- [ ] plan_files_in_scope: empty table exit 0 / unreadable non-zero / normal unchanged — scripts/test-plan-paths.sh
- [ ] lint: empty Files in Scope table → named error, exit 1, output present — scripts/test-lint-plan.sh
- [ ] defaultSh: ENOENT 127, EACCES 126, real exit codes preserved — harness/test/git-state-store.test.js
- [ ] rad approve with a missing blocker script → "check failed (exit 127", no write — harness/test/approval-authority-recording.test.js

## Non-Goals
- Changing `cli.js`'s exit-code branching, or `hook-runner.js`'s thrown-error fallback.
- Changing return codes of any `plan-paths.sh` helper other than `plan_files_in_scope`.
- Auditing every script for `pipefail` traps. Only lint's unguarded substitution is fixed; the rest are already guarded.

## Out-of-Scope Dependencies
None

## Risks
- **A caller relying on `plan_files_in_scope`'s old exit 1 for "no paths".** `plan_high_risk_findings` and `plan_light_violations` call `plan_scope_paths … || true`, which is unaffected, and `lint-plan.sh:229/252/392` use process substitution or pipelines, which ignore the exit code. So no caller depends on it; the re-lint (AC#5) confirms.
- **A caller relying on `defaultSh` returning 1 for a missing binary.** Every other consumer tests `!== 0`, so 127 or 126 gives the same branch. Only the blocker check's message changes, which is the fix.

## Issue Gaps
- **[ASSUMPTION — #145]** An empty Files in Scope table is a lint **error**, not a warning, because the scope check needs a declared set.
- **[ASSUMPTION — #142]** Use the shell conventions `127` / `126` rather than a new `error` field on the result, so the `{status, stdout, stderr}` shape stays the same for every caller and injected fake.
- **[ASSUMPTION]** `hook-runner.js`'s `status: 1` on a thrown `sh` error stays, because hooks are fail-closed on any non-zero exit.
