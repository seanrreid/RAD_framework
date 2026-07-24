#!/usr/bin/env bash
# classify-low-risk.sh
# Deterministic, fail-closed severity router. Given a RAD plan file, computes
# whether the plan's declared scope is auto-clearable as LOW risk — so a caller
# can route around human approval only when no judgment is needed.
#
# Verdict is LOW iff ALL of the following hold:
#   0. NO touched path is self-protected RAD machinery (the literal set in
#      lib/plan-paths.sh — never operator-tunable, checked before any
#      operator-pattern rule).
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

# ── Rule 0: self-protected paths (RAD machinery) are never auto-clearable ─────
# Runs regardless of RAD_LOW_RISK_PATTERNS / RAD_HIGH_RISK_PATTERNS (including
# empty) — the self-protected set is a literal in lib/plan-paths.sh, not routed
# through any env var, so no operator pattern can loosen it. First match wins,
# and it is reported BEFORE any high-risk tie so the verdict names the
# strongest rule.
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  if path_is_self_protected "$path"; then
    not_low "self-protected path (RAD machinery): $path"
  fi
done <<< "$SCOPE_PATHS"

# ── Rule 0.5: stale premise — declared paths must exist on the base ref ────────
# Over the union of cited `path:line` anchors, per-task File: paths, and
# Files-in-Scope entries — MINUS the paths this plan creates (create-exempt) — a
# path absent on origin/$BASE_BRANCH means the plan is anchored to removed/renamed
# code and is never auto-clearable. Existence only (no line-number check). Queries
# the locally-known ref — NO implicit fetch. Fail-closed: an unresolvable base ref
# is ambiguous → not-low. Runs before the low/high pattern rules so the verdict
# names the strongest reason (self-protected still wins, above).
FRESHNESS_PATHS=$(
  {
    plan_cited_anchors "$PLAN_FILE"
    plan_task_files "$PLAN_FILE"
    plan_files_in_scope "$PLAN_FILE"
  } | grep -v '^$' | sort -u | grep -Fxv -f <(plan_created_paths "$PLAN_FILE")
) || true
FRESHNESS_REF="origin/$BASE_BRANCH"
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  freshness_rc=0
  path_exists_on_ref "$path" "$FRESHNESS_REF" || freshness_rc=$?
  case "$freshness_rc" in
    1) not_low "stale premise: $path absent on $FRESHNESS_REF" ;;
    2) not_low "stale premise: base ref $FRESHNESS_REF unresolvable (fail-closed)" ;;
  esac
done <<< "$FRESHNESS_PATHS"

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
