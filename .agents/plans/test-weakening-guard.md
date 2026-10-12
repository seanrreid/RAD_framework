# Plan: Block Test Weakening in a Delivery (#241)
Created: 2026-10-12
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-12T18:08:44.425Z
Recorded-By: sean@torchcodelab.com
Branch: rad/test-weakening-guard
Issue: 241
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/241
Issue-Title: Test-weakening guard: block deleted/renamed tests and .skip markers in a wave (V4/V21)

## Context
A wave agent can weaken the tests that grade it and nothing detects it. `scripts/check-scope.sh` only checks that changed files are declared in the plan, and it auto-allows test files named in "Tests to Write"; `check-tests-present.sh` passes a file with zero assertions. The "never weaken expectations" rule is AGENTS.md prose only. As PRs grow, a reviewer is less likely to spot a removed assertion (factory-checks V4/V21).

**Design (architect decisions 2026-10-12).** Start small and blocking: a deterministic check that fails a delivery when, relative to the base branch, an existing test file is **deleted or renamed**, or a **skip marker is newly added** to an existing test file. A legitimate removal is allowed only by an **approved waiver**: a `## Waivers` bullet `- test-removal:<path>: <reason>`. Waivers sit in the plan body, so the approval fingerprint freezes them and they cannot be added after approval. The advisory net-negative-lines digest line from the issue is **deferred** to #242 (it needs a new wave-event field and a digest change).

**Implementation choice: extend `check-scope.sh`, not a new spine gate.** `check-scope.sh` already diffs the whole work branch against the base, is run by the spine after every wave (a failure is `fail-scope`, matrix `abort`), and is run by CI on every deliver PR. Putting the guard there gives per-wave enforcement and CI enforcement with no spine change, no new entry in the spine's script-argument table, and no change to the call-order arrays that `spine.test.js` and `spine-finish.test.js` assert. The logic lives in a new sourced library, `scripts/lib/test-integrity.sh`, so `check-scope.sh` only calls it. This broadens what "scope" means; it is flagged in Issue Gaps for the architect to veto.

## Scope
| In scope | Out of scope |
|---|---|
| New library `scripts/lib/test-integrity.sh` and its call from `check-scope.sh` | The advisory net-negative-lines digest line (#242) |
| Constants for test paths and the waiver prefix in `scripts/lib/plan-paths.sh` | Assertion-level analysis per language (#242) |
| Lint: no stale-waiver warning for `test-removal:` ids | Any change to the spine, `SCRIPT_ARGS`, `matrix.yaml` or `ci.yml` |
| Script tests, an invariant-registry entry, one decisions-doc bullet | A new adversarial eval (needs a pre-existing test in the eval fixture repo) |

## Acceptance Criteria
1. **Deleted test blocked.** When the work branch deletes a file whose path is a test path, and the plan has no `test-removal:<that path>` waiver, `check-scope.sh` exits 1 and names the path and the waiver syntax.
2. **Rename blocked.** A renamed test file counts as a removal of its old path (git rename detection on), whatever the new path is, unless the old path is waived.
3. **Skip marker blocked.** When a test file that exists on the base gains a line matching a skip marker (JS/TS `.skip(`, `xit(`, `xdescribe(`, `xtest(`, `it.todo(`, `test.todo(`; Python `@pytest.mark.skip`, `@unittest.skip`; Go `t.Skip(`; Java `@Disabled`; `pending(`), and the path is not waived, `check-scope.sh` exits 1 and names the path and the added line. A marker on a removed (`-`) line, or in a brand-new test file, does not count.
4. **Waiver.** A `## Waivers` bullet `- test-removal:<path>: <non-empty reason>` allows deletion, rename-away and added skip markers for exactly that path. A bullet with an empty reason, a different path, or a path-prefix of the real path does not.
5. **What is a test path.** The existing layer pattern (`RAD_LAYER_TEST_RE`: `test/`, `tests/`, `__tests__/`, `spec/` directories, and `.test.` / `.spec.` names) plus `test-*.sh` scripts, `*_test.go` and `test_*.py`, defined once as a named constant in `plan-paths.sh`.
6. **No false blocks.** New test files, edits to existing tests that add no skip marker, non-test deletions, and a branch with no test changes behave exactly as today (exit codes and output unchanged).
7. **Combined output and exit codes.** A scope violation and a test-integrity violation are both reported when both occur. Exit codes stay 0 (clean), 1 (any violation), 2 (usage, config, or a failure of the check itself, never reported as clean).
8. **Lint.** `lint-plan.sh` does not call a `test-removal:<path>` waiver stale; an unknown non-`test-removal:` id still gets the existing stale-waiver warning.
9. **Registered.** `docs/invariants.yaml` has an invariant for the guard whose anchors resolve, and `scripts/lint-invariants.sh` passes; `docs/rad-decisions.md` has one bullet pointing at it.
10. **Full suite passes.** `scripts/verify-all.sh` passes on the delivered branch.

## Agent Scope
No sub-agents were called. Research was inline (14 tool calls, over the usual cap because the plan has to name every test fixture): how the spine calls `check-scope.sh`, the script-argument table, the spine tests that assert script call order, the base-range logic in `check-scope.sh`, the waiver parser and the stale-waiver lint, the test-path pattern, the invariant registry, which fixtures copy `check-scope.sh`.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/lib/test-integrity.sh | 1-130 | New (mode 100755). `test_integrity_violations`: classify removals and added skip markers from the diff range and the plan's waivers |
| scripts/lib/plan-paths.sh | 505-520 | Constants: test-path pattern (adds `test-*.sh`, `_test.go`, `test_*.py`), `RAD_TEST_REMOVAL_WAIVER_PREFIX`, the skip-marker pattern |
| scripts/check-scope.sh | 1-20 | Header comment: document the second check; source the libraries |
| scripts/check-scope.sh | 86-110 | Keep the winning diff range in a variable the new check can reuse |
| scripts/check-scope.sh | 160-225 | Run the test-integrity check, report it with the scope result, exit codes per AC#7 |
| scripts/lint-plan.sh | 770-790 | `collect_waiver_warnings`: skip ids with the `test-removal:` prefix |
| scripts/test-check-scope.sh | 36-45 | Copy `scripts/lib/` into the fixture repo (it copies only two scripts today) |
| scripts/test-check-scope.sh | 200-235 | New cases for AC#1-AC#7 |
| scripts/test-lint-plan.sh | 1470-1499 | Waiver-lint cases for AC#8 |
| docs/invariants.yaml | 84-100 | New invariant `test-weakening-blocked` after `scope-enforced` |
| docs/rad-decisions.md | 15-27 | One bullet pointing at the invariant |

## Execution Notes

### Do Not Touch
- harness/ (no spine, CLI, matrix or event change; `check-scope.sh` is already wired)
- .github/workflows/ci.yml (CI already runs `check-scope.sh` on deliver PRs)
- scripts/check-tests-present.sh and the "Tests to Write" auto-allow rule in `check-scope.sh` (it still applies to scope; the new check is separate)

### Key Files
- scripts/check-scope.sh — the base-range candidates (~90-107) and the violation output (~197-225)
- scripts/lib/plan-paths.sh — `path_matches` (~94), `RAD_LAYER_TEST_RE` (~512), `plan_waivers` (~484)
- scripts/test-check-scope.sh — builds a temp git repo; the model for the new cases
- scripts/lint-plan.sh — `collect_waiver_warnings` (~774)
- docs/invariants.yaml — `scope-enforced` entry shows the registry shape

### Reminders
- harness/ is untouched but scripts/ and docs/invariants.yaml are self-protected: architect approval and the last-wave full-suite Verify. Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800` AND `RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- The new library must be committed mode 100755 (the shell-safety lint requires it) and must parse under bash 3.2 (`scripts/test-bash32-parse.sh`): no associative arrays, no `mapfile`.
- Paths can contain spaces: read `git diff --name-status -z` NUL-delimited (`read -r -d ''`), and pass the range and paths to git after `--`.
- The extra `.skip` markers are per-language starting points, defined once as a named constant; do not scatter patterns.
- `test-check-scope.sh` copies only specific scripts into its fixture repo; without the `lib/` copy every case would fail to source the library.
- A fixture plan with a `## Waivers` section must use the exact bullet form `- test-removal:<path>: <reason>`.

## Program Design

Signatures:

```bash
# scripts/lib/plan-paths.sh (constants)
readonly RAD_TEST_PATH_RE=...            # RAD_LAYER_TEST_RE plus test-*.sh, _test.go, test_*.py
readonly RAD_TEST_REMOVAL_WAIVER_PREFIX='test-removal:'
readonly RAD_TEST_SKIP_MARKER_RE=...

# scripts/lib/test-integrity.sh
test_integrity_violations <plan-file> <diff-range>
  # stdout: one line per violation, "<kind>\t<path>\t<detail>"  (kind: deleted | renamed | skip-added)
  # exit 0 = check ran (violations may be printed); exit 2 = the check itself failed
```

Call stack:

```
rad deliver (spine, after each wave) -> check-scope.sh
CI (every deliver PR)                -> check-scope.sh
check-scope.sh -> scope membership check (unchanged)
               -> test_integrity_violations -> git diff --name-status -M -z <range>
                                            -> git diff -U0 <range> -- <modified test path>
                                            -> plan_waivers (waived paths subtracted)
lint-plan.sh -> collect_waiver_warnings (skips test-removal: ids)
```

File tree diff:

```
scripts/lib/test-integrity.sh        NEW
scripts/lib/plan-paths.sh            + 3 constants
scripts/check-scope.sh               + source libs, keep range var, report/exit
scripts/lint-plan.sh                 + prefix exemption
scripts/test-check-scope.sh          + lib copy, new cases
scripts/test-lint-plan.sh            + waiver-lint cases
docs/invariants.yaml, docs/rad-decisions.md   + entry, + bullet
```

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (each builds on the previous).
Verify: bash scripts/test-check-scope.sh && bash scripts/test-lint-plan.sh && bash scripts/test-bash32-parse.sh && bash scripts/lint-shell-safety.sh

#### Task 1.1: Constants and the library
File: scripts/lib/plan-paths.sh:505-520, scripts/lib/test-integrity.sh:1-130
What: Add the three constants to `plan-paths.sh`. Create `scripts/lib/test-integrity.sh` (mode 100755) with `test_integrity_violations <plan-file> <diff-range>` as specified in Program Design: list changed paths with rename detection, keep those whose old path matches `RAD_TEST_PATH_RE`, classify D and R as removals and, for M, scan the added lines of that file for the skip-marker constant; subtract paths waived through `plan_waivers` ids of the form `test-removal:<path>` with a non-empty reason; print the rest. Small functions (under ~40 lines each), exit 2 on any git failure.
Validate: AC#1, AC#2, AC#3, AC#4, AC#5, AC#6 — covered by the cases in Task 1.3.

#### Task 1.2: Wire it into check-scope and the lint
File: scripts/check-scope.sh:1-20, 86-110, 160-225, scripts/lint-plan.sh:770-790
What: In `check-scope.sh` source both libraries, keep the winning diff range in a variable, run the library after the scope-membership check, print `✗ Test integrity violation` with one line per violation and the waiver syntax, and exit 1 if either check failed (both reported); a library failure exits 2. In `lint-plan.sh`, skip `test-removal:`-prefixed ids in `collect_waiver_warnings`.
Validate: AC#6, AC#7, AC#8 — exit codes and output per the cases in Task 1.3.

#### Task 1.3: Tests
File: scripts/test-check-scope.sh:36-45, 200-235, scripts/test-lint-plan.sh:1470-1499
What: Copy `scripts/lib/` into the fixture repo. Add cases: deleted test blocked; deleted test with a matching waiver passes; waiver with empty reason, wrong path, or path-prefix does not; renamed test blocked (old path waived passes); `.skip(` added to an existing test blocked; the same marker in a new test file passes; a marker on a removed line passes; edit with no marker passes; deleted non-test file passes; deleted `scripts/test-x.sh` blocked; a path containing a space; no changed files; a plan with no `## Waivers`; both a scope violation and a test violation reported together; the unchanged-behavior case (no test changes → same output as before). In `test-lint-plan.sh`: a `test-removal:` waiver gives no stale warning; an unknown id still does.
Validate: AC#1, AC#2, AC#3, AC#4, AC#5, AC#6, AC#7, AC#8 — each case is a named assertion.

### Wave 2 — sequential
Tasks in this wave must run in sequence.
Verify: exec bash scripts/verify-all.sh

#### Task 2.1: Register the invariant and note the decision
File: docs/invariants.yaml:84-100, docs/rad-decisions.md:15-27
What: Add the `test-weakening-blocked` invariant after `scope-enforced`: claim, authority (the approved plan's `## Waivers`), `enforced_by` anchors on `test_integrity_violations` in the library and on its call in `check-scope.sh`, and bypasses (test layouts the pattern does not match: guarded "no", tracked in #242; a waived path: guarded "yes", the architect approved the waiver). Add one bullet to `docs/rad-decisions.md` pointing at it.
Validate: AC#9 — `bash scripts/lint-invariants.sh` passes; every anchor symbol appears literally in its file.

#### Task 2.2: Full-suite check
File: docs/rad-decisions.md:15-27
What: No further edit. The wave's Verify runs the full suite.
Validate: AC#10 — `scripts/verify-all.sh` passes.

## Tests to Write
- [ ] Deleted, renamed and skip-marker cases, waivers, and the no-false-block cases — scripts/test-check-scope.sh
- [ ] Waiver lint exemption — scripts/test-lint-plan.sh

## Non-Goals
- The net-negative-lines advisory and any digest or event change (#242)
- Detecting loosened or removed assertions inside a still-present test
- A spine gate, a new script argument entry, or a CI change
- Protecting test layouts outside the declared patterns

## Out-of-Scope Dependencies
None.

## Risks
- The guard only sees the declared test-path patterns; a project whose tests live elsewhere is unprotected until #242 or a config setting widens it. The invariant records this as an unguarded bypass.
- Legitimate refactors that delete tests now need a waiver, so a refactor plan (for example #252) must plan for it. That is the intended friction.
- Rename detection depends on git's similarity heuristic; a rewritten-and-renamed test might show as D plus A, which still counts as a removal.
- `check-scope.sh` is also run in CI and by `rad pr-body` through a temp plan copy; any path that runs it without `scripts/lib/` beside it would fail to source. The fixture copy in Task 1.3 and the full-suite Verify are the net.

## Issue Gaps
- ASSUMPTION: the guard is implemented inside `check-scope.sh` (via a sourced library) rather than as a separate spine gate, to get per-wave and CI enforcement with no spine change. The issue says "wired as a spine gate with a fail-scope-style outcome"; this meets the intent through the existing scope gate. Veto this if you want the guard separate from scope.
- ASSUMPTION: the waiver id is `test-removal:<path>` and it also covers added skip markers and rename-away for that path; the issue named only deletions.
- ASSUMPTION: the check compares the whole work branch with the base (as the scope check does), so a violation made in wave 1 keeps failing every later wave until waived or reverted.
- ASSUMPTION: skip-marker patterns cover JS/TS, Python, Go and Java only; others fall to #242.
- ASSUMPTION: line ranges for `check-scope.sh`, `lint-plan.sh` and the docs are estimates from grep results; the executor should confirm exact lines and stay within the declared files.
