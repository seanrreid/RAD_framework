#!/usr/bin/env bash
# report-ledger-staleness.sh
# Read-only /rad-insights step: prints a `### Ledger Staleness` section naming
# every insights-ledger category whose LATEST row has gone stale. Writes nothing.
#
# Usage: scripts/report-ledger-staleness.sh [--today YYYY-MM-DD]   (repo root)
#   RAD_STALE_DAYS          positive integer age limit in days (default 90)
#   RAD_FINDINGS_THRESHOLD  parsed like draft-insights-plan.sh (default 5)
#   RAD_FINDINGS_FILE       findings log (default .agents/findings.jsonl);
#                           a missing file means zero recurrence
#
# Flags (latest row per category only):
#   adopted            recurred  findings dated strictly after the row's date
#                                number >= threshold
#                      aged      row older than RAD_STALE_DAYS days
#   declined/deferred  expired   expires is today or earlier
#                      expiring  expires within EXPIRY_WARN_DAYS days
#                      aged      no expires and older than RAD_STALE_DAYS days
#
# Exit codes: 0 = report printed (also when the ledger is absent or empty);
#   2 = usage error, invalid input, or malformed ledger / findings line
#       (nothing on stdout).

set -euo pipefail

readonly SELF="report-ledger-staleness"
readonly DEFAULT_STALE_DAYS=90
readonly DEFAULT_THRESHOLD=5
readonly EXPIRY_WARN_DAYS=14
readonly MAX_INT_DIGITS=9
readonly SECONDS_PER_DAY=86400
readonly LEDGER_FILE=".agents/insights-ledger.jsonl"
readonly FINDINGS_FILE="${RAD_FINDINGS_FILE:-.agents/findings.jsonl}"
readonly DATE_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/insights-ledger.sh
source "$SCRIPT_DIR/lib/insights-ledger.sh"

# Latest row per category, flagged; one line per flagged category.
readonly REPORT_JQ='
  def day: (. + "T00:00:00Z") | fromdateiso8601 / '"$SECONDS_PER_DAY"' | floor;
  ($today | day) as $t
  | ($f | map(select(type == "object" and .type == "finding"))) as $finds
  | [ $l | group_by(.category)[] | last ] | sort_by(.category)[]
  | . as $r
  | (($r.date | day) as $d | $t - $d) as $age
  | ([ $finds[] | select(.category == $r.category and ((.date // "") > $r.date)) ] | length) as $n
  | [ if $r.disposition == "adopted" then
        (if $n >= $thr then "recurred (\($n) findings since \($r.date), threshold \($thr))" else empty end),
        (if $age > $stale then "aged (\($age) days old, limit \($stale))" else empty end)
      elif $r.expires != null then
        (if $r.expires <= $today then "expired (\($r.expires))"
         elif (($r.expires | day) - $t) <= $warn then "expiring (\($r.expires))"
         else empty end)
      elif $age > $stale then "aged (\($age) days old, limit \($stale))"
      else empty end ] as $flags
  | select($flags | length > 0)
  | "- \($r.category) — \($r.disposition) \($r.date): \($flags | join("; "))"'

die() { echo "$SELF: $2" >&2; exit "$1"; }

# positive integer, no leading zero, bounded so jq arithmetic stays exact
is_pos_int() { [[ "$1" =~ ^[1-9][0-9]*$ ]] && (( ${#1} <= MAX_INT_DIGITS )); }

parse_stale_days() {
  if [[ -z "${RAD_STALE_DAYS+x}" ]]; then echo "$DEFAULT_STALE_DAYS"; return; fi
  is_pos_int "$RAD_STALE_DAYS" || die 2 "RAD_STALE_DAYS must be a positive integer: '$RAD_STALE_DAYS'"
  echo "$RAD_STALE_DAYS"
}

# Same semantics as draft-insights-plan.sh: leading integer > 0, else default.
parse_threshold() {
  local raw="${RAD_FINDINGS_THRESHOLD:-}"
  if [[ "$raw" =~ ^[[:space:]]*\+?([0-9]+) ]]; then
    local n="${BASH_REMATCH[1]}"
    n=$(printf '%s' "$n" | sed -E 's/^0+//')
    if [[ -n "$n" ]] && (( ${#n} <= MAX_INT_DIGITS )); then echo "$n"; return; fi
  fi
  echo "$DEFAULT_THRESHOLD"
}

# A real calendar date: shape-checked, then round-tripped through jq.
validate_today() {
  local d="$1" back
  [[ "$d" =~ $DATE_RE ]] || die 2 "--today must be YYYY-MM-DD: '$d'"
  back=$(jq -rn --arg d "$d" '($d + "T00:00:00Z") | fromdateiso8601 | strftime("%Y-%m-%d")' 2>/dev/null) \
    || die 2 "--today is not a valid date: '$d'"
  [[ "$back" == "$d" ]] || die 2 "--today is not a valid date: '$d'"
}

validate_findings_file() {
  case "$FINDINGS_FILE" in
    -*) die 2 "RAD_FINDINGS_FILE must not start with '-': $FINDINGS_FILE" ;;
    *$'\n'*) die 2 "RAD_FINDINGS_FILE must not contain a newline" ;;
  esac
  [[ ! -e "$FINDINGS_FILE" || -f "$FINDINGS_FILE" ]] || die 2 "findings log is not a file: $FINDINGS_FILE"
  if [[ -f "$FINDINGS_FILE" ]]; then
    jq -e . "$FINDINGS_FILE" >/dev/null 2>&1 || die 2 "malformed findings log: $FINDINGS_FILE"
  fi
}

# Absent file → empty JSON array (zero recurrence), never an error.
findings_json() {
  if [[ -f "$FINDINGS_FILE" ]]; then jq -cs . "$FINDINGS_FILE"; else echo '[]'; fi
}

render() {
  local today="$1" stale="$2" thr="$3" out
  out=$(jq -rn --slurpfile lrows "$LEDGER_FILE" --argjson f "$(findings_json)" \
    --arg today "$today" --argjson stale "$stale" --argjson thr "$thr" --argjson warn "$EXPIRY_WARN_DAYS" \
    '$lrows as $l | '"$REPORT_JQ") || die 2 "cannot evaluate ledger: $LEDGER_FILE"
  if [[ -z "$out" ]]; then echo "No stale ledger entries."; else printf '%s\n' "$out"; fi
}

main() {
  local today="" have_today=0 stale thr msg body
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --today) [[ $# -ge 2 ]] || die 2 "--today needs a value"; today="$2"; have_today=1; shift 2 ;;
      *) die 2 "usage: $SELF.sh [--today YYYY-MM-DD]" ;;
    esac
  done
  (( have_today )) || today=$(date +%Y-%m-%d)
  validate_today "$today"
  stale=$(parse_stale_days)
  thr=$(parse_threshold)
  validate_findings_file
  msg=$(ledger_validate "$LEDGER_FILE" 2>&1) || die 2 "malformed insights ledger: $msg"
  if [[ -s "$LEDGER_FILE" ]]; then body=$(render "$today" "$stale" "$thr"); else body="No ledger entries."; fi
  printf '### Ledger Staleness\n\n%s\n' "$body"
}

main "$@"
