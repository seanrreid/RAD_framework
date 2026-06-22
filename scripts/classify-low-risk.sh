#!/usr/bin/env bash
# classify-low-risk.sh
# Deterministic, fail-closed severity router. Given a RAD plan file, computes
# whether the plan's declared scope is auto-clearable as LOW risk — so a caller
# can route around human approval only when no judgment is needed.
#
# Verdict is LOW iff ALL of the following hold:
#   1. RAD_LOW_RISK_PATTERNS is non-empty.
#   2. Every touched path matches RAD_LOW_RISK_PATTERNS.
#   3. NO touched path matches RAD_HIGH_RISK_PATTERNS (high-risk wins ties).
#   4. The declared scope is unchanged vs the working git diff — i.e. every
#      changed file lies within the declared scope (no out-of-scope drift).
# Anything else — empty/unset allowlist, any non-matching path, any high-risk
# match, any scope drift, any ambiguity — yields NOT-LOW. Fail closed.
#
# The touched-path set is the union of the plan's Files-in-Scope and per-task
# `File:` paths, computed by the SAME helper lint-plan.sh uses (one source of
# truth: lib/plan-paths.sh).
#
# Usage: scripts/classify-low-risk.sh <plan-file> [work-branch] [base-branch]
#   work-branch  defaults to the current branch.
#   base-branch  defaults to the project default branch.
#
# Exit codes:
#   0 = low      (auto-clearable)
#   1 = not-low  (needs human judgment)
#   2 = usage error
#
# bash 3.2 (macOS stock) compatible.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/plan-paths.sh
. "$SCRIPT_DIR/lib/plan-paths.sh"

PLAN_FILE="${1:-}"
WORK_BRANCH="${2:-}"
BASE_BRANCH="${3:-$("$SCRIPT_DIR/get-default-branch.sh" 2>/dev/null || echo main)}"

[[ -z "$PLAN_FILE" ]]   && { echo "ERROR: plan file required"; exit 2; }
[[ ! -f "$PLAN_FILE" ]] && { echo "ERROR: plan file not found: $PLAN_FILE"; exit 2; }

# Default tight allowlist: inert-by-type only. Stylesheets, image/font assets,
# and docs. Tests, config, lockfiles, and CI are DELIBERATELY excluded.
RAD_LOW_RISK_PATTERNS="${RAD_LOW_RISK_PATTERNS:-}"
RAD_HIGH_RISK_PATTERNS="${RAD_HIGH_RISK_PATTERNS:-auth|payment|billing|migration|secret|credential|token}"

# ── Emit a not-low verdict and exit ───────────────────────────────────────────
not_low() {
  echo "verdict: not-low"
  echo "reason: $1"
  echo "low-risk patterns: ${RAD_LOW_RISK_PATTERNS:-<unset>}"
  echo "high-risk patterns: ${RAD_HIGH_RISK_PATTERNS:-<unset>}"
  exit 1
}

# ── Rule 1: allowlist must be set (fail closed when OFF) ───────────────────────
[[ -z "$RAD_LOW_RISK_PATTERNS" ]] && not_low "RAD_LOW_RISK_PATTERNS unset/empty — severity routing OFF"

# ── Declared scope set (the touched-path universe) ────────────────────────────
SCOPE_PATHS=$(plan_scope_paths "$PLAN_FILE")
[[ -z "$SCOPE_PATHS" ]] && not_low "plan declares no paths in scope"

# ── Rules 2 & 3: every path low, no path high (high wins ties) ────────────────
NON_LOW=""
HIGH=""
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  if path_matches "$path" "$RAD_HIGH_RISK_PATTERNS"; then
    HIGH="${HIGH}${path} "
  fi
  if ! path_matches "$path" "$RAD_LOW_RISK_PATTERNS"; then
    NON_LOW="${NON_LOW}${path} "
  fi
done <<< "$SCOPE_PATHS"

# High-risk wins ties: report it first.
[[ -n "$HIGH" ]]    && not_low "high-risk path(s) in scope: ${HIGH% }"
[[ -n "$NON_LOW" ]] && not_low "path(s) outside the low-risk allowlist: ${NON_LOW% }"

# ── Rule 4: declared scope unchanged vs the working git diff ──────────────────
# Every file actually changed on the work branch must lie within the declared
# scope. Any out-of-scope change = scope drift = not-low. An undetectable diff
# is ambiguous → fail closed.
CHANGED_FILES=$(
  if [[ -n "$WORK_BRANCH" ]]; then
    git diff --name-only "origin/$BASE_BRANCH"..."$WORK_BRANCH" 2>/dev/null \
      || git diff --name-only "$BASE_BRANCH"..."$WORK_BRANCH" 2>/dev/null \
      || git diff --name-only "$BASE_BRANCH"..."$WORK_BRANCH" 2>/dev/null
  else
    git diff --name-only "origin/$BASE_BRANCH"...HEAD 2>/dev/null \
      || git diff --name-only "$BASE_BRANCH"...HEAD 2>/dev/null \
      || git diff --name-only "$BASE_BRANCH"...HEAD 2>/dev/null
  fi
) || not_low "could not compute git diff vs $BASE_BRANCH — ambiguous, failing closed"

# An empty changed-file set is ambiguous (wrong base, no commits on the branch).
# A diff that resolves to nothing must NOT auto-clear — fail closed.
[[ -z "${CHANGED_FILES//[[:space:]]/}" ]] && not_low "no changed files detected vs base — ambiguous, failing closed"

while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  declared=false
  while IFS= read -r declared_path; do
    [[ -z "$declared_path" ]] && continue
    if [[ "$file" == "$declared_path" || "$file" == "$declared_path/"* ]]; then
      declared=true
      break
    fi
  done <<< "$SCOPE_PATHS"
  $declared || not_low "scope drift — changed file outside declared scope: $file"
done <<< "$CHANGED_FILES"

# ── All four rules satisfied ──────────────────────────────────────────────────
echo "verdict: low"
echo "reason: all touched paths match the low-risk allowlist, none high-risk, scope unchanged"
echo "low-risk patterns: $RAD_LOW_RISK_PATTERNS"
echo "high-risk patterns: $RAD_HIGH_RISK_PATTERNS"
exit 0
