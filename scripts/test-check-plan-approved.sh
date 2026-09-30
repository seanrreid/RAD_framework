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

# ── (e) #162: approved then edited → exit 1, stderr names the fingerprint cause ─
# The hook surfaces this stderr line as its block reason, so an edited approved
# plan must say "fingerprint mismatch", not "no approved event".
t_fingerprint_mismatch_message() {
  local feature="fp-edited-after-approval"
  local d="$TMP/$feature" plan err_file="$TMP/fp-mismatch.err"
  plan="$d/.agents/plans/${feature}.md"
  mkdir -p "$d/.agents/plans" "$d/.agents/state/${feature}"
  printf '# Plan: t\nBranch: rad/%s\n\n## Tasks\n- original task\n' "$feature" > "$plan"
  local fp
  fp=$(node "$REPO_ROOT/harness/cli.js" plan-fingerprint "$plan" | tr -d '\n')
  [[ -n "$fp" ]] || fail "(e) could not compute the fixture plan fingerprint"
  printf '{"feature":"%s","type":"approved","actor":"sean@torchcodelab.com","role":"architect","ts":"2026-06-12T13:42:41.192Z","data":{"fingerprint":"%s"}}\n' \
    "$feature" "$fp" > "$d/.agents/state/${feature}/events.jsonl"

  local code
  code=$(run_check "$feature" main "$d")
  [[ "$code" -eq 0 ]] || fail "(e) unedited approved plan should PASS before the edit (got $code)"

  printf -- '- added after approval\n' >> "$plan"
  set +e
  ( cd "$d" && bash "$SCRIPT" "rad/${feature}" main ) >/dev/null 2>"$err_file"
  code=$?
  set -e
  [[ "$code" -eq 1 ]] || fail "(e) edited approved plan should FAIL with exit 1 (got $code)"
  local want="plan changed since approval (fingerprint mismatch) — re-approve with /rad-approve ${feature}"
  grep -qF "$want" "$err_file" || fail "(e) stderr should name the fingerprint mismatch; got: $(tail -n 1 "$err_file")"
  echo "✓ (e) #162: edited approved plan exits 1 with a fingerprint-mismatch stderr reason"
}

# ── (f) #162: unapproved plan → exit 1, message unchanged (no fingerprint wording) ─
t_unapproved_message_unchanged() {
  local feature="unapproved-message"
  local d="$TMP/$feature" out_file="$TMP/unapproved.out"
  mkdir -p "$d/.agents/plans" "$d/.agents/state/${feature}"
  printf '# Plan: t\nBranch: rad/%s\n' "$feature" > "$d/.agents/plans/${feature}.md"
  printf '{"feature":"%s","type":"plan-drafted","actor":"x","role":"developer","ts":"2026-06-12T13:42:41.192Z"}\n' \
    "$feature" > "$d/.agents/state/${feature}/events.jsonl"

  local code
  set +e
  ( cd "$d" && bash "$SCRIPT" "rad/${feature}" main ) >"$out_file" 2>&1
  code=$?
  set -e
  [[ "$code" -eq 1 ]] || fail "(f) unapproved plan should FAIL with exit 1 (got $code)"
  if grep -qF "fingerprint mismatch" "$out_file"; then
    fail "(f) unapproved plan must not report a fingerprint mismatch"
  fi
  echo "✓ (f) #162: unapproved plan exits 1 without fingerprint-mismatch wording"
}

# ── #168: a CLI that exits 0 without a verdict never passes the gate ─────────
# The gate verb always prints a verdict line; exit 0 with no `passed=true` means
# the CLI never ran (the symlink main-module guard). A stub harness/cli.js
# prints $STUB_OUT (if set) and exits $STUB_CODE (default 0), standing in for the
# real CLI in a copied scripts/ tree so SCRIPT_DIR/../harness/cli.js resolves to it.
STUB_ROOT="$TMP/stub-root"
make_stub_root() {
  mkdir -p "$STUB_ROOT/scripts" "$STUB_ROOT/harness"
  cp "$SCRIPT" "$HERE/get-default-branch.sh" "$HERE/git-sync.sh" "$STUB_ROOT/scripts/"
  printf '%s\n' \
    'if (process.env.STUB_OUT) process.stdout.write(process.env.STUB_OUT + "\n");' \
    'process.exit(Number(process.env.STUB_CODE || 0));' > "$STUB_ROOT/harness/cli.js"
}

# run_stub_check STUB_CODE STUB_OUT ERR_FILE → echoes the exit code.
run_stub_check() {
  local stub_code="$1" stub_out="$2" err_file="$3"
  local feature="stub-verdict" d="$TMP/stub-verdict" code
  mkdir -p "$d/.agents/state/${feature}"
  printf '%s\n' "${APPROVED_EVENT/FEAT/$feature}" > "$d/.agents/state/${feature}/events.jsonl"
  set +e
  ( cd "$d" && STUB_CODE="$stub_code" STUB_OUT="$stub_out" \
      bash "$STUB_ROOT/scripts/check-plan-approved.sh" "rad/${feature}" main ) >/dev/null 2>"$err_file"
  code=$?
  set -e
  echo "$code"
}

t_silent_cli_fails_closed() {
  local err="$TMP/silent.err" code
  code=$(run_stub_check 0 "" "$err")
  [[ "$code" -eq 1 ]] || fail "(g) CLI exit 0 with no output must FAIL closed (got $code)"
  grep -qF "rad gate produced no verdict" "$err" || fail "(g) stderr should say no verdict; got: $(tail -n 1 "$err")"
  echo "✓ (g) #168: CLI exit 0 with empty output fails closed (exit 1, no-verdict reason)"
}

t_non_matching_output_fails_closed() {
  local err="$TMP/nonmatch.err" code
  code=$(run_stub_check 0 "rad gate: feature=x gate=approved passed=false" "$err")
  [[ "$code" -eq 1 ]] || fail "(h) CLI exit 0 with passed=false must FAIL closed (got $code)"
  grep -qF "no verdict" "$err" || fail "(h) stderr should say no verdict; got: $(tail -n 1 "$err")"
  echo "✓ (h) #168: CLI exit 0 without passed=true fails closed"
}

t_stub_passed_true_passes() {
  local err="$TMP/passtrue.err" code
  code=$(run_stub_check 0 "rad gate: feature=x gate=approved passed=true" "$err")
  [[ "$code" -eq 0 ]] || fail "(i) CLI exit 0 with passed=true should PASS (got $code)"
  echo "✓ (i) #168: CLI exit 0 with passed=true passes"
}

t_stub_nonzero_passes_through() {
  local err="$TMP/nonzero.err" code
  code=$(run_stub_check 2 "" "$err")
  [[ "$code" -eq 2 ]] || fail "(j) a non-zero CLI exit should pass straight through (got $code)"
  if grep -qF "no verdict" "$err"; then
    fail "(j) a non-zero CLI exit must not report no-verdict"
  fi
  echo "✓ (j) #168: a non-zero CLI exit passes through unchanged"
}

# get-default-branch.sh reads the same stub CLI (repo-root = $STUB_ROOT).
t_default_branch_empty_output_errors() {
  local err="$TMP/gdb-empty.err" code out
  set +e
  out=$(STUB_CODE=0 STUB_OUT="" bash "$STUB_ROOT/scripts/get-default-branch.sh" "$STUB_ROOT" 2>"$err")
  code=$?
  set -e
  [[ "$code" -eq 1 ]] || fail "(k) config get exit 0 with no output must exit 1 (got $code, out '$out')"
  [[ -z "$out" ]] || fail "(k) no branch name may be printed on the error path (got '$out')"
  grep -qF "exited 0 with no output" "$err" || fail "(k) stderr should name the empty output; got: $(tail -n 1 "$err")"
  echo "✓ (k) #168: get-default-branch errors on an empty config get (never an empty branch)"
}

t_default_branch_absent_key_falls_back() {
  local out
  out=$(STUB_CODE=3 STUB_OUT="" bash "$STUB_ROOT/scripts/get-default-branch.sh" "$STUB_ROOT" 2>/dev/null) \
    || fail "(l) absent key (exit 3) should succeed"
  [[ "$out" == "main" ]] || fail "(l) absent key should fall back to main (got '$out')"
  out=$(STUB_CODE=0 STUB_OUT="trunk" bash "$STUB_ROOT/scripts/get-default-branch.sh" "$STUB_ROOT") \
    || fail "(l) a declared branch should succeed"
  [[ "$out" == "trunk" ]] || fail "(l) declared branch should print as-is (got '$out')"
  echo "✓ (l) get-default-branch: absent key → main; declared branch printed"
}

t_doc_approved_no_event
t_event_present_doc_stale
t_missing_log_fails_closed
t_branch_tip_resolution
t_fingerprint_mismatch_message
t_unapproved_message_unchanged
make_stub_root
t_silent_cli_fails_closed
t_non_matching_output_fails_closed
t_stub_passed_true_passes
t_stub_nonzero_passes_through
t_default_branch_empty_output_errors
t_default_branch_absent_key_falls_back
echo "ALL PASS"
