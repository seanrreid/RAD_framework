#!/usr/bin/env bash
# test-detect-deliver-pr.sh
# Tests for scripts/detect-deliver-pr.sh: exit 0 (slug on stdout) / 1 (ambiguous,
# both slugs on stderr) / 2 (bad input, missing plans dir — fail closed) / 3
# (ordinary branch, empty stdout). Builds plan fixtures in a temp dir and runs
# the real script against them. Runs under bash 3.2+ (set -euo pipefail safe).
#
# Usage: scripts/test-detect-deliver-pr.sh   (exit 0 + "ALL PASS")

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/detect-deliver-pr.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }
pass() { echo "✓ $1"; }

OUT="$TMP/out.txt"
ERR="$TMP/err.txt"
PLANS="$TMP/plans"
DUPS="$TMP/dups"

# run_detect <args...> — capture stdout/stderr to $OUT/$ERR; sets RC.
run_detect() {
  if bash "$SCRIPT" "$@" >"$OUT" 2>"$ERR"; then RC=0; else RC=$?; fi
}

# expect <name> <rc> — assert the last run's exit code (stderr shown on mismatch).
expect() {
  [[ "$RC" -eq "$2" ]] || fail "$1: expected exit $2, got $RC (stderr: $(cat "$ERR"))"
}

expect_stdout() {
  [[ "$(cat "$OUT")" == "$2" ]] || fail "$1: expected stdout [$2], got [$(cat "$OUT")]"
}

expect_empty_stdout() {
  [[ ! -s "$OUT" ]] || fail "$1: stdout must be empty, got: [$(cat "$OUT")]"
}

expect_stderr_has() {
  grep -qF -- "$2" "$ERR" || fail "$1: stderr missing [$2]: $(cat "$ERR")"
}

# write_plan <file> <branch-header-line>
write_plan() {
  printf '# Plan: fixture\nStatus: approved\n%s\n\n## Tasks\nBranch: decoy/ignored\n' "$2" > "$1"
}

mkdir -p "$PLANS" "$DUPS"
write_plan "$PLANS/a.md" "Branch: rad/a"
write_plan "$PLANS/b.md" "Branch:   feature/b  "
printf "# Plan: no branch header\nTier: light\n" > "$PLANS/nobranch.md"
write_plan "$PLANS/README.md" "Branch: docs/readme"
write_plan "$DUPS/one.md" "Branch: rad/same"
write_plan "$DUPS/two.md" "Branch: rad/same"

# ── Detection (exit 0) ───────────────────────────────────────────────────────
run_detect rad/a "$PLANS"
expect "default prefix" 0; expect_stdout "default prefix" "a"; pass "rad/a → a"

run_detect feature/b "$PLANS"
expect "custom prefix" 0; expect_stdout "custom prefix" "b"; pass "feature/b → b (trimmed)"

# ── Ordinary branch (exit 3) ─────────────────────────────────────────────────
run_detect feature/unrelated "$PLANS"
expect "ordinary" 3; expect_empty_stdout "ordinary"; pass "ordinary branch → 3, empty stdout"

run_detect decoy/ignored "$PLANS"
expect "first Branch only" 3; expect_empty_stdout "first Branch only"
pass "only the first Branch: line counts"

run_detect docs/readme "$PLANS"
expect "README ignored" 3; expect_empty_stdout "README ignored"; pass "README.md ignored"

# ── Ambiguous (exit 1) ───────────────────────────────────────────────────────
run_detect rad/same "$DUPS"
expect "ambiguous" 1; expect_empty_stdout "ambiguous"
expect_stderr_has "ambiguous" "one"; expect_stderr_has "ambiguous" "two"
pass "two plans with the same Branch → 1 naming both"

# ── Bad input / fail closed (exit 2) ─────────────────────────────────────────
for bad in "-x" "a..b" "" "/abs" "a b"; do
  run_detect "$bad" "$PLANS"
  expect "bad ref [$bad]" 2; expect_empty_stdout "bad ref [$bad]"
done
pass "bad refs (-x, a..b, empty, /abs, space) → 2"

run_detect
expect "no args" 2; expect_stderr_has "no args" "usage"; pass "missing arg → 2 with usage"

run_detect rad/a "$PLANS" extra
expect "too many args" 2; pass "extra arg → 2"

run_detect rad/a "-plans"
expect "flag-like plans dir" 2; pass "plans dir with leading '-' → 2"

run_detect rad/a "$TMP/missing"
expect "missing plans dir" 2; expect_stderr_has "missing plans dir" "not found"
pass "missing plans dir → 2"

# ── Default plans dir (relative to cwd) ──────────────────────────────────────
mkdir -p "$TMP/repo/.agents/plans"
write_plan "$TMP/repo/.agents/plans/c.md" "Branch: team/c"
if (cd "$TMP/repo" && bash "$SCRIPT" team/c >"$OUT" 2>"$ERR"); then RC=0; else RC=$?; fi
expect "default dir" 0; expect_stdout "default dir" "c"; pass "default .agents/plans from cwd"

echo "ALL PASS"
