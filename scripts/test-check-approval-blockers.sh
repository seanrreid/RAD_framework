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

# ── fenced example waiver only (fail-open regression) ─────────────────────────
# A ``` fenced example holding a `## Waivers` heading and a bullet naming the REAL
# high-risk path must not be applied — the blocker stands.
FENCED_WAIVER=$'```markdown\n## Waivers\n- '"$RISK_ID"$': example only\n```'
write_plan "$TMP/fenced-waiver.md" "$RISK_PATH" "$FENCED_WAIVER"
run_check -- "$TMP/fenced-waiver.md"
expect "fenced waiver only" 1; expect_empty_stdout "fenced waiver only"
grep -qF "un-waived high-risk finding: $RISK_ID" "$ERR" \
  || fail "fenced waiver only: stderr must name $RISK_ID, got: [$(cat "$ERR")]"
echo "✓ waiver only inside a fenced example ⇒ exit 1 (not applied)"

# Same plan plus a real section → only the real waiver applies.
write_plan "$TMP/fenced-plus-real.md" "$RISK_PATH" \
  "$FENCED_WAIVER"$'\n\n## Waivers\n- '"$RISK_ID"': the real waiver'
run_check -- "$TMP/fenced-plus-real.md"
expect "fenced + real waiver" 0
[[ "$(cat "$OUT")" == "$RISK_ID${TAB}the real waiver" ]] \
  || fail "fenced + real waiver: stdout must hold only the real waiver, got: [$(cat "$OUT")]"
echo "✓ fenced example + real ## Waivers ⇒ exit 0, only the real waiver on stdout"

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
# A non-default pattern is recorded: stdout is exactly the tag line.
run_check RAD_HIGH_RISK_PATTERNS=no-such-path-zzz -- "$TMP/risk.md"
expect "narrowed pattern" 0
[[ "$(cat "$OUT")" == "high-risk-pattern${TAB}no-such-path-zzz" ]] \
  || fail "narrowed pattern: stdout must be exactly the tag line, got: [$(cat "$OUT")]"
echo "✓ narrowed RAD_HIGH_RISK_PATTERNS matching nothing ⇒ exit 0, stdout exactly the tag line"

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

# ── light tier: non-waivable blockers ─────────────────────────────────────────
# write_tier_plan <file> <tier-line> <scope-path> <waves> <extra-body>
# One single-task wave per <waves>; <tier-line> is placed in the header block.
write_tier_plan() {
  local w
  { printf '# Plan: fixture\nStatus: pending-review\n%s\n\n## Files in Scope\n' "$2"
    printf '| File | Lines | Change |\n|------|-------|--------|\n| `%s` | 1-10 | Modify |\n\n' "$3"
    printf '## Wave Plan\n'
    for ((w = 1; w <= $4; w++)); do printf '### Wave %s\n#### Task %s.1: t\nFile: %s\n' "$w" "$w" "$3"; done
    printf '\n%s\n' "$5"
  } > "$1"
}
LIGHT_HINT='(shrink the plan or remove "Tier: light" to make it a standard plan)'

write_tier_plan "$TMP/light-ok.md" "Tier: light" "docs/readme.md" 1 ""
run_check -- "$TMP/light-ok.md"
expect "light within limits" 0; expect_empty_stdout "light within limits"
echo "✓ light plan within limits ⇒ exit 0, empty stdout"

write_tier_plan "$TMP/light-waves.md" "Tier: light" "docs/readme.md" 2 ""
run_check -- "$TMP/light-waves.md"
expect "light 2 waves" 1; expect_empty_stdout "light 2 waves"
grep -Fq "✗ light-tier: 2 waves (max 1) $LIGHT_HINT" "$ERR" \
  || fail "light 2 waves: stderr must name the violation + hint, got: [$(cat "$ERR")]"
echo "✓ light plan with 2 waves ⇒ exit 1, violation named with the promotion hint"

write_tier_plan "$TMP/light-self.md" "Tier: light" "harness/cli.js" 1 ""
run_check -- "$TMP/light-self.md"
expect "light self-protected" 1; expect_empty_stdout "light self-protected"
grep -Fq "light-tier: self-protected path harness/cli.js" "$ERR" \
  || fail "light self-protected: stderr must name the path, got: [$(cat "$ERR")]"
echo "✓ light plan with a self-protected path ⇒ exit 1"

write_tier_plan "$TMP/light-risk-waived.md" "Tier: light" "$RISK_PATH" 1 \
  $'## Waivers\n- '"$RISK_ID"': reviewed: login flow only'
run_check -- "$TMP/light-risk-waived.md"
expect "light high-risk waived" 1; expect_empty_stdout "light high-risk waived"
grep -Fq "light-tier: high-risk path $RISK_PATH" "$ERR" \
  || fail "light high-risk waived: light-tier blocker must stand, got: [$(cat "$ERR")]"
if grep -q "un-waived" "$ERR"; then fail "light high-risk waived: the high-risk: waiver itself must still apply"; fi
echo "✓ light plan + high-risk path + matching high-risk waiver ⇒ exit 1 (light-tier blocker stands), empty stdout"

write_tier_plan "$TMP/light-waiver-bullet.md" "Tier: light" "docs/readme.md" 2 \
  $'## Waivers\n- light-tier: 2 waves (max 1): needs two waves'
run_check -- "$TMP/light-waiver-bullet.md"
expect "light-tier waiver bullet" 1; expect_empty_stdout "light-tier waiver bullet"
grep -Fq "light-tier: 2 waves (max 1)" "$ERR" \
  || fail "light-tier waiver bullet: violation must still be named, got: [$(cat "$ERR")]"
echo "✓ a '- light-tier…:' waiver bullet has no effect ⇒ exit 1"

write_tier_plan "$TMP/standard-5.md" "" "docs/readme.md" 5 ""
run_check -- "$TMP/standard-5.md"
expect "standard 5 waves" 0; expect_empty_stdout "standard 5 waves"
[[ ! -s "$ERR" ]] || fail "standard 5 waves: stderr must be empty, got: [$(cat "$ERR")]"
echo "✓ standard (no Tier:) 5-wave plan ⇒ exit 0 as today"

# ── high-risk-pattern tag line (non-default effective pattern only) ───────────
# Default pattern ⇒ stdout byte-identical to the pre-tag contract.
run_check -- "$TMP/clean.md"
expect "tag default clean" 0; expect_empty_stdout "tag default clean"
run_check RAD_HIGH_RISK_PATTERNS= -- "$TMP/clean.md"
expect "tag empty-env clean" 0; expect_empty_stdout "tag empty-env clean"
DEFAULT_PATTERN=$(env -u RAD_HIGH_RISK_PATTERNS bash -c '. "$1"; plan_high_risk_pattern' _ "$HERE/lib/plan-paths.sh")
run_check "RAD_HIGH_RISK_PATTERNS=$DEFAULT_PATTERN" -- "$TMP/clean.md"
expect "tag exact-default clean" 0; expect_empty_stdout "tag exact-default clean"
run_check -- "$TMP/waived.md"
expect "tag default waived" 0
printf '%s\t%s\n' "$RISK_ID" "reviewed: login flow only" > "$TMP/expected.txt"
cmp -s "$OUT" "$TMP/expected.txt" \
  || fail "tag default waived: stdout must be byte-identical to the waiver line only, got: [$(cat "$OUT")]"
echo "✓ default pattern (unset / empty / exact) ⇒ no tag line; stdout byte-identical"

# Custom pattern + an applied waiver ⇒ tag line FIRST, then the waiver.
run_check "RAD_HIGH_RISK_PATTERNS=auth" -- "$TMP/waived.md"
expect "tag custom waived" 0
printf '%s\t%s\n%s\t%s\n' "high-risk-pattern" "auth" "$RISK_ID" "reviewed: login flow only" > "$TMP/expected.txt"
cmp -s "$OUT" "$TMP/expected.txt" \
  || fail "tag custom waived: stdout must be tag line then waiver, got: [$(cat "$OUT")]"
echo "✓ custom pattern + applied waiver ⇒ tag line, then waiver line"

# Custom pattern on a blocked plan ⇒ exit 1, stdout EMPTY (no tag).
run_check "RAD_HIGH_RISK_PATTERNS=no-such-path-zzz" -- "$TMP/marker.md"
expect "tag custom blocked" 1; expect_empty_stdout "tag custom blocked"
echo "✓ custom pattern on a blocked plan ⇒ exit 1, empty stdout"

# Custom pattern on a usage error ⇒ exit 2, stdout EMPTY.
run_check "RAD_HIGH_RISK_PATTERNS=no-such-path-zzz" -- "$TMP/does-not-exist.md"
expect "tag custom missing plan" 2; expect_empty_stdout "tag custom missing plan"
echo "✓ custom pattern + missing plan ⇒ exit 2, empty stdout"

# Regex metacharacters | ( ) ^ $ survive verbatim into the tag line.
META_PATTERN='(^|/)(zzz-none|yyy-none)($|/)'
run_check "RAD_HIGH_RISK_PATTERNS=$META_PATTERN" -- "$TMP/clean.md"
expect "tag metachar pattern" 0
printf '%s\t%s\n' "high-risk-pattern" "$META_PATTERN" > "$TMP/expected.txt"
cmp -s "$OUT" "$TMP/expected.txt" \
  || fail "tag metachar pattern: pattern must survive verbatim, got: [$(cat "$OUT")]"
echo "✓ pattern with | ( ) ^ \$ ⇒ tag line carries it verbatim"

echo "ALL PASS"
