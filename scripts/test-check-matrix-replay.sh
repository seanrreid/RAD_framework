#!/usr/bin/env bash
# test-check-matrix-replay.sh
# Regression tests for check-matrix-replay.sh: known divergence, identical
# tables, removed outcome (throws:), unparseable table, empty history,
# branch-tip-preferred log collection, malformed log, unsafe-name skip warning,
# and usage errors.
# Hermetic: builds a temp git repo with a local bare origin and copies the
# script, get-default-branch.sh, and harness/ (minus node_modules/test — the
# replay modules plus cli.js, which serves `rad config get`) into it, with a
# fixture .rad/config.yml at its root. Runs under bash 3.2+ (set -u safe).
#
# Usage: scripts/test-check-matrix-replay.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(cd "$HERE/.." && pwd)"
# Physical path (pwd -P): cli.js runs main() only when argv[1] equals its
# realpath, and macOS mktemp dirs live under the /var -> /private/var symlink.
TMP="$(mktemp -d)"
TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT
unset RAD_BRANCH_PREFIX

fail() { echo "✗ $1"; echo "--- output ---"; cat "$TMP/out"; exit 1; }
pass() { echo "✓ $1"; }

GREPO="$TMP/repo"
ORIGIN="$TMP/origin.git"
mkdir -p "$GREPO/scripts" "$GREPO/harness" "$GREPO/.rad"
cp "$SRC_ROOT/scripts/check-matrix-replay.sh" "$SRC_ROOT/scripts/get-default-branch.sh" "$GREPO/scripts/"
for p in "$SRC_ROOT/harness/"*; do
  case "$(basename "$p")" in node_modules|test) ;; *) cp -R "$p" "$GREPO/harness/" ;; esac
done
cat > "$GREPO/.rad/config.yml" <<'EOF'
version: 1
platform: manual
default_branch: main
roles:
  architect:
    - arch@example.com
EOF

g() { git -C "$GREPO" -c user.email=t@t.t -c user.name=t -c commit.gpgsign=false "$@"; }

git init -q --bare "$ORIGIN"
g init -q
g checkout -q -b main
g add -A
g commit -q -m "baseline tables"
g remote add origin "$ORIGIN"
g push -q origin main

MATRIX="$GREPO/harness/matrix.yaml"

attempt_event() {
  # attempt_event <feature-or-empty> <attempt> — a fail-tests wave-attempt line
  if [[ -n "$1" ]]; then
    printf '{"feature":"%s","type":"wave-attempt","data":{"wave":1,"attempt":%s,"outcome":"fail-tests"}}\n' "$1" "$2"
  else
    printf '{"type":"wave-attempt","data":{"wave":1,"attempt":%s,"outcome":"fail-tests"}}\n' "$2"
  fi
}

write_log() {
  # write_log <feature> <attempt> — working-tree log (feature stamped from path)
  mkdir -p "$GREPO/.agents/state/$1"
  attempt_event "" "$2" > "$GREPO/.agents/state/$1/events.jsonl"
}

set_fail_tests() {
  # set_fail_tests <action> — rewrites the fail-tests row in the working tree
  sed -E "s/^(  fail-tests:[[:space:]]*)\{ action: [a-z-]+ \}/\1{ action: $1 }/" "$MATRIX" > "$TMP/m" \
    && cp "$TMP/m" "$MATRIX"
}

restore_tables() { g checkout -q -- harness/matrix.yaml harness/gates.yaml; }

CODE=0
run_check() {
  set +e
  ( cd "$GREPO" && "$BASH" scripts/check-matrix-replay.sh "$@" ) > "$TMP/out" 2>&1
  CODE=$?
  set -e
}

expect_code() { [[ "$CODE" == "$1" ]] || fail "$2: expected exit $1, got $CODE"; }
expect_out() { grep -qF -- "$1" "$TMP/out" || fail "$2: missing '$1'"; }
reject_out() { if grep -qF -- "$1" "$TMP/out"; then fail "$2: unexpected '$1'"; fi; }

# ── R5: no state logs ─────────────────────────────────────────────────────────
run_check
expect_code 0 R5; expect_out "no history to replay" R5
pass "R5 no history → exit 0 + 'no history to replay'"

# ── R1: known divergence ──────────────────────────────────────────────────────
write_log f1 1
set_fail_tests abort
run_check
expect_code 0 R1
expect_out "divergence: f1 matrix #0 wave 1 attempt 1 outcome fail-tests: revision → abort" R1
expect_out "1 divergence(s) across 1 feature(s) — advisory; review before merging" R1
pass "R1 fail-tests revision→abort renders a divergence, exit 0"

# ── R2: identical tables ──────────────────────────────────────────────────────
restore_tables
run_check
expect_code 0 R2; expect_out "no divergences across 1 feature(s)" R2
pass "R2 identical tables → no divergences"

# ── R3: proposed table missing an outcome ─────────────────────────────────────
grep -v '^  fail-tests:' "$MATRIX" > "$TMP/m" && cp "$TMP/m" "$MATRIX"
run_check
expect_code 0 R3
expect_out "divergence: f1 matrix #0 wave 1 attempt 1 outcome fail-tests: revision → throws:" R3
pass "R3 removed outcome → divergence with throws:, exit 0"

# ── R4: unparseable proposed YAML ─────────────────────────────────────────────
printf 'implement: [unclosed\n' > "$MATRIX"
run_check
expect_code 1 R4; expect_out "error: unparseable proposed matrix table" R4
pass "R4 unparseable proposed YAML → exit 1"
restore_tables

# ── R9: malformed event log ───────────────────────────────────────────────────
mkdir -p "$GREPO/.agents/state/bad"
printf '{"type":\n' > "$GREPO/.agents/state/bad/events.jsonl"
run_check
expect_code 1 R9; expect_out "error: malformed event log for bad" R9
pass "R9 malformed event log → exit 1"
rm -rf "$GREPO/.agents/state/bad"

# ── R10: unsafe feature dir name → warned skip, not silent drop ───────────────
mkdir -p "$GREPO/.agents/state/bad name"
attempt_event "" 1 > "$GREPO/.agents/state/bad name/events.jsonl"
run_check
expect_code 0 R10
expect_out "warning: skipped working-tree .agents/state/bad\\ name/events.jsonl log" R10
expect_out "unsafe feature name: bad\\ name" R10
expect_out "no divergences across 1 feature(s) (1 log(s) skipped — see warnings)" R10
pass "R10 unsafe feature name → stderr warning + skipped count in summary, exit 0"
rm -rf "$GREPO/.agents/state/bad name"

# ── R6: branch-tip log replayed and preferred over the working-tree copy ──────
g checkout -q -b rad/f2
mkdir -p "$GREPO/.agents/state/f2"
attempt_event f2 7 > "$GREPO/.agents/state/f2/events.jsonl"
g add .agents/state/f2/events.jsonl
g commit -q -m "f2 log"
g push -q origin rad/f2
g checkout -q main
g fetch -q origin
g rev-parse --verify --quiet refs/remotes/origin/rad/f2 >/dev/null || { echo "✗ R6 setup: no origin/rad/f2"; exit 1; }
write_log f2 1
set_fail_tests abort
run_check
expect_code 0 R6
expect_out "divergence: f2 matrix #0 wave 1 attempt 7 outcome fail-tests: revision → abort" R6
reject_out "divergence: f2 matrix #0 wave 1 attempt 1" R6
expect_out "divergence: f1 matrix #0" R6
expect_out "2 divergence(s) across 2 feature(s)" R6
pass "R6 branch-tip log replayed and preferred over working tree"
restore_tables

# ── R7: bad --base ────────────────────────────────────────────────────────────
run_check --base no-such-ref
expect_code 1 R7; expect_out "no-such-ref" R7
pass "R7 unresolvable --base → exit 1 naming the ref"

# ── R8: usage errors ──────────────────────────────────────────────────────────
run_check --bogus
expect_code 2 R8
run_check --base
expect_code 2 "R8 missing value"
run_check --base main extra
expect_code 2 "R8 extra arg"
pass "R8 unknown flag / missing value / extra arg → exit 2"

echo "ALL PASS"
