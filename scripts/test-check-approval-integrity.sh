#!/usr/bin/env bash
# test-check-approval-integrity.sh
# Regression tests for check-approval-integrity.sh: ancestry, fingerprint,
# gate, authenticity, override, ownership advisory, and merged-history cases.
# Self-contained (no external harness): builds a temp git-repo fixture and runs
# the REAL script (from this repo's scripts/) with the fixture as cwd, so the
# harness CLI resolves from the real repo. Runs under bash 3.2+ (set -u safe).
#
# Usage: scripts/test-check-approval-integrity.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

ARCH_EMAIL="arch@example.com"
EVIL_EMAIL="mallory@evil.com"

# ── Build a temp git-repo fixture ──────────────────────────────────────────────
# main holds CLAUDE.md (Role Assignments) + identical plan docs for every case
# feature. Each case cuts its own rad/<feature> branch and commits its own
# event log with a controlled author.
REPO="$TMP/repo"
mkdir -p "$REPO/.agents/plans"

cat > "$REPO/CLAUDE.md" <<EOF
**Name:** t
default_branch: main

### Role Assignments

architect:  ${ARCH_EMAIL}
developers: []
designers:  []
EOF

PLAN_BODY='# Plan: t
Status: approved
Branch: rad/feature

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| src/in-scope.js | 1-2 | x |
'
for f in f1 f2 f3 f4 f6 f7 f8; do
  printf '%s' "$PLAN_BODY" > "$REPO/.agents/plans/$f.md"
done

git -C "$REPO" init -q
git -C "$REPO" config user.email "t@t.t"
git -C "$REPO" config user.name "t"
git -C "$REPO" checkout -q -b main
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "baseline"

# The real fingerprint of the (identical) plan body, via the single source of
# truth — never re-hashed here.
FP=$(node "$HERE/../harness/cli.js" plan-fingerprint "$REPO/.agents/plans/f1.md")

approved_event() {
  # approved_event <feature> <fingerprint-or-empty>
  local feature="$1" fp="$2"
  if [[ -n "$fp" ]]; then
    printf '{"feature":"%s","type":"approved","actor":"%s","role":"architect","ts":"2026-07-01T00:00:00.000Z","recordedBy":"%s","data":{"fingerprint":"%s"}}\n' \
      "$feature" "$ARCH_EMAIL" "$ARCH_EMAIL" "$fp"
  else
    printf '{"feature":"%s","type":"approved","actor":"%s","role":"architect","ts":"2026-07-01T00:00:00.000Z","recordedBy":"%s"}\n' \
      "$feature" "$ARCH_EMAIL" "$ARCH_EMAIL"
  fi
}

commit_as() {
  # commit_as <author-email> <message>
  local email="$1" msg="$2"
  git -C "$REPO" add -A
  git -C "$REPO" -c user.email="$email" -c user.name="fixture" commit -q -m "$msg"
}

run_check() {
  # run_check <work-branch> — runs the REAL script inside the fixture repo.
  # Captures exit code without tripping set -e; output goes to $TMP/out.
  local branch="$1" code
  set +e
  ( cd "$REPO" && bash "$HERE/check-approval-integrity.sh" "$branch" main ) \
    > "$TMP/out" 2>&1
  code=$?
  set -e
  echo "$code"
}

# ── Case 1: approved event, ancestor of HEAD, matching fingerprint → 0 ─────────
git -C "$REPO" checkout -q -b rad/f1 main
mkdir -p "$REPO/.agents/state/f1"
approved_event f1 "$FP" > "$REPO/.agents/state/f1/events.jsonl"
commit_as "$ARCH_EMAIL" "approve f1"
code=$(run_check rad/f1)
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 1: approved+ancestor should exit 0 (got $code)"; }
echo "✓ case 1: approved + ancestor + matching fingerprint passes (exit 0)"

# ── Case 2: no approved event in the log → 1 ───────────────────────────────────
git -C "$REPO" checkout -q -b rad/f2 main
mkdir -p "$REPO/.agents/state/f2"
printf '{"feature":"f2","type":"planned","actor":"%s","ts":"2026-07-01T00:00:00.000Z"}\n' "$ARCH_EMAIL" \
  > "$REPO/.agents/state/f2/events.jsonl"
commit_as "$ARCH_EMAIL" "plan f2"
code=$(run_check rad/f2)
[[ "$code" -eq 1 ]] || fail "case 2: no approved event should exit 1 (got $code)"
echo "✓ case 2: missing approved event fails closed (exit 1)"

# ── Case 3: tampered fingerprint → 1 ───────────────────────────────────────────
git -C "$REPO" checkout -q -b rad/f3 main
mkdir -p "$REPO/.agents/state/f3"
approved_event f3 "0000000000000000000000000000000000000000000000000000000000000000" \
  > "$REPO/.agents/state/f3/events.jsonl"
commit_as "$ARCH_EMAIL" "approve f3 (tampered fp)"
code=$(run_check rad/f3)
[[ "$code" -eq 1 ]] || fail "case 3: fingerprint mismatch should exit 1 (got $code)"
grep -q "fingerprint mismatch" "$TMP/out" || fail "case 3: expected fingerprint-mismatch message"
echo "✓ case 3: tampered fingerprint fails (exit 1)"

# ── Case 4: approval commit authored by a non-architect → 1 ────────────────────
git -C "$REPO" checkout -q -b rad/f4 main
mkdir -p "$REPO/.agents/state/f4"
approved_event f4 "$FP" > "$REPO/.agents/state/f4/events.jsonl"
commit_as "$EVIL_EMAIL" "approve f4 (wrong author)"
code=$(run_check rad/f4)
[[ "$code" -eq 1 ]] || fail "case 4: non-architect author should exit 1 (got $code)"
grep -q "not the configured architect" "$TMP/out" || fail "case 4: expected authenticity message"
echo "✓ case 4: non-architect approval author fails (exit 1)"

# ── Case 5: RAD_ARCHITECT_OVERRIDE accepts the case-4 author → 0 ───────────────
set +e
( cd "$REPO" && RAD_ARCHITECT_OVERRIDE="$EVIL_EMAIL" \
    bash "$HERE/check-approval-integrity.sh" rad/f4 main ) > "$TMP/out" 2>&1
code=$?
set -e
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 5: RAD_ARCHITECT_OVERRIDE should exit 0 (got $code)"; }
echo "✓ case 5: RAD_ARCHITECT_OVERRIDE wins (exit 0)"

# ── Case 6: stale owner-claimed → advisory line AND exit 0 ─────────────────────
git -C "$REPO" checkout -q -b rad/f6 main
mkdir -p "$REPO/.agents/state/f6"
{
  approved_event f6 "$FP"
  printf '{"feature":"f6","type":"owner-claimed","actor":"%s","ts":"2026-07-02T00:00:00.000Z"}\n' "$ARCH_EMAIL"
} > "$REPO/.agents/state/f6/events.jsonl"
commit_as "$ARCH_EMAIL" "approve + claim f6"
code=$(run_check rad/f6)
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 6: stale claim must NOT affect exit code (got $code)"; }
grep -q "^advisory:" "$TMP/out" || fail "case 6: expected an advisory: line"
echo "✓ case 6: stale owner-claimed prints advisory and still exits 0"

# ── Case 7: approval commit reachable only via a merge → ancestry passes ───────
git -C "$REPO" checkout -q -b side/f7 main
mkdir -p "$REPO/.agents/state/f7"
approved_event f7 "$FP" > "$REPO/.agents/state/f7/events.jsonl"
commit_as "$ARCH_EMAIL" "approve f7 on side branch"
git -C "$REPO" checkout -q -b rad/f7 main
git -C "$REPO" merge -q --no-ff -m "merge side/f7" side/f7
code=$(run_check rad/f7)
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 7: merged-history approval should exit 0 (got $code)"; }
echo "✓ case 7: approval reachable via merge passes ancestry (exit 0)"

# ── Case 8: legacy approved event with no fingerprint → warn but pass ──────────
git -C "$REPO" checkout -q -b rad/f8 main
mkdir -p "$REPO/.agents/state/f8"
approved_event f8 "" > "$REPO/.agents/state/f8/events.jsonl"
commit_as "$ARCH_EMAIL" "approve f8 (legacy, no fingerprint)"
code=$(run_check rad/f8)
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 8: legacy no-fingerprint approval should exit 0 (got $code)"; }
grep -q "^warn:" "$TMP/out" || fail "case 8: expected a legacy warn line"
echo "✓ case 8: legacy approved event without fingerprint warns but passes (exit 0)"

echo "ALL PASS"
