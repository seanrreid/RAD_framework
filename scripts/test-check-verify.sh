#!/usr/bin/env bash
# test-check-verify.sh
# Behavior tests for scripts/check-verify.sh — the EXECUTING verification gate.
# Every case asserts an explicit exit code, because the exit code is the entire
# contract: the deliver spine reads it and nothing else to decide the wave's
# outcome (0 = pass, 124 = timed out → fail-timeout, 2 = usage error, anything
# else = the command's own code → fail-tests).
#
# Cases:
#   A1 passing command            → exit 0, output DISCARDED
#   A2 failing command            → the command's OWN exit code, bounded excerpt
#   A3 output over the caps       → truncated by lines AND by bytes
#   A4 missing/malformed argument → exit 2 (fail-closed usage error)
#   A5 stderr-only command        → stderr is captured, exit code passed through
#   A6 timeout                    → exit 124, distinctly reported, promptly
#   A7 env containment            → a non-allow-listed variable never reaches the
#                                    command (the plan's named highest risk)
#
# Self-contained (no external harness): runs the real script against real
# commands and asserts on real exit codes. Runs under bash 3.2+ (set -u safe).
#
# Usage: scripts/test-check-verify.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/check-verify.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── Constants mirrored from check-verify.sh ───────────────────────────────────
# Kept in lockstep with the script under test; a drift here is a real failure,
# not a test bug.
readonly EXPECTED_TIMEOUT_STATUS=124
readonly EXPECTED_USAGE_STATUS=2
readonly EXPECTED_MAX_LINES=40
readonly EXPECTED_MAX_BYTES=8000
# Slack for the excerpt HEADER lines the script prints above the excerpt itself
# (the "✗ Verification FAILED" line plus up to two truncation notices).
readonly HEADER_LINE_SLACK=5
readonly HEADER_BYTE_SLACK=400
# Timeout used by the timeout case. Small on purpose: a 600s default would make
# this suite unusable, and the timeout PATH is what is under test, not the value.
readonly FAST_TIMEOUT_SECONDS=1
# Upper bound on how long the timeout case may take (timeout + SIGTERM grace).
readonly FAST_TIMEOUT_MAX_ELAPSED=15

fail() { echo "✗ $1"; exit 1; }

OUT="$TMP/out"
ERR="$TMP/err"
CODE=0

run_verify() {
  # Run the real script, capturing stdout/stderr separately and recording its
  # exit code in CODE without tripping set -e (every case asserts on that code).
  set +e
  bash "$SCRIPT" "$@" >"$OUT" 2>"$ERR"
  CODE=$?
  set -e
}

out_lines() { wc -l <"$OUT" | tr -d '[:space:]'; }
out_bytes() { wc -c <"$OUT" | tr -d '[:space:]'; }

# ── A0: the script is executable ─────────────────────────────────────────────

[[ -x "$SCRIPT" ]] || fail "A0: $SCRIPT is not executable"
echo "✓ A0: check-verify.sh is executable"

# ── A1: a passing command exits 0 and prints NOTHING ─────────────────────────
# A green run has nothing the retry prompt needs, so its output is discarded.

run_verify 'true'
[[ "$CODE" -eq 0 ]] || fail "A1: a passing command should exit 0 (got $CODE)"
[[ "$(out_bytes)" -eq 0 ]] || fail "A1: passing output must be discarded (got $(out_bytes) bytes)"
echo "✓ A1: passing command → exit 0, no output"

# ── A2: a failing command passes its OWN exit code through ───────────────────
# Not a normalized 1: the spine and the operator both see what really happened.

run_verify 'echo "boom on stdout"; exit 7'
[[ "$CODE" -eq 7 ]] || fail "A2: the command's own exit code should pass through (want 7, got $CODE)"
grep -q "Verification FAILED (exit 7)" "$OUT" || fail "A2: failure banner missing from output"
grep -q "boom on stdout" "$OUT" || fail "A2: the command's stdout is not in the excerpt"
echo "✓ A2: failing command → own exit code (7), bounded excerpt printed"

# ── A3: truncation BITES — by lines, and independently by bytes ──────────────
# Truncation is mandatory, not best-effort: an untruncated failing suite in the
# retry prompt reproduces the context flood this check exists to prevent.

printf 'line %s\n' $(awk 'BEGIN{for(i=1;i<=500;i++)print i}') >"$TMP/many-lines"
run_verify "cat '$TMP/many-lines'; exit 1"
[[ "$CODE" -eq 1 ]] || fail "A3: failing command should exit 1 (got $CODE)"
[[ "$(out_lines)" -le $((EXPECTED_MAX_LINES + HEADER_LINE_SLACK)) ]] ||
  fail "A3: output not line-capped — $(out_lines) lines (cap $EXPECTED_MAX_LINES)"
grep -q "truncated: last $EXPECTED_MAX_LINES of 500 lines" "$OUT" ||
  fail "A3: the line-cap truncation notice is missing"
# The TAIL is what survives (where runners put the failure summary).
grep -q '^line 500$' "$OUT" || fail "A3: the tail of the output was not the part kept"
grep -q '^line 1$' "$OUT" && fail "A3: the head should have been truncated away"
echo "✓ A3a: 500-line output → line-capped to $EXPECTED_MAX_LINES, tail kept"

# One enormous SINGLE line: the line cap cannot bite, so the byte cap must.
awk 'BEGIN{s="";for(i=0;i<20000;i++)s=s "x";print s}' >"$TMP/one-huge-line"
run_verify "cat '$TMP/one-huge-line'; exit 1"
[[ "$CODE" -eq 1 ]] || fail "A3b: failing command should exit 1 (got $CODE)"
[[ "$(out_bytes)" -le $((EXPECTED_MAX_BYTES + HEADER_BYTE_SLACK)) ]] ||
  fail "A3b: output not byte-capped — $(out_bytes) bytes (cap $EXPECTED_MAX_BYTES)"
grep -q "output capped at $EXPECTED_MAX_BYTES bytes" "$OUT" ||
  fail "A3b: the byte-cap truncation notice is missing"
echo "✓ A3b: one 20000-byte line → byte-capped to $EXPECTED_MAX_BYTES, notice printed"

# ── A4: usage errors are fail-closed, exit 2, and run nothing ────────────────

run_verify
[[ "$CODE" -eq "$EXPECTED_USAGE_STATUS" ]] ||
  fail "A4: no argument should exit $EXPECTED_USAGE_STATUS (got $CODE)"
grep -q "Usage:" "$ERR" || fail "A4: usage text should go to stderr"
echo "✓ A4a: missing command → exit $EXPECTED_USAGE_STATUS"

run_verify 'true' 'extra-argument'
[[ "$CODE" -eq "$EXPECTED_USAGE_STATUS" ]] ||
  fail "A4b: two arguments should exit $EXPECTED_USAGE_STATUS (got $CODE)"
echo "✓ A4b: more than one argument → exit $EXPECTED_USAGE_STATUS"

run_verify '   '
[[ "$CODE" -eq "$EXPECTED_USAGE_STATUS" ]] ||
  fail "A4c: a blank command should exit $EXPECTED_USAGE_STATUS (got $CODE)"
echo "✓ A4c: empty/whitespace command → exit $EXPECTED_USAGE_STATUS"

# A malformed timeout override is a HARD error, never a silent fall back to the
# default — an operator typo must not quietly restore a 600s ceiling.
RAD_VERIFY_TIMEOUT_SECONDS="ten" run_verify 'true'
[[ "$CODE" -eq "$EXPECTED_USAGE_STATUS" ]] ||
  fail "A4d: a non-numeric RAD_VERIFY_TIMEOUT_SECONDS should exit $EXPECTED_USAGE_STATUS (got $CODE)"
grep -q "RAD_VERIFY_TIMEOUT_SECONDS" "$ERR" || fail "A4d: the bad value is not named in the error"
RAD_VERIFY_TIMEOUT_SECONDS="0" run_verify 'true'
[[ "$CODE" -eq "$EXPECTED_USAGE_STATUS" ]] ||
  fail "A4e: a zero RAD_VERIFY_TIMEOUT_SECONDS should exit $EXPECTED_USAGE_STATUS (got $CODE)"
echo "✓ A4d/e: malformed RAD_VERIFY_TIMEOUT_SECONDS → exit $EXPECTED_USAGE_STATUS, never a silent default"

# ── A5: a command that writes ONLY to stderr still reports ───────────────────
# The excerpt is combined stdout/stderr; a suite that logs failures to stderr
# (most of them) must not produce an empty excerpt.

run_verify 'echo "only on stderr" >&2; exit 3'
[[ "$CODE" -eq 3 ]] || fail "A5: stderr-only command should pass through exit 3 (got $CODE)"
grep -q "only on stderr" "$OUT" || fail "A5: stderr was not captured into the excerpt"
echo "✓ A5: stderr-only command → exit 3, stderr captured in the excerpt"

# ── A6: a wedged command is killed and reported DISTINCTLY ───────────────────
# 124 is reserved so the spine can map it to fail-timeout (surface) instead of
# fail-tests (retry) — a retry cannot fix a hang.

START=$SECONDS
RAD_VERIFY_TIMEOUT_SECONDS="$FAST_TIMEOUT_SECONDS" run_verify 'sleep 60'
ELAPSED=$((SECONDS - START))
[[ "$CODE" -eq "$EXPECTED_TIMEOUT_STATUS" ]] ||
  fail "A6: a timed-out command should exit $EXPECTED_TIMEOUT_STATUS (got $CODE)"
grep -q "TIMED OUT after ${FAST_TIMEOUT_SECONDS}s" "$OUT" || fail "A6: the timeout is not reported distinctly"
[[ "$ELAPSED" -le "$FAST_TIMEOUT_MAX_ELAPSED" ]] ||
  fail "A6: the timeout did not fire promptly (${ELAPSED}s elapsed)"
echo "✓ A6: wedged command → exit $EXPECTED_TIMEOUT_STATUS in ${ELAPSED}s, reported distinctly"

# ── A7: env containment — the plan's named highest risk ──────────────────────
# The command is arbitrary shell from an approved plan. It runs under `env -i`
# plus a fixed allow-list, so no credential exported by the operator can reach
# it. This is a PERMANENT regression test: a widened allow-list must fail here.

export RAD_TEST_CANARY="a-credential-shaped-value"
[[ -n "${RAD_TEST_CANARY:-}" ]] || fail "A7: the canary is unset in the test's own env — the case would pass vacuously"

run_verify 'test -z "$RAD_TEST_CANARY"'
[[ "$CODE" -eq 0 ]] || fail "A7a: a non-allow-listed variable REACHED the command (exit $CODE)"
echo "✓ A7a: a non-allow-listed variable does not reach the executed command"

# The negative control: proving the check above is not vacuous. If the canary
# were somehow visible, this command would exit 0 and the assertion would fail.
run_verify 'test -n "$RAD_TEST_CANARY"'
[[ "$CODE" -ne 0 ]] || fail "A7b: negative control failed — the canary was visible to the command"
echo "✓ A7b: negative control — asserting the canary IS visible correctly fails"

# Allow-listed variables DO reach the command; otherwise nothing could be run.
run_verify 'test -n "$PATH"'
[[ "$CODE" -eq 0 ]] || fail "A7c: the allow-listed PATH did not reach the command (exit $CODE)"
echo "✓ A7c: allow-listed PATH reaches the executed command"

echo "ALL PASS"
