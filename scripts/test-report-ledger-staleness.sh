#!/usr/bin/env bash
# test-report-ledger-staleness.sh
# Hermetic tests for scripts/report-ledger-staleness.sh: empty/missing/malformed
# ledger, latest-row-wins, recurrence and age boundaries, expiry window,
# input validation, and read-only behaviour (fixtures byte-identical after
# every run). Uses --today for determinism. bash 3.2+ safe.
#
# Usage: scripts/test-report-ledger-staleness.sh   (exit 0 + "ALL PASS")

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/report-ledger-staleness.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

readonly TODAY="2026-06-30"
readonly STALE_OK_DATE="2026-04-01"  # exactly 90 days before TODAY
readonly STALE_OLD_DATE="2026-03-31" # 91 days before TODAY
LEDGER=".agents/insights-ledger.jsonl"
FINDINGS=".agents/findings.jsonl"
OUT="$TMP/out.txt"
ERR="$TMP/err.txt"
RC=0
FAILED=0

fail() { echo "✗ $1"; FAILED=1; }

new_case() { rm -rf "$TMP/w"; mkdir -p "$TMP/w/.agents"; cd "$TMP/w"; }

ledger_row() { # category disposition date [expires]
  if [[ -n "${4:-}" ]]; then
    printf '{"type":"disposition","category":"%s","disposition":"%s","date":"%s","expires":"%s"}\n' "$1" "$2" "$3" "$4"
  else
    printf '{"type":"disposition","category":"%s","disposition":"%s","date":"%s"}\n' "$1" "$2" "$3"
  fi
}

finding() { printf '{"type":"finding","category":"%s","date":"%s"}\n' "$1" "$2"; }

# run_report [args...] — captures stdout/stderr/rc and checks the fixtures are
# byte-identical afterwards (AC6).
run_report() {
  local before after
  before=$(cat "$LEDGER" "$FINDINGS" 2>/dev/null | cksum || true)
  RC=0
  "$SCRIPT" "$@" >"$OUT" 2>"$ERR" || RC=$?
  after=$(cat "$LEDGER" "$FINDINGS" 2>/dev/null | cksum || true)
  [[ "$before" == "$after" ]] || fail "$LABEL: fixtures modified"
  [[ -z "$(find . -type f ! -path './.agents/*')" ]] || fail "$LABEL: stray file written"
}

# expect <label> <rc> <stdout-substring|-> <must-not-contain|->
expect() {
  LABEL="$1"
  if [[ "$RC" -ne "$2" ]]; then fail "$1: rc=$RC want $2 ($(head -c 200 "$ERR"))"; return; fi
  if [[ "$3" != "-" ]] && ! grep -qF -- "$3" "$OUT"; then fail "$1: stdout lacks '$3': $(cat "$OUT")"; return; fi
  if [[ "$4" != "-" ]] && grep -qF -- "$4" "$OUT"; then fail "$1: stdout has '$4': $(cat "$OUT")"; return; fi
  echo "✓ $1"
}

run() { LABEL="$1"; shift; run_report "$@"; }

# --- ledger presence -------------------------------------------------------
new_case; run "missing ledger" --today "$TODAY"
expect "missing ledger: empty section, exit 0" 0 "No ledger entries." -
new_case; : > "$LEDGER"; run "empty ledger" --today "$TODAY"
expect "empty ledger: empty section, exit 0" 0 "No ledger entries." -
new_case; { ledger_row testing adopted 2026-06-01; echo 'not json'; } > "$LEDGER"; run "malformed" --today "$TODAY"
expect "malformed row: exit 2" 2 - "###"
grep -q "$LEDGER:2" "$ERR" && echo "✓ malformed row names file:line" || fail "malformed row names file:line: $(cat "$ERR")"

# --- adopted: recurrence ---------------------------------------------------
new_case; ledger_row testing adopted 2026-06-01 > "$LEDGER"; run "no findings" --today "$TODAY"
expect "category with no findings file: not flagged" 0 "No stale ledger entries." -
new_case; ledger_row testing adopted 2026-06-01 > "$LEDGER"; : > "$FINDINGS"; run "empty findings" --today "$TODAY"
expect "zero-byte findings file: zero recurrence, exit 0" 0 "No stale ledger entries." -
new_case; ledger_row testing adopted 2026-06-01 > "$LEDGER"
for i in 1 2 3 4 5; do finding testing 2026-06-01; done > "$FINDINGS"; run "same-day" --today "$TODAY"
expect "finding on adoption date not counted" 0 "No stale ledger entries." -
new_case; ledger_row testing adopted 2026-06-01 > "$LEDGER"
for i in 1 2 3 4 5; do finding testing 2026-06-02; done > "$FINDINGS"; run "next-day" --today "$TODAY"
expect "finding one day after counted (count == threshold flags)" 0 "recurred" -
new_case; ledger_row testing adopted 2026-06-01 > "$LEDGER"
for i in 1 2 3 4; do finding testing 2026-06-02; done > "$FINDINGS"; run "threshold-1" --today "$TODAY"
expect "threshold - 1 does not flag" 0 "No stale ledger entries." -
new_case; ledger_row testing adopted 2026-06-01 > "$LEDGER"
for i in 1 2 3; do finding testing 2026-06-02; done > "$FINDINGS"
RAD_FINDINGS_THRESHOLD=3 run "custom-threshold" --today "$TODAY"
expect "RAD_FINDINGS_THRESHOLD=3 flags at 3" 0 "recurred" -
new_case; ledger_row testing adopted 2026-06-01 > "$LEDGER"
for i in 1 2 3 4 5; do finding other 2026-06-02; done > "$FINDINGS"; run "other-cat" --today "$TODAY"
expect "other category's findings not counted" 0 "No stale ledger entries." -

# --- age -------------------------------------------------------------------
new_case; ledger_row testing adopted "$STALE_OK_DATE" > "$LEDGER"; run "age-90" --today "$TODAY"
expect "age exactly 90 not flagged" 0 "No stale ledger entries." -
new_case; ledger_row testing adopted "$STALE_OLD_DATE" > "$LEDGER"; run "age-91" --today "$TODAY"
expect "age 91 flagged aged" 0 "aged" -
new_case; ledger_row testing adopted 2026-06-20 > "$LEDGER"; RAD_STALE_DAYS=5 run "stale5" --today "$TODAY"
expect "RAD_STALE_DAYS=5 flags 10-day-old row" 0 "aged" -

# --- declined / deferred ---------------------------------------------------
new_case; ledger_row security declined 2026-05-01 "$TODAY" > "$LEDGER"; run "exp-today" --today "$TODAY"
expect "expiry exactly today is expired" 0 "expired" -
new_case; ledger_row security deferred 2026-05-01 2026-07-14 > "$LEDGER"; run "exp-in" --today "$TODAY"
expect "expiry 14 days out is expiring" 0 "expiring" -
new_case; ledger_row security declined 2026-05-01 2026-07-15 > "$LEDGER"; run "exp-out" --today "$TODAY"
expect "expiry 15 days out not flagged" 0 "No stale ledger entries." -
new_case; ledger_row security declined "$STALE_OLD_DATE" > "$LEDGER"; run "declined-aged" --today "$TODAY"
expect "declined with no expires and 91 days old is aged" 0 "aged" -
new_case; ledger_row security deferred "$STALE_OLD_DATE" > "$LEDGER"; run "deferred-aged" --today "$TODAY"
expect "deferred with no expires and 91 days old is aged" 0 "aged" -
new_case; ledger_row security declined "$STALE_OLD_DATE" 2026-12-31 > "$LEDGER"; run "expires-no-age" --today "$TODAY"
expect "declined with a far expires is not aged" 0 "No stale ledger entries." -

# --- latest row wins -------------------------------------------------------
new_case; { ledger_row testing adopted "$STALE_OLD_DATE"; ledger_row testing adopted 2026-06-15; } > "$LEDGER"; run "supersede" --today "$TODAY"
expect "newer row supersedes older stale row" 0 "No stale ledger entries." -

# --- input validation ------------------------------------------------------
new_case; ledger_row testing adopted 2026-06-01 > "$LEDGER"
for v in 0 -5 abc "" 1.5 "07" "9999999999"; do
  RAD_STALE_DAYS="$v" run "stale-$v" --today "$TODAY"
  expect "RAD_STALE_DAYS='$v' exits 2, no stdout" 2 - "###"
  [[ ! -s "$OUT" ]] || fail "RAD_STALE_DAYS='$v': stdout not empty"
done
for v in '2026-06-30; rm -rf /' '$(id)' '2026-13-45' '2026-02-30' '--today' ''; do
  run "today-$v" --today "$v"
  expect "hostile --today '$v' rejected" 2 - "###"
done
run "no-today-value" --today
expect "--today without value rejected" 2 - "###"
run "unknown-arg" --bogus
expect "unknown argument rejected" 2 - "###"
for v in '-evil' $'a\nb' "$TMP/w/.agents"; do
  RAD_FINDINGS_FILE="$v" run "ff" --today "$TODAY"
  expect "hostile RAD_FINDINGS_FILE rejected" 2 - "###"
done
echo 'not json' > "$FINDINGS"; run "bad-findings" --today "$TODAY"
expect "malformed findings file exits 2" 2 - "###"

[[ "$FAILED" -eq 0 ]] || { echo "SOME FAILED"; exit 1; }
echo "ALL PASS"
