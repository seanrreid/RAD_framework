#!/usr/bin/env bash
# lint-claude-md.sh
# ADVISORY line-budget lint for CLAUDE.md (#87). CLAUDE.md is injected into
# every session, so it should stay lean; the full config reference lives in
# docs/configuration.md. Over budget WARNS and still exits 0 — it never blocks.
#
# Usage: scripts/lint-claude-md.sh [path]
#   default path: CLAUDE.md, resolved relative to the current directory
#
# Exit codes:
#   0 = checked (within budget: ✓ line; over budget: ⚠ line)
#   2 = the file is missing, not a regular file, or unreadable (reason on stderr)

set -euo pipefail

readonly CLAUDE_MD_LINE_BUDGET=150
readonly DEFAULT_PATH="CLAUDE.md"
readonly UNREADABLE_EXIT=2

TARGET="${1:-$DEFAULT_PATH}"

if [ ! -e "$TARGET" ]; then
  echo "lint-claude-md: $TARGET not found" >&2
  exit "$UNREADABLE_EXIT"
fi
if [ ! -f "$TARGET" ] || [ ! -r "$TARGET" ]; then
  echo "lint-claude-md: $TARGET is not a readable regular file" >&2
  exit "$UNREADABLE_EXIT"
fi

# awk NR counts a final line that lacks a trailing newline (wc -l would not).
if ! LINES="$(awk 'END { print NR }' "$TARGET")"; then
  echo "lint-claude-md: failed to count lines in $TARGET" >&2
  exit "$UNREADABLE_EXIT"
fi

if [ "$LINES" -gt "$CLAUDE_MD_LINE_BUDGET" ]; then
  echo "⚠ CLAUDE.md is $LINES lines (budget $CLAUDE_MD_LINE_BUDGET)"
else
  echo "✓ CLAUDE.md: $LINES lines (budget $CLAUDE_MD_LINE_BUDGET)"
fi
exit 0
