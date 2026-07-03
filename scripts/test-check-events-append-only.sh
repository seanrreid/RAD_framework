#!/usr/bin/env bash
# test-check-events-append-only.sh
# Regression tests for check-events-append-only.sh: pure append passes; any
# rewrite/deletion fails; malformed or field-missing appends fail; unrelated
# file changes are ignored. Self-contained: builds a temp git-repo fixture and
# runs the REAL script (from this repo's scripts/) with the fixture as cwd.
# Runs under bash 3.2+ (set -u safe).
#
# Usage: scripts/test-check-events-append-only.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

EVENT1='{"feature":"f","type":"planned","actor":"a@a.a","ts":"2026-07-01T00:00:00.000Z"}'
EVENT2='{"feature":"f","type":"approved","actor":"a@a.a","role":"architect","ts":"2026-07-02T00:00:00.000Z"}'

# ── Build a temp git-repo fixture ──────────────────────────────────────────────
# main holds an existing event log with one event; each case cuts a branch and
# mutates it in a specific way.
REPO="$TMP/repo"
mkdir -p "$REPO/.agents/state/f" "$REPO/src"
printf '%s\n' "$EVENT1" > "$REPO/.agents/state/f/events.jsonl"
printf 'export const x = 1;\n' > "$REPO/src/app.js"

git -C "$REPO" init -q
git -C "$REPO" config user.email "t@t.t"
git -C "$REPO" config user.name "t"
git -C "$REPO" checkout -q -b main
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "baseline"

run_check() {
  # run_check <head-branch> — diffs main...<branch> inside the fixture repo.
  local branch="$1" code
  set +e
  ( cd "$REPO" && bash "$HERE/check-events-append-only.sh" main "$branch" ) \
    > "$TMP/out" 2>&1
  code=$?
  set -e
  echo "$code"
}

new_case_branch() {
  git -C "$REPO" checkout -q main
  git -C "$REPO" checkout -q -b "$1" main
}

# ── Case 1: pure append of a well-formed event → 0 ─────────────────────────────
new_case_branch case/append
printf '%s\n' "$EVENT2" >> "$REPO/.agents/state/f/events.jsonl"
git -C "$REPO" add -A && git -C "$REPO" commit -q -m "append"
code=$(run_check case/append)
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 1: pure append should exit 0 (got $code)"; }
echo "✓ case 1: pure append passes (exit 0)"

# ── Case 2: modifying an existing line → 1 ─────────────────────────────────────
new_case_branch case/modify
printf '%s\n' '{"feature":"f","type":"REWRITTEN","actor":"a@a.a","ts":"2026-07-01T00:00:00.000Z"}' \
  > "$REPO/.agents/state/f/events.jsonl"
git -C "$REPO" add -A && git -C "$REPO" commit -q -m "rewrite"
code=$(run_check case/modify)
[[ "$code" -eq 1 ]] || fail "case 2: modified line should exit 1 (got $code)"
grep -q "append-only" "$TMP/out" || fail "case 2: expected append-only violation message"
echo "✓ case 2: modifying an existing event line fails (exit 1)"

# ── Case 3: deleting a line → 1 ────────────────────────────────────────────────
new_case_branch case/delete
: > "$REPO/.agents/state/f/events.jsonl"
git -C "$REPO" add -A && git -C "$REPO" commit -q -m "delete"
code=$(run_check case/delete)
[[ "$code" -eq 1 ]] || fail "case 3: deleted line should exit 1 (got $code)"
echo "✓ case 3: deleting an event line fails (exit 1)"

# ── Case 4: malformed-JSON append → 1 ──────────────────────────────────────────
new_case_branch case/malformed
printf 'not json at all\n' >> "$REPO/.agents/state/f/events.jsonl"
git -C "$REPO" add -A && git -C "$REPO" commit -q -m "malformed"
code=$(run_check case/malformed)
[[ "$code" -eq 1 ]] || fail "case 4: malformed JSON append should exit 1 (got $code)"
grep -q "not valid JSON" "$TMP/out" || fail "case 4: expected JSON-parse error message"
echo "✓ case 4: malformed-JSON append fails (exit 1)"

# ── Case 5: append missing a required field → 1 ────────────────────────────────
new_case_branch case/missing-field
printf '%s\n' '{"feature":"f","type":"approved","ts":"2026-07-02T00:00:00.000Z"}' \
  >> "$REPO/.agents/state/f/events.jsonl"
git -C "$REPO" add -A && git -C "$REPO" commit -q -m "missing actor"
code=$(run_check case/missing-field)
[[ "$code" -eq 1 ]] || fail "case 5: field-missing append should exit 1 (got $code)"
grep -q "required field: actor" "$TMP/out" || fail "case 5: expected missing-field message"
echo "✓ case 5: append missing a required field fails (exit 1)"

# ── Case 6: unrelated file changes are ignored → 0 with notice ─────────────────
new_case_branch case/unrelated
printf 'console.log(2);\n' >> "$REPO/src/app.js"
printf 'log line\n' > "$REPO/.agents/state/f/notes.txt"
git -C "$REPO" add -A && git -C "$REPO" commit -q -m "unrelated"
code=$(run_check case/unrelated)
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 6: unrelated changes should exit 0 (got $code)"; }
grep -q "no event-log changes" "$TMP/out" || fail "case 6: expected no-event-log-changes notice"
echo "✓ case 6: unrelated file changes are ignored (exit 0)"

echo "ALL PASS"
