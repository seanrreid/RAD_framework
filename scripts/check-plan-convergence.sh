#!/usr/bin/env bash
# check-plan-convergence.sh
# Post-merge plan<->code convergence report (#72): for a DELIVERED feature, lists
# which files in the plan's declared path set (Files in Scope + task File:
# lines, via plan_scope_paths) changed on the base branch after delivery.
# ADVISORY archaeology only — it is NEVER a gate; any completed report exits 0.
#
# Delivery locator: the oldest commit on <base> that ADDED
# .agents/plans/<feature>.md. Under Lane B the plan first lands on the default
# branch via the deliver PR, so that commit IS the delivery. For pre-Lane-B
# plans (plan committed to main before delivery) the locator is a HEURISTIC:
# it finds the plan's landing commit, and drift may include the delivery itself.
#
# Usage: scripts/check-plan-convergence.sh <feature> [--base <ref>]
#   Run from the repo root. <base> defaults to scripts/get-default-branch.sh
#   (fallback main). The path set is read from the working-tree plan copy.
#
# Exit codes:
#   0 = report printed (converged OR drift found)
#   1 = a git command failed (named on stderr)
#   2 = usage error, bad feature/base, plan missing/unreadable, base
#       unresolvable, or plan not delivered to <base>

set -euo pipefail

readonly EXIT_GIT=1
readonly EXIT_USAGE=2
readonly SELF="check-plan-convergence"
readonly FALLBACK_BASE="main"
readonly FEATURE_RE='^[a-z0-9][a-z0-9-]*$'
# A ref name: no leading dash (never parsed as a git option), safe charset only.
readonly REF_RE='^[A-Za-z0-9_.][A-Za-z0-9_./-]*$'
readonly SHA_RE='^[0-9a-f]{40}([0-9a-f]{24})?$'
readonly LOG_FORMAT='%h %ad %an %s'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/plan-paths.sh
. "$SCRIPT_DIR/lib/plan-paths.sh"

die() { echo "$SELF: $2" >&2; exit "$1"; }
usage() { die "$EXIT_USAGE" "usage: $SELF <feature> [--base <ref>] — $1"; }

FEATURE=""
BASE=""
parse_args() {
  [[ $# -ge 1 ]] || usage "feature required"
  FEATURE="$1"; shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --base) [[ $# -ge 2 ]] || usage "--base needs a ref"; BASE="$2"; shift 2 ;;
      *) usage "unknown argument: '$1'" ;;
    esac
  done
}

resolve_base() {
  if [[ -z "$BASE" ]]; then
    if ! BASE=$("$SCRIPT_DIR/get-default-branch.sh"); then
      echo "$SELF: get-default-branch.sh failed; falling back to $FALLBACK_BASE" >&2
      BASE=""
    fi
    [[ -n "$BASE" ]] || BASE="$FALLBACK_BASE"
  fi
  [[ "$BASE" =~ $REF_RE ]] || usage "invalid base ref: '$BASE'"
  git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null \
    || die "$EXIT_USAGE" "base ref not resolvable: '$BASE'"
}

# find_delivery <plan> — print the oldest commit on BASE that added <plan>.
find_delivery() {
  local out
  out=$(git log --diff-filter=A --format=%H "$BASE" -- "$1") \
    || die "$EXIT_GIT" "git log --diff-filter=A $BASE -- $1 failed"
  [[ -n "$out" ]] || die "$EXIT_USAGE" "not delivered to $BASE: $FEATURE"
  printf '%s\n' "$out" | tail -n 1
}

# report_drift <delivery> <paths> — print `  <path>:` + indented commits per
# drifted file (a path line is the only 2-space-indented line: count those).
report_drift() {
  local delivery="$1" paths="$2" path commits
  [[ "$delivery" =~ $SHA_RE ]] || die "$EXIT_GIT" "delivery is not a commit sha: '$delivery'"
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    commits=$(git log --format="$LOG_FORMAT" --date=short "$delivery..$BASE" -- "$path") \
      || die "$EXIT_GIT" "git log $delivery..$BASE -- $path failed"
    [[ -n "$commits" ]] || continue
    echo "  $path:"
    printf '%s\n' "$commits" | sed 's/^/    /'
  done <<EOF
$paths
EOF
}

main() {
  parse_args "$@"
  [[ "$FEATURE" =~ $FEATURE_RE ]] || usage "invalid feature: '$FEATURE'"
  local plan=".agents/plans/$FEATURE.md"
  require_readable_plan "$SELF" "$plan" || exit "$EXIT_USAGE"
  resolve_base
  local delivery sha7 paths body count
  delivery=$(find_delivery "$plan")
  sha7="${delivery:0:7}"
  paths=$(plan_scope_paths "$plan") || die "$EXIT_GIT" "plan_scope_paths $plan failed"
  body=$(report_drift "$delivery" "$paths")
  count=$(printf '%s\n' "$body" | grep -c '^  [^ ]' || [ $? -eq 1 ])
  echo "convergence: $FEATURE (delivered $sha7 on $BASE)"
  if [[ "$count" -eq 0 ]]; then
    echo "converged — no in-scope file changed since delivery ($sha7)"
  else
    printf '%s\n' "$body"
    echo "drift: $count in-scope file(s) changed since delivery"
  fi
}

main "$@"
