#!/usr/bin/env bash
# test-install-harness.sh
# Smoke test locking in the install-ships-harness behavior:
#   - install.sh ships harness/ source (EXCLUDING the ~250M node_modules dir)
#   - the vendored js-yaml bundle ships (gate path needs zero npm)
#   - scripts/hooks/ (README + lifecycle dirs) ships
#   - harness/cli.js loads and `rad gate` runs with NO node_modules present
#     (proves the lazy SDK import / zero-npm property)
# Self-contained: installs into a throwaway temp dir, asserts, always cleans up.
#
# Usage: scripts/test-install-harness.sh   (exit 0 = all assertions pass)

set -euo pipefail

# The script lives in scripts/, so REPO_ROOT is its parent.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0

ok()   { echo "✓ $1"; PASS=$((PASS + 1)); }
bad()  { echo "✗ $1"; FAIL=$((FAIL + 1)); }

assert_exists()     { [[ -e "$1" ]] && ok "$2" || bad "$2 (missing: $1)"; }
assert_dir()        { [[ -d "$1" ]] && ok "$2" || bad "$2 (not a dir: $1)"; }
assert_not_exists() { [[ ! -e "$1" ]] && ok "$2" || bad "$2 (should not exist: $1)"; }

# ── 1. throwaway git repo as install target ─────────────────────────────────
git init -q "$TMP"

# ── 2. run the installer non-interactively, suppressing its stdout ──────────
( cd "$REPO_ROOT" && bash install.sh --dir "$TMP" --yes >/dev/null )

# ── 3a. harness source shipped; node_modules excluded ───────────────────────
assert_exists "$TMP/harness/cli.js" "harness/cli.js shipped"
assert_not_exists "$TMP/harness/node_modules" "harness/node_modules excluded (the ~250M dir)"

# ── 3b. vendored js-yaml bundle shipped ─────────────────────────────────────
assert_exists "$TMP/harness/vendor/js-yaml.mjs" "vendored js-yaml bundle shipped"

# ── 3c. wave-lifecycle hooks shipped ────────────────────────────────────────
assert_exists "$TMP/scripts/hooks/README.md" "scripts/hooks/README.md shipped"
assert_dir "$TMP/scripts/hooks/on-error"  "scripts/hooks/on-error dir shipped"
assert_dir "$TMP/scripts/hooks/post-wave" "scripts/hooks/post-wave dir shipped"

# ── 3d. cli.js loads with NO node_modules present (lazy SDK / zero-npm) ──────
if node "$TMP/harness/cli.js" >/dev/null 2>&1; then
  ok "harness/cli.js loads with no node_modules present (lazy SDK import)"
else
  bad "harness/cli.js failed to load without node_modules (exit $?)"
fi

# ── 3e. `rad gate` over a synthetic approved event exits 0 (zero-npm gate) ───
EVENT='{"feature":"x","type":"approved","actor":"a","role":"architect","ts":"2026-01-01T00:00:00Z","recordedBy":"a"}'
if printf '%s\n' "$EVENT" | node "$TMP/harness/cli.js" gate x approved --stdin >/dev/null 2>&1; then
  ok "rad gate x approved --stdin passes on a synthetic approved event"
else
  bad "rad gate x approved --stdin failed (exit $?)"
fi

# ── summary ─────────────────────────────────────────────────────────────────
echo "─────────────────────────────────────────"
echo "PASS: $PASS  FAIL: $FAIL"
if [[ "$FAIL" -ne 0 ]]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: ALL PASS"
