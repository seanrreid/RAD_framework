# Plan: Scripts Parsing Fixes
Created: 2026-09-25
Author: architect
Status: complete
Completed-At: 2026-09-25T15:04:09Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-09-25T14:54:01.577Z
Recorded-By: sean@torchcodelab.com
Branch: rad/scripts-parsing-fixes

## Context

Three small `scripts/` defects, each a shell-parsing or error-handling slip at a
boundary RAD treats as trustworthy. `scripts/lib/plan-paths.sh` no longer parses
under macOS's stock `/bin/bash` 3.2, despite the 3.2 claim in its header (#102),
because CI runs only on ubuntu (bash 5) and nothing checks for it.
`scripts/check-tests-present.sh` misreads a Tests-to-Write line whose description
contains an em-dash, which makes a blocking gate report a false "missing" (#124).
`scripts/rad-label.sh` never clears stale status labels, and its add-only fallback
hides the failure (#126). All three are self-protected paths, so they ship together
under one architect-approved plan.

## Scope

| In scope | Out of scope |
|---|---|
| Make `plan-paths.sh` parse under bash 3.2 with identical `plan_cited_anchors` output (#102) | Runtime bash-3.2 behaviour (e.g. `set -u` on empty arrays), which a parse check cannot see |
| A bash-3.2 parse check over every `scripts/**/*.sh`, enforced in CI on macOS | Rewriting other scripts' 3.2 compatibility claims |
| `check-tests-present.sh` takes the path after the last em-dash separator (#124) | Changing its exit-code contract or the Tests-to-Write format |
| `rad-label.sh` removes only status labels present on the target, and warns with gh's error on fallback (#126) | Changing its CLI (`<N> <status>`), its best-effort exit 0, or its no-`gh` no-op |
| Comment or warn the unexplained `gh label create ... \|\| true` at `rad-label.sh:60` | Backfilling labels on existing issues (already done by hand on 2026-09-25) |

## Acceptance Criteria

1. `/bin/bash -n scripts/lib/plan-paths.sh` exits 0 under bash 3.2.57, and `plan_cited_anchors` output is unchanged for URL tokens, path tokens and the fail-closed sentinel (the existing `scripts/test-plan-paths.sh` passes, plus a new case asserting that a `host://` token is still dropped).
2. `scripts/check-tests-present.sh` resolves a Tests-to-Write line to the text after its **last** em-dash separator, so a description containing an em-dash plus a present file reports found (exit 0), and plus a missing file reports missing (exit 1). Existing cases A0–A5 and Part B stay green.
3. `scripts/rad-label.sh` passes `--remove-label` only for `rad:` status labels currently on the target (never for statuses absent from it or from the repo), and adds the new status label.
4. When the label swap fails and the add-only fallback runs, `rad-label.sh` still exits 0 but prints a `WARN:` line on stderr naming the target and gh's error, instead of the plain success line. No `|| true` in the file is left without a comment giving its reason.
5. A new `scripts/test-bash32-parse.sh` runs `bash -n` with a 3.2 interpreter over every `*.sh` under `scripts/` (found with `find`, not globstar). It fails and names the file on any parse error. When no bash 3.2 is available, it prints an explicit `SKIP:` line and exits 0.
6. CI runs the parse check on a macOS runner, where `/bin/bash` is 3.2, so the check is enforced there and never skipped.
7. Existing contracts hold: `npm test --prefix harness` passes (spine/resume tests invoke `check-tests-present.sh`), every `scripts/test-*.sh` passes, and `scripts/lint-shell-safety.sh` reports no new findings.

## Agent Scope

No agents were called. Research was one Explore sub-agent (6 of 10 searches)
covering the three scripts, their tests, the gh-stubbing pattern
(`scripts/test-open-pr.sh`), and `.github/workflows/ci.yml`. The architect role
covers every file here, including the CI workflow (the harness-ci / ci-wiring scope).

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| scripts/lib/plan-paths.sh | 165-180 | Rewrite the one-line `case ... ;; esac` inside `$( )` into a 3.2-safe form; give the nested `case` patterns a leading `(` |
| scripts/test-plan-paths.sh | 1-238 | Append a case: a `host://` URL token is still dropped by `plan_cited_anchors` |
| scripts/check-tests-present.sh | 25-45 | Take the path after the last `— ` separator |
| scripts/test-check-tests-present.sh | 24-80 | Add case A6: description with an em-dash, present path and missing path |
| scripts/rad-label.sh | 50-80 | Read current labels, remove only present statuses, WARN with gh stderr on fallback, comment the `label create` `\|\| true` |
| scripts/test-rad-label.sh | new | Stubbed-`gh` tests for the label swap and fallback |
| scripts/test-bash32-parse.sh | new | Parse check over `scripts/**/*.sh` with a 3.2 interpreter; explicit SKIP when unavailable |
| .github/workflows/ci.yml | 35-60 | Add a `macos-latest` job that runs `scripts/test-bash32-parse.sh` |

## Execution Notes

### Do Not Touch
- `harness/` (all of it). `spine.js` and `hook-runner.js` invoke `check-tests-present.sh`; its exit codes (0 present, 1 missing) are a contract, not something to change here.
- `scripts/lint-plan.sh` and `scripts/classify-low-risk.sh` source `lib/plan-paths.sh`. They are consumers, not edit targets; the fix must be output-identical for them.
- `scripts/lint-shell-safety.sh`, which is the checker here, not a target.
- The `rad-label.sh` call sites in `.claude/**`. The CLI stays `rad-label.sh <N> <status>`.

### Key Files
- `scripts/lib/plan-paths.sh` (lines 160-180): the `plan_cited_anchors` pipeline and the house style of commenting each `|| true`.
- `scripts/test-check-tests-present.sh`: the `run_check` helper and the A-case assertion style.
- `scripts/test-open-pr.sh`: the reference pattern for stubbing `gh` (sh stubs in `$TMP` that log argv, `PATH="$TMP:$PATH"`, and a guard against a stub that fails to engage).
- `.github/workflows/ci.yml`: the `script-tests` job loops `scripts/test-*.sh` on ubuntu.

### Reminders
- bash 3.2 has no globstar, associative arrays or `mapfile`. `test-bash32-parse.sh` itself must parse and run under 3.2.
- On ubuntu the `script-tests` loop will also run `test-bash32-parse.sh`. It must SKIP explicitly there, never pass silently as if it had checked.
- The `rad-label` stub must answer `gh auth status`, `gh label create`, `gh issue view --json labels` and `gh issue edit`, with a switch for the stub to make the edit fail.
- Any new `$1`-derived variable in `rad-label.sh` that flows into `gh` needs a guard, or `lint-shell-safety.sh` will flag it.
- Tests to Write descriptions below avoid em-dashes on purpose, so this plan's own gate is not affected by #124 before it is fixed.

## Wave Plan

### Wave 1 — parallel
Verify: for t in scripts/test-plan-paths.sh scripts/test-check-tests-present.sh scripts/test-rad-label.sh; do bash "$t" || exit 1; done

Three independent fixes in three disjoint files, each shipping its own test.

#### Task 1.1: Make plan-paths.sh parse under bash 3.2
File: scripts/lib/plan-paths.sh:165-180, scripts/test-plan-paths.sh
What: Replace `case "$token" in *//*) continue ;; esac` inside the `$( ... )` at line 171 with a 3.2-safe equivalent (`[[ "$token" == *//* ]] && continue`, or a multi-line `case` with `(*//*)` patterns). Give the nested `case "$path" in */*)` patterns a leading `(` as well. Keep the existing `|| true` comment. Append a test case to `scripts/test-plan-paths.sh` asserting that a `host://` URL token is still dropped.
Validate: AC#1 — `/bin/bash -n scripts/lib/plan-paths.sh` exits 0 on macOS (3.2.57), and `bash scripts/test-plan-paths.sh` passes, including the new URL-token case.

#### Task 1.2: Resolve the test path after the last em-dash
File: scripts/check-tests-present.sh:25-45, scripts/test-check-tests-present.sh
What: Keep detecting a file reference by the presence of `— `, but extract the path with `${line##*— }` (longest-prefix strip, so the text after the final separator). Leave the backtick strip, the trailing-space trim, the `[file]` unresolvable check, and all exit codes unchanged. Add case A6: a description containing an em-dash with a present file (exit 0) and with a missing file (exit 1, and the reported name is just the path).
Validate: AC#2 — `bash scripts/test-check-tests-present.sh` passes A0–A6 and Part B.

#### Task 1.3: rad-label.sh removes only present statuses and warns on fallback
File: scripts/rad-label.sh:50-80, scripts/test-rad-label.sh
What: After the target guard, read the target's labels (`gh issue view "$TARGET" --json labels -q '.labels[].name'`) and build `REMOVE_ARGS` only from `rad:` statuses in `ALL_STATUSES` that are present and differ from the new status. Capture stderr from the swap. On failure, run the add-only fallback, and if that succeeds print `WARN: added rad:<status> to #<N> but could not remove stale status labels: <gh error>` to stderr, exit 0. Keep the existing both-failed WARN. Correct the misleading comment. Give the `gh label create ... || true` at line 60 a comment stating why it is safe (already-exists is the expected failure). New `scripts/test-rad-label.sh` with a stubbed `gh`.
Validate: AC#3, AC#4 — `bash scripts/test-rad-label.sh` passes: one stale label present gets removed and the new one added; no status labels means no `--remove-label` passed; a failing swap exits 0 with a WARN naming the target and the stub's error; no `gh` is still a no-op.

### Wave 2 — sequential
Depends on: Wave 1 complete (the parse check fails until Task 1.1 lands)
Verify: bash scripts/test-bash32-parse.sh && npm test --prefix harness

#### Task 2.1: Bash 3.2 parse check
File: scripts/test-bash32-parse.sh
What: Resolve a 3.2 interpreter. Use `RAD_BASH32` if set, otherwise `/bin/bash` if its `BASH_VERSINFO[0]` is 3. If none is found, print `SKIP: no bash 3.2 interpreter found (set RAD_BASH32 or run on macOS); parse check not performed` and exit 0. Otherwise run `"$BASH32" -n` over every `*.sh` under `scripts/` (found with `find`, NUL-safe), print `✓`/`✗` per file, and exit 1 listing each failing file. A self-test fixture (a temp file with the #102 construct) must fail the check, proving it detects the regression and doesn't just pass.
Validate: AC#5 — on macOS, `bash scripts/test-bash32-parse.sh` passes over the tree and fails on the temp #102 fixture; with `RAD_BASH32=/nonexistent` it prints the SKIP line and exits 0.

#### Task 2.2: Enforce the parse check in CI on macOS
File: .github/workflows/ci.yml:35-60
What: Add a `bash32-parse` job on `macos-latest` that checks out the repo and runs `bash scripts/test-bash32-parse.sh`, then asserts that its output contains no `SKIP:` line, so a runner image without 3.2 fails loudly instead of skipping. Workflow YAML stays a thin wrapper, with no check logic inline beyond the SKIP guard.
Validate: AC#6, AC#7 — the workflow YAML parses (`ruby -ryaml` / `python -c yaml.safe_load` or `actionlint` if present); the job invokes only the script; the full `for t in scripts/test-*.sh` loop and `npm test --prefix harness` pass locally; `bash scripts/lint-shell-safety.sh` reports no new findings.

## Tests to Write
- [ ] plan_cited_anchors still drops a host:// URL token after the 3.2 rewrite — scripts/test-plan-paths.sh
- [ ] A6 em-dash inside the description resolves the path after the last separator, present and missing — scripts/test-check-tests-present.sh
- [ ] rad-label removes only present status labels and passes no remove flag when none are present — scripts/test-rad-label.sh
- [ ] rad-label failing swap exits 0 and warns with target and gh error; no gh is a no-op — scripts/test-rad-label.sh
- [ ] bash 3.2 parse check passes the tree, fails the #102 fixture, and skips explicitly when no 3.2 exists — scripts/test-bash32-parse.sh

## Non-Goals
- Verifying runtime bash-3.2 behaviour (a parse check proves syntax only).
- Changing the Tests-to-Write line format or `check-tests-present.sh` exit codes.
- Changing `rad-label.sh`'s CLI, its best-effort exit-0 contract, or its call sites.
- Creating the never-used status labels (`rad:draft`, `rad:ready`, `rad:needs-revision`, `rad:rejected`) in the repo.

## Out-of-Scope Dependencies
None. Every file is architect-writable. The CI job sits within the architect-owned ci-wiring scope.

## Risks
- **`plan_cited_anchors` feeds the freshness lint and `classify-low-risk.sh` (called by `harness/cli.js` for auto-clear).** A behaviour change there could flip a low-risk verdict. Mitigated by the output-identical requirement, the existing test file, and the new URL-token case.
- **`check-tests-present.sh` is a blocking gate in the deliver spine.** The fix could over-correct for paths that themselves contain `— `, which is vanishingly unlikely and was already unsupported.
- **The macOS runner could one day ship without bash 3.2.** The SKIP guard in the CI job turns that into a loud failure, not a silent pass.
- **The new `gh issue view` call adds a network round-trip to every label mirror.** It is still best-effort, and a failed read falls back to the add-only path with a WARN.
