#!/usr/bin/env bash
# test-insights-ledger.sh
# Tests for scripts/lib/insights-ledger.sh: validation (absent/empty/valid,
# invalid JSON, missing fields, unknown disposition, bad dates), baseline
# (none, single, latest-row-wins, category with no findings), and
# declined-active (unexpired, expired, expires-today, non-declined, latest
# row wins, other category). bash 3.2+ safe.
#
# Usage: scripts/test-insights-ledger.sh   (exit 0 + "ALL PASS")

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# shellcheck source=lib/insights-ledger.sh
source "$HERE/lib/insights-ledger.sh"

LEDGER="$TMP/ledger.jsonl"
ERR="$TMP/err.txt"
TODAY="2026-11-06"

fail() { echo "✗ $1"; exit 1; }
pass() { echo "✓ $1"; }

row() { # row <category> <disposition> <date> [extra-json-fields]
  printf '{"type":"disposition","category":"%s","disposition":"%s","date":"%s"%s}\n' \
    "$1" "$2" "$3" "${4:-}"
}

# expect_invalid <label> <expected-substring> — LEDGER must fail validation
# with exit 2 and a `file:line: reason` message containing the substring.
expect_invalid() {
  local rc=0
  ledger_validate "$LEDGER" 2>"$ERR" || rc=$?
  [[ "$rc" -eq 2 ]] || fail "$1: expected exit 2, got $rc"
  grep -q "$LEDGER:" "$ERR" || fail "$1: message lacks file:line ($(cat "$ERR"))"
  grep -q "$2" "$ERR" || fail "$1: message lacks '$2' ($(cat "$ERR"))"
  pass "$1"
}

# --- validate: valid inputs -------------------------------------------------
rm -f "$LEDGER"
ledger_validate "$LEDGER" || fail "missing file must be valid"
pass "missing file is valid"
: > "$LEDGER"
ledger_validate "$LEDGER" || fail "empty file must be valid"
pass "empty file is valid"
{ row testing adopted 2026-10-01 ',"ref":"AGENTS.md","reason":"say \"hi\""'
  row security declined 2026-10-02 ',"expires":"2026-12-01"'
  row security deferred 2026-10-03; } > "$LEDGER"
ledger_validate "$LEDGER" || fail "valid rows rejected"
pass "valid rows (optional fields, quotes in reason) accepted"
printf '%s' "$(row testing adopted 2026-10-01)" > "$LEDGER"
ledger_validate "$LEDGER" || fail "final line without newline rejected"
pass "final line without trailing newline accepted"

# --- validate: malformed rows name the line --------------------------------
{ row testing adopted 2026-10-01; echo '{not json'; } > "$LEDGER"
expect_invalid "invalid JSON on line 2" ":2: invalid JSON"
{ row testing adopted 2026-10-01; echo '[1,2]'; } > "$LEDGER"
expect_invalid "non-object row" "not a JSON object"
echo '{"type":"disposition","disposition":"adopted","date":"2026-10-01"}' > "$LEDGER"
expect_invalid "missing category" "missing category"
echo '{"type":"disposition","category":"","disposition":"adopted","date":"2026-10-01"}' > "$LEDGER"
expect_invalid "empty category" "missing category"
echo '{"type":"disposition","category":"testing","date":"2026-10-01"}' > "$LEDGER"
expect_invalid "missing disposition" "missing disposition"
row testing maybe 2026-10-01 > "$LEDGER"
expect_invalid "unknown disposition" "unknown disposition"
echo '{"type":"disposition","category":"testing","disposition":"adopted"}' > "$LEDGER"
expect_invalid "missing date" "missing date"
row testing adopted 10/01/2026 > "$LEDGER"
expect_invalid "bad date format" "date is not YYYY-MM-DD"
row testing declined 2026-10-01 ',"expires":"soon"' > "$LEDGER"
expect_invalid "bad expires format" "expires is not YYYY-MM-DD"
{ row testing adopted 2026-10-01; echo; } > "$LEDGER"
expect_invalid "blank line is malformed" ":2: invalid JSON"

# --- baseline ---------------------------------------------------------------
rm -f "$LEDGER"
[[ -z "$(ledger_baseline "$LEDGER" testing)" ]] || fail "missing file must give no baseline"
pass "baseline: missing file → nothing"
: > "$LEDGER"
[[ -z "$(ledger_baseline "$LEDGER" testing)" ]] || fail "empty file must give no baseline"
pass "baseline: empty file → nothing"
{ row testing adopted 2026-10-01; row testing deferred 2026-10-20; row security adopted 2026-10-05; } > "$LEDGER"
[[ "$(ledger_baseline "$LEDGER" testing)" == "2026-10-20" ]] || fail "latest row must win"
pass "baseline: latest of several rows wins"
[[ "$(ledger_baseline "$LEDGER" security)" == "2026-10-05" ]] || fail "per-category baseline"
pass "baseline: scoped to its category"
[[ -z "$(ledger_baseline "$LEDGER" correctness)" ]] || fail "unknown category must give no baseline"
pass "baseline: category with no row (and no findings) → nothing"
# Baseline date equal to a finding date: the caller's strict '>' must exclude it.
base="$(ledger_baseline "$LEDGER" testing)"
[[ ! "2026-10-20" > "$base" ]] || fail "finding dated exactly the baseline must not count"
[[ "2026-10-21" > "$base" ]] || fail "finding after the baseline must count"
pass "baseline: strict > excludes equal date, includes later date"
echo '{broken' > "$LEDGER"
if ledger_baseline "$LEDGER" testing >/dev/null 2>&1; then fail "baseline on malformed ledger must fail"; fi
pass "baseline: malformed ledger fails closed"

# --- declined_active --------------------------------------------------------
active() { ledger_declined_active "$LEDGER" "$1" "$TODAY"; }
rm -f "$LEDGER"
if active testing; then fail "missing file is never declined"; fi
pass "declined: missing file → inactive"
row testing declined 2026-10-01 > "$LEDGER"
active testing || fail "declined with no expiry must be active"
pass "declined: no expiry → active"
row testing declined 2026-10-01 ',"expires":"2026-12-01"' > "$LEDGER"
active testing || fail "unexpired declined must be active"
pass "declined: unexpired → active"
row testing declined 2026-10-01 ',"expires":"2026-11-05"' > "$LEDGER"
if active testing; then fail "expired declined must not suppress"; fi
pass "declined: expired → inactive"
row testing declined 2026-10-01 ',"expires":"2026-11-06"' > "$LEDGER"
if active testing; then fail "expires == today is expired"; fi
pass "declined: expires today → inactive (strict >)"
row testing adopted 2026-10-01 > "$LEDGER"
if active testing; then fail "adopted is not declined"; fi
pass "declined: adopted → inactive"
{ row testing declined 2026-10-01; row testing adopted 2026-10-10; } > "$LEDGER"
if active testing; then fail "later adopted row must override earlier declined"; fi
pass "declined: later non-declined row wins"
{ row testing adopted 2026-10-01; row testing declined 2026-10-10; } > "$LEDGER"
active testing || fail "later declined row must override earlier adopted"
pass "declined: later declined row wins"
if active security; then fail "other category must not be suppressed"; fi
pass "declined: scoped to its category"

echo "ALL PASS"
