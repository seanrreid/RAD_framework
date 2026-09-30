#!/usr/bin/env bash
# test-check-plan-convergence.sh
# Tests for scripts/check-plan-convergence.sh in a hermetic temp git repo (the
# script, lib/ and get-default-branch.sh are copied in): converged / drift
# listed / out-of-scope ignored / not-delivered / missing plan / bad feature /
# unknown flag / bad base. Runs under bash 3.2+ (set -euo pipefail safe).
#
# Usage: scripts/test-check-plan-convergence.sh   (exit 0 + "ALL PASS")

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"
OUT="$TMP/out.txt"
ERR="$TMP/err.txt"
FEATURE="demo-feature"
PLAN=".agents/plans/$FEATURE.md"

fail() { echo "✗ $1"; exit 1; }
pass() { echo "✓ $1"; }

# g <args...> — git in the fixture repo with a fixed identity, no user config.
g() {
  git -C "$REPO" -c user.name=Tester -c user.email=t@example.com \
    -c commit.gpgsign=false "$@" >/dev/null
}

setup_repo() {
  mkdir -p "$REPO/scripts/lib" "$REPO/.agents/plans" "$REPO/src"
  cp "$HERE/check-plan-convergence.sh" "$HERE/get-default-branch.sh" "$REPO/scripts/"
  cp "$HERE/lib/"*.sh "$REPO/scripts/lib/"
  git init -q -b main "$REPO"
  printf 'default_branch: main\n' > "$REPO/CLAUDE.md"
  echo seed > "$REPO/README"
  g add CLAUDE.md README scripts
  g commit -q -m seed
}

write_plan() {
  cat > "$REPO/$PLAN" <<'EOF'
# Plan: demo
Status: approved

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| `src/a.js` | 1-10 | Create |

## Tasks
File: src/b.js:1-5
EOF
}

# run [args...] — run the script from the fixture repo root; sets RC.
run() {
  if (cd "$REPO" && bash scripts/check-plan-convergence.sh "$@") >"$OUT" 2>"$ERR"; then
    RC=0
  else
    RC=$?
  fi
}

expect() {
  [[ "$RC" -eq "$2" ]] || fail "$1: expected exit $2, got $RC (out: $(cat "$OUT"); err: $(cat "$ERR"))"
}

expect_out() {
  grep -qF -- "$2" "$OUT" || fail "$1: stdout missing [$2]: $(cat "$OUT")"
}

setup_repo
write_plan

# Missing plan (feature with no plan file) -> 2.
run other-feature
expect "missing plan" 2
pass "missing plan -> exit 2"

# Plan in working tree but never committed to base -> 2 not delivered.
run "$FEATURE"
expect "not delivered" 2
grep -qF "not delivered to main: $FEATURE" "$ERR" || fail "not delivered: stderr: $(cat "$ERR")"
pass "undelivered plan -> exit 2"

# Delivery: plan + src/a.js in one commit, nothing after -> converged.
echo a > "$REPO/src/a.js"
g add "$PLAN" src/a.js
g commit -q -m "deliver demo"
DELIVERY="$(git -C "$REPO" rev-parse --short=7 HEAD)"
run "$FEATURE"
expect "converged" 0
expect_out "converged" "convergence: $FEATURE (delivered $DELIVERY on main)"
expect_out "converged" "converged — no in-scope file changed since delivery ($DELIVERY)"
pass "delivered, no later change -> converged"

# Out-of-scope change only -> still converged.
echo x > "$REPO/other.txt"
g add other.txt
g commit -q -m "unrelated change"
run "$FEATURE"
expect "out of scope" 0
expect_out "out of scope" "converged —"
grep -qF "other.txt" "$OUT" && fail "out of scope: other.txt listed"
pass "out-of-scope change -> not listed"

# In-scope change to src/a.js -> listed with its sha + drift summary.
echo a2 > "$REPO/src/a.js"
g add src/a.js
g commit -q -m "tweak a"
DRIFT="$(git -C "$REPO" rev-parse --short HEAD)"
run "$FEATURE"
expect "drift" 0
expect_out "drift" "  src/a.js:"
expect_out "drift" "    $DRIFT "
expect_out "drift" "tweak a"
expect_out "drift" "drift: 1 in-scope file(s) changed since delivery"
grep -qF "other.txt" "$OUT" && fail "drift: other.txt listed"
pass "in-scope change -> listed with sha"

# Explicit --base works; unresolvable base -> 2 naming it.
run "$FEATURE" --base main
expect "explicit base" 0
run "$FEATURE" --base no-such-branch
expect "unknown base" 2
grep -qF "no-such-branch" "$ERR" || fail "unknown base: not named: $(cat "$ERR")"
run "$FEATURE" --base "--all"
expect "dash base" 2
pass "--base handling"

# Bad feature names and usage errors -> 2.
for bad in "-x" "A B" ""; do
  run "$bad"
  expect "bad feature [$bad]" 2
done
run
expect "no args" 2
run "$FEATURE" --bogus
expect "unknown flag" 2
run "$FEATURE" --base
expect "--base without ref" 2
pass "usage errors -> exit 2"

echo "ALL PASS"
