#!/usr/bin/env bash
# check-ledger-append-only.sh
# All-PR check: .agents/insights-ledger.jsonl (the architect's per-category
# /rad-insights dispositions) is an append-only audit trail. If the ledger is
# touched in `git diff <base>...<head>`:
#
#   - FAIL if the diff removes or modifies any existing line (any '-' line in
#     the hunks; the "\ No newline at end of file" marker starts with '\').
#   - FAIL if any ADDED line is not a valid ledger row (the same schema the
#     drafter and recorder enforce: scripts/lib/insights-ledger.sh).
#
# Ledger untouched → exit 0 with a notice. Unresolvable refs fail closed.
# Mirrors check-events-append-only.sh. Requires jq.
#
# Usage: scripts/check-ledger-append-only.sh <base-ref> [head-ref]
#   head-ref defaults to HEAD.
#
# Exit codes:
#   0 = pass (append-only, added rows well-formed — or ledger untouched)
#   1 = fail (rewrite/deletion, malformed row, or error — fail closed)
#   2 = usage error

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/insights-ledger.sh
source "$HERE/lib/insights-ledger.sh"

readonly LEDGER_PATH=".agents/insights-ledger.jsonl"
BASE_REF="${1:-}"
HEAD_REF="${2:-HEAD}"

[[ -z "$BASE_REF" ]] && {
  echo "Usage: check-ledger-append-only.sh <base-ref> [head-ref]"
  exit 2
}

command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required. Failing closed."; exit 1; }

# Fail closed on unresolvable refs — an undiffable range is ambiguity, not a pass.
require_ref() {
  git rev-parse --verify --quiet "$2^{commit}" >/dev/null \
    || { echo "FAIL: $1 ref '$2' does not resolve. Failing closed."; exit 1; }
}

# Prints a reason per added line that is not a valid ledger row; returns 1 if any.
report_bad_added_rows() {
  local line verdict bad=0
  while IFS= read -r line; do
    # jq prints nothing (rc 0) for a blank line: that is a malformed row too.
    verdict=$(printf '%s' "$line" | jq -r "$LEDGER_ROW_CHECK" 2>/dev/null) || verdict=""
    if [[ -z "$verdict" ]]; then
      echo "not valid JSON: $line"; bad=1
    elif [[ "$verdict" != "ok" ]]; then
      echo "$verdict: $line"; bad=1
    fi
  done
  return "$bad"
}

require_ref base "$BASE_REF"
require_ref head "$HEAD_REF"

CHANGED=$(git diff --name-only "${BASE_REF}...${HEAD_REF}" -- "$LEDGER_PATH")
if [[ -z "$CHANGED" ]]; then
  echo "ok: no ledger changes in ${BASE_REF}...${HEAD_REF}"
  exit 0
fi

DIFF=$(git diff "${BASE_REF}...${HEAD_REF}" -- "$LEDGER_PATH")
VIOLATIONS=0

REMOVED=$(printf '%s\n' "$DIFF" | grep -E '^-' | grep -Ev '^---' || true)
if [[ -n "$REMOVED" ]]; then
  echo "FAIL: ${LEDGER_PATH} — existing ledger lines removed or modified (the ledger is append-only):"
  printf '%s\n' "$REMOVED" | sed 's/^/  /'
  VIOLATIONS=1
fi

# Keep the '+' prefix while testing for presence: a blank added row is just "+".
ADDED_RAW=$(printf '%s\n' "$DIFF" | grep -E '^\+' | grep -Ev '^\+\+\+' || true)
ADDED=$(printf '%s\n' "$ADDED_RAW" | sed 's/^+//')
if [[ -n "$ADDED_RAW" ]] && ! ERRORS=$(printf '%s\n' "$ADDED" | report_bad_added_rows); then
  echo "FAIL: ${LEDGER_PATH} — malformed added ledger row(s):"
  printf '%s\n' "$ERRORS" | sed 's/^/  /'
  VIOLATIONS=1
fi

[[ "$VIOLATIONS" -eq 0 ]] || exit 1
echo "PASS: ledger changes in ${BASE_REF}...${HEAD_REF} are append-only and well-formed"
exit 0
