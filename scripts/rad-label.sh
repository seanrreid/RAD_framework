#!/usr/bin/env bash
# rad-label.sh
# Mirror a plan's RAD status onto its GitHub issue (or PR) as a single
# rad:<status> label. This is a fetch-free "board" convenience layer — git branch
# tips remain the canonical source of truth; issue/PR labels are a mirror for
# dashboards that don't want to read every rad/ branch.
#
# Applies exactly one rad: status label, removing any other rad: status labels.
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

# All known RAD status labels and their colors (GitHub hex, no leading #).
declare -A LABEL_COLOR=(
  [draft]="cccccc"
  [ready]="0e8a16"
  [pending-review]="fbca04"
  [needs-revision]="e99695"
  [rejected]="b60205"
  [approved]="1d76db"
  [in-progress]="d93f0b"
  [review]="5319e7"
  [done]="0b5c2e"
)

if [[ -z "${LABEL_COLOR[$STATUS]:-}" ]]; then
  echo "ERROR: unknown status '$STATUS' (expected: ${!LABEL_COLOR[*]})" >&2
  exit 1
fi

# Gracefully no-op when gh isn't available/authenticated — local-only flows and
# non-GitHub platforms. The git branch tip is still canonical.
if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
  echo "gh unavailable — skipping label mirror (git branch tip is canonical)."
  exit 0
fi

LABEL="rad:${STATUS}"

# Ensure the target label exists (create-if-missing; ignore "already exists").
gh label create "$LABEL" --color "${LABEL_COLOR[$STATUS]}" \
  --description "RAD plan status: ${STATUS}" >/dev/null 2>&1 || true

# Remove any other rad: status labels currently on the target, then add this one.
# --remove-label is a no-op for labels not present, so passing all siblings is safe.
REMOVE_ARGS=()
for s in "${!LABEL_COLOR[@]}"; do
  [[ "$s" == "$STATUS" ]] && continue
  REMOVE_ARGS+=(--remove-label "rad:${s}")
done

# `gh issue edit` also accepts PR numbers (issues and PRs share a number space),
# so a single call handles both. The mirror is best-effort: a failure must NOT
# fail the calling RAD command, but we also must not claim success — warn, exit 0.
if gh issue edit "$TARGET" --add-label "$LABEL" "${REMOVE_ARGS[@]}" >/dev/null 2>&1 \
  || gh issue edit "$TARGET" --add-label "$LABEL" >/dev/null 2>&1; then
  echo "#${TARGET} → ${LABEL}"
else
  echo "WARN: could not mirror label ${LABEL} onto #${TARGET} — git branch tips are still authoritative." >&2
fi
