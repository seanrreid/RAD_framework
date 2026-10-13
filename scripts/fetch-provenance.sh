#!/usr/bin/env bash
# fetch-provenance.sh
# Print who wrote an issue and its comments, for `rad plan-open` to stamp into
# the plan header (#243). Display-only: the output never reaches a gate.
#
# Usage: scripts/fetch-provenance.sh <issue-number>
#
# Output (stdout, on success), tab-separated, never partial:
#   issue<TAB><login><TAB><user.type><TAB><author_association>
#   comment<TAB><login><TAB><user.type><TAB><author_association>   (one per comment, all pages)
#
# Exit codes: 0 success; 1 fetch failed (reason on stderr) or bad argument;
# 3 platform is not GitHub (stdout: unsupported<TAB><platform>).
#
# Requires gh (authenticated) and jq. Set RAD_PLATFORM to override
# detect-platform.sh (used by tests).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly FETCH_FAILED_EXIT=1
readonly UNSUPPORTED_EXIT=3
readonly GHOST_LOGIN="ghost"

die() {
  echo "fetch-provenance: $1" >&2
  exit "$FETCH_FAILED_EXIT"
}

ISSUE="${1:-}"
# Untrusted input: a bare positive integer, validated before it reaches any command.
if ! [[ "$ISSUE" =~ ^[1-9][0-9]*$ ]]; then
  die "issue number must be a positive integer, got '${ISSUE}'"
fi

PLATFORM="${RAD_PLATFORM:-}"
if [[ -z "$PLATFORM" ]]; then
  PLATFORM=$("$SCRIPT_DIR/detect-platform.sh" --quiet 2>/dev/null) || die "platform detection failed"
fi
if [[ "$PLATFORM" != "github" ]]; then
  printf 'unsupported\t%s\n' "$PLATFORM"
  exit "$UNSUPPORTED_EXIT"
fi

command -v gh >/dev/null 2>&1 || die "gh CLI not found"
command -v jq >/dev/null 2>&1 || die "jq not found"

ERR_FILE=$(mktemp)
trap 'rm -f "$ERR_FILE"' EXIT

# Run a gh call; on failure die with its stderr as the reason.
gh_or_die() {
  local what="$1"
  shift
  local out
  if ! out=$(gh "$@" 2>"$ERR_FILE"); then
    die "${what} failed: $(tr '\n' ' ' <"$ERR_FILE" | cut -c1-200)"
  fi
  printf '%s' "$out"
}

# Normalize one object-or-array stream of GitHub records to TSV rows of kind $1.
to_rows() {
  local kind="$1"
  jq -r --arg kind "$kind" --arg ghost "$GHOST_LOGIN" \
    '(if type == "array" then .[] else . end)
     | [$kind, (.user.login // $ghost), (.user.type // ""), (.author_association // "")] | @tsv'
}

REPO=$(gh_or_die "gh repo view" repo view --json nameWithOwner --jq '.nameWithOwner')
[[ "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "unexpected repo name '${REPO}'"

ISSUE_JSON=$(gh_or_die "gh api issue ${ISSUE}" api "repos/${REPO}/issues/${ISSUE}")
COMMENTS_JSON=$(gh_or_die "gh api comments for issue ${ISSUE}" api --paginate "repos/${REPO}/issues/${ISSUE}/comments")

ISSUE_ROWS=$(printf '%s' "$ISSUE_JSON" | to_rows issue) || die "could not parse issue ${ISSUE} response"
COMMENT_ROWS=$(printf '%s' "$COMMENTS_JSON" | to_rows comment) || die "could not parse comments response for issue ${ISSUE}"

printf '%s\n' "$ISSUE_ROWS"
[[ -z "$COMMENT_ROWS" ]] || printf '%s\n' "$COMMENT_ROWS"
