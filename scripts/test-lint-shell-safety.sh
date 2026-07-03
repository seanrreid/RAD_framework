#!/usr/bin/env bash
# test-lint-shell-safety.sh
# Regression tests for lint-shell-safety.sh: taint detection (positional +
# RAD_* env), sink matching (git / jq / node -e / eval), regex + case guard
# recognition, baseline ratchet semantics (warn / stale), and usage errors.
# Self-contained: builds synthetic script fixtures in a temp dir (no git
# needed) and runs the REAL script against them. Runs under bash 3.2+.
#
# Usage: scripts/test-lint-shell-safety.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

run_lint() {
  # run_lint <scripts-dir> <baseline-file> — runs the REAL lint; echoes code.
  local dir="$1" baseline="$2" code
  set +e
  bash "$HERE/lint-shell-safety.sh" "$dir" "$baseline" > "$TMP/out" 2>&1
  code=$?
  set -e
  echo "$code"
}

EMPTY_BASELINE="$TMP/empty-baseline.txt"
: > "$EMPTY_BASELINE"

# ── Case 1: regex-guarded positional into git passes ───────────────────────────
mkdir -p "$TMP/guarded"
cat > "$TMP/guarded/deploy.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
BRANCH="${1:-}"
if [[ ! "$BRANCH" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "invalid branch" >&2
  exit 2
fi
git fetch origin "$BRANCH"
EOF
code=$(run_lint "$TMP/guarded" "$EMPTY_BASELINE")
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 1: regex-guarded script should exit 0 (got $code)"; }
grep -q "^PASS:" "$TMP/out" || fail "case 1: expected terminal PASS line"
echo "✓ case 1: regex-guarded positional into git passes (exit 0)"

# ── Case 2: unguarded positional into git fails ────────────────────────────────
mkdir -p "$TMP/unguarded"
cat > "$TMP/unguarded/deploy.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
BRANCH="${1:-}"
[[ -z "$BRANCH" ]] && exit 2
git fetch origin "$BRANCH"
EOF
code=$(run_lint "$TMP/unguarded" "$EMPTY_BASELINE")
[[ "$code" -eq 1 ]] || fail "case 2: unguarded script should exit 1 (got $code)"
grep -q '✗ deploy.sh: unguarded \$BRANCH' "$TMP/out" || fail "case 2: expected unguarded-BRANCH reason"
echo "✓ case 2: unguarded positional into git fails (exit 1)"

# ── Case 3: same unguarded script, baselined → warns but exits 0 ───────────────
cat > "$TMP/baseline.txt" <<'EOF'
# frozen offenders
deploy.sh   # unguarded: $BRANCH into git fetch
EOF
code=$(run_lint "$TMP/unguarded" "$TMP/baseline.txt")
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 3: baselined offender should exit 0 (got $code)"; }
grep -q '⚠ baseline: deploy.sh: unguarded \$BRANCH' "$TMP/out" || fail "case 3: expected baseline warning"
grep -q "^PASS:" "$TMP/out" || fail "case 3: expected terminal PASS line"
echo "✓ case 3: baselined offender warns without failing (exit 0)"

# ── Case 4: baseline listing a clean file → stale warning, exit 0 ──────────────
cat > "$TMP/stale-baseline.txt" <<'EOF'
deploy.sh   # this file is guarded now — entry should be reported stale
EOF
code=$(run_lint "$TMP/guarded" "$TMP/stale-baseline.txt")
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 4: stale baseline should exit 0 (got $code)"; }
grep -q '⚠ stale baseline: deploy.sh' "$TMP/out" || fail "case 4: expected stale-baseline warning"
echo "✓ case 4: stale baseline entry warns and still exits 0"

# ── Case 5: nonexistent scripts dir → usage error (exit 2) ─────────────────────
code=$(run_lint "$TMP/no-such-dir" "$EMPTY_BASELINE")
[[ "$code" -eq 2 ]] || fail "case 5: nonexistent dir should exit 2 (got $code)"
grep -q "scripts dir not found" "$TMP/out" || fail "case 5: expected dir-not-found error"
echo "✓ case 5: nonexistent scripts dir exits 2"

# ── Case 6: unguarded RAD_* env-derived variable into node -e fails ────────────
mkdir -p "$TMP/envsink"
cat > "$TMP/envsink/report.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
PATTERN="${RAD_HIGH_RISK_PATTERNS:-}"
node -e "console.log('$PATTERN')"
EOF
code=$(run_lint "$TMP/envsink" "$EMPTY_BASELINE")
[[ "$code" -eq 1 ]] || fail "case 6: env-derived var into node -e should exit 1 (got $code)"
grep -q '✗ report.sh: unguarded \$PATTERN' "$TMP/out" || fail "case 6: expected unguarded-PATTERN reason"
echo "✓ case 6: unguarded RAD_* env variable into node -e fails (exit 1)"

# ── Case 7: case-guarded variable into git passes ──────────────────────────────
mkdir -p "$TMP/caseguard"
cat > "$TMP/caseguard/mode.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
MODE="${1:-}"
case "$MODE" in
  push|fetch) : ;;
  *) echo "bad mode" >&2; exit 2 ;;
esac
git config "sync.$MODE" true
EOF
code=$(run_lint "$TMP/caseguard" "$EMPTY_BASELINE")
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 7: case-guarded script should exit 0 (got $code)"; }
echo "✓ case 7: case-guarded variable into git passes (exit 0)"

# ── Case 8: test-*.sh fixtures are excluded from the scan ──────────────────────
mkdir -p "$TMP/excluded"
cat > "$TMP/excluded/test-something.sh" <<'EOF'
#!/usr/bin/env bash
BRANCH="$1"
git fetch origin "$BRANCH"
EOF
code=$(run_lint "$TMP/excluded" "$EMPTY_BASELINE")
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 8: test-*.sh should be excluded (got $code)"; }
echo "✓ case 8: test-*.sh fixtures are excluded (exit 0)"

echo "ALL PASS"
