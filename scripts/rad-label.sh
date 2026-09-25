#!/usr/bin/env bash
# rad-label.sh
# Mirror a plan's RAD status onto its GitHub issue (or PR) as a single
# rad:<status> label. This is a fetch-free "board" convenience layer — git branch
# tips remain the canonical source of truth; issue/PR labels are a mirror for
# dashboards that don't want to read every rad/ branch.
#
# Applies exactly one rad: status label, removing any other rad: status labels
# that are actually present on the target.
# Labels are created on first use (self-healing) so there is no separate setup step.
#
# Usage: scripts/rad-label.sh <issue-or-pr-number> <status>
#   status ∈ draft | ready | pending-review | needs-revision | rejected
#            | approved | in-progress | review | done
#
# Safe to call from any RAD command. No-ops (exit 0) if gh is unavailable or
# unauthenticated, so local flows and non-GitHub platforms never break.

set -euo pipefail

TARGET="${1:-}"
STATUS="${2:-}"

[[ -z "$TARGET" ]] && { echo "ERROR: issue/PR number required" >&2; exit 1; }
[[ -z "$STATUS" ]] && { echo "ERROR: status required" >&2; exit 1; }

# All known RAD status labels. Kept as a plain list + case map so the script runs
# on bash 3.2 (macOS stock) as well as bash 4+ — no associative arrays.
ALL_STATUSES="draft ready pending-review needs-revision rejected approved in-progress review done"

status_color() {
  case "$1" in
    draft)          echo "cccccc" ;;
    ready)          echo "0e8a16" ;;
    pending-review) echo "fbca04" ;;
    needs-revision) echo "e99695" ;;
    rejected)       echo "b60205" ;;
    approved)       echo "1d76db" ;;
    in-progress)    echo "d93f0b" ;;
    review)         echo "5319e7" ;;
    done)           echo "0b5c2e" ;;
    *)              echo "" ;;
  esac
}

COLOR=$(status_color "$STATUS")
if [[ -z "$COLOR" ]]; then
  echo "ERROR: unknown status '$STATUS' (expected: $ALL_STATUSES)" >&2
  exit 1
fi

# Gracefully no-op when gh isn't available/authenticated — local-only flows and
# non-GitHub platforms. The git branch tip is still canonical.
if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
  echo "gh unavailable — skipping label mirror (git branch tip is canonical)."
  exit 0
fi

STATUS_PREFIX="rad:"
LABEL="${STATUS_PREFIX}${STATUS}"

# Label creation is create-if-missing: "already exists" is the EXPECTED failure on
# every call after the first, and any other failure (e.g. no permission) surfaces
# in the `gh issue edit` below, which does warn — so discarding it here hides nothing.
gh label create "$LABEL" --color "$COLOR" \
  --description "RAD plan status: ${STATUS}" >/dev/null 2>&1 || true

# Read the target's current labels. Prints names on stdout; on failure prints the
# gh error on stdout and returns non-zero so the caller can quote it in a WARN.
read_target_labels() {
  local err_file out
  err_file=$(mktemp) || { echo "mktemp failed"; return 1; }
  if out=$(gh issue view "$TARGET" --json labels -q '.labels[].name' 2>"$err_file"); then
    rm -f "$err_file"
    printf '%s\n' "$out"
    return 0
  fi
  out=$(cat "$err_file")
  rm -f "$err_file"
  echo "${out:-gh issue view failed}"
  return 1
}

# --remove-label for a label the target does not carry is NOT a safe no-op (gh can
# fail the whole edit), so only statuses actually present — and not the new one —
# are passed for removal.
REMOVE_ARGS=()
LABEL_READ_ERR=""
if CURRENT_LABELS=$(read_target_labels); then
  for s in $ALL_STATUSES; do
    [[ "$s" == "$STATUS" ]] && continue
    case $'\n'"$CURRENT_LABELS"$'\n' in
      (*$'\n'"${STATUS_PREFIX}${s}"$'\n'*) REMOVE_ARGS+=(--remove-label "${STATUS_PREFIX}${s}") ;;
    esac
  done
else
  LABEL_READ_ERR="$CURRENT_LABELS"
fi

warn_stale() {
  echo "WARN: added ${LABEL} to #${TARGET} but could not remove stale status labels: $1" >&2
}

# `gh issue edit` also accepts PR numbers (issues and PRs share a number space),
# so a single call handles both. The mirror is best-effort: a failure must NOT
# fail the calling RAD command, but we also must not claim success — warn, exit 0.
# `2>&1 >/dev/null` captures only gh's stderr (the error text) into the variable.
# The `${arr[@]+...}` form keeps an empty array safe under set -u on bash 3.2.
if SWAP_ERR=$(gh issue edit "$TARGET" --add-label "$LABEL" \
    ${REMOVE_ARGS[@]+"${REMOVE_ARGS[@]}"} 2>&1 >/dev/null); then
  if [[ -n "$LABEL_READ_ERR" ]]; then
    warn_stale "could not read current labels: ${LABEL_READ_ERR}"
  else
    echo "#${TARGET} → ${LABEL}"
  fi
elif gh issue edit "$TARGET" --add-label "$LABEL" >/dev/null 2>&1; then
  warn_stale "${SWAP_ERR:-gh issue edit failed}"
else
  echo "WARN: could not mirror label ${LABEL} onto #${TARGET} — git branch tips are still authoritative." >&2
fi
