# Plan: Review Conventions
Created: 2026-07-03
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-07-03T17:26:46.152Z
Recorded-By: sean@torchcodelab.com
Branch: rad/review-conventions

## Context
/rad-insights' Findings Recurrence step flagged five categories at/above threshold
across 8 review cycles. Four (testing, code-clarity, error-handling, correctness)
map to convention bullets — CLAUDE.md's `## Coding Conventions` is currently two
empty placeholder bullets. The fifth (security — 4 of 9 findings HIGH) warrants a
real lint: shell scripts interpolating positional/env values into git/jq/node
-e/eval without a strong guard. Research shows the guard threshold is decisive:
requiring a regex/format guard flags 5 of 8 sampled scripts today, so the lint
ships with a committed baseline ratchet — strict for new code, warning-only for
baselined pre-existing offenders.

## Scope
| In scope | Out of scope |
|---|---|
| CLAUDE.md `## Coding Conventions`: four bullets replacing the placeholders | Editing ANY sampled weak-guard script (check-scope.sh, check-plan-approved.sh, check-approval-integrity.sh, classify-low-risk.sh, open-pr.sh) — remediation is a follow-up plan |
| NEW scripts/lint-shell-safety.sh + co-located fixture test | harness/** — separate suite, untouched |
| NEW scripts/lint-shell-safety-baseline.txt (known-offender ratchet) | scripts/lib/plan-paths.sh — no shared scanning helper exists; the lint is self-contained |
| One new fail-closed ci.yml job (checkout + invoke) | Existing ci.yml jobs — additive only |

## Acceptance Criteria
1. CLAUDE.md `## Coding Conventions` (lines 62-67 region) contains exactly the four /rad-insights suggestion bullets — testing (test ships with the behavior change / co-located test-<name>.sh / Validate-field exception), code-clarity (~40-line functions, intent-revealing names, named constants, constraint-comments), error-handling (never swallow: rethrow/exit-nonzero/log-with-context; fail-closed default at gate boundaries), correctness (edge cases named in Validate before implementation, each tested) — replacing the two placeholder bullets; no other CLAUDE.md section changes.
2. `scripts/lint-shell-safety.sh` exists (executable, bash 3.2 safe, `set -euo pipefail`): scans `scripts/*.sh` (excluding `test-*.sh` fixtures and `lib/`) for lines interpolating a positional-derived or env-derived variable into `git`/`jq`/`node -e`/`eval` invocations where that variable lacks a preceding STRONG guard in the same script — strong = a `[[ "$var" =~ ... ]]` regex match or `case`-pattern validation (the git-sync.sh/checkout-plan.sh/fetch-epic.sh idiom); `-z`/`-f` existence checks alone do NOT qualify. Exit 0 clean / 1 violations / 2 usage; `✗ <file>: <reason>` per violation; terminal `PASS:` line — mirroring lint-agent-files.sh.
3. Baseline ratchet: violations in files listed in `scripts/lint-shell-safety-baseline.txt` report as `⚠ baseline:` warnings and do NOT fail; violations in non-baselined files fail; a baseline entry whose file has no remaining violations emits a `⚠ stale baseline:` warning (still exit 0). The committed baseline lists exactly the current offenders (expected ≈ check-scope.sh, check-plan-approved.sh, check-approval-integrity.sh, classify-low-risk.sh, open-pr.sh — final list from running the lint), each with a trailing comment noting the unguarded variable(s).
4. `scripts/test-lint-shell-safety.sh` (temp-fixture pattern per test-lint-agent-files.sh) passes: guarded-script fixture exits 0; unguarded fixture exits 1 with the reason greppable; baselined-offender fixture exits 0 with `⚠ baseline:` output; stale-baseline fixture exits 0 with the stale warning; missing-args/nonexistent-dir usage cases exit 2.
5. The real tree passes: `scripts/lint-shell-safety.sh` exits 0 at commit time (offenders baselined), and `.github/workflows/ci.yml` gains a `shell-safety-lint` job (checkout + invoke, fail-closed, mirroring agent-file-lint) — the fixture test is auto-run by the existing script-tests job with no extra wiring.
6. The diff touches no existing script's logic: sampled weak-guard scripts, harness/**, and existing ci.yml jobs are byte-identical.

## Agent Scope
Research via Explore sub-agent within the architect convention-lints surfaces
(lint-plan.sh/check-scope.sh conventions, ci.yml, CLAUDE.md, the scripts corpus
as read-only survey material). No out-of-scope dependencies: the lint may FLAG
other domains' scripts via the baseline but never edits them.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| CLAUDE.md | 62-67 | Replace the two placeholder Coding Conventions bullets with the four recurrence-suggestion bullets |
| scripts/lint-shell-safety.sh | 1-190 | NEW — strict-guard interpolation lint with baseline ratchet (contract per AC#2/AC#3) |
| scripts/lint-shell-safety-baseline.txt | 1-10 | NEW — committed known-offender list with per-entry comments |
| scripts/test-lint-shell-safety.sh | 1-160 | NEW — temp-fixture self-test per the test-lint-agent-files.sh pattern |
| .github/workflows/ci.yml | 75-82 | NEW shell-safety-lint job after agent-file-lint (checkout + invoke, fail-closed) |

## Execution Notes

### Do Not Touch
- scripts/check-scope.sh, check-plan-approved.sh, check-approval-integrity.sh, classify-low-risk.sh, open-pr.sh, git-sync.sh, fetch-epic.sh, checkout-plan.sh, rad-label.sh — survey/baseline material only; the lint flags, never fixes
- harness/** — separate suite
- scripts/lib/plan-paths.sh — unrelated helper; the new lint is self-contained
- Existing ci.yml jobs — additive wiring only
- .agents/findings.jsonl and all events.jsonl — read-only

### Key Files
- scripts/lint-agent-files.sh — the canonical lint shape: header exit-code doc, `violation()` accumulator, `✗ <file>: <reason>`, terminal PASS, arg defaults with exit-2 guards
- scripts/test-lint-agent-files.sh — the canonical fixture test: mktemp -d + trap, heredoc fixtures, set +e/-e run wrapper, code + grep assertions, ALL PASS
- scripts/git-sync.sh + checkout-plan.sh + fetch-epic.sh — the STRONG guard idiom the lint requires (regex `[[ =~ ]]` validation before interpolation)
- .github/workflows/ci.yml agent-file-lint job (~66-74) — the job shape to mirror; insert after it
- CLAUDE.md lines 62-67 — the placeholder bullets to replace (bullet style per adjacent sections)

### Reminders
- The guard analysis is heuristic (grep-based, not AST): scope it to keep false positives near zero — flag only direct `"$VAR"` interpolation into the target commands (git/jq/node -e/eval) by variables assigned from `$1..$9`/`$@` or `${RAD_*}`/process env, where no `[[ "$VAR" =~` or `case "$VAR" in` appears earlier in the file. Document the heuristic's limits in the header comment.
- Run the lint against the real tree BEFORE finalizing the baseline; the committed baseline must make the real tree exit 0 (AC#5) — this is the harness-ci drift lesson applied proactively.
- bash 3.2 (macOS) compatible; exit 0/1/2; executable bits on both new scripts.
- ci.yml: zero check logic in YAML — the job is checkout + `- run: scripts/lint-shell-safety.sh`.
- CI gates this PR: do not edit the plan body after approval without re-approving (fingerprint).
- The four CLAUDE.md bullets should match the /rad-insights suggestion text (2026-07-03 session) in substance; tightening wording is fine, weakening is not.

## Wave Plan

### Wave 1 — parallel
Two independent tasks (different files, no dependency).

#### Task 1.1: Shell-safety lint + baseline + fixture test
File: scripts/lint-shell-safety.sh:1-190
What: Implement the lint per AC#2 (strict-guard heuristic, lint-agent-files.sh shape) and AC#3 (baseline ratchet with ⚠ baseline / ⚠ stale baseline warnings). Write scripts/test-lint-shell-safety.sh per AC#4 (guarded pass / unguarded fail / baselined warn-pass / stale-baseline warn / usage exit 2). Run the lint against the real scripts/ tree, freeze the actual offender list into scripts/lint-shell-safety-baseline.txt (per-entry comment naming the unguarded variable), and verify the real tree then exits 0. Both scripts chmod +x.
Validate: AC#2, AC#3, AC#4 — test script exits 0 (ALL PASS); real-tree lint exits 0 with baseline warnings only.

#### Task 1.2: CLAUDE.md convention bullets
File: CLAUDE.md:62-67
What: Replace the two placeholder bullets under `## Coding Conventions` with the four recurrence-suggestion bullets (testing, code-clarity, error-handling, correctness) per AC#1, matching the adjacent sections' bullet style. Touch nothing else in CLAUDE.md.
Validate: AC#1 — section contains exactly the four bullets; `git diff CLAUDE.md` confined to lines 62-67 region; scripts/lint-agent-files.sh still exits 0 (scope map untouched).

### Wave 2 — sequential
Depends on: Wave 1 complete (the job invokes the Wave-1 script).

#### Task 2.1: CI wiring
File: .github/workflows/ci.yml:75-82
What: Add a `shell-safety-lint` job after agent-file-lint mirroring its shape exactly (actions/checkout@v4 + `- run: scripts/lint-shell-safety.sh`), fail-closed. No other ci.yml changes. Validate YAML parses (js-yaml via harness node_modules) and run the exact command line locally.
Validate: AC#5, AC#6 — YAML parses; local invocation exits 0 on the real tree; diff shows only the new job.

## Tests to Write
- [ ] guarded fixture passes; unguarded interpolation into git/jq/node -e/eval fails with greppable reason; baselined offender warns but exits 0; stale baseline entry warns; missing/invalid args exit 2 — scripts/test-lint-shell-safety.sh

## Non-Goals
- No remediation of the ~5 baselined weak-guard scripts — that is a deliberate follow-up plan (they belong to other role domains); the baseline ratchet holds the line meanwhile.
- No AST-level shell parsing — the heuristic is grep-based and documented as such; precision over recall, near-zero false positives.
- No lint-plan.sh changes — this is a sibling lint, not an extension of the plan linter.
- No CLAUDE.md changes beyond the four Coding Conventions bullets.

## Out-of-Scope Dependencies
None — convention-lints is architect surface and the author is the architect.

## Risks
- Heuristic false positives on unusual-but-safe interpolations would block unrelated PRs — mitigated by the precision-first heuristic scope, the fixture test, and the baseline escape hatch (worst case: baseline the false positive with a comment).
- Heuristic false negatives (indirect assignment, sourced values) are accepted and documented — the lint raises the floor, it is not a proof.
- The baseline could rot (entries fixed but never removed) — the stale-baseline warning surfaces that in every run.
- New scripts added between plan and deliver could change the offender list — the baseline is frozen at deliver time from the actual lint run, not from this plan's estimate.
