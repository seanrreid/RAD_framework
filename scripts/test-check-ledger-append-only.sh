#!/usr/bin/env bash
# test-check-ledger-append-only.sh
# Regression tests for check-ledger-append-only.sh: untouched ledger and pure
# append pass; edited/deleted lines, malformed or unknown-disposition rows and
# unresolvable refs fail. Builds a temp git-repo fixture and runs the REAL
# script with the fixture as cwd. bash 3.2+ safe.
#
# Usage: scripts/test-check-ledger-append-only.sh   (exit 0 = all pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

ROW1='{"type":"disposition","category":"testing","disposition":"adopted","date":"2026-10-01"}'
ROW2='{"type":"disposition","category":"docs","disposition":"declined","date":"2026-10-02","expires":"2027-01-01","reason":"noise"}'
LEDGER=".agents/insights-ledger.jsonl"

REPO="$TMP/repo"
mkdir -p "$REPO/.agents" "$REPO/src"
printf '%s\n' "$ROW1" > "$REPO/$LEDGER"
printf 'x\n' > "$REPO/src/app.js"
git -C "$REPO" init -q
git -C "$REPO" config user.email "t@t.t"
git -C "$REPO" config user.name "t"
git -C "$REPO" checkout -q -b main
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "baseline"

# run_check <base> <head> — prints the exit code; output in $TMP/out.
run_check() {
  local code
  set +e
  ( cd "$REPO" && bash "$HERE/check-ledger-append-only.sh" "$@" ) > "$TMP/out" 2>&1
  code=$?
  set -e
  echo "$code"
}

# new_case <name> <ledger-content|-> — branch with the ledger replaced (or untouched/removed).
new_case() {
  git -C "$REPO" checkout -q main
  git -C "$REPO" checkout -q -b "$1" main
}
commit_case() { git -C "$REPO" add -A && git -C "$REPO" commit -q -m "$1"; }

expect() { # expect <label> <want-code> <branch>
  local code
  code=$(run_check main "$3")
  [[ "$code" -eq "$2" ]] || { cat "$TMP/out"; fail "$1: want exit $2, got $code"; }
  echo "✓ $1 (exit $2)"
}

new_case case/untouched
printf 'y\n' > "$REPO/src/app.js"; commit_case untouched
expect "ledger untouched passes" 0 case/untouched
grep -q "no ledger changes" "$TMP/out" || fail "untouched: missing notice"

new_case case/append
printf '%s\n' "$ROW2" >> "$REPO/$LEDGER"; commit_case append
expect "pure append of a valid row passes" 0 case/append

new_case case/edit
printf '%s\n' "${ROW1/adopted/declined}" > "$REPO/$LEDGER"; commit_case edit
expect "edited existing line fails" 1 case/edit
grep -q "removed or modified" "$TMP/out" || fail "edit: missing reason"

new_case case/delete
: > "$REPO/$LEDGER"; commit_case delete
expect "deleted line fails" 1 case/delete

new_case case/badjson
printf 'not json\n' >> "$REPO/$LEDGER"; commit_case badjson
expect "invalid JSON added row fails" 1 case/badjson
grep -q "not valid JSON" "$TMP/out" || fail "badjson: missing reason"

new_case case/missing
printf '%s\n' '{"type":"disposition","category":"docs","date":"2026-10-02"}' >> "$REPO/$LEDGER"; commit_case missing
expect "row missing disposition fails" 1 case/missing

new_case case/unknown
printf '%s\n' '{"category":"docs","disposition":"ignored","date":"2026-10-02"}' >> "$REPO/$LEDGER"; commit_case unknown
expect "unknown disposition fails" 1 case/unknown
grep -q "unknown disposition" "$TMP/out" || fail "unknown: missing reason"

new_case case/blank
printf '\n' >> "$REPO/$LEDGER"; commit_case blank
expect "blank added row fails" 1 case/blank

code=$(run_check no-such-ref main)
[[ "$code" -eq 1 ]] || fail "unresolvable base should fail closed (got $code)"
grep -q "does not resolve" "$TMP/out" || fail "base ref: missing reason"
code=$(run_check main no-such-ref)
[[ "$code" -eq 1 ]] || fail "unresolvable head should fail closed (got $code)"
echo "✓ unresolvable refs fail closed (exit 1)"

code=$(run_check)
[[ "$code" -eq 2 ]] || fail "missing base-ref should be a usage error (got $code)"
echo "✓ missing base-ref is a usage error (exit 2)"

echo "All check-ledger-append-only tests passed"
