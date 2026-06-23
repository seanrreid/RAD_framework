#!/usr/bin/env bash
# git-sync.sh
# Plain-git transport for portable RAD process memory. Moves the canonical
# event log / plan doc between machines using ONLY plain git (push / fetch /
# rev-parse) — never gh/glab/detect-platform.sh. It inherits the user's existing
# git credentials and never prompts for or stores any.
#
# This helper is the transport primitive only. It does NOT read RAD_SYNC — the
# caller (the rad verbs, wired in a later wave) is what gates on RAD_SYNC and
# decides whether to invoke this script at all. Called directly, it just does
# plain-git push/fetch.
#
# Subcommands:
#   push <branch>
#     Best-effort `git push origin <branch>`. On failure, warns to stderr but
#     EXITS 0 regardless (offline-fail-safe — a failed push must NEVER block the
#     caller; the local commit has already landed).
#
#   fetch-tip <branch>
#     `git fetch origin <branch>`, then compare the local branch tip to
#     origin/<branch>. Prints a one-line signal to stdout and uses the exit code
#     to SIGNAL divergence to the caller:
#       prints "in-sync"  and exits 0  — local tip == origin tip (or no remote
#                                        tip yet to diverge from)
#       prints "diverged" and exits 3  — local tip != origin tip
#       prints "diverged" and exits 4  — fetch failed (offline / no remote ref);
#                                        divergence is UNDETERMINABLE → fail-safe
#                                        signal so the caller never assumes sync
#     Note: a non-zero exit here is a DIVERGENCE SIGNAL, not a crash — the caller
#     interprets it; this script does not throw.
#
# Usage:
#   scripts/git-sync.sh push <branch>
#   scripts/git-sync.sh fetch-tip <branch>
#
# Exit codes:
#   0 = success / in-sync (push always returns 0)
#   2 = usage error (bad/missing subcommand or invalid branch name)
#   3 = fetch-tip: local diverged from origin tip
#   4 = fetch-tip: fetch failed, divergence undeterminable (fail-safe signal)
#
# The work-branch prefix can be overridden via RAD_BRANCH_PREFIX (default `rad/`),
# mirroring scripts/checkout-plan.sh.

set -euo pipefail

PREFIX="${RAD_BRANCH_PREFIX:-rad/}"

# Validate the branch argument against the same safe pattern the other RAD
# scripts use (see scripts/checkout-plan.sh) before interpolating it into git.
# The prefix is escaped so a custom prefix with regex metacharacters is matched
# literally.
validate_branch() {
  local branch="$1"
  [[ -z "$branch" ]] && { echo "✗ branch name required (e.g. ${PREFIX}<feature>)" >&2; exit 2; }
  local escaped_prefix
  escaped_prefix=$(printf '%s' "$PREFIX" | sed 's/[.[\*^$()+?{|]/\\&/g')
  if [[ ! "$branch" =~ ^${escaped_prefix}[a-z0-9][a-z0-9-]*$ ]]; then
    echo "✗ Invalid branch '$branch'. Expected: ${PREFIX}<feature> (lowercase, digits, hyphens)." >&2
    exit 2
  fi
}

cmd_push() {
  local branch="$1"
  validate_branch "$branch"
  # Best-effort: a failed push must never block the caller. The local commit has
  # already landed; the remote will catch up on the next successful sync.
  if ! git push origin "$branch" 2>/dev/null; then
    echo "⚠ git-sync: push of '$branch' to origin failed (offline?) — local commit kept, remote will catch up." >&2
  fi
  exit 0
}

cmd_fetch_tip() {
  local branch="$1"
  validate_branch "$branch"

  # Fetch the remote tip. If the fetch fails (offline / no such ref), divergence
  # is undeterminable — emit the fail-safe divergence signal so the caller never
  # assumes it is in sync.
  if ! git fetch origin "$branch" 2>/dev/null; then
    echo "diverged"
    exit 4
  fi

  local local_tip remote_tip
  local_tip=$(git rev-parse "$branch" 2>/dev/null || echo "")
  remote_tip=$(git rev-parse "origin/$branch" 2>/dev/null || echo "")

  if [[ -n "$local_tip" && -n "$remote_tip" && "$local_tip" == "$remote_tip" ]]; then
    echo "in-sync"
    exit 0
  fi

  echo "diverged"
  exit 3
}

SUBCMD="${1:-}"
case "$SUBCMD" in
  push)      cmd_push "${2:-}" ;;
  fetch-tip) cmd_fetch_tip "${2:-}" ;;
  *)
    echo "usage: git-sync.sh {push|fetch-tip} ${PREFIX}<feature>" >&2
    exit 2
    ;;
esac
