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
      _lv="${2#"${2%%[![:space:]]*}"}"; _lv="${_lv%"${_lv##*[![:space:]]}"}"
      [[ -n "$_lv" ]] && LABELS+=("$_lv")
      unset _lv
      shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

[[ -z "$TITLE" ]] && { echo "ERROR: --title is required"; exit 1; }
[[ -z "$HEAD" ]]  && { echo "ERROR: --head is required";  exit 1; }

PLATFORM=$("$SCRIPT_DIR/detect-platform.sh" --quiet)
REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")

open_github() {
  # Build flag arrays so each label is its own quoted --label arg and an empty
  # draft flag contributes no argument (no unquoted string expansion).
  # The count-guarded loop and ${arr[@]+"${arr[@]}"} expansion keep empty arrays
  # from tripping `set -u` on bash 3.2 (macOS stock).
  local label_args=() draft_args=()
  local label
  if [[ ${#LABELS[@]} -gt 0 ]]; then
    for label in "${LABELS[@]}"; do
      label_args+=(--label "$label")
    done
  fi
  [[ -n "$DRAFT" ]] && draft_args=("$DRAFT")

  local url
  url=$(gh pr create \
    --title "$TITLE" \
    --body "$BODY" \
    --base "$BASE" \
    --head "$HEAD" \
    ${draft_args[@]+"${draft_args[@]}"} \
    ${label_args[@]+"${label_args[@]}"} \
    2>&1)

  echo "$url"
}

open_gitlab() {
  # Fixed flags as an array (no unquoted string expansion).
  local mr_flags=(--squash-before-merge)
  [[ -n "$DRAFT" ]] && mr_flags+=(--draft)

  # Comma-join the label array with no leading/trailing comma, and only pass
  # --label when there is at least one label. Count-guarded for bash-3.2 set -u.
  local label_args=()
  if [[ ${#LABELS[@]} -gt 0 ]]; then
    local label_list old_ifs="$IFS"
    IFS=','; label_list="${LABELS[*]}"; IFS="$old_ifs"
    label_args=(--label "$label_list")
  fi

  local url
  url=$(glab mr create \
    --title "$TITLE" \
    --description "$BODY" \
    --target-branch "$BASE" \
    --source-branch "$HEAD" \
    ${label_args[@]+"${label_args[@]}"} \
    "${mr_flags[@]}" \
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
