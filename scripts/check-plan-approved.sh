#!/usr/bin/env bash
# check-plan-approved.sh
# Checks whether a plan has been approved for execution (Lane B model).
#
# Under Lane B the plan doc lives on its own work branch (rad/<feature>) until the
# deliver PR merges, so the branch tip is the canonical source of truth. We read
# it first, then fall back to the default branch (merged) and the local working
# tree (current checkout). Approval is set by /rad-approve, which writes
# `Status: approved` to the plan file on the work-branch tip.
#
# Platform-agnostic: uses only `git show` — no gh/glab/PR-merge dependency (the
# dedicated plan PR no longer exists under Lane B).
#
# Usage: scripts/check-plan-approved.sh rad/<feature> [base-branch]
#   e.g. scripts/check-plan-approved.sh rad/email-confirmation develop
#
# Exit codes:
#   0 = approved
#   1 = not approved (pending, rejected, needs-revision, or unknown)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WORK_BRANCH="${1:-}"
BASE_BRANCH="${2:-$("$SCRIPT_DIR/get-default-branch.sh" 2>/dev/null || echo main)}"

[[ -z "$WORK_BRANCH" ]] && { echo "ERROR: work branch name required (e.g. rad/<feature>)"; exit 1; }

# Strip any prefix (rad/, plan/, deliver/) to get the feature slug → plan file path.
FEATURE="${WORK_BRANCH##*/}"
PLAN_FILE=".agents/plans/${FEATURE}.md"

# Reads file content from stdin; prints the first Status: value as a lowercased token.
read_status() {
  grep -E '^Status:' | head -1 | awk '{print $2}' | tr '[:upper:]' '[:lower:]'
}

resolve_status() {
  local status

  # 1. Canonical: the plan's own work-branch tip on origin.
  status=$(git show "origin/${WORK_BRANCH}:${PLAN_FILE}" 2>/dev/null | read_status || true)
  [[ -n "$status" ]] && { echo "$status"; return 0; }

  # 2. Merged: the plan doc has landed on the default branch.
  status=$(git show "origin/${BASE_BRANCH}:${PLAN_FILE}" 2>/dev/null | read_status || true)
  [[ -n "$status" ]] && { echo "$status"; return 0; }

  # 3. Local working tree (approved but not yet pushed).
  if [[ -f "$PLAN_FILE" ]]; then
    status=$(read_status < "$PLAN_FILE" || true)
    [[ -n "$status" ]] && { echo "$status"; return 0; }
  fi

  echo ""
}

STATUS=$(resolve_status)

case "$STATUS" in
  approved)
    echo "approved"
    exit 0
    ;;
  rejected)
    echo "rejected — plan was rejected by the architect. Revise and resubmit."
    exit 1
    ;;
  needs-revision)
    echo "needs-revision — architect requested changes. Check the plan file for feedback."
    exit 1
    ;;
  pending-review)
    echo "pending — plan exists but is not yet approved. Architect runs /rad-approve ${FEATURE}."
    exit 1
    ;;
  "")
    echo "unknown — no plan found for '${WORK_BRANCH}' (looked on origin/${WORK_BRANCH}, origin/${BASE_BRANCH}, and ${PLAN_FILE})."
    exit 1
    ;;
  *)
    echo "unknown status: ${STATUS}"
    exit 1
    ;;
esac
