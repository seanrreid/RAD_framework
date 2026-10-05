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
#                       architect identity in .rad/config.yml roles.architect
#                       (read via `rad config get`, as check-role.sh does).
#                       RAD_ARCHITECT_OVERRIDE wins when set; a missing/invalid
#                       config fails closed.
#   (d) OWNERSHIP     — advisory ONLY: if the log's last ownership event is an
#                       owner-claimed with no later owner-released, print an
#                       "advisory:" line. Never affects the exit code.
#   (e) HIGH-RISK     — advisory ONLY: if the gating approved event carries
#       PATTERN         data.highRiskPattern (frozen by `rad approve` only when it
#                       ran under a non-default pattern), print it verbatim on an
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
readonly CONFIG_KEY_ABSENT_EXIT=3

readonly CONFIG_ERROR_EXIT=2

WORK_BRANCH="${1:-}"

[[ -z "$WORK_BRANCH" ]] && {
  echo "Usage: check-approval-integrity.sh <work-branch> [base-branch]"
  exit 2
}

# An explicit base skips the lookup. Otherwise a config error fails closed: the
# lookup's own stderr reason passes through and no ref is compared against main.
if [[ -n "${2:-}" ]]; then
  BASE_BRANCH="$2"
else
  BASE_BRANCH=$("$SCRIPT_DIR/get-default-branch.sh") || {
    echo "ERROR: check-approval-integrity: cannot resolve the default branch (reason above); pass a base branch explicitly" >&2
    exit "$CONFIG_ERROR_EXIT"
  }
fi

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
  let policy = 0;         // gating approval was recorded by a machine policy
  let staleClaim = 0;     // last ownership event is owner-claimed, unreleased
  let highRiskPattern = ""; // gating approval ran under a non-default pattern
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
      // Machine-policy provenance (the retired severity-gate auto-clear): a
      // human architect must record every approval, so this can never gate.
      policy = (ev.actor === "severity-gate" || ev.recordedBy === "policy") ? 1 : 0;
      // Only a non-empty string counts; reset per approved so only the GATING
      // (latest) event decides.
      highRiskPattern = (ev.data && typeof ev.data.highRiskPattern === "string")
        ? ev.data.highRiskPattern : "";
    } else if (ev.type === "owner-claimed") {
      staleClaim = 1;
    } else if (ev.type === "owner-released") {
      staleClaim = 0;
    }
  }
  process.stdout.write("parse_error=0\n");
  process.stdout.write("approved_line=" + approvedLine + "\n");
  process.stdout.write("fingerprint=" + fingerprint + "\n");
  process.stdout.write("policy=" + policy + "\n");
  process.stdout.write("stale_claim=" + staleClaim + "\n");
  // The pattern is arbitrary text (| ( ) ^ $ ...): it rides as data on its own
  // key=value line, never eval-ed. Line breaks are escaped so it stays one line.
  process.stdout.write("high_risk_pattern=" +
    highRiskPattern.replace(/\r/g, "\\r").replace(/\n/g, "\\n") + "\n");
') || { echo "FAIL: could not parse event log '${EVENTS_FILE}' at ${EVENTS_REF}. Failing closed."; exit 1; }

PARSE_ERROR=$(printf '%s\n' "$PARSED" | sed -n 's/^parse_error=//p')
APPROVED_LINE=$(printf '%s\n' "$PARSED" | sed -n 's/^approved_line=//p')
STORED_FP=$(printf '%s\n' "$PARSED" | sed -n 's/^fingerprint=//p')
STALE_CLAIM=$(printf '%s\n' "$PARSED" | sed -n 's/^stale_claim=//p')
POLICY_APPROVAL=$(printf '%s\n' "$PARSED" | sed -n 's/^policy=//p')
HIGH_RISK_PATTERN=$(printf '%s\n' "$PARSED" | sed -n 's/^high_risk_pattern=//p')

if [[ -z "$PARSE_ERROR" || "$PARSE_ERROR" != "0" ]]; then
  echo "FAIL: unparseable event at ${EVENTS_FILE}:${PARSE_ERROR:-?} (${EVENTS_REF}). Failing closed."
  exit 1
fi

if [[ -z "$APPROVED_LINE" || "$APPROVED_LINE" == "0" ]]; then
  echo "FAIL: no approved event found in ${EVENTS_FILE} at ${EVENTS_REF}. Failing closed."
  exit 1
fi

# Missing/empty policy flag is ambiguity, not a pass — only an explicit 0 clears.
if [[ "$POLICY_APPROVAL" != "0" ]]; then
  echo "FAIL: approval was recorded by a machine policy, not a human architect. Failing closed."
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
# RAD_ARCHITECT_OVERRIDE wins; otherwise roles.architect from .rad/config.yml
# (one identity per line). A missing/invalid config fails closed.
if [[ -n "${RAD_ARCHITECT_OVERRIDE:-}" ]]; then
  ARCHITECTS="$RAD_ARCHITECT_OVERRIDE"
else
  ARCH_RC=0
  ARCH_ERR=$(mktemp "${TMPDIR:-/tmp}/check-approval-integrity.XXXXXX")
  ARCHITECTS=$(node "$CLI" config get roles.architect 2>"$ARCH_ERR") || ARCH_RC=$?
  if [[ "$ARCH_RC" -ne 0 && "$ARCH_RC" -ne "$CONFIG_KEY_ABSENT_EXIT" ]]; then
    echo "FAIL: cannot read roles.architect from .rad/config.yml (rad config get exit ${ARCH_RC}). Failing closed."
    sed 's/^/  /' "$ARCH_ERR"
    rm -f "$ARCH_ERR"
    exit 1
  fi
  rm -f "$ARCH_ERR"
fi

if [[ -z "$ARCHITECTS" ]]; then
  echo "FAIL: no architect configured (roles.architect in .rad/config.yml empty and RAD_ARCHITECT_OVERRIDE unset). Failing closed."
  exit 1
fi

AUTHOR_EMAIL=$(git log -1 --format=%ae "$APPROVAL_COMMIT" 2>/dev/null) || AUTHOR_EMAIL=""
AUTHOR_USER="${AUTHOR_EMAIL%%@*}"

if [[ -z "$AUTHOR_EMAIL" ]]; then
  echo "FAIL: cannot read author email of approval commit ${APPROVAL_COMMIT}. Failing closed."
  exit 1
fi

ARCHITECT=""
while IFS= read -r candidate; do
  [[ -z "$candidate" ]] && continue
  if [[ "$AUTHOR_EMAIL" == "$candidate" || "$AUTHOR_USER" == "$candidate" ]]; then
    ARCHITECT="$candidate"
    break
  fi
done <<< "$ARCHITECTS"

if [[ -z "$ARCHITECT" ]]; then
  ARCH_LIST=$(printf '%s\n' "$ARCHITECTS" | paste -sd ',' -)
  echo "FAIL: approval commit ${APPROVAL_COMMIT} authored by '${AUTHOR_EMAIL}', not the configured architect '${ARCH_LIST}'."
  exit 1
fi
echo "ok: authenticity — approval commit authored by architect '${ARCHITECT}'"

# ── (d) OWNERSHIP ADVISORY — never affects the exit code ─────────────────────
if [[ "$STALE_CLAIM" == "1" ]]; then
  echo "advisory: last ownership event is an unreleased owner-claimed — the feature may still be claimed on another machine (informational only)."
fi

# ── (e) HIGH-RISK PATTERN ADVISORY — never affects the exit code ─────────────
# printf '%s' keeps shell metacharacters in the pattern inert and verbatim.
if [[ -n "$HIGH_RISK_PATTERN" ]]; then
  printf 'advisory: approval recorded under a non-default high-risk pattern: %s\n' "$HIGH_RISK_PATTERN"
fi

echo "PASS: approval integrity verified for '${FEATURE}' (log at ${EVENTS_REF})"
exit 0
