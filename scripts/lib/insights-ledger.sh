#!/usr/bin/env bash
# insights-ledger.sh — sourced helpers for .agents/insights-ledger.jsonl, the
# append-only record of what the architect decided about each /rad-insights
# findings category. One JSON row per line:
#   {"type":"disposition","category":"testing","disposition":"adopted|declined|deferred",
#    "date":"YYYY-MM-DD","expires":"YYYY-MM-DD"?,"reason":"..."?,"ref":"..."?,"actor":"..."?}
# The latest row (last line, since the file is append-only) for a category wins.
# Dates are YYYY-MM-DD strings compared lexically. Requires jq. bash 3.2 safe.
# Source this file; it sets no shell options and never exits the caller.

readonly LEDGER_VALID_DISPOSITIONS="adopted declined deferred"
readonly LEDGER_BAD_ROW_EXIT=2

# Prints "ok" or the first reason the row (one JSON line on stdin) is invalid.
# Unparseable JSON makes jq fail, which the caller reports as invalid JSON.
readonly LEDGER_ROW_CHECK='
  def isdate: type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$");
  if type != "object" then "row is not a JSON object"
  elif (.category | type) != "string" or (.category | length) == 0 then "missing category"
  elif .disposition == null then "missing disposition"
  elif (.disposition | IN("adopted","declined","deferred") | not) then "unknown disposition"
  elif .date == null then "missing date"
  elif (.date | isdate | not) then "date is not YYYY-MM-DD"
  elif .expires != null and (.expires | isdate | not) then "expires is not YYYY-MM-DD"
  else "ok" end'

# ledger_validate <file> — 0 when every row is valid or the file is absent or
# empty; otherwise prints `file:line: reason` to stderr and returns 2 (stops at
# the first bad row). A blank line is a malformed row.
ledger_validate() {
  local file="$1" line n=0 verdict
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    # jq prints nothing (rc 0) for a blank line: treat that as unparseable too.
    verdict=$(printf '%s' "$line" | jq -r "$LEDGER_ROW_CHECK" 2>/dev/null) || verdict=""
    if [[ -z "$verdict" ]]; then
      echo "$file:$n: invalid JSON" >&2
      return "$LEDGER_BAD_ROW_EXIT"
    fi
    if [[ "$verdict" != "ok" ]]; then
      echo "$file:$n: $verdict" >&2
      return "$LEDGER_BAD_ROW_EXIT"
    fi
  done < "$file"
  return 0
}

# _ledger_latest_row <file> <category> — prints the category's last row as
# compact JSON, or nothing. Absent file → nothing. A jq failure propagates
# (fail closed: the caller validated first, so this is a real error).
_ledger_latest_row() {
  local file="$1" category="$2"
  [[ -f "$file" ]] || return 0
  jq -cs --arg c "$category" '[.[] | select(.category == $c)] | last // empty' "$file"
}

# ledger_baseline <file> <category> — prints the date of the category's latest
# row, or nothing when the file or the category has no row.
ledger_baseline() {
  local row
  row=$(_ledger_latest_row "$1" "$2") || return 1
  [[ -n "$row" ]] || return 0
  printf '%s' "$row" | jq -r '.date'
}

# ledger_declined_active <file> <category> <today> — 0 when the category's
# latest row is `declined` and unexpired (no `expires`, or expires > today);
# 1 otherwise. A row whose expires equals today is already expired.
ledger_declined_active() {
  local row
  row=$(_ledger_latest_row "$1" "$2") || return 1
  [[ -n "$row" ]] || return 1
  printf '%s' "$row" | jq -e --arg today "$3" \
    '.disposition == "declined" and (.expires == null or .expires > $today)' >/dev/null
}
