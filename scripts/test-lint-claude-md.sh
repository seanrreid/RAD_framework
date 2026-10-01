#!/usr/bin/env bash
# test-lint-claude-md.sh
# Regression tests for lint-claude-md.sh: under budget, over budget (advisory:
# still exit 0), the exact boundary (150 ✓, 151 ⚠), an empty file (0 lines ✓),
# a final line without a trailing newline, the default path (CLAUDE.md in cwd),
# and a missing file (exit 2, reason on stderr).
# Self-contained: builds fixtures in a temp dir and runs the REAL script.
# Runs under bash 3.2+.
#
# Usage: scripts/test-lint-claude-md.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

readonly BUDGET=150

fail() { echo "✗ $1"; exit 1; }

# make_lines <file> <n> — write exactly n newline-terminated lines.
make_lines() {
  local file="$1" n="$2" i=0
  : > "$file"
  while [ "$i" -lt "$n" ]; do
    echo "line $i" >> "$file"
    i=$((i + 1))
  done
}

# run_lint <path-or-empty> — runs the REAL lint from $TMP; echoes the exit code.
run_lint() {
  local code
  set +e
  if [ -z "$1" ]; then
    (cd "$TMP" && bash "$HERE/lint-claude-md.sh") > "$TMP/out" 2> "$TMP/err"
  else
    bash "$HERE/lint-claude-md.sh" "$1" > "$TMP/out" 2> "$TMP/err"
  fi
  code=$?
  set -e
  echo "$code"
}

# expect <label> <path> <code> <stdout-line>
expect() {
  local label="$1" path="$2" want_code="$3" want_out="$4" code
  code="$(run_lint "$path")"
  [ "$code" = "$want_code" ] || fail "$label: expected exit $want_code, got $code ($(cat "$TMP/err"))"
  [ "$(cat "$TMP/out")" = "$want_out" ] || fail "$label: expected '$want_out', got '$(cat "$TMP/out")'"
  echo "✓ $label"
}

make_lines "$TMP/under.md" 10
expect "under budget" "$TMP/under.md" 0 "✓ CLAUDE.md: 10 lines (budget $BUDGET)"

make_lines "$TMP/over.md" 400
expect "over budget warns, still exit 0" "$TMP/over.md" 0 "⚠ CLAUDE.md is 400 lines (budget $BUDGET)"

make_lines "$TMP/exact.md" "$BUDGET"
expect "exactly $BUDGET is within budget" "$TMP/exact.md" 0 "✓ CLAUDE.md: $BUDGET lines (budget $BUDGET)"

make_lines "$TMP/one-over.md" $((BUDGET + 1))
expect "$((BUDGET + 1)) warns" "$TMP/one-over.md" 0 "⚠ CLAUDE.md is $((BUDGET + 1)) lines (budget $BUDGET)"

: > "$TMP/empty.md"
expect "empty file is 0 lines" "$TMP/empty.md" 0 "✓ CLAUDE.md: 0 lines (budget $BUDGET)"

printf 'a\nb\nc' > "$TMP/no-newline.md"
expect "final line without newline is counted" "$TMP/no-newline.md" 0 "✓ CLAUDE.md: 3 lines (budget $BUDGET)"

make_lines "$TMP/CLAUDE.md" 5
expect "default path is CLAUDE.md in cwd" "" 0 "✓ CLAUDE.md: 5 lines (budget $BUDGET)"

code="$(run_lint "$TMP/does-not-exist.md")"
[ "$code" = "2" ] || fail "missing file: expected exit 2, got $code"
[ -s "$TMP/err" ] || fail "missing file: expected a reason on stderr"
[ ! -s "$TMP/out" ] || fail "missing file: expected no stdout, got '$(cat "$TMP/out")'"
echo "✓ missing file exits 2 with a reason"

code="$(run_lint "$TMP")"
[ "$code" = "2" ] || fail "directory: expected exit 2, got $code"
echo "✓ a directory is not a readable file (exit 2)"

echo "All lint-claude-md tests passed."
