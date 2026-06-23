#!/usr/bin/env bash
# check-plan-approved.sh
# Checks whether a plan has been approved for execution (Lane B model).
#
# Authority lives in the event log, not the plan doc. /rad-approve records an
# `approved` event (with a frozen architect `role`) into the feature's event log
# at .agents/state/<feature>/events.jsonl. This script resolves that log from the
# canonical source — the work branch (rad/<feature>) tip — and feeds it to the
# pure gate fold (`rad gate <feature> approved --stdin`), mapping its exit code
# through. The plan-doc `Status:` header is no longer consulted; a doc that says
# "approved" without a matching approved event does NOT pass (AC#2).
#
# Resolution order mirrors the old plan-doc logic so the gate works pre-checkout
# (AC#3 — /rad-deliver Step 2 runs this BEFORE checkout, so the log is read from
# the branch tip): origin/<work-branch> tip, then origin/<base> (merged), then the
# local working tree. A missing log at every ref fails CLOSED — absence never
# passes the gate.
#
# Platform-agnostic: uses only `git show` — no gh/glab/PR-merge dependency.
#
# Usage: scripts/check-plan-approved.sh rad/<feature> [base-branch]
#   e.g. scripts/check-plan-approved.sh rad/email-confirmation develop
#
# Exit codes:
#   0 = approved (an approved event satisfies the gate at the resolved ref)
#   1 = not approved (no satisfying event, missing log, or error — fail closed)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$REPO_ROOT/harness/cli.js"

WORK_BRANCH="${1:-}"
BASE_BRANCH="${2:-$("$SCRIPT_DIR/get-default-branch.sh" 2>/dev/null || echo main)}"

[[ -z "$WORK_BRANCH" ]] && { echo "ERROR: work branch name required (e.g. rad/<feature>)"; exit 1; }

# Strip any prefix (rad/, plan/, deliver/) to get the feature slug → event-log path.
FEATURE="${WORK_BRANCH##*/}"
EVENTS_FILE=".agents/state/${FEATURE}/events.jsonl"

# Resolve the event log JSONL from the canonical ref and echo it to stdout.
# Returns 0 (with content on stdout) when a log is found, 1 when none exists at
# any ref. Tries the work-branch tip first (pre-checkout, branch-tip canonical),
# then the merged default branch, then the local working tree.
resolve_events() {
  local content

  # 1. Canonical: the plan's own work-branch tip on origin.
  if content=$(git show "origin/${WORK_BRANCH}:${EVENTS_FILE}" 2>/dev/null); then
    printf '%s' "$content"
    return 0
  fi

  # 2. Merged: the event log has landed on the default branch.
  if content=$(git show "origin/${BASE_BRANCH}:${EVENTS_FILE}" 2>/dev/null); then
    printf '%s' "$content"
    return 0
  fi

  # 3. Local working tree (approved but not yet pushed).
  if [[ -f "$EVENTS_FILE" ]]; then
    cat "$EVENTS_FILE"
    return 0
  fi

  return 1
}

# Portable process memory (RAD_SYNC-gated): before resolving the event log from
# the branch tip, fetch origin/<work-branch> so an approval recorded on ANOTHER
# machine is honored here without a manual pull. GATED on RAD_SYNC — unset/empty
# short-circuits, so with RAD_SYNC off there is NO fetch and behavior is identical
# to today (AC#5). Best-effort: fetch failure (offline / no remote ref) must never
# block the gate-read, which already falls back to merged/local refs and fails
# closed on a truly missing log. Plain git only; credentials are inherited.
if [[ -n "${RAD_SYNC:-}" ]]; then
  "$SCRIPT_DIR/git-sync.sh" fetch-tip "$WORK_BRANCH" >/dev/null 2>&1 || true
fi

EVENTS_JSONL=$(resolve_events) || {
  echo "unknown — no event log found for '${WORK_BRANCH}' (looked on origin/${WORK_BRANCH}, origin/${BASE_BRANCH}, and ${EVENTS_FILE}). Failing closed."
  exit 1
}

# Pipe the resolved JSONL through the pure gate fold. The verb exits 0 when the
# approved gate is satisfied, non-zero otherwise (including an empty log → fail
# closed). Map its exit code straight through.
printf '%s' "$EVENTS_JSONL" | node "$CLI" gate "$FEATURE" approved --stdin
