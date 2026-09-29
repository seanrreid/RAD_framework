#!/usr/bin/env bash
# default-tip.sh
# Prints the sha a remote's branch points at, read LIVE from the remote with
# `git ls-remote` (never a local remote-tracking ref, which a push from another
# checkout would not update). The deliver spine's push guard reads it before
# and after every wave: a moved default-branch tip means the wave pushed to it.
# READ-ONLY — never fetches, never writes a ref.
#
# Usage: scripts/default-tip.sh <remote> <branch>
#   e.g. scripts/default-tip.sh origin main
#
# Exit codes:
#   0 = ok; stdout is exactly the 40-hex sha, nothing else
#   2 = usage error: wrong arg count, or an arg failing its charset guard
#       (remote ^[A-Za-z0-9._-]+$, branch ^[A-Za-z0-9._/-]+$, neither may
#       start with '-')
#   3 = remote not configured, unreachable, or the branch is absent on it —
#       the reason is on stderr. The spine records this as audit
#       (push-check-unavailable) and never demotes on it.

set -euo pipefail

readonly EXIT_USAGE=2
readonly EXIT_UNAVAILABLE=3
readonly SELF="default-tip"
readonly REMOTE_RE='^[A-Za-z0-9._-]+$'
readonly BRANCH_RE='^[A-Za-z0-9._/-]+$'
readonly SHA_RE='^[0-9a-f]{40}$'

usage() {
  echo "$SELF: $1 (usage: $SELF <remote> <branch>)" >&2
  exit "$EXIT_USAGE"
}

unavailable() {
  echo "$SELF: $1" >&2
  exit "$EXIT_UNAVAILABLE"
}

[[ "$#" -eq 2 ]] || usage "expected 2 arguments, got $#"
REMOTE="$1"
BRANCH="$2"
[[ "$REMOTE" =~ $REMOTE_RE ]] || usage "invalid remote name"
[[ "$BRANCH" =~ $BRANCH_RE ]] || usage "invalid branch name"
[[ "$REMOTE" != -* ]] || usage "remote may not start with '-'"
[[ "$BRANCH" != -* ]] || usage "branch may not start with '-'"

git remote get-url "$REMOTE" >/dev/null 2>&1 \
  || unavailable "remote '$REMOTE' is not configured"

# GIT_TERMINAL_PROMPT=0: an auth prompt must fail, not hang the wave loop.
if ! LISTING="$(GIT_TERMINAL_PROMPT=0 git ls-remote --heads "$REMOTE" "refs/heads/$BRANCH")"; then
  unavailable "remote '$REMOTE' is unreachable (git ls-remote failed)"
fi

# ls-remote matches ref-name TAILS, so keep only the exact ref.
SHA="$(printf '%s\n' "$LISTING" | awk -v ref="refs/heads/$BRANCH" '$2 == ref { print $1 }')"
[[ -n "$SHA" ]] || unavailable "branch '$BRANCH' is absent on remote '$REMOTE'"
[[ "$SHA" =~ $SHA_RE ]] || unavailable "unexpected ls-remote sha for '$BRANCH': '$SHA'"

printf '%s\n' "$SHA"
