#!/usr/bin/env bash
# test-record-insights-disposition.sh
# Tests for scripts/record-insights-disposition.sh in a hermetic temp repo:
# ledger created when absent, row shape, optional fields, append-only
# behavior, and refusals (empty category, unknown disposition, expires before
# today, malformed ledger, unterminated ledger, missing option value), plus
# reasons containing quotes and newlines. bash 3.2+ safe.
#
# Usage: scripts/test-record-insights-disposition.sh   (exit 0 + "ALL PASS")

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

GREPO="$TMP/repo"
mkdir -p "$GREPO/scripts/lib" "$GREPO/.agents"
cp "$HERE/record-insights-disposition.sh" "$GREPO/scripts/"
cp "$HERE/lib/insights-ledger.sh" "$GREPO/scripts/lib/"
git -C "$GREPO" init -q
git -C "$GREPO" config user.email "arch@example.com"
LEDGER="$GREPO/.agents/insights-ledger.jsonl"
ERR="$TMP/err.txt"

fail() { echo "✗ $1"; exit 1; }
pass() { echo "✓ $1"; }

# rec <args...> — run the recorder in the fixture repo; sets RC, stderr in $ERR.
rec() {
  RC=0
  (cd "$GREPO" && bash scripts/record-insights-disposition.sh "$@") >"$TMP/out.txt" 2>"$ERR" || RC=$?
}
# expect_refused <label> <rc> <stderr-substring> <args...>: nothing may be written.
expect_refused() {
  local label="$1" want="$2" sub="$3" before after
  shift 3
  before=$(cat "$LEDGER" 2>/dev/null || echo "<absent>")
  rec "$@"
  [[ "$RC" -eq "$want" ]] || fail "$label: expected exit $want, got $RC ($(cat "$ERR"))"
  grep -q -- "$sub" "$ERR" || fail "$label: stderr lacks '$sub' ($(cat "$ERR"))"
  after=$(cat "$LEDGER" 2>/dev/null || echo "<absent>")
  [[ "$before" == "$after" ]] || fail "$label: ledger changed on refusal"
  pass "$label"
}

# Refusals while the ledger is absent leave no file behind.
expect_refused "empty category" 2 "category must not be empty" "" adopted --reason x
expect_refused "whitespace category" 2 "category must not be empty" "  " adopted
expect_refused "unknown disposition" 2 "unknown disposition" testing maybe
expect_refused "missing disposition" 2 "Usage" testing
expect_refused "unknown option" 2 "unknown option" testing adopted --bogus x
expect_refused "option without value" 2 "requires a value" testing adopted --reason
expect_refused "bad expires format" 2 "YYYY-MM-DD" testing declined --expires soon
expect_refused "expires earlier than date" 2 "earlier than today" testing declined --expires 2000-01-01
[[ ! -e "$LEDGER" ]] || fail "refusals created the ledger"

# Absent ledger → created with exactly one valid row.
rec testing adopted --reason "wired up" --ref "PR #1"
[[ "$RC" -eq 0 ]] || fail "append to absent ledger: rc=$RC ($(cat "$ERR"))"
[[ $(wc -l < "$LEDGER" | tr -d ' ') -eq 1 ]] || fail "absent ledger: expected 1 line"
TODAY=$(date +%Y-%m-%d)
jq -e --arg t "$TODAY" '.type=="disposition" and .category=="testing" and .disposition=="adopted"
  and .date==$t and .reason=="wired up" and .ref=="PR #1" and .actor=="arch@example.com"
  and (has("expires")|not)' "$LEDGER" >/dev/null || fail "row shape wrong: $(cat "$LEDGER")"
pass "absent ledger created with one valid row"

# Append-only: the first line is byte-identical after later appends.
FIRST=$(sed -n 1p "$LEDGER")
rec security declined --expires 2999-12-31
[[ "$RC" -eq 0 ]] || fail "second append rc=$RC"
[[ $(wc -l < "$LEDGER" | tr -d ' ') -eq 2 ]] || fail "expected 2 lines"
[[ "$(sed -n 1p "$LEDGER")" == "$FIRST" ]] || fail "existing line was altered"
jq -e '.expires=="2999-12-31" and (has("reason")|not)' <(sed -n 2p "$LEDGER") >/dev/null \
  || fail "expires/optional-field handling wrong"
pass "second row appended, first line untouched"

# Reason with quotes, backslash and newline round-trips as one valid line.
REASON=$'say "hi"\\ now\nsecond line: with colon'
rec naming deferred --reason "$REASON"
[[ "$RC" -eq 0 ]] || fail "special-char reason rc=$RC ($(cat "$ERR"))"
[[ $(wc -l < "$LEDGER" | tr -d ' ') -eq 3 ]] || fail "newline in reason split the row"
[[ "$(sed -n 3p "$LEDGER" | jq -r .reason)" == "$REASON" ]] || fail "reason did not round-trip"
pass "reason with quotes and newline stored as a single row"

# Malformed existing ledger → refuse, nothing appended.
printf 'not json\n' >> "$LEDGER"
expect_refused "malformed ledger refused" 1 "malformed ledger" testing adopted
expect_refused "malformed ledger names the line" 1 "insights-ledger.jsonl:4" testing adopted

# Unterminated last line → refuse (appending would rewrite that line).
printf '%s' "$FIRST" > "$LEDGER"
expect_refused "unterminated ledger refused" 1 "no trailing newline" testing adopted

echo "ALL PASS"
