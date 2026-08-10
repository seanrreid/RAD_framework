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
write_plan() {
  local out="$1" scope_rows="$2" task_file="$3"
  local wave_count="${4:-1}" program_design="${5:-false}"
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
    printf '%s\n' "$LINT_OUT" | grep -q "self-protected path (RAD machinery — never auto-clearable): harness/gates.js" \
      || fail "AC#2: default env did not emit the self-protected advisory"
    [[ "$LINT_CODE" -eq 0 ]] || fail "AC#2: self-protected plan exited $LINT_CODE (expected 0)"
  ) || exit 1
  echo "✓ AC#2d: self-protected path emits the advisory under the default env"

  # (b) A high-risk override that matches nothing → advisory still fires.
  ( export RAD_HIGH_RISK_PATTERNS="zzz-nomatch"; run_lint "$plan"
    printf '%s\n' "$LINT_OUT" | grep -q "self-protected path (RAD machinery — never auto-clearable): harness/gates.js" \
      || fail "AC#2: no-match RAD_HIGH_RISK_PATTERNS suppressed the self-protected advisory"
    [[ "$LINT_CODE" -eq 0 ]] || fail "AC#2: self-protected plan exited $LINT_CODE (expected 0)"
  ) || exit 1
  echo "✓ AC#2e: self-protected advisory fires with a no-match RAD_HIGH_RISK_PATTERNS override"

  # (c) An emptied high-risk set → advisory still fires (not gated on the env).
  ( export RAD_HIGH_RISK_PATTERNS=""; run_lint "$plan"
    printf '%s\n' "$LINT_OUT" | grep -q "self-protected path (RAD machinery — never auto-clearable): harness/gates.js" \
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
# real repo with an origin remote (mirrors test-classify-low-risk.sh's fixture).
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

t_missing_task_file
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
echo "ALL PASS"
