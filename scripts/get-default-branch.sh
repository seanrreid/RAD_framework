#!/usr/bin/env bash
# get-default-branch.sh
# Prints the project's default branch as declared in CLAUDE.md.
#
# Reads the `default_branch:` field from the RAD Configuration → Git Platform
# block. Falls back to `main` if the field is absent or empty. This is the one
# place every RAD command/script resolves the default branch — no command should
# hardcode `main`.
#
# Usage: scripts/get-default-branch.sh [claude-md-path]
#
# Output: the branch name on stdout (always exits 0).

set -euo pipefail

CLAUDE_MD="${1:-CLAUDE.md}"
FALLBACK="main"

if [[ ! -f "$CLAUDE_MD" ]]; then
  echo "$FALLBACK"
  exit 0
fi

# Match `default_branch: <name>` (inside the platform code block), tolerating
# leading whitespace and an optional trailing comment.
branch=$(grep -E '^[[:space:]]*default_branch:' "$CLAUDE_MD" 2>/dev/null \
  | head -1 \
  | sed -E 's/^[[:space:]]*default_branch:[[:space:]]*//; s/[[:space:]]*#.*$//; s/[[:space:]]*$//' \
  || true)

if [[ -z "$branch" ]]; then
  echo "$FALLBACK"
else
  echo "$branch"
fi
