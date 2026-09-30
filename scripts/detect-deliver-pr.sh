#!/usr/bin/env bash
# detect-deliver-pr.sh
# Prefix-agnostic deliver-PR detection by CONTENT (#154). A PR is a deliver PR
# iff its head branch carries a plan `<plans-dir>/<slug>.md` whose `Branch:`
# header equals the head ref — no hard-coded `rad/` prefix, so a custom
# RAD_BRANCH_PREFIX is detected exactly like the default.
#
# Only the first `^Branch:` line of each plan is read (value trimmed of
# surrounding whitespace and a trailing CR). README.md is never a plan.
#
# Usage: scripts/detect-deliver-pr.sh <head-ref> [plans-dir]
#   plans-dir defaults to .agents/plans (relative to the cwd).
#
# Exit codes:
#   0 = exactly one plan matches; its slug (filename without .md) on stdout
#   1 = more than one plan matches; each matching slug named on stderr
#   2 = usage error, bad input, or plans dir missing / unreadable — fail closed
#   3 = no plan matches (an ordinary PR); stdout EMPTY

set -euo pipefail

readonly EXIT_OK=0
readonly EXIT_AMBIGUOUS=1
readonly EXIT_ERROR=2
readonly EXIT_NOT_DELIVER=3
readonly SELF="detect-deliver-pr"
readonly DEFAULT_PLANS_DIR=".agents/plans"
readonly REF_RE='^[A-Za-z0-9][A-Za-z0-9._/-]*$'
readonly USAGE="usage: $SELF <head-ref> [plans-dir]"

die() {
  echo "$SELF: $1" >&2
  exit "$EXIT_ERROR"
}

# validate_ref <ref> — exit 2 unless a safe git ref name (no `..`).
validate_ref() {
  local ref="$1"
  [[ "$ref" =~ $REF_RE ]] || die "invalid head ref: '$ref' ($USAGE)"
  case "$ref" in
    *..*) die "invalid head ref (contains '..'): '$ref'" ;;
  esac
}

# validate_plans_dir <dir> — exit 2 on a flag-like, missing, or unreadable dir.
validate_plans_dir() {
  local dir="$1"
  case "$dir" in
    ""|-*) die "invalid plans dir: '$dir' ($USAGE)" ;;
  esac
  [[ -d "$dir" ]] || die "plans dir not found: '$dir'"
  [[ -r "$dir" && -x "$dir" ]] || die "plans dir unreadable: '$dir'"
}

# plan_branch <plan-file> — print the trimmed first `Branch:` value (may be empty).
plan_branch() {
  awk '/^Branch:/ { sub(/^Branch:[[:space:]]*/, ""); sub(/\r$/, "");
         sub(/[[:space:]]+$/, ""); print; exit }' "$1" \
    || die "failed to read plan: '$1'"
}

main() {
  [[ $# -ge 1 && $# -le 2 ]] || die "$USAGE"
  local head_ref="$1" plans_dir="${2:-$DEFAULT_PLANS_DIR}"
  validate_ref "$head_ref"
  validate_plans_dir "$plans_dir"

  local plan name branch count=0 matches=""
  for plan in "$plans_dir"/*.md; do
    [[ -f "$plan" ]] || continue
    name="$(basename "$plan")"
    [[ "$name" == "README.md" ]] && continue
    [[ -r "$plan" ]] || die "plan unreadable: '$plan'"
    branch="$(plan_branch "$plan")"
    [[ "$branch" == "$head_ref" ]] || continue
    count=$((count + 1))
    matches="$matches ${name%.md}"
  done

  if [[ "$count" -eq 0 ]]; then
    exit "$EXIT_NOT_DELIVER"
  elif [[ "$count" -gt 1 ]]; then
    echo "$SELF: $count plans declare Branch: $head_ref:$matches" >&2
    exit "$EXIT_AMBIGUOUS"
  fi
  echo "${matches# }"
  exit "$EXIT_OK"
}

main "$@"
