#!/usr/bin/env bash
# test-default-tip.sh
# Tests for scripts/default-tip.sh: exit 0 (the remote branch's 40-hex sha, alone
# on stdout) / 3 (remote not configured, unreachable, branch absent) / 2 (usage,
# bad arg). Builds a temp work repo with a LOCAL bare origin and runs the real
# script inside it. Runs under bash 3.2+ (set -euo pipefail safe).
#
# Usage: scripts/test-default-tip.sh   (exit 0 + "ALL PASS")

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/default-tip.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

OUT="$TMP/out.txt"
ERR="$TMP/err.txt"
WORK="$TMP/work"
ORIGIN="$TMP/origin.git"

# Deterministic identity; no user/global config can alter the fixture.
export GIT_AUTHOR_NAME="fixture" GIT_AUTHOR_EMAIL="fixture@example.com"
export GIT_COMMITTER_NAME="fixture" GIT_COMMITTER_EMAIL="fixture@example.com"
export GIT_CONFIG_NOSYSTEM=1 HOME="$TMP"

# run_tip <args...> — run the script inside $WORK; sets RC to its exit code.
run_tip() {
  if (cd "$WORK" && bash "$SCRIPT" "$@") >"$OUT" 2>"$ERR"; then
    RC=0
  else
    RC=$?
  fi
}

# expect <name> <rc> — assert the last run's exit code (stderr shown on mismatch).
expect() {
  [[ "$RC" -eq "$2" ]] || fail "$1: expected exit $2, got $RC (stderr: $(cat "$ERR"))"
}

expect_empty_stdout() {
  [[ ! -s "$OUT" ]] || fail "$1: stdout must be empty, got: [$(cat "$OUT")]"
}

# ── fixture: work repo with one commit on main, pushed to a local bare origin ──
git init -q --bare "$ORIGIN"
git init -q "$WORK"
git -C "$WORK" symbolic-ref HEAD refs/heads/main
echo "seed" > "$WORK/seed.txt"
git -C "$WORK" add seed.txt
git -C "$WORK" commit -q -m "seed"
git -C "$WORK" remote add origin "$ORIGIN"
git -C "$WORK" push -q origin main
MAIN_SHA="$(git -C "$WORK" rev-parse HEAD)"

# ── happy path ─────────────────────────────────────────────────────────────────
run_tip origin main
expect "happy path" 0
[[ "$(cat "$OUT")" == "$MAIN_SHA" ]] || fail "happy path: expected [$MAIN_SHA], got [$(cat "$OUT")]"
[[ "$(wc -l < "$OUT" | tr -d ' ')" -eq 1 ]] || fail "happy path: stdout must be exactly one line"
echo "✓ origin main ⇒ exit 0, prints only the pushed sha"

# ── tip moves after a new push ─────────────────────────────────────────────────
echo "more" >> "$WORK/seed.txt"
git -C "$WORK" commit -q -am "second"
git -C "$WORK" push -q origin main
run_tip origin main
expect "moved tip" 0
[[ "$(cat "$OUT")" == "$(git -C "$WORK" rev-parse HEAD)" ]] || fail "moved tip: expected the new sha"
[[ "$(cat "$OUT")" != "$MAIN_SHA" ]] || fail "moved tip: sha must differ from the first push"
echo "✓ after a push ⇒ prints the new sha"

# ── remote not configured ──────────────────────────────────────────────────────
run_tip upstream main
expect "remote not configured" 3; expect_empty_stdout "remote not configured"
grep -q "not configured" "$ERR" || fail "remote not configured: reason missing from stderr"
echo "✓ unconfigured remote ⇒ exit 3"

# ── remote unreachable ─────────────────────────────────────────────────────────
git -C "$WORK" remote add gone "$TMP/no-such-origin.git"
run_tip gone main
expect "remote unreachable" 3; expect_empty_stdout "remote unreachable"
grep -q "unreachable" "$ERR" || fail "remote unreachable: reason missing from stderr"
echo "✓ unreachable remote ⇒ exit 3"

# ── branch absent on remote (a tail-matching ref must not count) ──────────────
git -C "$WORK" push -q origin HEAD:refs/heads/team/develop
run_tip origin develop
expect "branch absent" 3; expect_empty_stdout "branch absent"
grep -q "absent" "$ERR" || fail "branch absent: reason missing from stderr"
echo "✓ branch absent on remote (tail match ignored) ⇒ exit 3"

# ── usage errors ───────────────────────────────────────────────────────────────
run_tip
expect "no args" 2; expect_empty_stdout "no args"
run_tip origin
expect "one arg" 2; expect_empty_stdout "one arg"
run_tip origin main extra
expect "three args" 2; expect_empty_stdout "three args"
echo "✓ missing / extra args ⇒ exit 2"

run_tip 'origin;rm' main
expect "bad remote" 2; expect_empty_stdout "bad remote"
run_tip origin 'main branch'
expect "bad branch" 2; expect_empty_stdout "bad branch"
run_tip --upload-pack=x main
expect "option-shaped remote" 2; expect_empty_stdout "option-shaped remote"
run_tip origin -main
expect "option-shaped branch" 2; expect_empty_stdout "option-shaped branch"
echo "✓ bad / option-shaped args ⇒ exit 2"

echo "ALL PASS"
