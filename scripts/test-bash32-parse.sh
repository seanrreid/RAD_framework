#!/usr/bin/env bash
# test-bash32-parse.sh
# Parse-checks every *.sh under scripts/ with a bash 3.2 interpreter (`-n`), so
# a construct that only newer bash accepts (e.g. #102: an unparenthesised case
# pattern inside a `$( ... )` loop) cannot land again unnoticed. macOS ships
# /bin/bash 3.2, which is what operators actually run.
#
# Interpreter resolution:
#   - RAD_BASH32 set + executable + reports major version 3 → used
#   - RAD_BASH32 set + executable + NOT 3.x → hard failure (misconfiguration
#     must not masquerade as a check)
#   - RAD_BASH32 set but not executable → SKIP
#   - else /bin/bash if it reports major version 3 → used
#   - else → SKIP (explicit line, exit 0; CI's macOS job fails on SKIP)
#
# Self-tests (run before the tree scan):
#   - a #102 fixture must be reported as failing by the same per-file check
#   - nested runs prove the SKIP and misconfiguration branches
#
# Runs under bash 3.2+ (set -euo pipefail safe; no globstar/mapfile/assoc arrays).
# Usage: scripts/test-bash32-parse.sh   (exit 0 + "ALL PASS" = all files parse)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQUIRED_MAJOR=3
DEFAULT_BASH32="/bin/bash"
SKIP_MSG="SKIP: no bash 3.2 interpreter found (set RAD_BASH32 or run on macOS); parse check not performed"
# Set on nested self-test invocations so they only exercise resolution.
NESTED_VAR="RAD_BASH32_NESTED"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

bash_major() {
  "$1" -c 'echo "${BASH_VERSINFO[0]}"'
}

# Prints the resolved interpreter path; returns 1 when none is available (SKIP),
# exits 2 on a misconfigured RAD_BASH32.
resolve_bash32() {
  local major
  if [ -n "${RAD_BASH32:-}" ]; then
    [ -x "$RAD_BASH32" ] || return 1
    if ! major="$(bash_major "$RAD_BASH32")"; then
      echo "ERROR: RAD_BASH32=$RAD_BASH32 failed to report its version" >&2
      exit 2
    fi
    if [ "$major" != "$REQUIRED_MAJOR" ]; then
      echo "ERROR: RAD_BASH32=$RAD_BASH32 reports bash major version '$major', expected $REQUIRED_MAJOR" >&2
      exit 2
    fi
    echo "$RAD_BASH32"
    return 0
  fi
  if [ -x "$DEFAULT_BASH32" ] && major="$(bash_major "$DEFAULT_BASH32")" \
     && [ "$major" = "$REQUIRED_MAJOR" ]; then
    echo "$DEFAULT_BASH32"
    return 0
  fi
  return 1
}

# 0 = parses under $BASH32; non-zero = syntax error (stderr captured to $2).
parse_check() {
  "$BASH32" -n "$1" 2>"$2"
}

# resolve_bash32's `exit 2` only leaves the $( ) subshell, so propagate it here.
resolve_rc=0
BASH32="$(resolve_bash32)" || resolve_rc=$?
case "$resolve_rc" in
  0) ;;
  1) echo "$SKIP_MSG"; exit 0 ;;
  *) exit "$resolve_rc" ;;
esac

if [ -n "${RAD_BASH32_NESTED:-}" ]; then
  echo "resolved: $BASH32"
  exit 0
fi

echo "using bash 3.2 interpreter: $BASH32"

# --- Self-test 1: the check catches the #102 regression -----------------------
FIXTURE="$TMP/fixture-102.sh"
cat >"$FIXTURE" <<'EOF'
out=$(for x in a b; do case "$x" in *//*) continue ;; esac; echo "$x"; done)
EOF
if parse_check "$FIXTURE" "$TMP/fixture.err"; then
  fail "SELF-TEST: #102 fixture parsed cleanly — the check cannot detect the regression"
fi
echo "✓ SELF-TEST-102: #102 fixture reported as failing"

# --- Self-test 2: resolution branches (nested runs) ---------------------------
SELF="$HERE/$(basename "${BASH_SOURCE[0]}")"
skip_out="$(env "$NESTED_VAR=1" RAD_BASH32=/nonexistent bash "$SELF" 2>&1)" \
  || fail "SELF-TEST: RAD_BASH32=/nonexistent exited non-zero"
case "$skip_out" in
  *"$SKIP_MSG"*) echo "✓ SELF-TEST-SKIP: non-executable RAD_BASH32 prints SKIP and exits 0" ;;
  *) fail "SELF-TEST: RAD_BASH32=/nonexistent did not print the SKIP line: $skip_out" ;;
esac

FAKE5="$TMP/fake-bash5"
printf '#!/bin/sh\necho 5\n' >"$FAKE5"
chmod +x "$FAKE5"
if misconf_out="$(env "$NESTED_VAR=1" RAD_BASH32="$FAKE5" bash "$SELF" 2>&1)"; then
  fail "SELF-TEST: non-3.x RAD_BASH32 exited 0: $misconf_out"
fi
case "$misconf_out" in
  *"$SKIP_MSG"*) fail "SELF-TEST: non-3.x RAD_BASH32 masqueraded as SKIP" ;;
esac
echo "✓ SELF-TEST-MISCONF: non-3.x RAD_BASH32 fails loudly"

# --- Tree scan ----------------------------------------------------------------
failed=""
count=0
while IFS= read -r -d '' f; do
  count=$((count + 1))
  rel="${f#"$HERE"/}"
  if parse_check "$f" "$TMP/parse.err"; then
    echo "✓ $rel"
  else
    echo "✗ $rel"
    sed 's/^/    /' "$TMP/parse.err"
    failed="$failed    $rel
"
  fi
done < <(find "$HERE" -type f -name '*.sh' -print0)

[ "$count" -gt 0 ] || fail "no *.sh files found under $HERE"

if [ -n "$failed" ]; then
  echo "FAIL: files not parseable by bash 3.2 ($BASH32):"
  printf '%s' "$failed"
  exit 1
fi

echo "ALL PASS ($count files)"
