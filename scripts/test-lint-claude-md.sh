#!/usr/bin/env bash
# test-lint-claude-md.sh
# Regression tests for lint-claude-md.sh: under budget, over budget (advisory:
# still exit 0), the exact boundary (150 ✓, 151 ⚠), an empty file (0 lines ✓),
# a final line without a trailing newline, the default path (CLAUDE.md in cwd),
# and a missing file (exit 2, reason on stderr). Two-file mode (#171): both
# AGENTS.md and CLAUDE.md, only one of them, neither (exit 2), and the AGENTS.md
# 32 KiB Codex cap (32768 bytes silent, 32769 warns; a path arg gets it too).
# Self-contained: builds fixtures in a temp dir and runs the REAL script.
# Runs under bash 3.2+.
#
# Usage: scripts/test-lint-claude-md.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

readonly BUDGET=150
readonly BYTE_CAP=32768

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

# make_bytes <file> <n> — write exactly n bytes (single-line files, no newline).
make_bytes() {
  head -c "$2" /dev/zero | tr '\0' 'x' > "$1"
}

# run_lint <path-or-empty> [cwd] — runs the REAL lint (no-arg mode from cwd,
# default $TMP); echoes the exit code.
run_lint() {
  local code dir="${2:-$TMP}"
  set +e
  if [ -z "$1" ]; then
    (cd "$dir" && bash "$HERE/lint-claude-md.sh") > "$TMP/out" 2> "$TMP/err"
  else
    bash "$HERE/lint-claude-md.sh" "$1" > "$TMP/out" 2> "$TMP/err"
  fi
  code=$?
  set -e
  echo "$code"
}

# expect <label> <path> <code> <stdout> [cwd]
expect() {
  local label="$1" path="$2" want_code="$3" want_out="$4" code
  code="$(run_lint "$path" "${5:-}")"
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

# --- two-file mode (#171) -------------------------------------------------

# pair_dir <name> — a fresh empty directory for one no-argument case.
pair_dir() {
  mkdir "$TMP/$1"
  echo "$TMP/$1"
}

d="$(pair_dir both)"
make_lines "$d/AGENTS.md" 120
make_lines "$d/CLAUDE.md" 20
expect "no arg: both files, one line each" "" 0 "✓ AGENTS.md: 120 lines (budget $BUDGET)
✓ CLAUDE.md: 20 lines (budget $BUDGET)" "$d"

d="$(pair_dir claude-only)"
make_lines "$d/CLAUDE.md" 7
expect "no arg: CLAUDE.md only (missing AGENTS.md is fine)" "" 0 "✓ CLAUDE.md: 7 lines (budget $BUDGET)" "$d"

d="$(pair_dir agents-only)"
make_lines "$d/AGENTS.md" 200
expect "no arg: AGENTS.md only, over budget warns" "" 0 "⚠ AGENTS.md is 200 lines (budget $BUDGET)" "$d"

d="$(pair_dir neither)"
code="$(run_lint "" "$d")"
[ "$code" = "2" ] || fail "neither file: expected exit 2, got $code"
[ -s "$TMP/err" ] || fail "neither file: expected a reason on stderr"
[ ! -s "$TMP/out" ] || fail "neither file: expected no stdout, got '$(cat "$TMP/out")'"
echo "✓ no arg: neither file exits 2 with a reason"

d="$(pair_dir at-cap)"
make_bytes "$d/AGENTS.md" "$BYTE_CAP"
expect "AGENTS.md at exactly $BYTE_CAP bytes: no byte warning" "" 0 "✓ AGENTS.md: 1 lines (budget $BUDGET)" "$d"

d="$(pair_dir over-cap)"
make_bytes "$d/AGENTS.md" $((BYTE_CAP + 1))
make_lines "$d/CLAUDE.md" 3
expect "AGENTS.md at $((BYTE_CAP + 1)) bytes warns" "" 0 "✓ AGENTS.md: 1 lines (budget $BUDGET)
⚠ AGENTS.md is $((BYTE_CAP + 1)) bytes (Codex cap $BYTE_CAP; the rest is truncated)
✓ CLAUDE.md: 3 lines (budget $BUDGET)" "$d"

expect "path arg named AGENTS.md gets the byte check" "$d/AGENTS.md" 0 "✓ AGENTS.md: 1 lines (budget $BUDGET)
⚠ AGENTS.md is $((BYTE_CAP + 1)) bytes (Codex cap $BYTE_CAP; the rest is truncated)"

make_bytes "$TMP/big-other.md" $((BYTE_CAP + 1))
expect "path arg not named AGENTS.md: no byte check" "$TMP/big-other.md" 0 "✓ CLAUDE.md: 1 lines (budget $BUDGET)"

echo "All lint-claude-md tests passed."
