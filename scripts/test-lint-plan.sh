#!/usr/bin/env bash
# test-lint-plan.sh
# Dedicated regression tests for lint-plan.sh's advisory (warning) behavior:
#   - missing task `File:` path advisory
#   - high-risk path advisory + RAD_HIGH_RISK_PATTERNS override
#   - self-protected path advisory (unconditional, never env-gated)
#   - rename-destination advisory (#99): a rename-shaped Change cell whose
#     destination has no File-column row of its own
#   - missing-in-scope suppression (#100): a path already reported absent from
#     disk is never ALSO reported as a stale premise
#   - warnings-only plans still exit 0
#   - multi-file task File: lines (#134): one warning per missing comma-separated
#     path, range-only continuations ignored
#   - context budget (#134): a bare Lines number counts as 1 line; ranges unchanged
#   - approval blockers: markers (fenced / inline-span skipped) and un-waived
#     high-risk ids listed, never changing the exit code; stale, empty and
#     clarify-naming waivers warned; fenced example waivers ignored
#   - stack-order wave advisory (layered waves only; mixed/single/unknown silent)
#   - missing-mockup advisory (present, absent, fenced refs)
# Self-contained (no external harness): writes temp fixture plans, runs the real
# lint-plan.sh, and asserts on output/exit code. Runs under bash 3.2+ (set -u safe).
#
# Usage: scripts/test-lint-plan.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

# Run lint-plan.sh against a plan file, capturing combined output and exit code
# without tripping set -e (these tests assert on the code). Honors any
# RAD_HIGH_RISK_PATTERNS already exported by the caller.
LINT_OUT=""
LINT_CODE=0
run_lint() {
  set +e
  LINT_OUT=$(bash "$HERE/lint-plan.sh" "$1" 2>&1)
  LINT_CODE=$?
  set -e
}

# Emit an otherwise-valid plan to $1. A `BODY` heredoc-able tail lets each test
# vary only the Files-in-Scope and task File: lines. Real on-disk paths are used
# for the "valid" rows so the existence checks stay quiet; tests that want a
# missing-path or high-risk advisory inject those rows themselves.
#
# Args: $1 = output path
#       $2 = Files-in-Scope data rows (table body, may be empty)
#       $3 = task File: line value (path:lines form, may be empty to omit)
#       $4 = wave count (optional, default 1). When >1, extra minimal `### Wave N`
#            blocks are emitted (each with one AC-citing task) so the fixture can
#            exercise the "large plan (>=3 waves)" advisory branch.
#       $5 = program_design (optional, default false). When "true", a
#            `## Program Design` section is emitted so has_section finds it.
#       $6 = tail (optional, default empty). Raw text appended after ## Risks —
#            e.g. a marker line (lands in Risks) or a `## Waivers` section.
write_plan() {
  local out="$1" scope_rows="$2" task_file="$3"
  local wave_count="${4:-1}" program_design="${5:-false}" tail="${6:-}"
  local w
  {
    cat <<'EOF'
# Plan: advisory-test
Created: 2026-06-15
Author: developer
Status: pending-review
Branch: rad/advisory-test

## Context
Fixture plan exercising lint-plan advisory paths.

## Scope
| In | Out |

## Acceptance Criteria
1. Something testable.

## Agent Scope
developer

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
EOF
    [[ -n "$scope_rows" ]] && printf '%s\n' "$scope_rows"
    cat <<'EOF'

## Execution Notes
### Do Not Touch
- None
EOF
    # Optional Program Design section (heading + a token line). Presence is all
    # the linter checks; contents are never validated.
    if [[ "$program_design" == "true" ]]; then
      printf '\n## Program Design\nsignatures, call-stack sketch, file-tree diff\n'
    fi
    # Wave 1 is always emitted and carries the optional task File: line.
    printf '\n## Wave Plan\n'
    printf '### Wave 1 — sequential\n'
    printf '#### Task 1.1: do the thing\n'
    [[ -n "$task_file" ]] && printf 'File: %s\n' "$task_file"
    printf 'Validate: AC#1 — x\n'
    # Additional minimal waves for the >=3-wave "large plan" cases.
    for (( w = 2; w <= wave_count; w++ )); do
      printf '### Wave %d — sequential\n' "$w"
      printf '#### Task %d.1: do the thing\n' "$w"
      printf 'Validate: AC#1 — x\n'
    done
    cat <<'EOF'

## Tests to Write
- [ ] t — scripts/test-lint-plan.sh

## Non-Goals
- a
- b

## Risks
none
EOF
    # An `if`, not `&&`: a false test as the group's last command would fail it.
    if [[ -n "$tail" ]]; then printf '%s\n' "$tail"; fi
  } > "$out"
}

# A real, on-disk, non-high-risk path to use for "present" rows.
REAL_PATH="scripts/lint-plan.sh"

# ── AC#1: missing task File: path → warning; all-present → no such warning ─────
t_missing_task_file() {
  local plan="$TMP/missing-task-file.md"
  write_plan "$plan" "| $REAL_PATH | 1-2 | x |" "src/does-not-exist-xyz.js:1-10"
  run_lint "$plan"
  printf '%s\n' "$LINT_OUT" | grep -q "references a File: path that does not exist: src/does-not-exist-xyz.js" \
    || fail "AC#1: missing task File: path did not emit the advisory"
  echo "✓ AC#1a: missing task File: path emits the does-not-exist advisory"

  # All-present: a real task File: path → no such warning.
  local plan2="$TMP/present-task-file.md"
  write_plan "$plan2" "| $REAL_PATH | 1-2 | x |" "$REAL_PATH:1-10"
  run_lint "$plan2"
  printf '%s\n' "$LINT_OUT" | grep -q "references a File: path that does not exist" \
    && fail "AC#1: all-present plan wrongly emitted a missing-File advisory" || true
  echo "✓ AC#1b: all-present task File: path emits no does-not-exist advisory"
}

# ── AC#2: high-risk path → advisory; RAD_HIGH_RISK_PATTERNS override changes it ─
t_high_risk_advisory() {
  # A task File: path matching the DEFAULT high-risk patterns (contains "auth").
  # Use a real on-disk dir-ish path? No — keep it a clearly-scoped source path.
  # It need not exist: the high-risk advisory is independent of existence.
  local risky="src/auth/login.js:1-20"
  local plan="$TMP/high-risk.md"
  write_plan "$plan" "| $REAL_PATH | 1-2 | x |" "$risky"

  # Default patterns: "auth" matches → high-risk advisory present.
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$plan"
    printf '%s\n' "$LINT_OUT" | grep -q "High-risk path in scope — flag for close architect review: src/auth/login.js" \
      || fail "AC#2: default patterns did not flag the auth path as high-risk"
  ) || exit 1
  echo "✓ AC#2a: high-risk path emits the architect-review advisory under defaults"

  # Override that does NOT include "auth" → no high-risk advisory for this path.
  ( export RAD_HIGH_RISK_PATTERNS="payment|billing"; run_lint "$plan"
    printf '%s\n' "$LINT_OUT" | grep -q "High-risk path in scope" \
      && fail "AC#2: override without 'auth' still flagged the auth path" || true
  ) || exit 1
  echo "✓ AC#2b: RAD_HIGH_RISK_PATTERNS override narrows matches (auth no longer flagged)"

  # Override that introduces a NEW term → a previously-clean path is now flagged.
  local plan2="$TMP/high-risk-custom.md"
  write_plan "$plan2" "| $REAL_PATH | 1-2 | x |" "src/widget/frobnicate.js:1-20"
  ( export RAD_HIGH_RISK_PATTERNS="frobnicate"; run_lint "$plan2"
    printf '%s\n' "$LINT_OUT" | grep -q "High-risk path in scope — flag for close architect review: src/widget/frobnicate.js" \
      || fail "AC#2: custom 'frobnicate' pattern did not flag the matching path"
  ) || exit 1
  echo "✓ AC#2c: RAD_HIGH_RISK_PATTERNS override widens matches (custom term flagged)"
}

# ── AC#5: otherwise-valid plan with only these advisories still exits 0 ─────────
t_exit_zero_invariance() {
  # A plan whose ONLY findings are the two new advisories (missing task File: +
  # high-risk path). No errors → must exit 0.
  local plan="$TMP/advisories-only.md"
  write_plan "$plan" "| $REAL_PATH | 1-2 | x |" "src/auth/ghost.js:1-20"
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$plan"
    # Both advisories should be present...
    printf '%s\n' "$LINT_OUT" | grep -q "references a File: path that does not exist: src/auth/ghost.js" \
      || fail "AC#5: expected the missing-File advisory in the advisories-only plan"
    printf '%s\n' "$LINT_OUT" | grep -q "High-risk path in scope" \
      || fail "AC#5: expected the high-risk advisory in the advisories-only plan"
    # ...and there must be NO Errors section.
    printf '%s\n' "$LINT_OUT" | grep -q "Errors (must fix before approval):" \
      && fail "AC#5: advisories-only plan unexpectedly reported errors" || true
    # ...and the exit code must be 0.
    [[ "$LINT_CODE" -eq 0 ]] || fail "AC#5: advisories-only plan exited $LINT_CODE (expected 0)"
  ) || exit 1
  echo "✓ AC#5: otherwise-valid plan with only the new advisories still exits 0"
}

# ── AC#2: self-protected path advisory fires unconditionally ────────────────────
t_self_protected_advisory() {
  # harness/gates.js is real, on-disk, matches no high-risk default token, and
  # sits squarely in the self-protected set.
  local plan="$TMP/self-protected.md"
  write_plan "$plan" "| harness/gates.js | 1-2 | x |" "harness/gates.js:1-10"

  # (a) Default env → advisory present, exit 0.
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$plan"
    printf '%s\n' "$LINT_OUT" | grep -q "self-protected path (RAD machinery — always requires architect review): harness/gates.js" \
      || fail "AC#2: default env did not emit the self-protected advisory"
    [[ "$LINT_CODE" -eq 0 ]] || fail "AC#2: self-protected plan exited $LINT_CODE (expected 0)"
  ) || exit 1
  echo "✓ AC#2d: self-protected path emits the advisory under the default env"

  # (b) A high-risk override that matches nothing → advisory still fires.
  ( export RAD_HIGH_RISK_PATTERNS="zzz-nomatch"; run_lint "$plan"
    printf '%s\n' "$LINT_OUT" | grep -q "self-protected path (RAD machinery — always requires architect review): harness/gates.js" \
      || fail "AC#2: no-match RAD_HIGH_RISK_PATTERNS suppressed the self-protected advisory"
    [[ "$LINT_CODE" -eq 0 ]] || fail "AC#2: self-protected plan exited $LINT_CODE (expected 0)"
  ) || exit 1
  echo "✓ AC#2e: self-protected advisory fires with a no-match RAD_HIGH_RISK_PATTERNS override"

  # (c) An emptied high-risk set → advisory still fires (not gated on the env).
  ( export RAD_HIGH_RISK_PATTERNS=""; run_lint "$plan"
    printf '%s\n' "$LINT_OUT" | grep -q "self-protected path (RAD machinery — always requires architect review): harness/gates.js" \
      || fail "AC#2: empty RAD_HIGH_RISK_PATTERNS suppressed the self-protected advisory"
    [[ "$LINT_CODE" -eq 0 ]] || fail "AC#2: self-protected plan exited $LINT_CODE (expected 0)"
  ) || exit 1
  echo "✓ AC#2f: self-protected advisory fires with RAD_HIGH_RISK_PATTERNS emptied"

  # (d) Docs-only plan → no self-protected advisory, exit 0.
  local plan2="$TMP/docs-only.md"
  write_plan "$plan2" "| docs/rad-cli.md | 1-2 | x |" "docs/rad-cli.md:1-10"
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$plan2"
    printf '%s\n' "$LINT_OUT" | grep -q "self-protected path" \
      && fail "AC#2: docs-only plan wrongly emitted a self-protected advisory" || true
    [[ "$LINT_CODE" -eq 0 ]] || fail "AC#2: docs-only plan exited $LINT_CODE (expected 0)"
  ) || exit 1
  echo "✓ AC#2g: docs-only plan emits no self-protected advisory"
}

# ── Git-backed premise-freshness fixtures ──────────────────────────────────────
# The freshness advisory queries origin/<default_branch>, so these cases need a
# real repo with an origin remote (a local bare origin, like test-plan-paths.sh).
# Plans are SYNTHETIC (built here), never the real repo's plans — kept hermetic.
FRESH_OUT=""
FRESH_CODE=0
run_lint_in_repo() {
  local repo="$1" plan="$2"
  set +e
  FRESH_OUT=$( cd "$repo" && bash scripts/lint-plan.sh "$plan" 2>&1 )
  FRESH_CODE=$?
  set -e
}

# copy_scripts <repo> — drop lint-plan.sh, get-default-branch.sh, and the lib
# into a fixture repo so the freshness check runs against that repo's origin.
copy_scripts() {
  local repo="$1"
  mkdir -p "$repo/scripts/lib"
  cp "$HERE/lint-plan.sh" "$HERE/get-default-branch.sh" "$repo/scripts/"
  cp "$HERE/lib/plan-paths.sh" "$repo/scripts/lib/"
  printf '**Name:** t\ndefault_branch: main\n' > "$repo/CLAUDE.md"
}

# GREPO: baseline pushed to a bare origin, so origin/main resolves and carries
# src/app.js. Absent paths (src/removed.js, src/brandnew.js) are NOT on origin.
GREPO="$TMP/frepo"
setup_freshness_fixture() {
  mkdir -p "$GREPO/src" "$GREPO/.agents/plans"
  copy_scripts "$GREPO"
  printf 'export const app=1\n' > "$GREPO/src/app.js"
  git -C "$GREPO" init -q
  git -C "$GREPO" config user.email t@t.t
  git -C "$GREPO" config user.name t
  git -C "$GREPO" checkout -q -b main
  git -C "$GREPO" add -A
  git -C "$GREPO" commit -q -m baseline
  git init -q --bare "$TMP/origin.git"
  git -C "$GREPO" remote add origin "$TMP/origin.git"
  git -C "$GREPO" push -q origin main
}

# NOREPO: a git repo with NO origin remote → origin/main is unresolvable.
NOREPO="$TMP/norepo"
setup_noorigin_fixture() {
  mkdir -p "$NOREPO/src" "$NOREPO/.agents/plans"
  copy_scripts "$NOREPO"
  printf 'export const app=1\n' > "$NOREPO/src/app.js"
  git -C "$NOREPO" init -q
  git -C "$NOREPO" config user.email t@t.t
  git -C "$NOREPO" config user.name t
  git -C "$NOREPO" checkout -q -b main
  git -C "$NOREPO" add -A
  git -C "$NOREPO" commit -q -m baseline
}

# ── AC#2/AC#6: present path on base → no stale warning; absent path → warning ────
t_freshness_present_and_absent() {
  # (a) All cited paths exist on origin/main → NO stale-premise warning, exit 0.
  write_plan "$GREPO/.agents/plans/present.md" "| src/app.js | 1-2 | x |" "src/app.js:1-10"
  run_lint_in_repo "$GREPO" ".agents/plans/present.md"
  printf '%s\n' "$FRESH_OUT" | grep -q "stale premise" \
    && fail "AC#2: a plan whose paths all exist on origin wrongly emitted a stale-premise warning" || true
  printf '%s\n' "$FRESH_OUT" | grep -q "freshness not verified" \
    && fail "AC#2: resolvable base ref wrongly reported freshness-not-verified" || true
  [[ "$FRESH_CODE" -eq 0 ]] || fail "AC#2: present-path plan exited $FRESH_CODE (expected 0)"
  echo "✓ AC#2a: a plan citing only paths present on origin emits no freshness warning"

  # (b) A task File: anchor absent on origin/main → stale-premise warning naming
  # the path (line suffix stripped → AC#6), exit 0 preserved.
  write_plan "$GREPO/.agents/plans/absent.md" "| src/app.js | 1-2 | x |" "src/removed.js:120"
  run_lint_in_repo "$GREPO" ".agents/plans/absent.md"
  printf '%s\n' "$FRESH_OUT" | grep -q "stale premise: src/removed.js not found on origin/main" \
    || fail "AC#2: absent path did not emit the stale-premise advisory naming it: $FRESH_OUT"
  printf '%s\n' "$FRESH_OUT" | grep -q "stale premise: src/removed.js:120" \
    && fail "AC#6: stale-premise advisory leaked the :line suffix (existence only)" || true
  [[ "$FRESH_CODE" -eq 0 ]] || fail "AC#2: absent-path plan exited $FRESH_CODE (expected 0)"
  echo "✓ AC#2b/AC#6: absent path warns naming the path with the :line stripped, exit 0"
}

# ── AC#4: a path the plan CREATES (Files-in-Scope `new file`) is exempt ─────────
t_freshness_created_exempt() {
  # src/brandnew.js is absent on origin but declared `new file` → create-exempt,
  # so it must NOT be flagged stale. src/app.js (present) keeps the plan clean.
  write_plan "$GREPO/.agents/plans/created.md" \
    "$(printf '| src/app.js | 1-2 | x |\n| src/brandnew.js | new file | Create |')" "src/app.js:5"
  run_lint_in_repo "$GREPO" ".agents/plans/created.md"
  printf '%s\n' "$FRESH_OUT" | grep -q "stale premise: src/brandnew.js" \
    && fail "AC#4: a create-exempt (new file) path was wrongly flagged stale" || true
  printf '%s\n' "$FRESH_OUT" | grep -q "stale premise" \
    && fail "AC#4: created-exempt plan emitted an unexpected stale-premise warning: $FRESH_OUT" || true
  [[ "$FRESH_CODE" -eq 0 ]] || fail "AC#4: created-exempt plan exited $FRESH_CODE (expected 0)"
  echo "✓ AC#4: a Files-in-Scope 'new file' path is exempt from the freshness check"
}

# ── Missing-in-scope suppression (#100): one fact, one finding ─────────────────
# A Files-in-Scope path absent from disk is reported ONCE — by the existence
# check — and is subtracted from the freshness input, so the same path never also
# produces a stale-premise warning. Needs the git-backed fixture: without a
# resolvable base ref the freshness scan is skipped and the case is vacuous.
MISSING_SCOPE_ADVISORY="File in scope does not exist"
STALE_ADVISORY="stale premise"

t_missing_scope_suppression() {
  # (a) src/ghost.js is absent from disk AND from origin/main, and is NOT a create
  # target (Change is "Modify"), so pre-suppression it earned both warnings.
  write_plan "$GREPO/.agents/plans/missing-scope.md" \
    "$(printf '| src/app.js | 1-2 | x |\n| src/ghost.js | 1-5 | Modify |')" "src/app.js:1-2"
  run_lint_in_repo "$GREPO" ".agents/plans/missing-scope.md"
  printf '%s\n' "$FRESH_OUT" | grep -q "$MISSING_SCOPE_ADVISORY: src/ghost.js" \
    || fail "MIS(a): absent Files-in-Scope path lost its does-not-exist warning: $FRESH_OUT"
  printf '%s\n' "$FRESH_OUT" | grep -q "$STALE_ADVISORY" \
    && fail "MIS(a): the same absent path was double-reported as a stale premise: $FRESH_OUT" || true
  [[ "$FRESH_CODE" -eq 0 ]] || fail "MIS(a): exited $FRESH_CODE (expected 0)"
  echo "✓ MIS(a): an absent Files-in-Scope path warns once (does-not-exist), never also stale-premise"

  # (b) Parity: a plan with NO missing files is untouched by the subtraction — its
  # output is byte-identical to the pre-suppression clean-plan line.
  local expected="✓ parity.md — plan is valid (waves: 1, budget: ~2L)"
  write_plan "$GREPO/.agents/plans/parity.md" "| src/app.js | 1-2 | x |" "src/app.js:1-2"
  run_lint_in_repo "$GREPO" ".agents/plans/parity.md"
  [[ "$FRESH_OUT" == "$expected" ]] \
    || fail "MIS(b): clean-plan output drifted. expected [$expected] got [$FRESH_OUT]"
  [[ "$FRESH_CODE" -eq 0 ]] || fail "MIS(b): exited $FRESH_CODE (expected 0)"
  echo "✓ MIS(b): a plan with no missing files produces byte-identical output (parity)"
}

# ── AC#5: unresolvable base ref → ONE advisory (fail-closed), exit 0 ────────────
t_freshness_unresolvable_ref() {
  write_plan "$NOREPO/.agents/plans/noorigin.md" "| src/app.js | 1-2 | x |" "src/removed.js:9"
  run_lint_in_repo "$NOREPO" ".agents/plans/noorigin.md"
  printf '%s\n' "$FRESH_OUT" | grep -q "freshness not verified: base ref origin/main unresolvable" \
    || fail "AC#5: unresolvable base ref did not emit the freshness-not-verified advisory: $FRESH_OUT"
  # Fail-closed advisory must appear exactly once (no per-path spam).
  local n
  n=$(printf '%s\n' "$FRESH_OUT" | grep -c "freshness not verified")
  [[ "$n" -eq 1 ]] || fail "AC#5: freshness-not-verified advisory appeared $n times (expected exactly 1)"
  # With the ref unresolvable, no per-path stale-premise warnings should fire.
  printf '%s\n' "$FRESH_OUT" | grep -q "stale premise" \
    && fail "AC#5: per-path stale-premise warnings leaked despite an unresolvable ref" || true
  [[ "$FRESH_CODE" -eq 0 ]] || fail "AC#5: unresolvable-ref plan exited $FRESH_CODE (expected 0)"
  echo "✓ AC#5: unresolvable base ref → single freshness advisory, exit 0 (fail-closed)"
}

# ── Program Design section advisory ─────────────────────────────────────────────
# "Large" = WAVE_COUNT >= 3 OR at least one high-risk path in scope. A large plan
# with no ## Program Design section warns (never errors); a small plan, or a large
# plan that has the section, stays silent. Exit code is 0 in every case.
PD_ADVISORY="no ## Program Design section"

t_program_design_advisory() {
  # (a) Large via a high-risk path (1 wave), no Program Design → advisory, exit 0.
  local plan="$TMP/pd-high-risk.md"
  write_plan "$plan" "| $REAL_PATH | 1-2 | x |" "src/auth/login.js:1-20"
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$plan"
    printf '%s\n' "$LINT_OUT" | grep -q "$PD_ADVISORY" \
      || fail "PD(a): high-risk large plan without Program Design did not warn"
    [[ "$LINT_CODE" -eq 0 ]] || fail "PD(a): exited $LINT_CODE (expected 0)"
  ) || exit 1
  echo "✓ PD(a): large-via-high-risk plan missing Program Design warns, exit 0"

  # (b) Large via >=3 waves (non-high-risk paths), no Program Design → advisory.
  local plan2="$TMP/pd-three-waves.md"
  write_plan "$plan2" "| $REAL_PATH | 1-2 | x |" "$REAL_PATH:1-10" 3
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$plan2"
    printf '%s\n' "$LINT_OUT" | grep -q "$PD_ADVISORY" \
      || fail "PD(b): 3-wave large plan without Program Design did not warn"
    [[ "$LINT_CODE" -eq 0 ]] || fail "PD(b): exited $LINT_CODE (expected 0)"
  ) || exit 1
  echo "✓ PD(b): large-via-3-waves plan missing Program Design warns, exit 0"

  # (c) Small: 1 wave, non-high-risk real path, no Program Design → silent.
  local plan3="$TMP/pd-small.md"
  write_plan "$plan3" "| $REAL_PATH | 1-2 | x |" "$REAL_PATH:1-10"
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$plan3"
    printf '%s\n' "$LINT_OUT" | grep -q "$PD_ADVISORY" \
      && fail "PD(c): small plan wrongly emitted the Program Design advisory" || true
    [[ "$LINT_CODE" -eq 0 ]] || fail "PD(c): exited $LINT_CODE (expected 0)"
  ) || exit 1
  echo "✓ PD(c): small plan missing Program Design stays silent, exit 0"

  # (d) Large (3 waves) WITH a Program Design section → silent.
  local plan4="$TMP/pd-present.md"
  write_plan "$plan4" "| $REAL_PATH | 1-2 | x |" "$REAL_PATH:1-10" 3 true
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$plan4"
    printf '%s\n' "$LINT_OUT" | grep -q "$PD_ADVISORY" \
      && fail "PD(d): large plan WITH Program Design still emitted the advisory" || true
    [[ "$LINT_CODE" -eq 0 ]] || fail "PD(d): exited $LINT_CODE (expected 0)"
  ) || exit 1
  echo "✓ PD(d): large plan with Program Design present stays silent, exit 0"

  # (e) Boundary: exactly 2 waves, non-high-risk, no Program Design → silent.
  local plan5="$TMP/pd-two-waves.md"
  write_plan "$plan5" "| $REAL_PATH | 1-2 | x |" "$REAL_PATH:1-10" 2
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$plan5"
    printf '%s\n' "$LINT_OUT" | grep -q "$PD_ADVISORY" \
      && fail "PD(e): 2-wave plan wrongly emitted the Program Design advisory" || true
    [[ "$LINT_CODE" -eq 0 ]] || fail "PD(e): exited $LINT_CODE (expected 0)"
  ) || exit 1
  echo "✓ PD(e): exactly-2-waves plan missing Program Design stays silent (boundary), exit 0"
}

# ── Rename-destination advisory (#99) ──────────────────────────────────────────
# check-scope.sh builds its declared set from the File column alone, so a rename
# destination named only in the Change prose fails deliver-time scope check as
# out-of-scope drift. lint-plan.sh warns at plan time for each path-shaped token
# in a rename-shaped Change cell that has no File-column row. ADVISORY ONLY: the
# warning must never change lint-plan.sh's exit code, which stays 0.
RENAME_ADVISORY="rename destination not declared"
RENAME_SRC="src/old-name.js"
RENAME_DST="src/new-name.js"

t_rename_advisory() {
  # (a) Each rename phrasing the matcher recognizes — `git mv`, `rename`, and the
  # `→` arrow — warns and NAMES the undeclared destination, exit 0.
  local phrasing plan i=0
  for phrasing in "git mv $RENAME_SRC $RENAME_DST" \
                  "rename $RENAME_SRC to $RENAME_DST" \
                  "$RENAME_SRC → $RENAME_DST"; do
    i=$((i + 1))
    plan="$TMP/rename-$i.md"
    write_plan "$plan" "| $RENAME_SRC | 1-40 | $phrasing |" "$RENAME_SRC:1-40"
    ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$plan"
      printf '%s\n' "$LINT_OUT" | grep -q "$RENAME_ADVISORY: '$RENAME_DST'" \
        || fail "REN(a$i): '$phrasing' did not warn naming $RENAME_DST: $LINT_OUT"
      printf '%s\n' "$LINT_OUT" | grep -q "Errors (must fix before approval):" \
        && fail "REN(a$i): the rename advisory was reported as an error, not a warning: $LINT_OUT" || true
      [[ "$LINT_CODE" -eq 0 ]] \
        || fail "REN(a$i): exited $LINT_CODE (expected 0 — advisory, never an error)"
    ) || exit 1
    echo "✓ REN(a$i): rename cell '$phrasing' warns naming the undeclared destination, exit 0"
  done

  # (b) Declaring the destination as its own File-column row silences it.
  local plan_declared="$TMP/rename-declared.md"
  write_plan "$plan_declared" \
    "$(printf '| %s | 1-40 | git mv %s %s |\n| %s | new file | New — rename destination |' \
        "$RENAME_SRC" "$RENAME_SRC" "$RENAME_DST" "$RENAME_DST")" "$RENAME_SRC:1-40"
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$plan_declared"
    printf '%s\n' "$LINT_OUT" | grep -q "$RENAME_ADVISORY" \
      && fail "REN(b): a declared destination row did not silence the advisory: $LINT_OUT" || true
    [[ "$LINT_CODE" -eq 0 ]] || fail "REN(b): exited $LINT_CODE (expected 0)"
  ) || exit 1
  echo "✓ REN(b): declaring the destination as its own File row silences the advisory"

  # (c) A plan with no rename-shaped Change cell emits no new output.
  local plan_none="$TMP/rename-none.md"
  write_plan "$plan_none" "| $REAL_PATH | 1-2 | Modify the linter |" "$REAL_PATH:1-2"
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$plan_none"
    printf '%s\n' "$LINT_OUT" | grep -q "$RENAME_ADVISORY" \
      && fail "REN(c): a plan with no rename wrongly emitted the advisory: $LINT_OUT" || true
    [[ "$LINT_CODE" -eq 0 ]] || fail "REN(c): exited $LINT_CODE (expected 0)"
  ) || exit 1
  echo "✓ REN(c): plan with no rename-shaped Change cell emits no rename advisory, exit 0"

  # (d) Edge: a rename-shaped cell containing only PROSE (no path-shaped token)
  # warns about nothing — the prose is never mined for paths (plan Non-Goal).
  local plan_prose="$TMP/rename-prose.md"
  write_plan "$plan_prose" "| $REAL_PATH | 1-2 | rename the helper for clarity |" "$REAL_PATH:1-2"
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$plan_prose"
    printf '%s\n' "$LINT_OUT" | grep -q "$RENAME_ADVISORY" \
      && fail "REN(d): prose-only rename cell wrongly produced a destination warning: $LINT_OUT" || true
    [[ "$LINT_CODE" -eq 0 ]] || fail "REN(d): exited $LINT_CODE (expected 0)"
  ) || exit 1
  echo "✓ REN(d): rename cell with no path-shaped token warns about nothing, exit 0"
}

# ── #134: multi-file task File: lines — one warning per missing part ──────────
MISSING_FILE_ADVISORY="references a File: path that does not exist"
SECOND_REAL_PATH="scripts/lib/plan-paths.sh"

t_multi_file_task_line() {
  # (a) Every comma-separated path exists → no File: warning at all.
  local plan="$TMP/multi-present.md"
  write_plan "$plan" "| $REAL_PATH | 1-2 | x |" "$REAL_PATH:10-20, $SECOND_REAL_PATH"
  run_lint "$plan"
  printf '%s\n' "$LINT_OUT" | grep -q "$MISSING_FILE_ADVISORY" \
    && fail "MF(a): all-present multi-file line wrongly warned: $LINT_OUT" || true
  echo "✓ MF(a): multi-file File: line, all paths present ⇒ no does-not-exist advisory"

  # (b) Second path missing → exactly one warning, naming that path and the task.
  local plan_b="$TMP/multi-second-missing.md" n
  write_plan "$plan_b" "| $REAL_PATH | 1-2 | x |" "$REAL_PATH:10-20, src/second-missing-xyz.js"
  run_lint "$plan_b"
  n=$(printf '%s\n' "$LINT_OUT" | grep -c "$MISSING_FILE_ADVISORY" || true)
  [[ "$n" -eq 1 ]] || fail "MF(b): expected exactly 1 File: warning, got $n: $LINT_OUT"
  printf '%s\n' "$LINT_OUT" | grep -q "Task 'Task 1.1: do the thing' $MISSING_FILE_ADVISORY: src/second-missing-xyz.js" \
    || fail "MF(b): warning did not name the task and the missing second path: $LINT_OUT"
  [[ "$LINT_CODE" -eq 0 ]] || fail "MF(b): exited $LINT_CODE (expected 0 — advisory only)"
  echo "✓ MF(b): second path missing ⇒ exactly one warning naming task + src/second-missing-xyz.js"

  # (c) Range continuation `path:16-33, 80-96` → the ranges are never paths.
  local plan_c="$TMP/multi-range-continuation.md"
  write_plan "$plan_c" "| $REAL_PATH | 1-2 | x |" "$REAL_PATH:16-33, 80-96"
  run_lint "$plan_c"
  printf '%s\n' "$LINT_OUT" | grep -q "$MISSING_FILE_ADVISORY" \
    && fail "MF(c): range continuation '80-96' was treated as a missing path: $LINT_OUT" || true
  echo "✓ MF(c): '$REAL_PATH:16-33, 80-96' range continuation ⇒ no does-not-exist advisory"
}

# ── #134: context budget — bare number counts as 1 line; ranges unchanged ─────
BUDGET_ADVISORY="Context budget is large"

t_budget_bare_number() {
  # (a) A bare Lines value 900 is one line reference, not 900 lines.
  local plan="$TMP/budget-bare.md"
  write_plan "$plan" "| $REAL_PATH | 900 | x |" "$REAL_PATH:900"
  run_lint "$plan"
  printf '%s\n' "$LINT_OUT" | grep -q "$BUDGET_ADVISORY" \
    && fail "BUD(a): bare Lines '900' was counted as 900 lines: $LINT_OUT" || true
  echo "✓ BUD(a): bare Lines '900' ⇒ no budget warning"

  # (a2) It counts as exactly 1 — not 0: a 1-800 range (800, at the threshold)
  # plus a bare 900 totals 801 and tips over the warn line.
  local plan_a2="$TMP/budget-bare-plus-range.md"
  write_plan "$plan_a2" "$(printf '| %s | 1-800 | x |\n| %s | 900 | x |' "$REAL_PATH" "$SECOND_REAL_PATH")" "$REAL_PATH:1-800"
  run_lint "$plan_a2"
  printf '%s\n' "$LINT_OUT" | grep -q "$BUDGET_ADVISORY: ~801 lines" \
    || fail "BUD(a2): range 1-800 + bare 900 should total ~801 lines: $LINT_OUT"
  echo "✓ BUD(a2): range 1-800 + bare '900' ⇒ ~801 lines (bare number adds exactly 1)"

  # (b) A range 1-900 is still counted in full (900 > 800 warn threshold).
  local plan_b="$TMP/budget-range.md"
  write_plan "$plan_b" "| $REAL_PATH | 1-900 | x |" "$REAL_PATH:1-900"
  run_lint "$plan_b"
  printf '%s\n' "$LINT_OUT" | grep -q "$BUDGET_ADVISORY: ~900 lines" \
    || fail "BUD(b): range '1-900' should still warn at ~900 lines: $LINT_OUT"
  echo "✓ BUD(b): range '1-900' still counted ⇒ ~900-line budget warning"
}

# ── AC#4: approval blockers section + waiver warnings ────────────────────────
BLOCKER_HEADING="Approval blockers (resolve or waive before /rad-approve):"
RISKY_PATH="src/auth/login.js"
RISKY_ID="high-risk:$RISKY_PATH"
# Clean, existing, non-self-protected, non-high-risk path for the no-output case.
CLEAN_PATH="docs/rad-cli.md"

# assert_no_blockers <label> — the blocker heading and ⛔ prefix are both absent.
assert_no_blockers() {
  printf '%s\n' "$LINT_OUT" | grep -qF "$BLOCKER_HEADING" \
    && fail "$1: unexpected blocker section: $LINT_OUT" || true
  printf '%s\n' "$LINT_OUT" | grep -q "⛔" \
    && fail "$1: unexpected ⛔ line: $LINT_OUT" || true
}

t_blocker_markers() {
  # (a) A live marker → blocker names its line and question; exit stays 0.
  local plan="$TMP/blk-marker.md" line
  write_plan "$plan" "| $REAL_PATH | 1-2 | x |" "$REAL_PATH:1-2" 1 false \
    "Open: [NEEDS CLARIFICATION: which cache?]"
  line=$(grep -n "NEEDS CLARIFICATION" "$plan" | cut -d: -f1)
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$plan"
    printf '%s\n' "$LINT_OUT" | grep -qF "$BLOCKER_HEADING" \
      || fail "BLK(a): marker did not produce the blocker section: $LINT_OUT"
    printf '%s\n' "$LINT_OUT" | grep -qF "  ⛔ clarification marker at line $line: which cache?" \
      || fail "BLK(a): blocker did not name line $line and the question: $LINT_OUT"
    [[ "$LINT_CODE" -eq 0 ]] || fail "BLK(a): blockers changed the exit code to $LINT_CODE"
  ) || exit 1
  echo "✓ BLK(a): unresolved marker ⇒ blocker section names line + question, exit 0"

  # (b) A marker inside a ``` fence is code → no blocker.
  local fenced="$TMP/blk-fenced.md"
  write_plan "$fenced" "| $REAL_PATH | 1-2 | x |" "$REAL_PATH:1-2" 1 false \
    "$(printf '```\n[NEEDS CLARIFICATION: example only]\n```')"
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$fenced"; assert_no_blockers "BLK(b)" ) || exit 1
  echo "✓ BLK(b): fenced marker ⇒ no blocker section"

  # (c) A marker inside an inline code span is code → no blocker.
  local span="$TMP/blk-span.md"
  write_plan "$span" "| $REAL_PATH | 1-2 | x |" "$REAL_PATH:1-2" 1 false \
    'Syntax: `[NEEDS CLARIFICATION: q]` marks a question.'
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$span"; assert_no_blockers "BLK(c)" ) || exit 1
  echo "✓ BLK(c): inline-span marker ⇒ no blocker section"
}

t_blocker_high_risk() {
  # (a) Un-waived high-risk path → blocker names the id; warning carries the id.
  local plan="$TMP/blk-hr.md"
  write_plan "$plan" "| $REAL_PATH | 1-2 | x |" "$RISKY_PATH:1-20"
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$plan"
    printf '%s\n' "$LINT_OUT" | grep -qF "  ⛔ $RISKY_ID — waive under ## Waivers or remove the path" \
      || fail "BLK-HR(a): un-waived high-risk path not listed as a blocker: $LINT_OUT"
    printf '%s\n' "$LINT_OUT" | grep -qF "flag for close architect review: $RISKY_PATH (id: $RISKY_ID)" \
      || fail "BLK-HR(a): high-risk warning does not carry the id: $LINT_OUT"
    [[ "$LINT_CODE" -eq 0 ]] || fail "BLK-HR(a): exited $LINT_CODE (expected 0)"
  ) || exit 1
  echo "✓ BLK-HR(a): un-waived high-risk path ⇒ blocker names $RISKY_ID; warning carries the id"

  # (b) Waived → no blocker section, warning (with id) still shown, no waiver warning.
  local waived="$TMP/blk-hr-waived.md"
  write_plan "$waived" "| $REAL_PATH | 1-2 | x |" "$RISKY_PATH:1-20" 1 false \
    "$(printf '\n## Waivers\n- %s: reviewed by the architect' "$RISKY_ID")"
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$waived"; assert_no_blockers "BLK-HR(b)"
    printf '%s\n' "$LINT_OUT" | grep -qF "$RISKY_PATH (id: $RISKY_ID)" \
      || fail "BLK-HR(b): waived path lost its high-risk warning: $LINT_OUT"
    printf '%s\n' "$LINT_OUT" | grep -q "waiver" \
      && fail "BLK-HR(b): a valid waiver drew a waiver warning: $LINT_OUT" || true
  ) || exit 1
  echo "✓ BLK-HR(b): waived high-risk path ⇒ no blocker section; warning still shows the id"
}

t_waiver_warnings() {
  # One plan, three bad waivers: stale id, empty justification, clarify id.
  local plan="$TMP/blk-waivers.md"
  write_plan "$plan" "| $REAL_PATH | 1-2 | x |" "$REAL_PATH:1-2" 1 false \
    "$(printf '\n## Waivers\n- high-risk:src/gone/token.js: path was removed\n- high-risk:src/auth/x.js:\n- clarify-3: we decided already')"
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$plan"
    printf '%s\n' "$LINT_OUT" | grep -qF "⚠ stale waiver: 'high-risk:src/gone/token.js' matches no current finding" \
      || fail "WV(a): stale waiver not warned: $LINT_OUT"
    printf '%s\n' "$LINT_OUT" | grep -qF "⚠ waiver 'high-risk:src/auth/x.js' has an empty justification" \
      || fail "WV(b): empty-justification waiver not warned: $LINT_OUT"
    printf '%s\n' "$LINT_OUT" | grep -qF "⚠ waiver 'clarify-3' names a clarification marker — markers can't be waived — answer the question and delete the marker" \
      || fail "WV(c): clarify-naming waiver not warned: $LINT_OUT"
    printf '%s\n' "$LINT_OUT" | grep -q "stale waiver: 'clarify-3'" \
      && fail "WV(c): clarify waiver was ALSO reported stale: $LINT_OUT" || true
    [[ "$LINT_CODE" -eq 0 ]] || fail "WV: waiver warnings changed the exit code to $LINT_CODE"
  ) || exit 1
  echo "✓ WV: stale, empty-justification and clarify-naming waivers each get a ⚠ warning, exit 0"
}

t_fenced_waiver_ignored() {
  # (a) A fenced example ## Waivers block → no stale-waiver warning (it is not a
  # waiver at all), and it does not waive the real high-risk finding.
  local plan="$TMP/blk-fenced-waiver.md"
  write_plan "$plan" "| $REAL_PATH | 1-2 | x |" "$RISKY_PATH:1-20" 1 false \
    "$(printf '\n```markdown\n## Waivers\n- high-risk:scripts/token-budget.sh: example\n- %s: example\n```' "$RISKY_ID")"
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$plan"
    printf '%s\n' "$LINT_OUT" | grep -q "stale waiver" \
      && fail "FW(a): fenced example drew a stale-waiver warning: $LINT_OUT" || true
    printf '%s\n' "$LINT_OUT" | grep -qF "  ⛔ $RISKY_ID — waive under ## Waivers or remove the path" \
      || fail "FW(a): fenced example waived the real finding: $LINT_OUT"
  ) || exit 1
  echo "✓ FW(a): fenced example ## Waivers ⇒ no stale-waiver warning, blocker stands"

  # (b) A fenced empty-justification bullet inside the real section is not reported.
  local empty="$TMP/blk-fenced-empty.md"
  write_plan "$empty" "| $REAL_PATH | 1-2 | x |" "$RISKY_PATH:1-20" 1 false \
    "$(printf '\n## Waivers\n- %s: reviewed\n```\n- high-risk:src/auth/y.js:\n```' "$RISKY_ID")"
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$empty"
    printf '%s\n' "$LINT_OUT" | grep -q "empty justification" \
      && fail "FW(b): fenced bullet drew an empty-justification warning: $LINT_OUT" || true
    assert_no_blockers "FW(b)"
  ) || exit 1
  echo "✓ FW(b): fenced empty-justification bullet ⇒ no warning; real waiver still applies"
}

t_blocker_no_new_output() {
  # No markers, no high-risk paths, no ## Waivers → no blocker section, no
  # waiver lines; a fully clean plan still prints the one-line success message.
  # Runs in the hermetic GREPO fixture (local bare origin) so origin/main always
  # resolves: in the real checkout an unresolvable base ref (e.g. a CI runner)
  # adds a freshness warning, which correctly suppresses the success line.
  local plan="$GREPO/.agents/plans/blk-none.md"
  write_plan "$plan" "| src/app.js | 1-2 | x |" "src/app.js:1-2"
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint_in_repo "$GREPO" ".agents/plans/blk-none.md"
    printf '%s\n' "$FRESH_OUT" | grep -qF "$BLOCKER_HEADING" \
      && fail "NONE: clean plan printed the blocker section: $FRESH_OUT" || true
    printf '%s\n' "$FRESH_OUT" | grep -qE "waiver|\(id: " \
      && fail "NONE: unexpected waiver/id output: $FRESH_OUT" || true
    printf '%s\n' "$FRESH_OUT" | grep -qF "✓ blk-none.md — plan is valid" \
      || fail "NONE: clean plan lost its success line: $FRESH_OUT"
    [[ "$FRESH_CODE" -eq 0 ]] || fail "NONE: exited $FRESH_CODE (expected 0)"
  ) || exit 1
  echo "✓ NONE: plan with no markers/high-risk/waivers ⇒ no new output, success line intact"

  # A marker alone must NOT yield the "plan is valid" line.
  local marked="$TMP/blk-only-marker.md"
  write_plan "$marked" "| $CLEAN_PATH | 1-2 | x |" "$CLEAN_PATH:1-2" 1 false \
    "[NEEDS CLARIFICATION: ok?]"
  ( unset RAD_HIGH_RISK_PATTERNS; run_lint "$marked"
    printf '%s\n' "$LINT_OUT" | grep -q "plan is valid" \
      && fail "NONE(b): blocked plan claimed to be valid: $LINT_OUT" || true
    printf '%s\n' "$LINT_OUT" | grep -qF "$BLOCKER_HEADING" \
      || fail "NONE(b): blocker-only plan did not print the blocker section: $LINT_OUT"
    [[ "$LINT_CODE" -eq 0 ]] || fail "NONE(b): exited $LINT_CODE (expected 0)"
  ) || exit 1
  echo "✓ NONE(b): blocker-only plan prints the blocker section, not the success line, exit 0"
}

# ── Stack-order wave advisory ──────────────────────────────────────────────────
# write_wave_plan <out> <wave1-File> [<wave2-File> ...] — a write_plan fixture with
# one wave per argument, each wave's task carrying that argument as its File:
# value. The advisory reasons about path strings only, so paths need not exist.
write_wave_plan() {
  local out="$1"; shift
  local files
  # `|`-joined, not newline-joined: BSD awk rejects a newline in a -v value.
  files=$(IFS='|'; printf '%s' "$*")
  # A scope row is required: an empty Files-in-Scope table aborts lint (pre-existing).
  write_plan "$out" "| $REAL_PATH | 1-2 | x |" "" "$#"
  awk -v files="$files" '
    BEGIN { n = split(files, f, "|") }
    { print }
    /^#### Task [0-9]+\.1:/ { w++; if (w <= n) print "File: " f[w] }
  ' "$out" > "$out.tmp" && mv "$out.tmp" "$out"
}

STACK_ORDER_LINE="waves look stack-ordered"

# assert_stack_order <label> <plan> <expected-summary|""> — "" asserts silence.
assert_stack_order() {
  local label="$1" plan="$2" expected="$3"
  run_lint "$plan"
  if [[ -n "$expected" ]]; then
    printf '%s\n' "$LINT_OUT" | grep -qF "⚠ $STACK_ORDER_LINE ($expected) — prefer vertical slices that each land a testable end-to-end increment; dismiss if this is a refactor" \
      || fail "$label: expected stack-order advisory ($expected): $LINT_OUT"
    [[ $(printf '%s\n' "$LINT_OUT" | grep -cF "$STACK_ORDER_LINE") -eq 1 ]] \
      || fail "$label: stack-order advisory not emitted exactly once: $LINT_OUT"
  else
    printf '%s\n' "$LINT_OUT" | grep -qF "$STACK_ORDER_LINE" \
      && fail "$label: unexpected stack-order advisory: $LINT_OUT" || true
  fi
  [[ "$LINT_CODE" -eq 0 ]] || fail "$label: exited $LINT_CODE (expected 0)"
}

t_stack_order_advisory() {
  local p="$TMP/so"
  write_wave_plan "$p-layered.md" "db/schema.sql" "src/services/user.js" "src/components/User.tsx"
  assert_stack_order "SO(a) layered" "$p-layered.md" "Wave 1: schema, Wave 2: service, Wave 3: ui"
  echo "✓ SO(a): schema/service/ui across 3 waves ⇒ one advisory naming all three, exit 0"

  write_wave_plan "$p-mixed.md" "db/schema.sql, src/services/user.js" "src/components/User.tsx"
  assert_stack_order "SO(b) mixed" "$p-mixed.md" ""
  echo "✓ SO(b): a wave mixing layers ⇒ no advisory, exit 0"

  write_wave_plan "$p-single.md" "db/schema.sql"
  assert_stack_order "SO(c) single" "$p-single.md" ""
  echo "✓ SO(c): single wave ⇒ no advisory, exit 0"

  write_wave_plan "$p-unknown.md" "db/schema.sql" "src/services/user.js" "lib/thing.js"
  assert_stack_order "SO(d) unknown" "$p-unknown.md" ""
  echo "✓ SO(d): any unknown path ⇒ no advisory, exit 0"

  write_wave_plan "$p-same.md" "db/schema.sql" "db/seed.sql"
  assert_stack_order "SO(e) same layer" "$p-same.md" ""
  echo "✓ SO(e): repeated same layer ⇒ no advisory, exit 0"

  write_wave_plan "$p-withtest.md" "db/schema.sql, tests/schema.test.js" "src/components/User.tsx"
  assert_stack_order "SO(f) test alongside" "$p-withtest.md" "Wave 1: schema, Wave 2: ui"
  echo "✓ SO(f): a test file beside schema files still reads as schema ⇒ advisory fires, exit 0"

  write_wave_plan "$p-testonly.md" "tests/a.test.js" "src/components/User.tsx"
  assert_stack_order "SO(g) test-only wave" "$p-testonly.md" ""
  echo "✓ SO(g): a wave with only test paths ⇒ no advisory, exit 0"
}

# ── Missing-mockup advisory ────────────────────────────────────────────────────
# Runs in GREPO so the mockup path resolves from a controlled repo root.
t_missing_mockup_advisory() {
  mkdir -p "$GREPO/.agents/mockups"
  printf '<html></html>\n' > "$GREPO/.agents/mockups/present.html"
  local base="$GREPO/.agents/plans"
  write_plan "$base/mk-missing.md" "| src/app.js | 1-2 | x |" "src/app.js:1-2" 1 false \
    'Mockup: `.agents/mockups/absent.html`'
  ( run_lint_in_repo "$GREPO" ".agents/plans/mk-missing.md"
    printf '%s\n' "$FRESH_OUT" | grep -qF "⚠ mockup referenced but missing: .agents/mockups/absent.html" \
      || fail "MK(a): missing mockup not warned: $FRESH_OUT"
    [[ "$FRESH_CODE" -eq 0 ]] || fail "MK(a): exited $FRESH_CODE (expected 0)"
  ) || exit 1
  echo "✓ MK(a): referenced-but-missing mockup ⇒ advisory, exit 0"

  write_plan "$base/mk-present.md" "| src/app.js | 1-2 | x |" "src/app.js:1-2" 1 false \
    'Mockup: `.agents/mockups/present.html`'
  ( run_lint_in_repo "$GREPO" ".agents/plans/mk-present.md"
    printf '%s\n' "$FRESH_OUT" | grep -qF "mockup referenced but missing" \
      && fail "MK(b): present mockup warned: $FRESH_OUT" || true
    [[ "$FRESH_CODE" -eq 0 ]] || fail "MK(b): exited $FRESH_CODE (expected 0)"
  ) || exit 1
  echo "✓ MK(b): present mockup ⇒ no advisory, exit 0"

  write_plan "$base/mk-fenced.md" "| src/app.js | 1-2 | x |" "src/app.js:1-2" 1 false \
    "$(printf '```\n.agents/mockups/absent.html\n```')"
  ( run_lint_in_repo "$GREPO" ".agents/plans/mk-fenced.md"
    printf '%s\n' "$FRESH_OUT" | grep -qF "mockup referenced but missing" \
      && fail "MK(c): fenced mockup ref warned: $FRESH_OUT" || true
    [[ "$FRESH_CODE" -eq 0 ]] || fail "MK(c): exited $FRESH_CODE (expected 0)"
  ) || exit 1
  echo "✓ MK(c): fenced mockup ref ⇒ no advisory, exit 0"
}

t_missing_task_file
t_multi_file_task_line
t_budget_bare_number
t_high_risk_advisory
t_exit_zero_invariance
t_self_protected_advisory
t_program_design_advisory
t_rename_advisory
setup_freshness_fixture
setup_noorigin_fixture
t_freshness_present_and_absent
t_freshness_created_exempt
t_missing_scope_suppression
t_freshness_unresolvable_ref
t_blocker_markers
t_blocker_high_risk
t_waiver_warnings
t_fenced_waiver_ignored
t_blocker_no_new_output
t_stack_order_advisory
t_missing_mockup_advisory
echo "ALL PASS"
