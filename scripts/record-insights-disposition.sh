#!/usr/bin/env bash
# record-insights-disposition.sh
# The ONLY sanctioned writer of .agents/insights-ledger.jsonl (the append-only
# record of the architect's decision per /rad-insights findings category).
#
# Usage: scripts/record-insights-disposition.sh <category> <adopted|declined|deferred>
#          [--reason <text>] [--ref <text>] [--expires <YYYY-MM-DD>]
#
# Appends exactly one row. `date` is today, `actor` is `git config user.email`.
# Runs from the repo root (the ledger path is cwd-relative, like the drafter).
# Refuses (nothing written) on: invalid input, `expires` earlier than today, an
# empty actor, an existing malformed ledger, or a ledger whose last line lacks
# a trailing newline (appending would rewrite that line).
#
# Exit codes: 0 = row appended; 1 = refused or write failed; 2 = usage error.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/insights-ledger.sh
source "$HERE/lib/insights-ledger.sh"

readonly LEDGER_FILE=".agents/insights-ledger.jsonl"
readonly USAGE="Usage: record-insights-disposition.sh <category> <adopted|declined|deferred> [--reason <text>] [--ref <text>] [--expires <YYYY-MM-DD>]"
readonly DATE_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}$'

die() { echo "record-insights-disposition: $2" >&2; exit "$1"; }

command -v jq >/dev/null 2>&1 || die 1 "jq is required"

CATEGORY="${1:-}" DISPOSITION="${2:-}"
[[ $# -ge 2 ]] || { echo "$USAGE" >&2; exit 2; }
shift 2
REASON="" REF="" EXPIRES=""
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || die 2 "$1 requires a value"
  case "$1" in
    --reason) REASON="$2" ;;
    --ref) REF="$2" ;;
    --expires) EXPIRES="$2" ;;
    *) die 2 "unknown option '$1'" ;;
  esac
  shift 2
done

[[ -n "${CATEGORY//[[:space:]]/}" ]] || die 2 "category must not be empty"
[[ "$CATEGORY" =~ ^[A-Za-z0-9._-]+$ ]] || die 2 "category must match [A-Za-z0-9._-]+ (got '$CATEGORY')"
case " $LEDGER_VALID_DISPOSITIONS " in
  *" $DISPOSITION "*) ;;
  *) die 2 "unknown disposition '$DISPOSITION' (expected: $LEDGER_VALID_DISPOSITIONS)" ;;
esac
TODAY=$(date +%Y-%m-%d)
if [[ -n "$EXPIRES" ]]; then
  [[ "$EXPIRES" =~ $DATE_RE ]] || die 2 "--expires must be YYYY-MM-DD"
  [[ "$EXPIRES" < "$TODAY" ]] && die 2 "--expires $EXPIRES is earlier than today ($TODAY)"
fi
ACTOR=$(git config user.email 2>/dev/null || true)
[[ -n "$ACTOR" ]] || die 1 "cannot determine git user.email — set your git identity first"

# Fail closed on a malformed or unterminated existing ledger.
ledger_validate "$LEDGER_FILE" || die 1 "refusing to append to a malformed ledger"
if [[ -s "$LEDGER_FILE" && -n "$(tail -c 1 "$LEDGER_FILE")" ]]; then
  die 1 "refusing to append: last line of $LEDGER_FILE has no trailing newline"
fi

ROW=$(jq -nc --arg c "$CATEGORY" --arg d "$DISPOSITION" --arg date "$TODAY" \
  --arg exp "$EXPIRES" --arg reason "$REASON" --arg ref "$REF" --arg actor "$ACTOR" '
  {type: "disposition", category: $c, disposition: $d, date: $date}
  + (if $exp != "" then {expires: $exp} else {} end)
  + (if $reason != "" then {reason: $reason} else {} end)
  + (if $ref != "" then {ref: $ref} else {} end)
  + {actor: $actor}')
VERDICT=$(printf '%s' "$ROW" | jq -r "$LEDGER_ROW_CHECK") || die 1 "built an unparseable row"
[[ "$VERDICT" == "ok" ]] || die 1 "built an invalid row: $VERDICT"
mkdir -p "$(dirname "$LEDGER_FILE")"
printf '%s\n' "$ROW" >> "$LEDGER_FILE" || die 1 "cannot write $LEDGER_FILE"
echo "ok: recorded $DISPOSITION for '$CATEGORY' ($TODAY)"
