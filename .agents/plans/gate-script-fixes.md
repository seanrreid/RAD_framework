# Plan: Gate Script Fixes (#298, #303)
Created: 2026-10-26
Author: developer
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-26T15:05:00.198Z
Recorded-By: sean@torchcodelab.com
Branch: rad/gate-script-fixes
Issue: 298
Source-Author: seanrreid (OWNER)
Source-Comments: 0 total, 0 non-collaborator

## Context
Two gate bugs found while delivering earlier plans. (#298) The spine runs `scripts/*` gates from the harness package root (the main checkout) while the delivery agent works in a worktree, so a plan that fixes a gate script is judged by the unmodified copy and can never pass its own fix. (#303) `itemPath` in `harness/pr-body.js` (and its mirror in `scripts/check-tests-present.sh`) treats any `## Tests to Write` line containing `— ` as naming a path, so trailing prose becomes a phantom unpromised test and schedules a test wave that the agent correctly refuses.

## Scope
| In scope | Out of scope |
|---|---|
| Run a gate script from the run root when the plan's own tasks declare that script | Making `check-tests-present.sh` accept directories (#298 option c) |
| Whitespace-bearing "paths" resolve to unresolvable in `itemPath` and `check-tests-present.sh` | Rewording the "No file path found" message |
| `lint-plan.sh` warns on a Tests to Write item whose path is not path-shaped | Any other SCRIPT_ARGS script behavior |

## Acceptance Criteria
1. When the plan's task `File:` lines declare a gate script (e.g. `scripts/check-tests-present.sh`) and the run root differs from the harness root, the spine port executes the run root's copy; a script the plan does not declare still runs from the harness root.
2. With no declared scripts, a missing/empty scope set, or `root === repoRoot`, `makeSpineScriptPort` behaves exactly as before (argv, cwd, script path unchanged).
3. A `## Tests to Write` line such as `- [ ] No new test file: … — all run by the last-wave Verify.` resolves to `unresolvable` in both `testsToWritePaths` and `check-tests-present.sh`, and schedules no test wave.
4. A real line such as `- [ ] covers x — harness/test/x.test.js` and an annotated line `— path.sh (Amendment 1)` still resolve to their paths in both parsers.
5. `scripts/lint-plan.sh` emits a warning naming a Tests to Write item whose resolved path contains whitespace; a well-formed plan produces no such warning.

## Agent Scope
Research done inline against `harness/cli.js`, `harness/pr-body.js`, `harness/plan-tasks.js`, `scripts/check-tests-present.sh`, `scripts/lint-plan.sh`. No sub-agents called. No out-of-scope agent dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/cli.js | 1921-1980 | `makeScriptCtx` exposes the plan's declared scripts; `makeSpineScriptPort` resolves a declared script against `root` |
| harness/test/cli.test.js | 1476-1560 | port tests for declared / undeclared / same-root / empty-ctx cases |
| harness/pr-body.js | 105-118 | `itemPath` returns null for a path containing whitespace |
| harness/test/pr-body.test.js | 1-285 | prose line is unresolvable; real and annotated lines still resolve |
| scripts/check-tests-present.sh | 72-105 | whitespace-bearing candidate is unresolvable (mirrors `itemPath`) |
| scripts/test-check-tests-present.sh | 1-251 | prose-line fixture; real-path regression |
| scripts/lint-plan.sh | 665-710 | warn on non-path-shaped Tests to Write item |
| scripts/test-lint-plan-preflight.sh | 1-end | warning fires on prose item, silent on well-formed plan |

## Execution Notes

### Do Not Touch
- harness/gates.js, harness/events.js, harness/matrix.yaml — gate fold and stop matrix are unaffected
- harness/plan-tasks.js — reuse `taskFilesFromPlanText`, do not change its semantics (shared with /rad-insights)

### Key Files
- harness/plan-tasks.js — `taskFilesFromPlanText` already yields the paths declared by task `File:` lines
- harness/cli.js — `SCRIPT_ARGS`, `makeScriptCtx`, `makeSpineScriptPort`

### Reminders
- The plan is architect-approved and fingerprinted, so "declared in the plan" is the trust boundary for running a worktree copy; undeclared scripts must keep running from the harness root.
- The bash parser and `itemPath` must stay in sync; change both in the same wave-2 pass.
- New/changed scripts must stay mode 100755 (shell-safety lint).

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence.

#### Task 1.1: Resolve plan-declared gate scripts from the run root
File: harness/cli.js:1921-1980
What: In `makeScriptCtx`, read the plan text from `root` and expose `declaredScripts` (a Set of repo-relative paths from `taskFilesFromPlanText`, filtered to `scripts/`). In `makeSpineScriptPort`, when `scriptCtx.declaredScripts` has `script` and `root !== repoRoot`, execute `join(root, script)`; otherwise `join(repoRoot, script)`. An absent `declaredScripts` (tests pass `scriptCtx: {}`) means the old behavior. An unreadable plan yields an empty set and logs the reason to stderr, never a silent swallow.
Validate: AC#1, AC#2 — port tests assert the executed path for declared vs undeclared scripts and for root === repoRoot.

#### Task 1.2: Port tests for script resolution
File: harness/test/cli.test.js:1476-1560
What: Add cases: declared script runs from `root`; undeclared runs from `repoRoot`; `root === repoRoot`; `scriptCtx: {}` unchanged; unreadable plan yields empty set.
Validate: AC#1, AC#2 — `node --test harness/test/cli.test.js` passes.

### Wave 2 — sequential
Depends on: Wave 1 complete

#### Task 2.1: Whitespace candidate is unresolvable in both parsers
File: harness/pr-body.js:105-118, scripts/check-tests-present.sh:72-105
What: After backtick/annotation stripping, a candidate containing whitespace returns null in `itemPath` and is routed to `UNRESOLVABLE` (ignored under `--only`) in the bash parser. Update the shared comment so the two stay documented as mirrors.
Validate: AC#3, AC#4 — the prose line is unresolvable; real and annotated paths still resolve.

#### Task 2.2: Parser tests
File: harness/test/pr-body.test.js:1-285, scripts/test-check-tests-present.sh:1-251
What: Add the issue's prose line as `unresolvable` (no unpromised test, no test wave) and keep a `— harness/test/x.test.js` line and an annotated line resolving, in both suites. Name edge cases: empty path, trailing bare separator, prose with several em-dashes.
Validate: AC#3, AC#4 — both suites pass.

#### Task 2.3: lint-plan warns on non-path Tests to Write items
File: scripts/lint-plan.sh:665-710, scripts/test-lint-plan-preflight.sh:1-end
What: In the Tests to Write scan, warn when a resolved path contains whitespace ("Tests to Write item '…' does not name a path — check-tests-present.sh treats it as unresolvable"). Add fixtures for a prose item (warns) and a well-formed plan (silent). A failed scan fails closed via `preflight_scan_failed`.
Validate: AC#5 — `bash scripts/test-lint-plan-preflight.sh` passes.

Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] Port resolves declared scripts from root, undeclared from repoRoot — harness/test/cli.test.js
- [ ] Prose Tests-to-Write line is unresolvable; real and annotated lines resolve — harness/test/pr-body.test.js
- [ ] Bash parser mirrors itemPath for prose and real lines — scripts/test-check-tests-present.sh
- [ ] lint-plan warns on a non-path Tests to Write item — scripts/test-lint-plan-preflight.sh

## Non-Goals
- Accepting directories in `check-tests-present.sh` (#298 option c) — a separate decision about the gate contract.
- Changing which scripts the spine runs or their argv contracts.
- Making lint-plan's new check an approval blocker (advisory only for now).

## Out-of-Scope Dependencies
None. The plan edits `harness/` and `scripts/` (self-protected paths), so it is flagged for architect review.

## Risks
- Running a worktree copy of a gate lets a plan alter the gate that judges it. Mitigated by limiting it to scripts the approved, fingerprinted plan declares; the architect sees the self-protected-path flag at approval.
- Rejecting whitespace paths would misclassify a real test path containing a space. The repo has none; the line becomes unresolvable and lint warns, so it surfaces rather than silently passing.
