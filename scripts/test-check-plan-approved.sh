#!/usr/bin/env bash
# test-check-plan-approved.sh
# Regression tests for the rewritten check-plan-approved.sh (decision-2 cutover).
#
# Authority moved from the plan-doc `Status:` header to the branch-tip event log
# (.agents/state/<feature>/events.jsonl), fed through `rad gate <feature> approved`.
# These tests assert the AC#2 divergence cases and AC#3 branch-tip resolution:
#   (a) doc says "Status: approved" but NO approved event  → gate FAILS  (exit 1)
#   (b) approved event present but doc Status stale/absent → gate PASSES (exit 0)
#   (c) missing event log at every ref                     → fails closed (exit 1)
# It exercises the local-working-tree resolution path, the origin/<work-branch>
# branch-tip path, and the missing-log path, against the REAL script + CLI.
#
# Self-contained (no external harness): builds temp git-repo fixtures, runs the
# real check-plan-approved.sh in the real repo (so it resolves the real harness
# CLI via SCRIPT_DIR/../harness/cli.js), and asserts the exit code.
#
# macOS realpath quirk: /tmp is a /var→/private/var symlink and the CLI's
# self-invocation/realpath guard misbehaves under it. We build the temp git
# fixtures under $HOME (non-symlinked) to avoid tripping that guard. Runs under
# bash 3.2+ (set -u safe).
#
# Usage: scripts/test-check-plan-approved.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
SCRIPT="$HERE/check-plan-approved.sh"

# Build fixtures under $HOME (non-symlinked) — see header note on the macOS quirk.
TMP="$(mktemp -d "${HOME}/.rad-test-cpa.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

APPROVED_EVENT='{"feature":"FEAT","type":"approved","actor":"sean@torchcodelab.com","role":"architect","ts":"2026-06-12T13:42:41.192Z","recordedBy":"sean@torchcodelab.com"}'

# run_check FEATURE [BASE]
# Runs the real check-plan-approved.sh from inside the fixture working dir so the
# local-working-tree resolution path (case 3) reads $TMP/<fixture>/.agents/state.
# The script itself still lives in the real repo, so it finds the real harness CLI.
# Captures the exit code without tripping set -e.
run_check() {
  local feature="$1" base="${2:-main}" dir="$3"
  local code
  set +e
  ( cd "$dir" && bash "$SCRIPT" "rad/${feature}" "$base" ) >/dev/null 2>&1
  code=$?
  set -e
  echo "$code"
}

# ── (a) AC#2: doc says "Status: approved" but NO approved event → FAILS (exit 1) ─
# Authority is the event log, not the doc header. A doc that claims approval
# without a matching approved event must NOT pass the gate (fails closed via the
# missing-log path, since there is no event log at all here).
t_doc_approved_no_event() {
  local feature="doc-says-approved"
  local d="$TMP/$feature"
  mkdir -p "$d/.agents/plans"
  # The plan doc loudly claims approval — the script must ignore it.
  printf '# Plan: t\nStatus: approved\nBranch: rad/%s\n' "$feature" > "$d/.agents/plans/${feature}.md"
  # Deliberately NO .agents/state/<feature>/events.jsonl.

  local code
  code=$(run_check "$feature" main "$d")
  [[ "$code" -eq 1 ]] || fail "(a) doc Status:approved with no approved event should FAIL closed (got $code)"
  echo "✓ (a) AC#2: doc Status:approved without an approved event FAILS the gate (exit 1)"
}

# ── (b) AC#2: approved event present, doc Status stale/absent → PASSES (exit 0) ──
# The inverse divergence: the event log carries an architect-role approved event
# while the plan doc has a stale (or missing) Status header. Authority is the
# event log, so the gate PASSES. Exercises the local-working-tree path (case 3).
t_event_present_doc_stale() {
  local feature="event-present-doc-stale"
  local d="$TMP/$feature"
  mkdir -p "$d/.agents/plans" "$d/.agents/state/${feature}"
  # Doc Status is stale/wrong — must be ignored by the rewritten script.
  printf '# Plan: t\nStatus: pending-review\nBranch: rad/%s\n' "$feature" > "$d/.agents/plans/${feature}.md"
  printf '%s\n' "${APPROVED_EVENT/FEAT/$feature}" > "$d/.agents/state/${feature}/events.jsonl"

  local code
  code=$(run_check "$feature" main "$d")
  [[ "$code" -eq 0 ]] || fail "(b) approved event with stale doc Status should PASS (got $code)"
  echo "✓ (b) AC#2: approved event PASSES even with a stale/absent doc Status (exit 0)"
}

# ── (c) AC#3: missing event log at every ref → fails closed (exit 1) ────────────
# No origin, no merged base, no local working-tree log. Absence never passes.
t_missing_log_fails_closed() {
  local feature="totally-missing"
  local d="$TMP/$feature"
  mkdir -p "$d/.agents/plans"
  # No event log anywhere, and not a git repo with any origin → all three
  # resolution refs miss; resolve_events returns 1; script fails closed.
  printf '# Plan: t\nBranch: rad/%s\n' "$feature" > "$d/.agents/plans/${feature}.md"

  local code
  code=$(run_check "$feature" main "$d")
  [[ "$code" -eq 1 ]] || fail "(c) missing event log should fail closed (got $code)"
  echo "✓ (c) AC#3: a missing event log fails CLOSED (exit 1)"
}

# ── (d) AC#3: branch-tip resolution — approved event on origin/<work-branch> ────
# The canonical resolution path. The local working tree has NO event log; the
# approved event lives only on the work-branch tip of an `origin` remote. The
# script must resolve it via `git show origin/<work-branch>:<events-file>` and
# PASS — proving branch-tip authority works pre-checkout. A local bare repo plays
# the role of `origin` (no live network).
t_branch_tip_resolution() {
  local feature="branch-tip-feat"
  local work="$TMP/$feature-work"     # the "origin"-bearing work clone
  local origin="$TMP/$feature-origin.git"
  local events=".agents/state/${feature}/events.jsonl"

  # Bare repo standing in for origin.
  git init -q --bare "$origin"

  # Work repo: commit the approved event onto the work branch, push to origin.
  mkdir -p "$work"
  git -C "$work" init -q
  git -C "$work" config user.email "t@t.t"
  git -C "$work" config user.name "t"
  git -C "$work" checkout -q -b main
  printf 'baseline\n' > "$work/README.md"
  git -C "$work" add -A
  git -C "$work" commit -q -m "baseline"
  git -C "$work" remote add origin "$origin"
  git -C "$work" push -q origin main

  git -C "$work" checkout -q -b "rad/${feature}" main
  mkdir -p "$work/.agents/state/${feature}"
  printf '%s\n' "${APPROVED_EVENT/FEAT/$feature}" > "$work/$events"
  git -C "$work" add -A
  git -C "$work" commit -q -m "record approval"
  git -C "$work" push -q origin "rad/${feature}"

  # Now drop the event log from the local working tree so the only way to find
  # the approved event is the origin/<work-branch> tip (case 1).
  rm -f "$work/$events"

  local code
  code=$(run_check "$feature" main "$work")
  [[ "$code" -eq 0 ]] || fail "(d) approved event on origin/rad/<feature> tip should PASS via branch-tip resolution (got $code)"
  echo "✓ (d) AC#3: approved event resolved from the origin/<work-branch> tip PASSES (exit 0)"

  # Negative branch-tip: a non-approved log on the tip and no local log → FAILS.
  local feat2="branch-tip-unapproved"
  local work2="$TMP/$feat2-work"
  local origin2="$TMP/$feat2-origin.git"
  local events2=".agents/state/${feat2}/events.jsonl"
  git init -q --bare "$origin2"
  mkdir -p "$work2"
  git -C "$work2" init -q
  git -C "$work2" config user.email "t@t.t"
  git -C "$work2" config user.name "t"
  git -C "$work2" checkout -q -b main
  printf 'baseline\n' > "$work2/README.md"
  git -C "$work2" add -A
  git -C "$work2" commit -q -m "baseline"
  git -C "$work2" remote add origin "$origin2"
  git -C "$work2" push -q origin main
  git -C "$work2" checkout -q -b "rad/${feat2}" main
  mkdir -p "$work2/.agents/state/${feat2}"
  printf '{"feature":"%s","type":"plan-drafted","actor":"x","role":"developer","ts":"2026-06-12T13:42:41.192Z"}\n' "$feat2" > "$work2/$events2"
  git -C "$work2" add -A
  git -C "$work2" commit -q -m "record draft only"
  git -C "$work2" push -q origin "rad/${feat2}"
  rm -f "$work2/$events2"

  code=$(run_check "$feat2" main "$work2")
  [[ "$code" -eq 1 ]] || fail "(d) draft-only log on origin tip (no approved event) should FAIL (got $code)"
  echo "✓ (d) AC#3: a draft-only branch-tip log (no approved event) FAILS the gate (exit 1)"
}

t_doc_approved_no_event
t_event_present_doc_stale
t_missing_log_fails_closed
t_branch_tip_resolution
echo "ALL PASS"
