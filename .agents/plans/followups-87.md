# Plan: Follow-ups from #87
Created: 2026-10-01
Author: architect
Status: complete
Completed-At: 2026-10-05T15:37:50Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-05T15:27:27.477Z
Recorded-By: sean@torchcodelab.com
Branch: rad/followups-87
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/174
Issue-Title: Follow-ups from #87: fail-closed default-branch reads, lint-plan en-dash crash, tests-present annotation parsing, notices

## Context

`scripts/get-default-branch.sh` already fails closed. It falls back to `main` only when the `default_branch` key is absent, and exits 1 on a missing or invalid `.rad/config.yml`. Seven callers discard that with `2>/dev/null || echo main`, three of them gates.

Separately:
- `lint-plan.sh` crashes with a bare `awk: towc` error when a vague word sits next to an en dash.
- `check-tests-present.sh` takes a trailing `(...)` annotation as part of the test path. This was a false "missing" during the #173 deliver.
- Two messages still point at the old CLAUDE.md config.

The issue was filed in this session from reproduced behavior, so it is fully specified.

## Scope
| In scope | Out of scope |
|---|---|
| Fail-closed default-branch reads in the 3 gate scripts and `open-pr.sh` | Changing `get-default-branch.sh` itself (it is already correct) |
| Logged-reason fallback in `rad-status.sh` and the `lint-plan.sh` freshness check | `draft-insights-plan.sh:242`, which already documents its fallback |
| `lint-plan.sh` vague-wording scan surviving multibyte input | Rewriting the other awk scans in `lint-plan.sh` |
| `check-tests-present.sh` stripping a trailing `(...)` annotation | Changing the Tests to Write line format |
| `detect-platform.sh` notice and `docs/rad-cli.md:58` pointer | Other docs |

## Acceptance Criteria
1. **The gates fail closed on a config error.** When no base branch argument is given and `get-default-branch.sh` exits non-zero, these scripts exit non-zero, print `get-default-branch.sh`'s stderr reason, and never compare against `main`:

   | Script | Exit code |
   |---|---|
   | `check-plan-approved.sh` | 1 |
   | `check-approval-integrity.sh` | 2 |
   | `check-scope.sh` | 2 |

   An explicit base branch argument still skips the lookup, and a config with the `default_branch` key absent still resolves to `main`, as before.
2. **`open-pr.sh` fails closed.** When `get-default-branch.sh` exits non-zero, `open-pr.sh` exits 1 with the reason and opens no PR.
3. **The advisory and display callers log the reason.**
   - `rad-status.sh`, at both call sites, prints `warning: default branch unresolved (<reason>), assuming main` on stderr and continues.
   - The `lint-plan.sh` freshness check emits its single existing "freshness could not be verified" advisory with the reason, and its exit code is unchanged.
4. **`lint-plan.sh` survives an en dash next to a vague word.**
   - A plan whose task `What:` contains `robust` followed directly by an en dash (U+2013) lints with exit 0 under `LANG=en_US.UTF-8` on macOS `/usr/bin/awk`.
   - The vague-wording advisory still flags `robust`.
   - ASCII-only behavior is unchanged: every existing `test-lint-plan.sh` case passes.
5. **`check-tests-present.sh` strips an annotation.**
   - `- [ ] x — path/to/file.sh (Amendment 1)` resolves to `path/to/file.sh`.
   - A path with no annotation behaves as before.
   - A non-existent path with an annotation is still reported missing.
6. **The notices are corrected.**
   - The `detect-platform.sh` no-config notice names both `rad config init` and `rad config migrate`.
   - `docs/rad-cli.md:58` says `.rad/config.yml` (`roles.architect`) instead of `CLAUDE.md`.
7. **Everything stays green:**
   - every `scripts/test-*.sh` under both `bash` and `/bin/bash`;
   - `npm test --prefix harness`;
   - `lint-shell-safety` and `lint-invariants`.

## Agent Scope
Research was done directly by the orchestrator: grep of the `get-default-branch.sh` callers, and reproduction of the en-dash crash and the tests-present parsing bug. No agents were called.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/check-plan-approved.sh | 30-40 | Fail-closed base lookup (AC#1) |
| scripts/check-approval-integrity.sh | 46-56 | Fail-closed base lookup (AC#1) |
| scripts/check-scope.sh | 15-25 | Fail-closed base lookup (AC#1) |
| scripts/test-check-plan-approved.sh | 290-327 | Config-error case (AC#1) |
| scripts/test-check-approval-integrity.sh | 210-243 | Config-error case (AC#1) |
| scripts/test-check-scope.sh | 180-211 | Config-error case (AC#1) |
| scripts/open-pr.sh | 12-20 | Fail-closed base lookup (AC#2) |
| scripts/test-open-pr.sh | 160-188 | Config-error case (AC#2) |
| scripts/rad-status.sh | 85-95, 222-230 | Logged fallback (AC#3) |
| scripts/test-rad-status.sh | 290-320 | Warning case (AC#3) |
| scripts/check-tests-present.sh | 30-50 | Strip trailing annotation (AC#5) |
| scripts/test-check-tests-present.sh | 120-158 | Annotation cases (AC#5) |
| scripts/lint-plan.sh | 438-448, 465-502 | Freshness reason (AC#3); multibyte-safe vague scan (AC#4) |
| scripts/test-lint-plan.sh | 1080-1109 | En-dash and freshness cases (AC#3, AC#4) |
| scripts/detect-platform.sh | 46-50 | Notice text (AC#6) |
| scripts/test-detect-platform.sh | 120-143 | Notice assertion (AC#6) |
| docs/rad-cli.md | 56-60 | Pointer (AC#6) |
| harness/evals/approval.eval.js | 296-310 | Amendment 1: `runGateScript` passes an explicit base branch |

## Execution Notes

### Do Not Touch
- `scripts/get-default-branch.sh`
- `scripts/draft-insights-plan.sh`
- `harness/` (except, under Amendment 1, `runGateScript` in `harness/evals/approval.eval.js`)
- `.rad/config.yml`, CLAUDE.md

### Key Files
- `scripts/get-default-branch.sh`: its exit contract (absent key → `main` and exit 0; missing or invalid config → exit 1) is what the callers must respect
- `scripts/test-check-plan-approved.sh`: its existing fixture pattern for building a temp repo with a copied `scripts/` and `harness/`, and how to reuse that to break `.rad/config.yml`

### Reminders
- The scripts use `"${N:-$(...)}"`. A command substitution inside a parameter default does not trip `set -e`, so split it into an explicit `if [[ -n "${N:-}" ]] ... else BASE=$(...) || { ...; exit N; }`.
- bash 3.2 portability: no `${var,,}`, no `mapfile`, no associative arrays. Run every test under `/bin/bash` too.
- No en dashes in shell files. In tests, generate the en dash with `printf '\342\200\223'`.
- For AC#4, the likely fix is running the vague-wording awk under `LC_ALL=C`. The vague-word list is ASCII, so byte matching is equivalent. Check that `tolower` and the word-boundary checks still behave the same.

## Wave Plan

### Wave 1 — parallel
Disjoint files.

#### Task 1.1: Gate scripts fail closed on a config error
File: scripts/check-plan-approved.sh:30-40, scripts/check-approval-integrity.sh:46-56, scripts/check-scope.sh:15-25, scripts/test-check-plan-approved.sh:290-327, scripts/test-check-approval-integrity.sh:210-243, scripts/test-check-scope.sh:180-211
What: Implement AC#1 in all three gates, replacing `2>/dev/null || echo main` with an explicit lookup that exits with the listed code and forwards the reason. Add one test case per gate: an invalid `.rad/config.yml` with no base argument. It asserts the exit code, that the reason is printed, and that there is no `main` comparison.
Validate: AC#1, AC#7:
- the three test files pass under `bash` and `/bin/bash`;
- the existing explicit-base and absent-key cases still pass.

Edge cases: an explicit base argument given with a broken config (the lookup is skipped, so it is not an error); the absent `default_branch` key (still `main`).

#### Task 1.2: open-pr fails closed; rad-status logs the reason
File: scripts/open-pr.sh:12-20, scripts/test-open-pr.sh:160-188, scripts/rad-status.sh:85-95, scripts/rad-status.sh:222-230, scripts/test-rad-status.sh:290-320
What: Implement AC#2 and AC#3 for `rad-status.sh`. `open-pr.sh` resolves the base after argument parsing, so an explicit `--base` still skips the lookup.
Validate: AC#2, AC#3:
- the `test-open-pr.sh` config-error case exits 1 with no `gh` or `glab` call;
- the `test-rad-status.sh` case sees the warning on stderr and exit 0;
- both pass under `bash` and `/bin/bash`.

Edge case: `--base` given explicitly with a broken config.

#### Task 1.3: check-tests-present strips a trailing annotation
File: scripts/check-tests-present.sh:30-50, scripts/test-check-tests-present.sh:120-158
What: Implement AC#5. Strip a single trailing ` (...)` group, after the backtick strip and before the existence test.
Validate: AC#5:
- new cases for an annotated existing path (found), an annotated missing path (missing, exit 1), and a path with parentheses mid-name but no trailing annotation (unchanged);
- passes under both shells.

Edge cases: an empty annotation `()`; an annotation with nothing before it.

### Wave 2 — parallel
Disjoint from Wave 1.

#### Task 2.1: lint-plan survives an en dash; freshness logs the reason
File: scripts/lint-plan.sh:438-448, scripts/lint-plan.sh:465-502, scripts/test-lint-plan.sh:1080-1109
What: Implement AC#4 and the `lint-plan.sh` part of AC#3. Add a `t_vague_wording_multibyte` case: a fixture with `robust` followed directly by an en dash (U+2013) in a `What:` line exits 0 and still flags `robust`. Add a freshness case with an invalid `.rad/config.yml`: the advisory includes the reason.
Validate: AC#3, AC#4, AC#7:
- `bash scripts/test-lint-plan.sh && /bin/bash scripts/test-lint-plan.sh` prints `ALL PASS`;
- the reproduction from #174 exits 0.

Edge cases: an en dash directly before and directly after a vague word; an em dash (unchanged).

#### Task 2.2: detect-platform notice and rad-cli pointer
File: scripts/detect-platform.sh:46-50, scripts/test-detect-platform.sh:120-143, docs/rad-cli.md:56-60
What: Implement AC#6.
Validate: AC#6:
- `test-detect-platform.sh` asserts that the no-config notice names `rad config init`, and passes under both shells;
- `grep -n "configured architect in .CLAUDE" docs/rad-cli.md` finds nothing.

### Wave 3 — sequential
Amendment 1: Task 1.1's fail-closed base lookup makes an eval's mutated twin refuse for the wrong reason.

#### Task 3.1: Gate eval passes an explicit base branch
File: harness/evals/approval.eval.js:296-310
What: `gate-hook-via-symlinked-checkout [mutated]` now fails ("assertion still passed with the guard removed").
- **Why:** the twin restores the old string-compare guard in `cli.js`. Run through the symlink, `get-default-branch.sh` then gets a silent, empty `config get`, so it exits 1. Task 1.1 makes `check-plan-approved.sh` refuse on that error, before the gate it is meant to test ever runs. That is a correct refusal, but it is a third defence the twin doesn't revert, so the eval no longer isolates the guard plus the `passed=true` check.
- **Fix:** `runGateScript` passes the base branch explicitly (`check-plan-approved.sh rad/<feature> main`), which skips the lookup the same way any caller with an explicit base does. Add a one-line constraint comment saying why. The base-lookup failure keeps its own coverage in `scripts/test-check-plan-approved.sh`.

Validate: AC#1 (amendment 1).
- `node --test harness/evals/approval.eval.js` passes in full, including `gate-hook-via-symlinked-checkout [mutated]`.
- `node --test harness/evals/*.eval.js` has no failures.
- Edge case: the un-mutated case must still refuse the unapproved plan through the symlink.

## Tests to Write
- [ ] Gate config-error cases — scripts/test-check-plan-approved.sh
- [ ] Gate config-error cases — scripts/test-check-approval-integrity.sh
- [ ] Gate config-error cases — scripts/test-check-scope.sh
- [ ] open-pr config-error case — scripts/test-open-pr.sh
- [ ] rad-status warning case — scripts/test-rad-status.sh
- [ ] Annotation stripping cases — scripts/test-check-tests-present.sh
- [ ] En-dash and freshness-reason cases — scripts/test-lint-plan.sh
- [ ] Notice names rad config init — scripts/test-detect-platform.sh

## Non-Goals
- Changing `get-default-branch.sh`'s contract or the absent-key fallback to `main`.
- Making the other `lint-plan.sh` awk scans multibyte-aware beyond the vague-wording scan.
- Changing the format of the plan's Tests to Write line.

## Out-of-Scope Dependencies
None.

## Risks
- **A gate that used to pass now fails** in a repo whose `.rad/config.yml` is broken. That is the intended fail-closed behavior, but a CI run with a missing config would newly go red. Mitigation: the error message names the cause, and `rad config init` fixes it.
- **`LC_ALL=C` in the vague scan** could change how non-ASCII letters next to a vague word count for the word boundary. Under C, a multibyte byte is not `[a-z0-9_-]`, so it counts as a boundary. That matches the current intent.

## Issue Gaps
- **AMENDMENT 1 (2026-10-05, after Wave 2).** The final checks found that `harness/evals/approval.eval.js` `gate-hook-via-symlinked-checkout [mutated]` fails. Task 1.1's fail-closed base lookup refuses before the gate when the reverted `cli.js` guard silently empties `get-default-branch.sh`'s output, so the twin can't reach the layers it tests. The new Task 3.1 has the eval pass an explicit base branch. The range `harness/evals/approval.eval.js:296-310` is added.
- **ASSUMPTION: exit codes per gate.** Each gate reuses its existing error code (`check-plan-approved` 1; `check-approval-integrity` and `check-scope` 2, their usage/config code) rather than a new shared code.
- **ASSUMPTION: `rad-status.sh` and `lint-plan.sh` freshness stay non-fatal.** They are display and advisory, so they warn and continue rather than fail.
- **ASSUMPTION: `draft-insights-plan.sh:242` is left alone.** Its fallback is commented as the documented default and already doesn't discard stderr.
