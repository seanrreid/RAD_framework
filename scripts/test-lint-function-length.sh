#!/usr/bin/env bash
# test-lint-function-length.sh
# Regression tests for lint-function-length.mjs: the 40-line limit boundary,
# the baseline ratchet (grew / tighten / remove), stable function keys,
# fail-closed exits, --write-baseline, and the excluded directories.
# Self-contained: builds fixture trees in a temp dir and runs the REAL lint
# against them with --root / --baseline. Runs under bash 3.2+.
#
# Usage: scripts/test-lint-function-length.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LINT="$HERE/lint-function-length.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

readonly LIMIT=40
PASSED=0
OUT=""
RC=0

fail() { echo "✗ $1"; exit 1; }
pass() { PASSED=$((PASSED + 1)); echo "✓ $1"; }

# fn_lines <name> <n> — a function declaration spanning exactly n lines.
fn_lines() {
  local name="$1" n="$2" i
  echo "function $name() {"
  for ((i = 0; i < n - 2; i++)); do echo "  void 0;"; done
  echo "}"
}

# new_root <name> — fresh fixture root with harness/ and an empty baseline path.
new_root() {
  R="$TMP/$1"
  B="$R/baseline.txt"
  mkdir -p "$R/harness" "$R/scripts"
}

# lint — run the lint on $R / $B, capturing combined output and exit code.
lint() {
  RC=0
  OUT="$(node "$LINT" --root "$R" --baseline "$B" "$@" 2>&1)" || RC=$?
}

# expect <label> <rc> [pattern] — assert last lint's exit code and output.
expect() {
  local label="$1" rc="$2" pattern="${3:-}"
  [[ "$RC" -eq "$rc" ]] || fail "$label: expected exit $rc, got $RC: $OUT"
  if [[ -n "$pattern" ]]; then
    printf '%s\n' "$OUT" | grep -qF -- "$pattern" || fail "$label: output lacks '$pattern': $OUT"
  fi
  pass "$label"
}

# ── limit boundary ───────────────────────────────────────────────────────────
new_root boundary
fn_lines exactly40 "$LIMIT" > "$R/harness/a.js"
lint; expect "exactly 40 lines passes" 0
fn_lines tooLong $((LIMIT + 1)) > "$R/harness/a.js"
lint; expect "41 lines fails naming file, key and length" 1 "harness/a.js::tooLong: 41 lines"

# ── baseline ratchet ─────────────────────────────────────────────────────────
new_root ratchet
fn_lines big 50 > "$R/harness/a.js"
printf 'harness/a.js::big\t50\n' > "$B"
lint; expect "baselined function at its recorded length passes" 0
fn_lines big 51 > "$R/harness/a.js"
lint; expect "baselined function that grows fails" 1 "grew from 50 to 51"
fn_lines big 45 > "$R/harness/a.js"
lint; expect "shrunk but still over 40 says tighten" 1 "tighten the baseline to 45"
fn_lines big "$LIMIT" > "$R/harness/a.js"
lint; expect "dropped to 40 says remove" 1 "remove the baseline entry"
fn_lines renamed 50 > "$R/harness/a.js"
lint; expect "renamed function: old entry says remove" 1 "no longer found — remove the baseline entry"
echo '' > "$R/harness/a.js"
lint; expect "deleted function says remove" 1 "remove the baseline entry"

# ── stable keys ──────────────────────────────────────────────────────────────
new_root keys
fn_lines big 50 > "$R/harness/a.js"
lint --write-baseline >/dev/null
{ echo '// a'; echo '// b'; echo 'const x = 1;'; fn_lines big 50; } > "$R/harness/a.js"
lint; expect "inserting lines above keeps the key" 0

new_root siblings
{ fn_lines dup 45; fn_lines dup 46; } > "$R/harness/a.js"
lint; expect "same-named siblings get distinct keys" 1 "harness/a.js::dup#2: 46 lines"
printf '%s\n' "$OUT" | grep -qF "harness/a.js::dup#1: 45 lines" || fail "siblings: #1 key missing: $OUT"

new_root anon
{ echo 'function outer() {'; echo '  return [1].map(() => {'; for ((i = 0; i < 44; i++)); do echo '    void 0;'; done; echo '  });'; echo '}'; } > "$R/harness/a.js"
lint; expect "anonymous callback keyed under its enclosing function" 1 "harness/a.js::outer><anon>: 46 lines"

new_root shapes
{
  echo 'const arrow = () => {'; for ((i = 0; i < 40; i++)); do echo '  void 0;'; done; echo '};'
  echo 'class Box {'; echo '  method() {'; for ((i = 0; i < 40; i++)); do echo '    void 0;'; done; echo '  }'; echo '}'
  echo 'function wrap() {'; echo '  function inner() {'; for ((i = 0; i < 40; i++)); do echo '    void 0;'; done; echo '  }'; echo '}'
} > "$R/harness/a.js"
lint
expect "arrow function measured by variable name" 1 "harness/a.js::arrow: 42 lines"
printf '%s\n' "$OUT" | grep -qF "harness/a.js::Box>method: 42 lines" || fail "class method key missing: $OUT"
printf '%s\n' "$OUT" | grep -qF "harness/a.js::wrap>inner: 42 lines" || fail "nested function key missing: $OUT"
pass "class methods and nested functions measured separately"

# ── fail closed (exit 2) ─────────────────────────────────────────────────────
new_root syntax
echo 'function (' > "$R/harness/a.js"
lint; expect "syntax error exits 2" 2 "does not parse"

new_root empty
lint; expect "no files exits 2" 2 "no files to scan"

new_root malformed
fn_lines ok 10 > "$R/harness/a.js"
echo 'not a valid line' > "$B"
lint; expect "malformed baseline line exits 2" 2 "malformed baseline line"
printf 'harness/a.js::x\t50\nharness/a.js::x\t50\n' > "$B"
lint; expect "duplicate baseline key exits 2" 2 "duplicate baseline key"
mkdir -p "$B.d"; B="$B.d"
lint; expect "unreadable baseline exits 2" 2 "cannot read baseline"
B="$R/missing.txt"
lint; expect "missing baseline is empty" 0
lint --bogus; expect "unknown argument exits 2" 2 "unknown argument"

# ── --write-baseline ─────────────────────────────────────────────────────────
new_root write
{ fn_lines zeta 60; fn_lines alpha 45; fn_lines small 5; } > "$R/harness/a.js"
lint --write-baseline; expect "--write-baseline succeeds" 0
lint; expect "check right after --write-baseline exits 0" 0
grep -q '^#' "$B" || fail "baseline lacks a header comment"
grep -qF 'small' "$B" && fail "baseline lists a function within the limit"
entries="$(grep -v '^#' "$B" | cut -f1)"
[[ "$entries" == "$(printf '%s\n' "$entries" | sort)" ]] || fail "baseline is not sorted"
pass "baseline has a header, is sorted, and omits in-limit functions"

# ── scan scope ───────────────────────────────────────────────────────────────
new_root scope
for d in test vendor node_modules evals fixtures; do
  mkdir -p "$R/harness/$d"; fn_lines hidden 60 > "$R/harness/$d/x.js"
done
fn_lines ok 10 > "$R/harness/a.js"
lint; expect "excluded directories are not scanned" 0
fn_lines scriptFn 60 > "$R/scripts/tool.mjs"
lint; expect "scripts/*.mjs is scanned" 1 "scripts/tool.mjs::scriptFn"
rm "$R/scripts/tool.mjs"; mkdir -p "$R/scripts/sub"; fn_lines deep 60 > "$R/scripts/sub/t.mjs"
lint; expect "scripts subdirectories are not scanned" 0

# ── the lint obeys itself ────────────────────────────────────────────────────
RC=0
OUT="$(node "$LINT" --baseline "$TMP/none.txt" 2>&1 | grep -F 'lint-function-length.mjs')" || RC=$?
[[ "$RC" -eq 1 ]] || fail "lint-function-length.mjs has an over-long function: $OUT"
pass "lint-function-length.mjs has no function over $LIMIT lines"

echo "PASS: $PASSED assertions"
