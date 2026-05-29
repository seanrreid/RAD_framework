#!/usr/bin/env bash
# checkout-plan.sh
# Check out a RAD work branch at its remote tip — the one safe idiom shared by
# every RAD command (rad-plan, rad-approve, rad-deliver). Under the Lane B model
# the plan doc lives on its work branch (not the default branch) until the deliver
# PR merges, so reading or writing a plan MUST be done against the remote tip, not
# a possibly-stale local copy.
#
# Behavior:
#   - validate the branch name against the configured work prefix (default `rad/`)
#   - fetch the branch from origin; fail loudly if it doesn't exist
#   - check out a local tracking branch from origin (or switch to the existing one)
#   - fast-forward to the remote tip; fail loudly if local has diverged
#
# Usage: scripts/checkout-plan.sh rad/<feature>
#
# Exit codes:
#   0 = on the branch at its remote tip
#   1 = invalid name, missing branch, or divergence
#
# The work-branch prefix can be overridden via the RAD_BRANCH_PREFIX env var
# (default `rad/`) for projects that configure a different convention.

set -euo pipefail

BRANCH="${1:-}"
PREFIX="${RAD_BRANCH_PREFIX:-rad/}"

[[ -z "$BRANCH" ]] && { echo "usage: checkout-plan.sh ${PREFIX}<feature>" >&2; exit 1; }

# Enforce the work-branch contract before touching git — never route a RAD flow
# onto the default branch or a stray feature/fix branch. The prefix is escaped so
# a custom prefix with regex metacharacters is matched literally.
ESCAPED_PREFIX=$(printf '%s' "$PREFIX" | sed 's/[.[\*^$()+?{|]/\\&/g')
if [[ ! "$BRANCH" =~ ^${ESCAPED_PREFIX}[a-z0-9][a-z0-9-]*$ ]]; then
  echo "✗ Invalid branch '$BRANCH'. Expected: ${PREFIX}<feature> (lowercase, digits, hyphens)." >&2
  exit 1
fi

if ! git fetch origin "$BRANCH" 2>/dev/null; then
  echo "✗ Work branch '$BRANCH' not found on origin — was the plan created with /rad-plan?" >&2
  exit 1
fi

# Switch to the branch: existing local branch, or a fresh tracking branch from origin.
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" --track "origin/$BRANCH"

# Ensure we're exactly at the remote tip. ff-only fails loudly on divergence
# (e.g. a force-push) rather than silently leaving us on stale content.
if ! git pull --ff-only origin "$BRANCH"; then
  echo "✗ Local '$BRANCH' has diverged from origin (force-push or conflicting commits)." >&2
  echo "  Resolve or reset to origin/$BRANCH, then re-run the command." >&2
  exit 1
fi
