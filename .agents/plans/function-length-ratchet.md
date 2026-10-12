# Plan: CI Ratchet Lint for the ~40-Line Function Rule (#251)
Created: 2026-10-12
Author: architect
Status: pending-review
Branch: rad/function-length-ratchet
Issue: 251
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/251
Issue-Title: CI ratchet lint for the ~40-line function rule

## Context
AGENTS.md says functions stay under ~40 lines, but nothing enforces it. Measured on current `main` with `acorn` (harness code excluding tests, evals, vendor and fixtures): 1,232 functions, **24 over 40 lines**, the worst being `runOneWave` (425), `createGitStateStore` (384), `deliverCommand` (215), `createRunWave` (176) and `deliverSpine` (160). The factory-checks catalogue (A3) argues rot has to be prevented actively. Refactoring all 24 now is a separate, risky effort (#252); this plan adds the **ratchet**: a CI lint with a baseline of the current offenders that can only shrink, so no new long function lands and none of the 24 grows.

**Parser decision (architect, 2026-10-12): vendor `acorn`.** The install manifest copies `harness/` wholesale to consumer projects (`CORE_TREES` in `harness/install-manifest.js`), so vendoring into `harness/vendor/` would ship ~220 KB of a RAD-internal lint parser to every consumer. The vendored copy therefore lives in `scripts/vendor/` (the manifest copies only `scripts/lib` and `scripts/hooks`, not `scripts/vendor`), with its licence and a regeneration recipe beside it, following `harness/vendor/README.md`.

**Self-gating.** This adds a CI gate, and a PR that adds a gate is judged by the old gate during its own delivery, so CI is its first real run. The plan generates the baseline from the code at delivery time and the full-suite Verify runs the new check, which should keep the CI round clean, but a fix-up round is possible.

## Scope
| In scope | Out of scope |
|---|---|
| `scripts/lint-function-length.mjs` (check mode and `--write-baseline`) | Refactoring any of the 24 offenders (#252) |
| Vendored `acorn` 8.14.0 under `scripts/vendor/` with licence and README | Linting tests, evals, fixtures, vendored code or `node_modules` |
| A baseline file of the current offenders | Cyclomatic complexity, nesting depth, dead code, duplication |
| A CI job and a `verify-all.sh` check entry | A hard failure on pre-existing offenders |
| Tests for the lint and one decisions-doc bullet | Changing the ~40-line rule itself |

## Acceptance Criteria
1. **Scan scope.** The lint scans `.js` and `.mjs` files under `harness/` (excluding `node_modules`, `vendor`, `test`, `evals`, `fixtures`) and `scripts/*.mjs`. A function is a declaration, function expression or arrow function; its length is `end line - start line + 1`; nested functions are measured separately.
2. **New offender fails.** A function over 40 lines that is not in the baseline makes the lint exit 1 and name `file`, the function key and its length.
3. **Baselined function may not grow.** A baselined function longer than its recorded length exits 1 ("grew").
4. **Shrinks must be recorded.** A baselined function now shorter than recorded but still over 40 exits 1 with "tighten the baseline to N"; a baselined function now at or under 40, or no longer found (renamed or deleted), exits 1 with "remove the baseline entry". So the baseline can only shrink and an old limit cannot be regrown.
5. **Stable keys.** A baseline key is the file path plus the enclosing function-name chain plus the function's own name, with a `#N` ordinal for same-named siblings. Anonymous functions are keyed by the nearest named enclosing function. Inserting or removing unrelated lines above a function does not change its key.
6. **Fail closed.** A file that does not parse, a scan that finds no files, an unreadable baseline, or a malformed baseline line exits 2 with the reason. A missing baseline file is an empty baseline.
7. **Baseline generation.** `--write-baseline` rewrites the baseline file, sorted, with a header comment explaining the ratchet rules, from the current code; a check run immediately afterwards exits 0. The delivered baseline contains the offenders measured on the delivered branch.
8. **The lint obeys itself.** `scripts/lint-function-length.mjs` has no function over 40 lines and is committed mode 100755.
9. **Wired in.** `verify-all.sh` has a `lint-function-length` check and its test lists the name; `ci.yml` has a job that runs the lint on every PR with Node set up and no `npm` install.
10. **Vendored verbatim and kept out of installs.** `scripts/vendor/acorn.mjs` is a verbatim copy of acorn 8.14.0 `dist/acorn.mjs`; `scripts/vendor/` has the licence text and a README with the version, source and regeneration recipe; `scripts/vendor/` is not in the installed trees (checked against `harness/install-manifest.js`).
11. **Documented.** `docs/rad-decisions.md` has one bullet pointing at the lint and its baseline.
12. **Full suite passes.** `scripts/verify-all.sh` passes on the delivered branch.

## Agent Scope
No sub-agents were called. Research was inline (about 14 tool calls, over the usual cap because the plan has to name every file a CI-gate change touches): the install manifest, the CI lint-job pattern, the shell-safety baseline precedent, the `verify-all.sh` table and its test, a re-measurement of the offenders and acorn's size.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/lint-function-length.mjs | 1-170 | New (mode 100755). Scan, measure, key, compare to baseline, `--write-baseline` |
| scripts/lint-function-length-baseline.txt | 1-40 | New. Generated by `--write-baseline` at delivery time; do not hand-write |
| scripts/vendor/acorn.mjs | 1-1 | New. Verbatim copy of acorn 8.14.0 `dist/acorn.mjs` (about 226 KB); do not edit |
| scripts/vendor/ACORN-LICENSE | 1-25 | New. Acorn's MIT licence text |
| scripts/vendor/README.md | 1-20 | New. Version, source, why vendored here, regeneration recipe |
| scripts/test-lint-function-length.sh | 1-220 | New (mode 100755). Fixture-based tests for AC#1-AC#8 |
| scripts/verify-all.sh | 58-72 | Add the `lint-function-length` check to the built-in table |
| scripts/test-verify-all.sh | 104-116 | Add the name to the expected `--list` names |
| .github/workflows/ci.yml | 100-122 | New `function-length-lint` job next to `shell-safety-lint` |
| docs/rad-decisions.md | 15-30 | One bullet pointing at the lint and baseline |

## Execution Notes

### Do Not Touch
- harness/ (this plan lints it; it does not change it, and every offender stays as it is)
- AGENTS.md (the rule is already written there; AGENTS.md is the consumer template)
- scripts/lint-shell-safety.sh and its baseline (the model to follow, not to change)

### Key Files
- scripts/lint-shell-safety.sh and scripts/lint-shell-safety-baseline.txt — the existing ratchet-baseline precedent (header comment, stale-entry handling, exit codes)
- harness/vendor/README.md — the vendoring README to mirror
- scripts/verify-all.sh — the check table (`name<TAB>command`)
- .github/workflows/ci.yml — job pattern for `invariant-lint` (setup-node, then one script)
- harness/install-manifest.js — `CORE_TREES` and `EXCLUDED_TREES`, to confirm `scripts/vendor` is not installed

### Reminders
- scripts/ and .github/ are touched: architect approval and the last-wave full-suite Verify. Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800` AND `RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- Obtain acorn without relying on a global install: `npm pack acorn@8.14.0` in a temporary directory, unpack, and copy `package/dist/acorn.mjs` and `package/LICENSE` verbatim. Do not add acorn to `harness/package.json`.
- Both new files under `scripts/` that are `.sh` or `.mjs` must be committed mode 100755 (the shell-safety lint fails otherwise); `scripts/vendor/acorn.mjs` is a vendored data file in a subdirectory the lint does not enter, but check that `lint-shell-safety.sh` still passes.
- New shell tests must parse under bash 3.2 (`scripts/test-bash32-parse.sh`): no associative arrays, no `mapfile`.
- The baseline must be generated from the branch's own code by the lint (`--write-baseline`), after all other edits, so it is accurate. Do not copy numbers from this plan.
- Keep every function in the new lint under 40 lines; split into small helpers.
- A tree walker must be written by hand (a small recursive visitor); do not vendor `acorn-walk`.

## Program Design

Signatures:

```js
// scripts/lint-function-length.mjs
const FUNCTION_LENGTH_LIMIT = 40;
function listSourceFiles(repoRoot)            // -> string[]  (empty => caller exits 2)
function measureFunctions(source, relPath)    // -> { key, line, length }[]  (throws on parse error)
function keyFor(relPath, ancestors, name, ordinals) // -> stable string key
function readBaseline(path)                   // -> Map<key, number>  (missing file => empty map)
function compare(measured, baseline)          // -> { violations: string[] }  (grew | new | tighten | remove)
function writeBaseline(path, measured)        // sorted, header comment, offenders only
// CLI: node scripts/lint-function-length.mjs [--write-baseline] [--root <dir>] [--baseline <file>]
// exit 0 clean | 1 violations | 2 usage/parse/config error
```

Call stack:

```
CI job / verify-all.sh -> lint-function-length.mjs
  -> listSourceFiles -> measureFunctions (scripts/vendor/acorn.mjs) per file
  -> readBaseline -> compare -> report -> exit code
--write-baseline -> measure all -> writeBaseline
```

File tree diff:

```
scripts/lint-function-length.mjs               NEW
scripts/lint-function-length-baseline.txt      NEW (generated)
scripts/test-lint-function-length.sh           NEW
scripts/vendor/{acorn.mjs,ACORN-LICENSE,README.md}   NEW
scripts/verify-all.sh, scripts/test-verify-all.sh    + one check / one name
.github/workflows/ci.yml                       + function-length-lint job
docs/rad-decisions.md                          + one bullet
```

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (each builds on the previous).
Verify: bash scripts/test-lint-function-length.sh && bash scripts/lint-shell-safety.sh && bash scripts/test-bash32-parse.sh

#### Task 1.1: Vendor acorn
File: scripts/vendor/acorn.mjs:1-1, scripts/vendor/ACORN-LICENSE:1-25, scripts/vendor/README.md:1-20
What: Fetch acorn 8.14.0 as described in Reminders and copy `dist/acorn.mjs` and the licence verbatim into `scripts/vendor/`. Write the README: version, source, why it lives in `scripts/vendor/` and not `harness/vendor/` (the installer copies `harness/`), and the regeneration recipe.
Validate: AC#10 — the copied file imports and parses a trivial source (`node -e "import('./scripts/vendor/acorn.mjs')"`); `scripts/vendor` does not appear in `CORE_TREES`.

#### Task 1.2: The lint
File: scripts/lint-function-length.mjs:1-170
What: Implement the CLI exactly as in Program Design: scan scope per AC#1, stable keys per AC#5, comparison rules per AC#2-AC#4, fail-closed behavior per AC#6, `--write-baseline` per AC#7. Named constants for the limit, exit codes and the excluded directory names. Mode 100755.
Validate: AC#1, AC#2, AC#3, AC#4, AC#5, AC#6, AC#7, AC#8 — the cases in Task 1.3, plus the lint run on its own file reports no function over 40 lines.

#### Task 1.3: Tests
File: scripts/test-lint-function-length.sh:1-220
What: Fixture-based tests (temporary repo, `--root` and `--baseline`) for: a new 41-line function fails; exactly 40 lines passes; a baselined function that grows fails; one that shrinks but stays over 40 fails with the tighten message; one that drops to 40 or below, and one that is renamed or deleted, fail with the remove message; stable keys when lines are inserted above; two same-named siblings get distinct keys; anonymous callbacks keyed by their enclosing function; arrow functions, class methods and nested functions; a file with a syntax error exits 2; no files exits 2; a malformed baseline line exits 2; a missing baseline is empty; `--write-baseline` then a clean check exits 0; excluded directories (`test`, `vendor`, `node_modules`) are not scanned. Mode 100755.
Validate: AC#2, AC#3, AC#4, AC#5, AC#6, AC#7 — each case is a named assertion.

### Wave 2 — sequential
Tasks in this wave must run in sequence (2.2 needs the lint from Wave 1).
Verify: exec bash scripts/verify-all.sh

#### Task 2.1: Wire it into verify-all and CI
File: scripts/verify-all.sh:58-72, scripts/test-verify-all.sh:104-116, .github/workflows/ci.yml:100-122
What: Add `lint-function-length` (`node scripts/lint-function-length.mjs`) to the built-in table, add the name to the expected list in the verify-all test, and add a `function-length-lint` job in `ci.yml` modelled on `invariant-lint` (checkout, setup-node 20, one run step, no npm install).
Validate: AC#9 — `scripts/verify-all.sh --list` shows the new name; `test-verify-all.sh` passes.

#### Task 2.2: Generate the baseline and document it
File: scripts/lint-function-length-baseline.txt:1-40, docs/rad-decisions.md:15-30
What: As the last edit before verification, run `node scripts/lint-function-length.mjs --write-baseline` on the branch and commit the result; confirm a check run then exits 0. Add one bullet to `docs/rad-decisions.md`: the ~40-line rule is enforced as a ratchet; the baseline lists the current offenders and can only shrink; see the lint and #252.
Validate: AC#7, AC#11 — the check exits 0 against the generated baseline; the doc bullet points at the lint.

#### Task 2.3: Full-suite check
File: docs/rad-decisions.md:15-30
What: No further edit. The wave's Verify runs the full suite, which now includes the new lint.
Validate: AC#12 — `scripts/verify-all.sh` passes.

## Tests to Write
- [ ] Ratchet rules, key stability, fail-closed behavior, baseline generation and scan exclusions — scripts/test-lint-function-length.sh
- [ ] The new check name in the expected list — scripts/test-verify-all.sh

## Non-Goals
- Refactoring any offender (#252)
- Complexity, nesting, duplication or dead-code checks
- Linting test, eval, fixture or vendored code
- Shipping the lint or its parser to consumer projects

## Out-of-Scope Dependencies
None.

## Risks
- Other in-flight PRs that touch a baselined function will conflict with the baseline file or trip the "grew" rule; the author regenerates the baseline, and the architect reviews the diff as part of the PR (the baseline is under self-protected `scripts/`).
- Renaming a baselined function reads as a new offender plus a stale entry, so it fails until the baseline is regenerated. This is intended friction.
- Factory-closure functions (`createGitStateStore`, `createHookRunner`, `createCommandAdapter`) inflate counts; nested inner functions are measured separately, so the closure counts as one offender and its large inner methods may add more.
- A vendored 226 KB generated file lands in the diff and is unreviewable line by line; AC#10's verbatim-copy check and the README recipe are the control.
- The CI job is new, so branch-protection required checks need updating by the maintainer; this plan cannot do that.

## Issue Gaps
- ASSUMPTION: the vendored parser lives in `scripts/vendor/` rather than `harness/vendor/` as the architect's "vendor" decision implied, because `harness/` is installed wholesale into consumer projects. If you would rather keep a single vendor directory, the cost is shipping ~220 KB to every consumer.
- ASSUMPTION: a baselined function that shrinks but stays over 40 fails the lint until the baseline is tightened. The issue says "can only shrink"; strict enforcement is what stops regrowth to the old limit.
- ASSUMPTION: scan scope is `harness/` production code plus `scripts/*.mjs`; shell scripts are not measured.
- ASSUMPTION: the baseline key scheme (file plus enclosing-name chain plus `#N` ordinal) is stable enough that unrelated edits do not churn the file; the executor may refine the exact format as long as AC#5 holds.
- ASSUMPTION: line ranges for `ci.yml`, `verify-all.sh` and the docs are estimates from grep results; the executor should confirm exact lines and stay within the declared files.
