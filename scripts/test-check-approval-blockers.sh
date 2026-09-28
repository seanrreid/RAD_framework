#!/usr/bin/env bash
# test-check-approval-blockers.sh
# Tests for scripts/check-approval-blockers.sh: exit 0 (applied waivers on
# stdout) / 1 (blockers named on stderr, empty stdout) / 2 (usage, missing,
# empty plan — fail closed). Builds plan fixtures in a temp dir and runs the
# real script against them. Runs under bash 3.2+ (set -euo pipefail safe).
#
# Usage: scripts/test-check-approval-blockers.sh   (exit 0 + "ALL PASS")

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/check-approval-blockers.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

TAB=$'\t'
RISK_PATH="src/auth/login.js"
RISK_ID="high-risk:$RISK_PATH"
OUT="$TMP/out.txt"
ERR="$TMP/err.txt"

# run_check [env-assignment...] -- <args...>
# Run the script, capturing stdout/stderr to $OUT/$ERR; sets RC to its exit code.
# Default env leaves RAD_HIGH_RISK_PATTERNS unset (the built-in default applies).
run_check() {
  local envs=()
  while [[ "$1" != "--" ]]; do envs+=("$1"); shift; done
  shift
  if env -u RAD_HIGH_RISK_PATTERNS ${envs[@]+"${envs[@]}"} bash "$SCRIPT" "$@" >"$OUT" 2>"$ERR"; then
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

# write_plan <file> <scope-path> <extra-body>
write_plan() {
  cat > "$1" <<EOF
# Plan: fixture
Status: pending-review

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| \`$2\` | 1-10 | Modify |

$3
EOF
}

# ── clean plan ─────────────────────────────────────────────────────────────────
write_plan "$TMP/clean.md" "docs/readme.md" ""
run_check -- "$TMP/clean.md"
expect "clean plan" 0; expect_empty_stdout "clean plan"
echo "✓ clean plan ⇒ exit 0, empty stdout"

# ── one live marker ───────────────────────────────────────────────────────────
write_plan "$TMP/marker.md" "docs/readme.md" "Which store? [NEEDS CLARIFICATION: pick a store]"
run_check -- "$TMP/marker.md"
expect "one marker" 1; expect_empty_stdout "one marker"
grep -q "clarification marker at line 9: pick a store" "$ERR" \
  || fail "one marker: stderr must name line 9, got: [$(cat "$ERR")]"
echo "✓ one marker ⇒ exit 1, line named on stderr"

# ── fenced marker only ────────────────────────────────────────────────────────
write_plan "$TMP/fenced.md" "docs/readme.md" $'```\n[NEEDS CLARIFICATION: example only]\n```'
run_check -- "$TMP/fenced.md"
expect "fenced marker" 0; expect_empty_stdout "fenced marker"
echo "✓ fenced marker only ⇒ exit 0"

# ── high-risk path, no waiver ─────────────────────────────────────────────────
write_plan "$TMP/risk.md" "$RISK_PATH" ""
run_check -- "$TMP/risk.md"
expect "high-risk no waiver" 1; expect_empty_stdout "high-risk no waiver"
grep -Fq "un-waived high-risk finding: $RISK_ID" "$ERR" \
  || fail "high-risk no waiver: stderr must name $RISK_ID, got: [$(cat "$ERR")]"
echo "✓ high-risk path without waiver ⇒ exit 1, id named"

# ── matching waiver ───────────────────────────────────────────────────────────
write_plan "$TMP/waived.md" "$RISK_PATH" $'## Waivers\n- '"$RISK_ID"': reviewed: login flow only'
run_check -- "$TMP/waived.md"
expect "matching waiver" 0
[[ "$(cat "$OUT")" == "$RISK_ID${TAB}reviewed: login flow only" ]] \
  || fail "matching waiver: stdout mismatch, got: [$(cat "$OUT")]"
echo "✓ matching waiver ⇒ exit 0, exact '<id>\\t<justification>' on stdout"

# ── stale waiver alone (+ clarify-named waiver) ───────────────────────────────
write_plan "$TMP/stale.md" "docs/readme.md" \
  $'## Waivers\n- high-risk:gone/token.js: path was removed\n- clarify:1: cannot waive a marker'
run_check -- "$TMP/stale.md"
expect "stale waiver" 0; expect_empty_stdout "stale waiver"
echo "✓ stale / clarify-named waivers ⇒ exit 0, not printed"

# ── empty-justification waiver on a high-risk path ────────────────────────────
write_plan "$TMP/nojust.md" "$RISK_PATH" $'## Waivers\n- '"$RISK_ID"':'
run_check -- "$TMP/nojust.md"
expect "empty justification" 1; expect_empty_stdout "empty justification"
echo "✓ empty-justification waiver ⇒ exit 1 (not applied)"

# ── marker + waived finding ───────────────────────────────────────────────────
write_plan "$TMP/mixed.md" "$RISK_PATH" \
  $'[NEEDS CLARIFICATION: open]\n## Waivers\n- '"$RISK_ID"': reviewed'
run_check -- "$TMP/mixed.md"
expect "marker + waived finding" 1; expect_empty_stdout "marker + waived finding"
grep -q "clarification marker" "$ERR" || fail "marker + waived finding: marker not named"
if grep -q "un-waived" "$ERR"; then fail "marker + waived finding: waived finding must not block"; fi
echo "✓ marker + waived finding ⇒ exit 1 (marker only), empty stdout"

# ── RAD_HIGH_RISK_PATTERNS='' falls back to the default (never disables) ───────
run_check RAD_HIGH_RISK_PATTERNS= -- "$TMP/risk.md"
expect "empty pattern" 1; expect_empty_stdout "empty pattern"
grep -Fq "un-waived high-risk finding: $RISK_ID" "$ERR" \
  || fail "empty pattern: default must still flag $RISK_ID, got: [$(cat "$ERR")]"
echo "✓ RAD_HIGH_RISK_PATTERNS='' with a high-risk path ⇒ exit 1 (default applies)"

# ── narrowed custom pattern matching nothing ──────────────────────────────────
run_check RAD_HIGH_RISK_PATTERNS=no-such-path-zzz -- "$TMP/risk.md"
expect "narrowed pattern" 0; expect_empty_stdout "narrowed pattern"
echo "✓ narrowed RAD_HIGH_RISK_PATTERNS matching nothing ⇒ exit 0"

# ── inline-span marker only ───────────────────────────────────────────────────
write_plan "$TMP/span.md" "docs/readme.md" 'Syntax: `[NEEDS CLARIFICATION: example]` is the marker.'
run_check -- "$TMP/span.md"
expect "inline-span marker" 0; expect_empty_stdout "inline-span marker"
echo "✓ inline-span marker only ⇒ exit 0"

# ── error cases: missing file, empty file, no args ────────────────────────────
run_check -- "$TMP/does-not-exist.md"
expect "missing file" 2; grep -q "not found" "$ERR" || fail "missing file: no stderr reason"
: > "$TMP/empty.md"
run_check -- "$TMP/empty.md"
expect "empty file" 2; grep -q "empty" "$ERR" || fail "empty file: no stderr reason"
run_check --
expect "no args" 2; grep -q "usage" "$ERR" || fail "no args: no usage message"
echo "✓ missing file / empty file / no args ⇒ exit 2 with a reason"

echo "ALL PASS"
