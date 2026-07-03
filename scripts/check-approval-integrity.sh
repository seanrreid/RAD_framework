#!/usr/bin/env bash
# check-approval-integrity.sh
# Deliver-PR integrity check over a feature's approval authority. Verifies, at
# the PR head, that the recorded approval is REAL (ancestry), CURRENT
# (fingerprint + gate), and AUTHENTIC (authored by the configured architect):
#
#   (a) ANCESTRY      — the commit that introduced the gating (latest) `approved`
#                       event line in .agents/state/<feature>/events.jsonl must be
#                       an ancestor of HEAD (git merge-base --is-ancestor; merge
#                       commits reachable through history pass).
#   (b) FINGERPRINT   — the approved event's data.fingerprint must equal the
#       + GATE          current `rad plan-fingerprint` of the plan doc (legacy
#                       events with NO stored fingerprint warn but PASS, mirroring
#                       check-plan-approved.sh's deliberate narrow fail-open);
#                       then the events JSONL must satisfy the pure gate fold
#                       (`rad gate <feature> approved --stdin`).
#   (c) AUTHENTICITY  — the introducing commit's git author email must match the
#                       architect identity parsed from CLAUDE.md Role Assignments
#                       (same parse as check-role.sh). RAD_ARCHITECT_OVERRIDE
#                       wins when set.
#   (d) OWNERSHIP     — advisory ONLY: if the log's last ownership event is an
#                       owner-claimed with no later owner-released, print an
#                       "advisory:" line. Never affects the exit code.
#
# Events-log resolution mirrors check-plan-approved.sh (origin/<work-branch> →
# origin/<base> → local), except the local fallback is HEAD — ancestry needs a
# COMMITTED log, so an uncommitted-only log fails closed. All ambiguity (missing
# plan, missing log, unparseable event, undeterminable ancestry) fails closed.
#
# Usage: scripts/check-approval-integrity.sh <work-branch> [base-branch]
#   e.g. scripts/check-approval-integrity.sh rad/email-confirmation main
#
# Exit codes:
#   0 = approval integrity verified
#   1 = check failed (or any ambiguity — fail closed)
#   2 = usage error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$REPO_ROOT/harness/cli.js"

WORK_BRANCH="${1:-}"
BASE_BRANCH="${2:-$("$SCRIPT_DIR/get-default-branch.sh" 2>/dev/null || echo main)}"

[[ -z "$WORK_BRANCH" ]] && {
  echo "Usage: check-approval-integrity.sh <work-branch> [base-branch]"
  exit 2
}

# Strip any prefix (rad/, or a custom RAD_BRANCH_PREFIX) to get the feature slug
# → event-log + plan paths. Same derivation as check-plan-approved.sh.
FEATURE="${WORK_BRANCH##*/}"
EVENTS_FILE=".agents/state/${FEATURE}/events.jsonl"
PLAN_FILE=".agents/plans/${FEATURE}.md"

# ── Resolve the committed event log + the ref it came from ────────────────────
# Order mirrors check-plan-approved.sh: origin/<work-branch> tip, then
# origin/<base> (merged), then local — but the local fallback here is HEAD, not
# the working tree: ancestry/authenticity need a COMMITTED introducing commit.
EVENTS_REF=""
EVENTS_JSONL=""
for ref in "origin/${WORK_BRANCH}" "origin/${BASE_BRANCH}" "HEAD"; do
  if EVENTS_JSONL=$(git show "${ref}:${EVENTS_FILE}" 2>/dev/null); then
    EVENTS_REF="$ref"
    break
  fi
done

if [[ -z "$EVENTS_REF" ]]; then
  if [[ -f "$EVENTS_FILE" ]]; then
    echo "FAIL: event log '${EVENTS_FILE}' exists only in the working tree (uncommitted) — ancestry undeterminable. Failing closed."
  else
    echo "FAIL: no event log found for '${WORK_BRANCH}' (looked on origin/${WORK_BRANCH}, origin/${BASE_BRANCH}, HEAD). Failing closed."
  fi
  exit 1
fi

# ── Parse the gating (latest) approved event + ownership state ────────────────
# One pass over the JSONL. Any unparseable line is ambiguity → fail closed.
# Emits shell-greppable key=value lines.
PARSED=$(printf '%s' "$EVENTS_JSONL" | node -e '
  const fs = require("fs");
  const lines = fs.readFileSync(0, "utf8").split("\n");
  let approvedLine = 0;   // 1-based line number of the gating approved event
  let fingerprint = "";
  let staleClaim = 0;     // last ownership event is owner-claimed, unreleased
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    let ev;
    try { ev = JSON.parse(raw); } catch {
      process.stdout.write("parse_error=" + (i + 1) + "\n");
      process.exit(0);
    }
    if (!ev || typeof ev !== "object") {
      process.stdout.write("parse_error=" + (i + 1) + "\n");
      process.exit(0);
    }
    if (ev.type === "approved") {
      approvedLine = i + 1; // latest approved wins (re-approval histories)
      fingerprint = (ev.data && typeof ev.data.fingerprint === "string")
        ? ev.data.fingerprint : "";
    } else if (ev.type === "owner-claimed") {
      staleClaim = 1;
    } else if (ev.type === "owner-released") {
      staleClaim = 0;
    }
  }
  process.stdout.write("parse_error=0\n");
  process.stdout.write("approved_line=" + approvedLine + "\n");
  process.stdout.write("fingerprint=" + fingerprint + "\n");
  process.stdout.write("stale_claim=" + staleClaim + "\n");
') || { echo "FAIL: could not parse event log '${EVENTS_FILE}' at ${EVENTS_REF}. Failing closed."; exit 1; }

PARSE_ERROR=$(printf '%s\n' "$PARSED" | sed -n 's/^parse_error=//p')
APPROVED_LINE=$(printf '%s\n' "$PARSED" | sed -n 's/^approved_line=//p')
STORED_FP=$(printf '%s\n' "$PARSED" | sed -n 's/^fingerprint=//p')
STALE_CLAIM=$(printf '%s\n' "$PARSED" | sed -n 's/^stale_claim=//p')

if [[ -z "$PARSE_ERROR" || "$PARSE_ERROR" != "0" ]]; then
  echo "FAIL: unparseable event at ${EVENTS_FILE}:${PARSE_ERROR:-?} (${EVENTS_REF}). Failing closed."
  exit 1
fi

if [[ -z "$APPROVED_LINE" || "$APPROVED_LINE" == "0" ]]; then
  echo "FAIL: no approved event found in ${EVENTS_FILE} at ${EVENTS_REF}. Failing closed."
  exit 1
fi

# ── (a) ANCESTRY — introducing commit of the gating approved line ─────────────
BLAME_HEAD=$(git blame --line-porcelain -L "${APPROVED_LINE},${APPROVED_LINE}" \
  "$EVENTS_REF" -- "$EVENTS_FILE" 2>/dev/null | head -1) || BLAME_HEAD=""
APPROVAL_COMMIT=$(printf '%s' "$BLAME_HEAD" | awk '{print $1}')

if [[ -z "$APPROVAL_COMMIT" || "$APPROVAL_COMMIT" == 0000000000000000000000000000000000000000 ]]; then
  echo "FAIL: cannot determine the commit that introduced the approved event (blame at ${EVENTS_REF}:${EVENTS_FILE}:${APPROVED_LINE}). Failing closed."
  exit 1
fi

if ! git merge-base --is-ancestor "$APPROVAL_COMMIT" HEAD 2>/dev/null; then
  echo "FAIL: approval commit ${APPROVAL_COMMIT} is NOT an ancestor of HEAD — the approved event on ${EVENTS_REF} is not part of this PR's history. Failing closed."
  exit 1
fi
echo "ok: ancestry — approval commit ${APPROVAL_COMMIT} is an ancestor of HEAD"

# ── (b) FINGERPRINT + GATE ────────────────────────────────────────────────────
if [[ ! -f "$PLAN_FILE" ]]; then
  echo "FAIL: plan doc '${PLAN_FILE}' not found in the working tree. Failing closed."
  exit 1
fi

if [[ -z "$STORED_FP" ]]; then
  # LEGACY FAIL-OPEN: pre-fingerprint approved events carry no data.fingerprint;
  # we cannot prove the plan was edited. Deliberate, narrow — mirrors
  # check-plan-approved.sh's local gate semantics.
  echo "warn: approved event has no data.fingerprint (legacy) — skipping fingerprint compare"
else
  if ! CURRENT_FP=$(node "$CLI" plan-fingerprint "$PLAN_FILE" 2>/dev/null); then
    echo "FAIL: could not compute plan fingerprint for '${PLAN_FILE}'. Failing closed."
    exit 1
  fi
  CURRENT_FP="${CURRENT_FP//$'\n'/}"
  if [[ "$STORED_FP" != "$CURRENT_FP" ]]; then
    echo "FAIL: plan modified after approval — fingerprint mismatch for '${FEATURE}' (stored ${STORED_FP}, current ${CURRENT_FP}). Re-run /rad-approve."
    exit 1
  fi
  echo "ok: fingerprint — plan doc matches the approved fingerprint"
fi

if ! printf '%s' "$EVENTS_JSONL" | node "$CLI" gate "$FEATURE" approved --stdin; then
  echo "FAIL: gate fold rejected the event log — 'approved' gate not satisfied for '${FEATURE}'."
  exit 1
fi
echo "ok: gate — approved gate satisfied by the event fold"

# ── (c) AUTHENTICITY — introducing commit authored by the architect ───────────
if [[ -n "${RAD_ARCHITECT_OVERRIDE:-}" ]]; then
  ARCHITECT="$RAD_ARCHITECT_OVERRIDE"
else
  # Same Role Assignments parse as check-role.sh (architect line, first match).
  ARCHITECT=$(grep "^architect:" CLAUDE.md 2>/dev/null | head -1 \
    | sed "s/^architect:[[:space:]]*//" \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//') || ARCHITECT=""
fi

if [[ -z "$ARCHITECT" ]]; then
  echo "FAIL: no architect configured (CLAUDE.md Role Assignments empty and RAD_ARCHITECT_OVERRIDE unset). Failing closed."
  exit 1
fi

AUTHOR_EMAIL=$(git log -1 --format=%ae "$APPROVAL_COMMIT" 2>/dev/null) || AUTHOR_EMAIL=""
AUTHOR_USER="${AUTHOR_EMAIL%%@*}"

if [[ -z "$AUTHOR_EMAIL" ]]; then
  echo "FAIL: cannot read author email of approval commit ${APPROVAL_COMMIT}. Failing closed."
  exit 1
fi

if [[ "$AUTHOR_EMAIL" != "$ARCHITECT" && "$AUTHOR_USER" != "$ARCHITECT" ]]; then
  echo "FAIL: approval commit ${APPROVAL_COMMIT} authored by '${AUTHOR_EMAIL}', not the configured architect '${ARCHITECT}'."
  exit 1
fi
echo "ok: authenticity — approval commit authored by architect '${ARCHITECT}'"

# ── (d) OWNERSHIP ADVISORY — never affects the exit code ─────────────────────
if [[ "$STALE_CLAIM" == "1" ]]; then
  echo "advisory: last ownership event is an unreleased owner-claimed — the feature may still be claimed on another machine (informational only)."
fi

echo "PASS: approval integrity verified for '${FEATURE}' (log at ${EVENTS_REF})"
exit 0
