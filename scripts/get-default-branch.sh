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
# Exit codes: 0 = branch printed; 1 = missing/invalid config, harness failure,
#   or a harness that exited 0 with no output.

set -euo pipefail

readonly FALLBACK="main"
readonly CONFIG_KEY_ABSENT_EXIT=3

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-$SCRIPT_DIR/..}"
# Legacy argument form accepted: a path naming an existing regular FILE (e.g.
# the pre-#87 `CLAUDE.md` argument) resolves to its directory as the repo root.
# Config is still read ONLY from .rad/config.yml — no CLAUDE.md data fallback.
if [[ -f "$ROOT" ]]; then
  ROOT="$(dirname -- "$ROOT")"
fi
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

# Exit 0 with no output means the CLI never answered (e.g. the #168 symlink
# main-module guard) — an error, never an empty branch name or a silent `main`.
if [[ -z "$branch" ]]; then
  echo "get-default-branch: rad config get default_branch exited 0 with no output — failing closed" >&2
  exit 1
fi
echo "$branch"
