#!/usr/bin/env bash
# check-plan-approved.sh
# Checks whether a plan is approved for execution.
#
# Primary check: plan file on main has Status: approved (set by /rad-approve).
# Fallback check: plan branch merged to base (legacy PR-merge gate).
#
# Usage: scripts/check-plan-approved.sh plan/feature-name [base-branch]
#
# Exit codes:
#   0 = approved
#   1 = not approved (pending, rejected, or needs-revision)
#   2 = cannot determine

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PLAN_BRANCH="${1:-}"
BASE_BRANCH="${2:-main}"

[[ -z "$PLAN_BRANCH" ]] && { echo "ERROR: plan branch name required"; exit 1; }

FEATURE=$(basename "$PLAN_BRANCH")
PLAN_FILE=".agents/plans/$FEATURE.md"

# ── Primary check: Status field in plan file on base branch ──────────────────

check_file_status() {
  local status

  # Try reading from the base branch first, then working tree
  status=$(git show "origin/$BASE_BRANCH:$PLAN_FILE" 2>/dev/null \
    | grep "^Status:" | head -1 | awk '{print $2}' || true)

  if [[ -z "$status" ]]; then
    status=$(grep "^Status:" "$PLAN_FILE" 2>/dev/null | head -1 | awk '{print $2}' || true)
  fi

  case "$status" in
    approved)
      echo "approved"
      exit 0
      ;;
    rejected)
      echo "rejected — plan was rejected by architect. Revise and resubmit."
      exit 1
      ;;
    needs-revision)
      echo "needs-revision — architect requested changes. Check plan file for feedback."
      exit 1
      ;;
    pending-review|"")
      # Fall through to legacy branch-merge check
      return 1
      ;;
    *)
      echo "unknown status: $status"
      exit 2
      ;;
  esac
}

# ── Fallback check: branch merged to base (legacy PR-merge gate) ──────────────

check_local() {
  git fetch origin "$BASE_BRANCH" 2>/dev/null || true

  if git branch -r --merged "origin/$BASE_BRANCH" 2>/dev/null | grep -q "origin/$PLAN_BRANCH"; then
    echo "approved (branch merged)"
    exit 0
  fi

  if git ls-remote --heads origin "$PLAN_BRANCH" | grep -q "$PLAN_BRANCH"; then
    echo "pending — plan branch exists but is not yet approved"
    exit 1
  fi

  if git show "origin/$BASE_BRANCH:$PLAN_FILE" &>/dev/null; then
    echo "approved (branch deleted after merge)"
    exit 0
  fi

  echo "unknown"
  exit 2
}

check_github() {
  if ! command -v gh &>/dev/null; then
    check_local
    return
  fi

  local state
  state=$(gh pr list \
    --head "$PLAN_BRANCH" \
    --base "$BASE_BRANCH" \
    --state all \
    --json state \
    --jq '.[0].state // "NOTFOUND"' \
    2>/dev/null || echo "NOTFOUND")

  case "$state" in
    MERGED)
      echo "approved (PR merged)"
      exit 0
      ;;
    OPEN|DRAFT)
      echo "pending — PR is open but not yet approved"
      echo "PR: $(gh pr list --head "$PLAN_BRANCH" --json url --jq '.[0].url' 2>/dev/null || echo 'unknown')"
      exit 1
      ;;
    CLOSED)
      echo "closed — PR was closed without merging. Plan needs to be re-submitted."
      exit 1
      ;;
    NOTFOUND)
      check_local
      ;;
  esac
}

check_gitlab() {
  if ! command -v glab &>/dev/null; then
    check_local
    return
  fi

  local state
  state=$(glab mr list \
    --source-branch "$PLAN_BRANCH" \
    --target-branch "$BASE_BRANCH" \
    --state all \
    --output json \
    2>/dev/null | python3 -c "import sys,json; mrs=json.load(sys.stdin); print(mrs[0]['state'] if mrs else 'NOTFOUND')" \
    2>/dev/null || echo "NOTFOUND")

  case "$state" in
    merged)
      echo "approved (MR merged)"
      exit 0
      ;;
    opened|locked)
      echo "pending — MR is open but not yet approved"
      exit 1
      ;;
    closed)
      echo "closed — MR was closed without merging. Plan needs to be re-submitted."
      exit 1
      ;;
    NOTFOUND|*)
      check_local
      ;;
  esac
}

# ── Main ──────────────────────────────────────────────────────────────────────

PLATFORM=$("$SCRIPT_DIR/detect-platform.sh" --quiet)

# Always try file-status check first — it works regardless of platform
check_file_status || true

# Fall back to branch-merge check
case "$PLATFORM" in
  github)  check_github ;;
  gitlab)  check_gitlab ;;
  *)       check_local  ;;
esac
