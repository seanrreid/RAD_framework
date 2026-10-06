#!/usr/bin/env bash
# lint-claude-md.sh
# ADVISORY line-budget lint for the conventions files (#87, #171): AGENTS.md
# (project conventions, read natively by Codex) and CLAUDE.md (imports it with
# @AGENTS.md). Both are injected into every session, so they should stay lean;
# the full config reference lives in docs/configuration.md. Over budget WARNS
# and still exits 0 — it never blocks. AGENTS.md also warns above Codex's
# default project_doc_max_bytes (32 KiB), past which Codex truncates it.
#
# Usage: scripts/lint-claude-md.sh [path]
#   no path: checks AGENTS.md and CLAUDE.md in the current directory, one line
#            per file present; a missing AGENTS.md is fine (CLAUDE.md fallback)
#   path:    checks that one file
#   A file named AGENTS.md is labelled AGENTS.md and gets the byte check; any
#   other path is labelled CLAUDE.md (the historical single-file output).
#
# Exit codes:
#   0 = checked (within budget: ✓ line; over budget: ⚠ line)
#   2 = the named file is missing, not a regular file, or unreadable; or, with
#       no path, neither AGENTS.md nor CLAUDE.md exists (reason on stderr)

set -euo pipefail

readonly CLAUDE_MD_LINE_BUDGET=150
readonly AGENTS_MD_BYTE_CAP=32768
readonly AGENTS_NAME="AGENTS.md"
readonly CLAUDE_NAME="CLAUDE.md"
readonly UNREADABLE_EXIT=2

# label_for <path> — the name printed on the result line.
label_for() {
  if [ "$(basename "$1")" = "$AGENTS_NAME" ]; then echo "$AGENTS_NAME"; else echo "$CLAUDE_NAME"; fi
}

# require_readable <path> — exit 2 with a reason unless path is a readable file.
require_readable() {
  if [ ! -e "$1" ]; then
    echo "lint-claude-md: $1 not found" >&2
    exit "$UNREADABLE_EXIT"
  fi
  if [ ! -f "$1" ] || [ ! -r "$1" ]; then
    echo "lint-claude-md: $1 is not a readable regular file" >&2
    exit "$UNREADABLE_EXIT"
  fi
}

# check_bytes <path> <label> — warn when AGENTS.md exceeds the Codex byte cap.
check_bytes() {
  local bytes
  if ! bytes="$(wc -c < "$1")"; then
    echo "lint-claude-md: failed to count bytes in $1" >&2
    exit "$UNREADABLE_EXIT"
  fi
  bytes="$(echo "$bytes" | tr -d '[:space:]')"
  if [ "$bytes" -gt "$AGENTS_MD_BYTE_CAP" ]; then
    echo "⚠ $2 is $bytes bytes (Codex cap $AGENTS_MD_BYTE_CAP; the rest is truncated)"
  fi
}

# check_file <path> — line budget for any file, plus the byte cap for AGENTS.md.
check_file() {
  local target="$1" label lines
  require_readable "$target"
  label="$(label_for "$target")"
  # awk NR counts a final line that lacks a trailing newline (wc -l would not).
  if ! lines="$(awk 'END { print NR }' "$target")"; then
    echo "lint-claude-md: failed to count lines in $target" >&2
    exit "$UNREADABLE_EXIT"
  fi
  if [ "$lines" -gt "$CLAUDE_MD_LINE_BUDGET" ]; then
    echo "⚠ $label is $lines lines (budget $CLAUDE_MD_LINE_BUDGET)"
  else
    echo "✓ $label: $lines lines (budget $CLAUDE_MD_LINE_BUDGET)"
  fi
  if [ "$label" = "$AGENTS_NAME" ]; then check_bytes "$target" "$label"; fi
}

# check_default_pair — no-argument mode: every conventions file present in cwd.
check_default_pair() {
  local found=0 name
  for name in "$AGENTS_NAME" "$CLAUDE_NAME"; do
    if [ -e "$name" ]; then
      check_file "$name"
      found=1
    fi
  done
  if [ "$found" -eq 0 ]; then
    echo "lint-claude-md: neither $AGENTS_NAME nor $CLAUDE_NAME found" >&2
    exit "$UNREADABLE_EXIT"
  fi
}

if [ -n "${1:-}" ]; then
  check_file "$1"
else
  check_default_pair
fi
exit 0
