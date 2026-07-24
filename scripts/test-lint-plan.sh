#!/usr/bin/env bash
# test-lint-plan.sh
# Dedicated regression tests for lint-plan.sh's advisory (warning) behavior:
#   - missing task `File:` path advisory
#   - high-risk path advisory + RAD_HIGH_RISK_PATTERNS override
#   - self-protected path advisory (unconditional, never env-gated)
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
write_plan() {
  local out="$1" scope_rows="$2" task_file="$3"
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

## Wave Plan
### Wave 1 — sequential
#### Task 1.1: do the thing
EOF
    [[ -n "$task_file" ]] && printf 'File: %s\n' "$task_file"
    cat <<'EOF'
Validate: AC#1 — x

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

t_missing_task_file
t_high_risk_advisory
t_exit_zero_invariance
t_self_protected_advisory
echo "ALL PASS"
