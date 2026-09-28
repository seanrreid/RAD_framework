#!/usr/bin/env bash
# check-approval-blockers.sh
# Decides whether a RAD plan carries approval blockers. A blocker is either:
#   - an unresolved `[NEEDS CLARIFICATION: <question>]` marker outside a ```
#     fenced block and outside an inline code span (resolve-only — markers can
#     NEVER be waived), or
#   - a high-risk path finding (`high-risk:<path>`, RAD_HIGH_RISK_PATTERNS) with
#     no matching `- <id>: <justification>` bullet under `## Waivers`, or
#   - a light-tier violation (`light-tier: <reason>`, plan_light_violations): a
#     `Tier: light` plan exceeding a light bound — too many waves or tasks, or a
#     high-risk or self-protected scope path. NON-WAIVABLE: these never pass
#     through applied_waivers; the fix is to shrink the plan or drop the tier.
# For a standard plan (no `Tier: light`) the self-protected advisory is
# deliberately NOT a blocker.
#
# All parsing lives in lib/plan-paths.sh (one source of truth); this script only
# combines the helpers' output. A waiver applies iff its id equals a CURRENT
# finding — stale waivers and waivers naming a clarification marker are ignored
# here (never applied, never blocking); lint-plan.sh warns about them.
#
# Usage: scripts/check-approval-blockers.sh <plan-file>
#
# Exit codes:
#   0 = no blockers; applied waivers printed on stdout as `<id>\t<justification>`
#   1 = blockers found; each named on stderr, stdout EMPTY
#   2 = usage error, or plan missing / unreadable / empty, or a helper failed —
#       fail closed: an error is never reported as 0

set -euo pipefail

readonly EXIT_OK=0
readonly EXIT_BLOCKED=1
readonly EXIT_ERROR=2
readonly SELF="check-approval-blockers"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/plan-paths.sh
. "$SCRIPT_DIR/lib/plan-paths.sh"

die() {
  echo "$SELF: $1" >&2
  exit "$EXIT_ERROR"
}

# validate_plan_arg <argc> <plan-file>
# Exit 2 unless exactly one argument names a readable, non-empty regular file.
validate_plan_arg() {
  local argc="$1" plan_file="$2"
  [[ "$argc" -eq 1 ]] || die "usage: $SELF <plan-file>"
  [[ -f "$plan_file" ]] || die "plan file not found: '$plan_file'"
  [[ -r "$plan_file" ]] || die "plan file unreadable: '$plan_file'"
  [[ -s "$plan_file" ]] || die "plan file is empty: '$plan_file'"
}

# applied_waivers <findings> <waivers>
# Print each `<id>\t<justification>` waiver whose id equals a current finding,
# first occurrence per id only. Stale ids (and clarify-named ids, which are never
# findings) fall through unprinted.
applied_waivers() {
  local findings="$1" waivers="$2" id why seen=""
  [[ -z "$findings" || -z "$waivers" ]] && return 0
  while IFS=$'\t' read -r id why; do
    printf '%s\n' "$findings" | grep -Fxq -- "$id" || continue
    printf '%s\n' "$seen" | grep -Fxq -- "$id" && continue
    seen="$seen"$'\n'"$id"
    printf '%s\t%s\n' "$id" "$why"
  done <<< "$waivers"
}

# Appended to every light-tier blocker: the only two ways to clear one.
readonly LIGHT_TIER_HINT='(shrink the plan or remove "Tier: light" to make it a standard plan)'

# report_blockers <markers> <findings> <applied> <light-violations>
# Name every blocker on stderr; print the blocker count on stdout (captured by
# the caller, never reaching the script's own stdout). Light-tier violations are
# counted unconditionally — <applied> is never consulted for them.
report_blockers() {
  local markers="$1" findings="$2" applied="$3" light="$4" line question id count=0
  if [[ -n "$markers" ]]; then
    while IFS=$'\t' read -r line question; do
      echo "✗ clarification marker at line $line: $question" >&2
      count=$((count + 1))
    done <<< "$markers"
  fi
  if [[ -n "$findings" ]]; then
    while IFS= read -r id; do
      printf '%s\n' "$applied" | cut -f1 | grep -Fxq -- "$id" && continue
      echo "✗ un-waived high-risk finding: $id (add a \"- $id: <justification>\" line under ## Waivers, or remove the path)" >&2
      count=$((count + 1))
    done <<< "$findings"
  fi
  if [[ -n "$light" ]]; then
    while IFS= read -r line; do
      echo "✗ $line $LIGHT_TIER_HINT" >&2
      count=$((count + 1))
    done <<< "$light"
  fi
  echo "$count"
}

main() {
  local plan_file="${1:-}" markers findings waivers applied light blockers
  validate_plan_arg "$#" "$plan_file"
  markers=$(plan_clarification_markers "$plan_file") || die "could not read clarification markers"
  findings=$(plan_high_risk_findings "$plan_file") || die "could not compute high-risk findings"
  waivers=$(plan_waivers "$plan_file") || die "could not read ## Waivers"
  applied=$(applied_waivers "$findings" "$waivers") || die "could not match waivers to findings"
  light=$(plan_light_violations "$plan_file") || die "could not compute light-tier violations"
  blockers=$(report_blockers "$markers" "$findings" "$applied" "$light") || die "could not report blockers"
  if [[ "$blockers" -gt 0 ]]; then
    echo "$SELF: $blockers approval blocker(s) in $plan_file" >&2
    exit "$EXIT_BLOCKED"
  fi
  [[ -n "$applied" ]] && printf '%s\n' "$applied"
  exit "$EXIT_OK"
}

main "$@"
