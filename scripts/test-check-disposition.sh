#!/usr/bin/env bash
# test-check-disposition.sh
# Tests for scripts/check-disposition.sh: exit 0 (actionable / fail-open /
# overridden) / 1 (cited non-actionable refusal) / 2 (usage, missing file,
# empty override reason). Builds research-artifact fixtures in a temp dir and
# runs the real script against them, plus every real .agents/research/*.md
# artifact (excluding README.md), which must pass as actionable unchanged.
# Runs under bash 3.2+ (set -euo pipefail safe).
#
# Usage: scripts/test-check-disposition.sh   (exit 0 + "ALL PASS")

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/check-disposition.sh"
RESEARCH_DIR="$HERE/../.agents/research"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

OUT="$TMP/out.txt"
ERR="$TMP/err.txt"
EVIDENCE="harness/gates.js:42"

# run_check <args...> — run the script; sets RC, captures $OUT / $ERR.
run_check() {
  if "$BASH" "$SCRIPT" "$@" >"$OUT" 2>"$ERR"; then RC=0; else RC=$?; fi
}

expect() {
  [[ "$RC" -eq "$2" ]] || fail "$1: expected exit $2, got $RC (stderr: $(cat "$ERR"))"
}

expect_stdout() {
  [[ "$(cat "$OUT")" == "$2" ]] || fail "$1: stdout [$(cat "$OUT")] != [$2]"
}

expect_stderr_has() {
  grep -qF -- "$2" "$ERR" || fail "$1: stderr missing [$2], got [$(cat "$ERR")]"
}

expect_stderr_empty() {
  [[ ! -s "$ERR" ]] || fail "$1: stderr must be empty, got [$(cat "$ERR")]"
}

# write_artifact <file> <header-lines> — header block, then a body section.
write_artifact() {
  printf '# Research: fixture\n%s\n\n## Summary\nBody text.\n' "$2" > "$1"
}

F="$TMP/a.md"

# --- actionable paths -------------------------------------------------------
write_artifact "$F" "Status: draft"
run_check "$F"; expect "missing disposition" 0; expect_stdout "missing" "actionable"; expect_stderr_empty "missing"

write_artifact "$F" "Disposition:   "
run_check "$F"; expect "empty disposition" 0; expect_stdout "empty" "actionable"

write_artifact "$F" "Disposition: actionable"
run_check "$F"; expect "explicit actionable" 0; expect_stdout "explicit" "actionable"; expect_stderr_empty "explicit"

write_artifact "$F" "Disposition: maybe-later"
run_check "$F"; expect "unknown disposition" 0; expect_stdout "unknown" "actionable"
expect_stderr_has "unknown" "warning: unknown disposition 'maybe-later' — treated as actionable"

for d in not-actionable insufficient-context superseded; do
  write_artifact "$F" "Disposition: $d"
  run_check "$F"; expect "uncited $d" 0; expect_stdout "uncited $d" "actionable"
  expect_stderr_has "uncited $d" "warning: uncited $d — treated as actionable"
done

write_artifact "$F" "$(printf 'Disposition: superseded\nDisposition-Evidence:   ')"
run_check "$F"; expect "blank evidence" 0; expect_stdout "blank evidence" "actionable"

# --- refusal (exit 1) and override ------------------------------------------
HINT='to proceed anyway: re-run with --override-disposition "<reason>"'
for d in not-actionable insufficient-context superseded; do
  write_artifact "$F" "$(printf 'Disposition: %s\nDisposition-Evidence: %s' "$d" "$EVIDENCE")"
  run_check "$F"; expect "cited $d" 1
  expect_stdout "cited $d" "$(printf '%s: %s\n%s' "$d" "$EVIDENCE" "$HINT")"
  run_check "$F" --override "operator says go"; expect "override $d" 0
  expect_stdout "override $d" "overridden: $d ($EVIDENCE) — operator says go"
done

write_artifact "$F" "$(printf 'Disposition: Not-Actionable\nDisposition-Evidence: %s' "$EVIDENCE")"
run_check "$F"; expect "case-insensitive" 1
expect_stdout "case-insensitive" "$(printf 'not-actionable: %s\n%s' "$EVIDENCE" "$HINT")"

printf '# Research: crlf\r\nDisposition: superseded\r\nDisposition-Evidence: plans/x.md\r\n\r\n## Summary\r\n' > "$F"
run_check "$F"; expect "CRLF header" 1
expect_stdout "CRLF header" "$(printf 'superseded: plans/x.md\n%s' "$HINT")"

printf '# Research: body\n\n## Notes\nDisposition: not-actionable\nDisposition-Evidence: x.js:1\n' > "$F"
run_check "$F"; expect "body line ignored" 0; expect_stdout "body line ignored" "actionable"; expect_stderr_empty "body"

# --- usage / error (exit 2) -------------------------------------------------
write_artifact "$F" "$(printf 'Disposition: superseded\nDisposition-Evidence: %s' "$EVIDENCE")"
run_check; expect "no args" 2
run_check "$TMP/nope.md"; expect "missing file" 2; expect_stderr_has "missing file" "missing or unreadable"
run_check "$TMP"; expect "directory arg" 2
run_check "$F" --override; expect "override no reason" 2; expect_stderr_has "override no reason" "non-empty reason"
run_check "$F" --override ""; expect "override empty reason" 2
run_check "$F" --override "   "; expect "override blank reason" 2
run_check "$F" --bogus; expect "unknown flag" 2; expect_stderr_has "unknown flag" "unknown flag '--bogus'"
run_check --bogus "$F"; expect "leading flag" 2
run_check "$F" extra; expect "extra arg" 2; expect_stderr_has "extra arg" "unexpected argument 'extra'"
run_check "$F" --override a --override b; expect "double override" 2

# --- real research artifacts pass unchanged as actionable -------------------
count=0
for f in "$RESEARCH_DIR"/*.md; do
  [[ -f "$f" ]] || fail "no research artifacts found under $RESEARCH_DIR"
  [[ "$(basename "$f")" == "README.md" ]] && continue
  run_check "$f"; expect "real $(basename "$f")" 0; expect_stdout "real $(basename "$f")" "actionable"
  count=$((count + 1))
done
[[ "$count" -ge 8 ]] || fail "expected >= 8 real research artifacts, found $count"

echo "ALL PASS"
