#!/usr/bin/env bash
# fetch-epic.sh
# Fetch an epic issue and its child issues from GitHub, emitting JSON for
# downstream decomposition (e.g. /rad-decompose).
#
# Usage: scripts/fetch-epic.sh <issue-number-or-url>
#   <issue-number-or-url> — e.g. 42, #42, or
#     https://github.com/org/repo/issues/42
#
# Children are gathered from three sources and deduped by number (the epic
# itself is excluded):
#   1. Native sub-issues (GitHub sub-issues API)
#   2. Issue numbers referenced in the epic body (#NN)
#   3. Other issues sharing the epic's milestone
#
# GitHub-only for v1. On any non-github platform the script exits non-zero with
# a clear message rather than half-implementing another platform's path.
#
# Output (stdout, on success): a single JSON object:
#   { "epic": { ... }, "children": [ { ... }, ... ] }
#
# Requires: gh (authenticated) and jq. detect-platform.sh decides the platform;
# set RAD_PLATFORM to override the platform gate (used by tests).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARG="${1:-}"
if [[ -z "$ARG" ]]; then
  echo "ERROR: an issue number or URL is required." >&2
  echo "Usage: scripts/fetch-epic.sh <issue-number-or-url>" >&2
  exit 1
fi

# --- Input normalization: accept a number, #NN, or a GitHub issue URL ---------
# Extract the trailing issue number from a URL, strip a leading '#', then
# validate that what remains is a bare positive integer. This is untrusted
# input, so we reject anything that is not purely digits before it reaches gh.
EPIC_NUMBER="$ARG"
if [[ "$EPIC_NUMBER" == *"/issues/"* ]]; then
  # .../issues/42  or  .../issues/42#issuecomment-... → 42
  EPIC_NUMBER="${EPIC_NUMBER##*/issues/}"
  EPIC_NUMBER="${EPIC_NUMBER%%[!0-9]*}"
fi
EPIC_NUMBER="${EPIC_NUMBER#\#}"

if ! [[ "$EPIC_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "ERROR: could not extract an issue number from '$ARG'." >&2
  echo "Expected a number (42), #42, or a GitHub issue URL." >&2
  exit 1
fi

# --- Platform gate: GitHub-only for v1 ---------------------------------------
PLATFORM="${RAD_PLATFORM:-$("$SCRIPT_DIR/detect-platform.sh" --quiet)}"

if [[ "$PLATFORM" != "github" ]]; then
  echo "ERROR: fetch-epic.sh is GitHub-only in this version." >&2
  echo "       Detected platform: ${PLATFORM}." >&2
  echo "       Epic decomposition for other platforms is not yet supported." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: gh CLI not found. Install from https://cli.github.com/" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq not found. Install jq to assemble epic JSON." >&2
  exit 1
fi

# --- Fetch the epic -----------------------------------------------------------
EPIC_JSON=$(gh issue view "$EPIC_NUMBER" \
  --json number,title,body,url,milestone,labels,state)

REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')

# Body and milestone come from the epic we already fetched — no re-fetch.
EPIC_BODY=$(printf '%s' "$EPIC_JSON" | jq -r '.body // ""')
EPIC_MILESTONE=$(printf '%s' "$EPIC_JSON" | jq -r '.milestone.title // ""')

# --- Gather child issue numbers from three sources ----------------------------
# Each source emits bare numbers, one per line; we concatenate, drop the epic,
# dedupe, and sort numerically.
collect_children() {
  # 1. Native sub-issues (REST API; tolerate repos/installs without the feature).
  gh api "repos/${REPO}/issues/${EPIC_NUMBER}/sub_issues" \
    --jq '.[].number' 2>/dev/null || true

  # 2. Issue references in the epic body: #NN tokens.
  printf '%s\n' "$EPIC_BODY" | grep -oE '#[0-9]+' | tr -d '#' || true

  # 3. Issues sharing the epic's milestone (open + closed).
  if [[ -n "$EPIC_MILESTONE" ]]; then
    gh issue list --milestone "$EPIC_MILESTONE" --state all --limit 200 \
      --json number --jq '.[].number' 2>/dev/null || true
  fi
}

CHILD_NUMBERS=$(collect_children \
  | grep -E '^[0-9]+$' \
  | grep -vx "$EPIC_NUMBER" \
  | sort -nu || true)

# --- Fetch each child and assemble the JSON output ----------------------------
# Fetch each child with the same shape as the epic, then slurp into an array.
CHILDREN_JSON="[]"
if [[ -n "$CHILD_NUMBERS" ]]; then
  CHILDREN_JSON=$(
    {
      while IFS= read -r n; do
        [[ -z "$n" ]] && continue
        gh issue view "$n" \
          --json number,title,body,url,milestone,labels,state 2>/dev/null || true
      done <<< "$CHILD_NUMBERS"
    } | jq -s '.'
  )
fi

jq -n \
  --argjson epic "$EPIC_JSON" \
  --argjson children "$CHILDREN_JSON" \
  '{ epic: $epic, children: $children }'
