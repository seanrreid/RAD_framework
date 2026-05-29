#!/usr/bin/env bash
# open-pr.sh
# Opens a PR/MR on the detected git platform.
# Usage: scripts/open-pr.sh --title "Deliver: feature-name" --body "..." --head rad/feature-name --no-draft --label "rad:deliver"
#
# --base defaults to the project default branch (scripts/get-default-branch.sh).
# Outputs the PR URL on success, or prints manual instructions if CLI unavailable.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Parse args
TITLE=""
BODY=""
BASE="$("$SCRIPT_DIR/get-default-branch.sh" 2>/dev/null || echo main)"
HEAD=""
DRAFT="--draft"
# Indexed array (bash 3.2 safe) — never a space-joined string, so no leading
# blank element leaks into the GitHub args or the GitLab comma-join.
LABELS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)   TITLE="$2";  shift 2 ;;
    --body)    BODY="$2";   shift 2 ;;
    --base)    BASE="$2";   shift 2 ;;
    --head)    HEAD="$2";   shift 2 ;;
    --no-draft) DRAFT="";   shift ;;
    --label)
      # Trim surrounding whitespace; skip empty values so no blank --label is built.
      label_val="${2#"${2%%[![:space:]]*}"}"; label_val="${label_val%"${label_val##*[![:space:]]}"}"
      [[ -n "$label_val" ]] && LABELS+=("$label_val")
      shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

[[ -z "$TITLE" ]] && { echo "ERROR: --title is required"; exit 1; }
[[ -z "$HEAD" ]]  && { echo "ERROR: --head is required";  exit 1; }

PLATFORM=$("$SCRIPT_DIR/detect-platform.sh" --quiet)
REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")

open_github() {
  local label_flags=""
  for label in $LABELS; do
    label_flags="$label_flags --label $label"
  done

  local url
  url=$(gh pr create \
    --title "$TITLE" \
    --body "$BODY" \
    --base "$BASE" \
    --head "$HEAD" \
    $DRAFT \
    $label_flags \
    2>&1)

  echo "$url"
}

open_gitlab() {
  local mr_flags="--squash-before-merge"
  [[ -n "$DRAFT" ]] && mr_flags="$mr_flags --draft"

  local label_list
  label_list=$(echo "$LABELS" | tr ' ' ',')

  local url
  url=$(glab mr create \
    --title "$TITLE" \
    --description "$BODY" \
    --target-branch "$BASE" \
    --source-branch "$HEAD" \
    --label "$label_list" \
    $mr_flags \
    2>&1)

  echo "$url"
}

open_forgejo() {
  if command -v tea &>/dev/null; then
    tea pr create \
      --title "$TITLE" \
      --description "$BODY" \
      --base "$BASE" \
      --head "$HEAD" \
      2>&1
  else
    open_manual
  fi
}

open_manual() {
  # Extract base URL for helpful link
  local base_url=""
  if [[ "$REMOTE_URL" =~ ^https://([^/]+)/(.+)\.git$ ]]; then
    base_url="https://${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  elif [[ "$REMOTE_URL" =~ ^git@([^:]+):(.+)\.git$ ]]; then
    base_url="https://${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  fi

  echo ""
  echo "┌─────────────────────────────────────────────────────┐"
  echo "│  Manual PR Creation Required                        │"
  echo "└─────────────────────────────────────────────────────┘"
  echo ""
  echo "Branch pushed: $HEAD"
  echo "Target:        $BASE"
  echo ""
  echo "Title: $TITLE"
  echo ""
  echo "Body:"
  echo "$BODY"
  echo ""
  if [[ -n "$base_url" ]]; then
    echo "Open a PR/MR at: $base_url"
  fi
  echo ""
  echo "After creating the PR, paste the URL here so it can be"
  echo "recorded in the plan file."
}

# Push branch first
git push --set-upstream origin "$HEAD" 2>/dev/null || git push origin "$HEAD"

# Open PR
case "$PLATFORM" in
  github)
    if command -v gh &>/dev/null; then
      open_github
    else
      echo "WARNING: gh not found, falling back to manual mode."
      open_manual
    fi
    ;;
  gitlab)
    if command -v glab &>/dev/null; then
      open_gitlab
    else
      echo "WARNING: glab not found, falling back to manual mode."
      open_manual
    fi
    ;;
  forgejo)
    open_forgejo
    ;;
  bitbucket|manual|*)
    open_manual
    ;;
esac
