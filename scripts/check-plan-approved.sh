#!/usr/bin/env bash
# check-plan-approved.sh
# Checks whether a plan branch has been merged to the default branch.
# Usage: scripts/check-plan-approved.sh plan/feature-name [base-branch]
#
# Exit codes:
#   0 = approved (branch merged)
#   1 = not approved (branch not merged or PR open)
#   2 = cannot determine (platform unavailable, falls back to local check)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PLAN_BRANCH="${1:-}"
BASE_BRANCH="${2:-main}"

[[ -z "$PLAN_BRANCH" ]] && { echo "ERROR: plan branch name required"; exit 1; }

PLATFORM=$("$SCRIPT_DIR/detect-platform.sh" --quiet)

check_local() {
  # Fallback: check if branch exists locally and is merged into base
  git fetch origin "$BASE_BRANCH" 2>/dev/null || true

  if git branch -r --merged "origin/$BASE_BRANCH" 2>/dev/null | grep -q "origin/$PLAN_BRANCH"; then
    echo "approved"
    exit 0
  fi

  # Branch still exists remotely = not merged
  if git ls-remote --heads origin "$PLAN_BRANCH" | grep -q "$PLAN_BRANCH"; then
    echo "pending"
    exit 1
  fi

  # Branch gone and not in merged list — assume merged (deleted after merge)
  # Check if the plan file exists on base branch as confirmation
  if git show "origin/$BASE_BRANCH:.agents/plans/$(basename "$PLAN_BRANCH").md" &>/dev/null; then
    echo "approved"
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
      echo "approved"
      exit 0
      ;;
    OPEN|DRAFT)
      echo "pending — PR is open but not yet merged"
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
      echo "approved"
      exit 0
      ;;
    opened|locked)
      echo "pending — MR is open but not yet merged"
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

case "$PLATFORM" in
  github)  check_github ;;
  gitlab)  check_gitlab ;;
  *)       check_local  ;;
esac
