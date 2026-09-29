#!/usr/bin/env bash
# test-lint-invariants.sh
# Regression tests for lint-invariants.sh: schema validation, anchor coupling
# (missing file, moved symbol, missing symbol), empty registry, unanalyzed
# bypasses, unparseable YAML, the #91 divergence (a claim anchored to text the
# current spine no longer contains), the --inventory table, and the REAL
# registry. Self-contained: builds fixture roots in a temp dir and points
# RAD_INVARIANTS_ROOT at them. Runs under bash 3.2+ (set -u safe).
#
# Usage: scripts/test-lint-invariants.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$HERE")"
LINT="$HERE/lint-invariants.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

# run_lint <root> [args...] — run the REAL script against a fixture root;
# output to $TMP/out, prints the exit code.
run_lint() {
  local root="$1"; shift
  local code=0
  RAD_INVARIANTS_ROOT="$root" bash "$LINT" "$@" > "$TMP/out" 2>&1 || code=$?
  echo "$code"
}

# build_fixture <dir> — a CLEAN root: one source file and a registry with one
# invariant anchored in it, plus a guarded and an UNGUARDED bypass.
build_fixture() {
  local dir="$1"
  mkdir -p "$dir/src" "$dir/docs"
  cat > "$dir/src/gate.js" <<'EOF'
// header
export function checkGate(events) {
  return events.some((e) => e.type === 'approved');
}
EOF
  cat > "$dir/docs/invariants.yaml" <<'EOF'
version: 1
invariants:
  - id: approval-gates-deliver
    claim: Deliver runs only after an approved event.
    authority: events.jsonl approved event
    enforced_by:
      - { file: src/gate.js, symbol: "export function checkGate" }
    bypasses:
      - { id: proxy, surface: "--on-behalf-of", guarded: "yes", note: recorded }
      - { id: env-skip, surface: "RAD_SKIP_GATE", guarded: "no", note: open }
EOF
}

# ── A1: valid registry passes ──────────────────────────────────────────────────
build_fixture "$TMP/a1"
code=$(run_lint "$TMP/a1")
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "A1: valid registry should exit 0 (got $code)"; }
grep -q "✓ invariants: 1 entries, 1 anchors resolved" "$TMP/out" || { cat "$TMP/out"; fail "A1: expected ✓ summary"; }
echo "✓ A1: valid registry passes (exit 0)"

# ── A2: renamed (missing) anchor file fails, naming the entry ──────────────────
build_fixture "$TMP/a2"
mv "$TMP/a2/src/gate.js" "$TMP/a2/src/gates.js"
code=$(run_lint "$TMP/a2")
[[ "$code" -eq 1 ]] || fail "A2: missing anchor file should exit 1 (got $code)"
grep -q "✗ approval-gates-deliver: src/gate.js not found" "$TMP/out" || { cat "$TMP/out"; fail "A2: expected entry id + missing file"; }
echo "✓ A2: renamed anchor file fails naming the entry (exit 1)"

# ── A3: symbol moved within the file still passes ──────────────────────────────
build_fixture "$TMP/a3"
printf '// moved below\n\n\n' > "$TMP/a3/src/new.js"
cat "$TMP/a3/src/gate.js" >> "$TMP/a3/src/new.js"
mv "$TMP/a3/src/new.js" "$TMP/a3/src/gate.js"
code=$(run_lint "$TMP/a3")
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "A3: moved symbol should still pass (got $code)"; }
echo "✓ A3: symbol moved within file passes (exit 0)"

# ── A4: missing symbol in an existing file fails, naming id + symbol ───────────
build_fixture "$TMP/a4"
printf 'export function renamedGate() {}\n' > "$TMP/a4/src/gate.js"
code=$(run_lint "$TMP/a4")
[[ "$code" -eq 1 ]] || fail "A4: missing symbol should exit 1 (got $code)"
grep -q "✗ approval-gates-deliver: symbol not found in src/gate.js: export function checkGate" "$TMP/out" \
  || { cat "$TMP/out"; fail "A4: expected entry id + symbol"; }
echo "✓ A4: missing symbol fails naming id + symbol (exit 1)"

# ── A5: empty registry passes ──────────────────────────────────────────────────
mkdir -p "$TMP/a5/docs"
printf 'version: 1\ninvariants: []\n' > "$TMP/a5/docs/invariants.yaml"
code=$(run_lint "$TMP/a5")
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "A5: empty registry should exit 0 (got $code)"; }
grep -q "✓ invariants: 0 entries, 0 anchors resolved" "$TMP/out" || { cat "$TMP/out"; fail "A5: expected 0/0 summary"; }
echo "✓ A5: empty registry passes (exit 0)"

# ── A6: missing bypasses key fails as "not analyzed" ───────────────────────────
build_fixture "$TMP/a6"
grep -v -e 'bypasses:' -e '{ id: ' "$TMP/a6/docs/invariants.yaml" > "$TMP/a6/reg.yaml"
code=$(run_lint "$TMP/a6" "$TMP/a6/reg.yaml")
[[ "$code" -eq 1 ]] || { cat "$TMP/out"; fail "A6: missing bypasses should exit 1 (got $code)"; }
grep -q "✗ approval-gates-deliver: bypasses not analyzed" "$TMP/out" || { cat "$TMP/out"; fail "A6: expected 'not analyzed'"; }
echo "✓ A6: missing bypasses key fails as not analyzed (exit 1)"

# ── A7: unparseable YAML is a usage error ──────────────────────────────────────
mkdir -p "$TMP/a7/docs"
printf 'version: 1\ninvariants: [ { id: broken\n' > "$TMP/a7/docs/invariants.yaml"
code=$(run_lint "$TMP/a7")
[[ "$code" -eq 2 ]] || { cat "$TMP/out"; fail "A7: unparseable YAML should exit 2 (got $code)"; }
echo "✓ A7: unparseable YAML exits 2"

# ── A8: #91 divergence — a per-wave regression claim anchored to text the ──────
# CURRENT (post-fix) spine no longer contains must fail, naming the entry.
mkdir -p "$TMP/a8/docs" "$TMP/a8/harness"
cp "$REPO_ROOT/harness/spine.js" "$TMP/a8/harness/spine.js"
cat > "$TMP/a8/docs/invariants.yaml" <<'EOF'
version: 1
invariants:
  - id: per-wave-regression-detection
    claim: Each wave detects a regression and demotes it to fail-tests.
    authority: harness/spine.js
    enforced_by:
      - { file: harness/spine.js, symbol: "// regression. DEMOTE it to fail-tests" }
    bypasses: []
EOF
code=$(run_lint "$TMP/a8")
[[ "$code" -eq 1 ]] || { cat "$TMP/out"; fail "A8: #91 divergence should exit 1 (got $code)"; }
grep -q "✗ per-wave-regression-detection: symbol not found in harness/spine.js" "$TMP/out" \
  || { cat "$TMP/out"; fail "A8: expected the diverged entry to be named"; }
echo "✓ A8: #91 divergence caught against current spine.js (exit 1)"

# ── A9: --inventory marks guarded:no as UNGUARDED ──────────────────────────────
build_fixture "$TMP/a9"
code=$(run_lint "$TMP/a9" --inventory)
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "A9: --inventory should exit 0 (got $code)"; }
grep -q "^invariant | bypass | surface | guarded | note$" "$TMP/out" || { cat "$TMP/out"; fail "A9: expected header"; }
grep -q "^approval-gates-deliver | env-skip | RAD_SKIP_GATE | UNGUARDED | open$" "$TMP/out" \
  || { cat "$TMP/out"; fail "A9: expected UNGUARDED row"; }
grep -q "^approval-gates-deliver | proxy | --on-behalf-of | guarded | recorded$" "$TMP/out" \
  || { cat "$TMP/out"; fail "A9: expected guarded row"; }
echo "✓ A9: --inventory prints UNGUARDED for guarded:no (exit 0)"

# ── Usage errors: unknown flag, extra args, missing registry → exit 2 ─────────
build_fixture "$TMP/u"
[[ "$(run_lint "$TMP/u" --bogus)" -eq 2 ]] || fail "usage: unknown flag should exit 2"
[[ "$(run_lint "$TMP/u" a.yaml b.yaml)" -eq 2 ]] || fail "usage: extra args should exit 2"
[[ "$(run_lint "$TMP/u" "$TMP/u/nope.yaml")" -eq 2 ]] || fail "usage: missing registry should exit 2"
echo "✓ usage errors exit 2"

# ── R1: the REAL registry lints clean and inventories the known bypasses ──────
if [[ -f "$REPO_ROOT/docs/invariants.yaml" ]]; then
  code=0
  env -u RAD_INVARIANTS_ROOT bash "$LINT" > "$TMP/out" 2>&1 || code=$?
  [[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "R1: real registry should lint clean (got $code)"; }
  code=0
  env -u RAD_INVARIANTS_ROOT bash "$LINT" --inventory > "$TMP/inv" 2>&1 || code=$?
  [[ "$code" -eq 0 ]] || { cat "$TMP/inv"; fail "R1: real --inventory should exit 0 (got $code)"; }
  for surface in --on-behalf-of RAD_HIGH_RISK_PATTERNS '## Waivers' RAD_HOOKS_DIR \
                 RAD_AGENT_PREFLIGHT RAD_VERIFY_TIMEOUT_SECONDS RAD_BRANCH_PREFIX; do
    grep -qF -- "$surface" "$TMP/inv" || fail "R1: inventory missing surface: $surface"
  done
  echo "✓ R1: real registry lints clean and inventories all known surfaces"
else
  echo "SKIP R1: docs/invariants.yaml not present yet"
fi

echo "ALL PASS"
