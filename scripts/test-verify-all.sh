#!/usr/bin/env bash
# test-verify-all.sh
# Behavior tests for scripts/verify-all.sh, driven through its test hook
# (RAD_VERIFY_ALL_CHECKS_FILE) so no real CI check runs.
#
# Cases:
#   V1 all checks pass            → exit 0, summary is the LAST line
#   V2 one failing check          → non-zero, FAIL line, its output excerpted
#   V3 --only skips the rest      → skipped is not a failure
#   V4 no base ref                → base-dependent check skips, exit 0
#   V5 --list                     → prints the built-in check names
#   V6 git identity defaults      → exported when unset, kept when set
#   V7 SIGTERM during a long check→ exit 143, check + its child killed
#   V8 empty checks file          → exit 2 (nothing verified is not a pass)
#   V9 usage errors               → unknown flag / unknown --only name → exit 2
#
# Usage: scripts/test-verify-all.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/verify-all.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TAB=$'\t'

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

# expect_rc <label> <expected-rc> <actual-rc>
expect_rc() {
  if [[ "$3" -eq "$2" ]]; then ok "$1 (exit $3)"; else bad "$1 (expected exit $2, got $3)"; fi
}
# expect_has <label> <needle> — against $OUT
expect_has() {
  if printf '%s\n' "$OUT" | grep -qF -- "$2"; then ok "$1"; else bad "$1 (missing '$2')"; fi
}
expect_lacks() {
  if printf '%s\n' "$OUT" | grep -qF -- "$2"; then bad "$1 (unexpected '$2')"; else ok "$1"; fi
}

# run_va <checks-file> [args...] → sets OUT and RC
run_va() {
  local checks="$1"; shift
  RC=0
  OUT="$(RAD_VERIFY_ALL_CHECKS_FILE="$checks" bash "$SCRIPT" "$@" 2>&1)" || RC=$?
}

expect_last_summary() {
  local last
  last="$(printf '%s\n' "$OUT" | tail -n 1)"
  if [[ "$last" == "verify-all: $2" ]]; then ok "$1 summary is last"; else bad "$1 last line was '$last'"; fi
}

PASSING="$TMP/pass.tsv"
printf 'one%secho hi\ntwo%strue\n' "$TAB" "$TAB" >"$PASSING"

# V1 all checks pass
run_va "$PASSING" --base HEAD
expect_rc "V1 all pass" 0 "$RC"
expect_has "V1 ok line" "ok   one ("
expect_last_summary "V1" "2 passed, 0 failed, 0 skipped"

# V2 one failing check: its own output is excerpted before the summary
FAILING="$TMP/fail.tsv"
printf 'good%strue\nbroken%secho "boom-detail"; exit 7\n' "$TAB" "$TAB" >"$FAILING"
run_va "$FAILING" --base HEAD
expect_rc "V2 failing check" 1 "$RC"
expect_has "V2 FAIL line" "FAIL broken (exit 7,"
expect_has "V2 output excerpted" "boom-detail"
expect_last_summary "V2" "1 passed, 1 failed, 0 skipped"

# V2b excerpt is bounded to the last 12 lines
LONG="$TMP/long.tsv"
printf 'noisy%sfor i in $(seq 1 30); do echo "line-$i"; done; exit 1\n' "$TAB" >"$LONG"
run_va "$LONG" --base HEAD
expect_has "V2b keeps the tail" "line-30"
expect_lacks "V2b drops the head" "line-5"
expect_lacks "V2b drops line-18" "line-18"

# V3 --only: unselected checks are skipped, not failed
run_va "$FAILING" --base HEAD --only good
expect_rc "V3 --only skips the failing check" 0 "$RC"
expect_has "V3 skip line" "skip  broken (not selected)"
expect_last_summary "V3" "1 passed, 0 failed, 1 skipped"

# V4 base-dependent check skips when no base ref resolves: run a copy of the
# script inside a throwaway repo that has no origin/main.
BASED="$TMP/based.tsv"
printf 'plain%strue\nneeds-base%sexit 9%sbase\n' "$TAB" "$TAB" "$TAB" >"$BASED"
NOBASE="$TMP/nobase-repo"
mkdir -p "$NOBASE/scripts"
git -C "$NOBASE" init -q
cp "$SCRIPT" "$NOBASE/scripts/verify-all.sh"
RC=0
OUT="$(RAD_VERIFY_ALL_CHECKS_FILE="$BASED" bash "$NOBASE/scripts/verify-all.sh" 2>&1)" || RC=$?
expect_rc "V4 no base ref → skip, not failure" 0 "$RC"
expect_has "V4 skip line" "skip  needs-base (no base ref)"
expect_last_summary "V4" "1 passed, 0 failed, 1 skipped"
run_va "$BASED" --base HEAD --only plain,needs-base
expect_rc "V4b base given → base check runs (and fails)" 1 "$RC"
expect_has "V4b FAIL line" "FAIL needs-base (exit 9,"

# V5 --list prints the built-in names (no hook)
RC=0
OUT="$(env -u RAD_VERIFY_ALL_CHECKS_FILE bash "$SCRIPT" --list 2>&1)" || RC=$?
expect_rc "V5 --list" 0 "$RC"
for n in harness-tests evals script-tests generate-drift playbook-lint config-validate \
  lint-invariants lint-agent-files lint-claude-md lint-shell-safety plan-lint events-append-only; do
  expect_has "V5 lists $n" "$n"
done

# V6 identity defaults exported when unset; operator values kept
IDENT="$TMP/ident.tsv"
printf 'ident%sprintf "%%s|%%s|%%s|%%s\\n" "$GIT_AUTHOR_NAME" "$GIT_AUTHOR_EMAIL" "$GIT_COMMITTER_NAME" "$GIT_COMMITTER_EMAIL"; exit 5\n' "$TAB" >"$IDENT"
RC=0
OUT="$(env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL \
  RAD_VERIFY_ALL_CHECKS_FILE="$IDENT" bash "$SCRIPT" --base HEAD 2>&1)" || RC=$?
expect_has "V6 defaults exported" "rad-verify|rad-verify@localhost|rad-verify|rad-verify@localhost"
RC=0
OUT="$(GIT_AUTHOR_NAME=custom RAD_VERIFY_ALL_CHECKS_FILE="$IDENT" bash "$SCRIPT" --base HEAD 2>&1)" || RC=$?
expect_has "V6 operator value kept" "custom|"

# V7 SIGTERM during a long check kills it and its child; exit 143
LONGRUN="$TMP/sig.tsv"
PIDFILE="$TMP/sleep.pid"
printf 'slow%ssleep 300 & echo $! >"%s"; wait\n' "$TAB" "$PIDFILE" >"$LONGRUN"
RAD_VERIFY_ALL_CHECKS_FILE="$LONGRUN" bash "$SCRIPT" --base HEAD >"$TMP/sig.out" 2>&1 &
VPID=$!
for _ in $(seq 1 50); do [[ -s "$PIDFILE" ]] && break; sleep 0.1; done
if [[ ! -s "$PIDFILE" ]]; then bad "V7 long check never started"; else
  CHILD="$(cat "$PIDFILE")"
  kill -TERM "$VPID"
  RC=0; wait "$VPID" || RC=$?
  expect_rc "V7 SIGTERM" 143 "$RC"
  OUT="$(cat "$TMP/sig.out")"
  expect_has "V7 interrupted line" "verify-all: interrupted"
  sleep 0.3
  if kill -0 "$CHILD" 2>/dev/null; then bad "V7 stray child $CHILD still alive"; kill -KILL "$CHILD" 2>/dev/null || true
  else ok "V7 no stray child"; fi
fi

# V8 empty checks file → usage error, never a vacuous pass
: >"$TMP/empty.tsv"
run_va "$TMP/empty.tsv" --base HEAD
expect_rc "V8 empty checks file" 2 "$RC"
expect_has "V8 says why" "no checks to run"

# V9 usage errors
run_va "$PASSING" --bogus
expect_rc "V9 unknown flag" 2 "$RC"
run_va "$PASSING" --only nonexistent
expect_rc "V9 unknown --only name" 2 "$RC"
run_va "$PASSING" --base definitely-not-a-ref
expect_rc "V9 unresolvable --base" 2 "$RC"

echo "---"
echo "passed=$PASS failed=$FAIL"
[[ "$FAIL" -eq 0 ]]
