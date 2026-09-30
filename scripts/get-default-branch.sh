#!/usr/bin/env bash
# get-default-branch.sh
# Prints the project's default branch as declared in .rad/config.yml.
#
# Reads the `default_branch` key via `rad config get` (harness/cli.js). Falls
# back to `main` ONLY when the key is absent (config get exit 3). A missing or
# invalid .rad/config.yml is NOT papered over: the reason goes to stderr and the
# script exits 1 (fail-closed — there is no CLAUDE.md fallback). This is the one
# place every RAD command/script resolves the default branch — no command should
# hardcode `main`.
#
# Usage: scripts/get-default-branch.sh [repo-root]
#   repo-root defaults to this script's checkout; its harness/cli.js reads its
#   .rad/config.yml.
#
# Output: the branch name on stdout.
# Exit codes: 0 = branch printed; 1 = missing/invalid config or harness failure.

set -euo pipefail

readonly FALLBACK="main"
readonly CONFIG_KEY_ABSENT_EXIT=3

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-$SCRIPT_DIR/..}"
RAD_CLI="$ROOT/harness/cli.js"

if [[ ! -f "$RAD_CLI" ]]; then
  echo "get-default-branch: no RAD harness at '$RAD_CLI' (repo-root: '$ROOT')" >&2
  exit 1
fi

ERR_FILE=$(mktemp "${TMPDIR:-/tmp}/get-default-branch.XXXXXX")
trap 'rm -f "$ERR_FILE"' EXIT

rc=0
branch=$(node "$RAD_CLI" config get default_branch 2>"$ERR_FILE") || rc=$?

if [[ "$rc" -eq "$CONFIG_KEY_ABSENT_EXIT" ]]; then
  echo "$FALLBACK"
  exit 0
fi

if [[ "$rc" -ne 0 ]]; then
  cat "$ERR_FILE" >&2
  echo "get-default-branch: cannot read default_branch from .rad/config.yml (rad config get exit $rc)" >&2
  exit 1
fi

if [[ -z "$branch" ]]; then
  echo "$FALLBACK"
else
  echo "$branch"
fi
