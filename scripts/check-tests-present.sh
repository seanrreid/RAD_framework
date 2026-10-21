#!/usr/bin/env bash
# check-tests-present.sh
# Verifies that every test file listed in a plan's "Tests to Write" section
# EXISTS ON DISK. This is a presence check only: it never runs a test, never
# invokes a test runner, and knows nothing about whether the tests pass.
# A file containing zero assertions satisfies this check.
#
# Usage: scripts/check-tests-present.sh <plan-file> [--only <path>...]
#
# --only restricts the check to the listed paths (wave-scoped use). A path is
# checked only if it equals a Tests-to-Write entry's RESOLVED path exactly;
# every other line, unresolvable ones included, is ignored. If none of the
# listed paths is promised in Tests to Write, the check passes ("no promised
# tests yet") — the empty-section rule applies only without --only.
#
# Exit codes:
#   0 = all (filtered) test files present
#   1 = one or more (filtered) test files missing
#   2 = usage error

set -euo pipefail

ONLY_FLAG='--only'
USAGE="Usage: check-tests-present.sh <plan-file> [$ONLY_FLAG <path>...]"

PLAN_FILE="${1:-}"
[[ -z "$PLAN_FILE" ]] && { echo "ERROR: plan file required"; exit 2; }
[[ "$PLAN_FILE" == -* ]] && { echo "ERROR: plan file must come first"; echo "$USAGE"; exit 2; }
[[ ! -f "$PLAN_FILE" ]] && { echo "ERROR: plan file not found: $PLAN_FILE"; exit 2; }
shift

# ── Parse optional --only <path>... ───────────────────────────────────────────
# Bash 3.2 (macOS) has no associative arrays: ONLY_PATHS is a plain list and
# membership is a linear scan. Fail closed on anything unrecognised.
ONLY_MODE=0
ONLY_PATHS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    "$ONLY_FLAG") ONLY_MODE=1 ;;
    -*) echo "ERROR: unknown flag: $1"; echo "$USAGE"; exit 2 ;;
    *)
      [[ "$ONLY_MODE" -eq 1 ]] || { echo "ERROR: unexpected argument: $1"; echo "$USAGE"; exit 2; }
      ONLY_PATHS+=("$1")
      ;;
  esac
  shift
done
if [[ "$ONLY_MODE" -eq 1 && "${#ONLY_PATHS[@]}" -eq 0 ]]; then
  echo "ERROR: $ONLY_FLAG requires at least one path"; echo "$USAGE"; exit 2
fi

# True when $1 is exactly one of ONLY_PATHS. Only called in --only mode, where
# ONLY_PATHS is non-empty (an empty-array expansion trips set -u on bash 3.2).
in_only_list() {
  local p
  for p in "${ONLY_PATHS[@]}"; do
    [[ "$p" == "$1" ]] && return 0
  done
  return 1
}

MISSING=()
FOUND=()
UNRESOLVABLE=()

# ── Parse ## Tests to Write ───────────────────────────────────────────────────
# Expected format: - [ ] description — path/to/test_file.ext
# Also handles:    - [x] description — path/to/test_file.ext
# The description may itself contain em-dashes: the path is the text after the
# FINAL separator, so a line ending in a bare separator stays unresolvable.

FILE_SEPARATOR='— '
# A single trailing " (...)" group after the path is an annotation, e.g.
# "path/to/test.sh (Amendment 1)". Whitespace must precede it, so parentheses
# inside a path are kept; a bare group with no path before it is unresolvable.
ANNOTATED_PATH_RE='^(.*[^[:space:]])[[:space:]]+\([^()]*\)$'
ANNOTATION_ONLY_RE='^\([^()]*\)$'

while IFS= read -r line; do
  if [[ "$line" =~ —[[:space:]]+[^[:space:]]. ]]; then
    testfile="${line##*"$FILE_SEPARATOR"}"
    # Strip Markdown backticks (authors commonly wrap the path) and surrounding space.
    testfile="${testfile//\`/}"
    testfile=$(echo "$testfile" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    if [[ "$testfile" =~ $ANNOTATED_PATH_RE ]]; then
      testfile="${BASH_REMATCH[1]}"
    fi

    if [[ -z "$testfile" || "$testfile" == "[file]" || "$testfile" =~ $ANNOTATION_ONLY_RE ]]; then
      [[ "$ONLY_MODE" -eq 1 ]] || UNRESOLVABLE+=("$line")
      continue
    fi

    if [[ "$ONLY_MODE" -eq 1 ]] && ! in_only_list "$testfile"; then
      continue
    fi

    if [[ -f "$testfile" ]]; then
      FOUND+=("$testfile")
    else
      MISSING+=("$testfile")
    fi
  else
    # Line has no file reference — flag as unresolvable (ignored under --only)
    [[ "$ONLY_MODE" -eq 1 ]] || UNRESOLVABLE+=("$line")
  fi
done < <(
  awk '/^## Tests to Write/{found=1; next} /^## /{found=0} found && /^- /' "$PLAN_FILE"
)

# ── Check if section is empty ─────────────────────────────────────────────────

TOTAL=$(( ${#FOUND[@]} + ${#MISSING[@]} + ${#UNRESOLVABLE[@]} ))
PLAN_NAME=$(basename "$PLAN_FILE" .md)

# Under --only, nothing matching is not an error: this wave promised no tests.
if [[ "$ONLY_MODE" -eq 1 && "$TOTAL" -eq 0 ]]; then
  echo "✓ Test check passed: $PLAN_NAME (no promised tests yet)"
  exit 0
fi

if [[ "$TOTAL" -eq 0 ]]; then
  echo "⚠ No tests listed in ## Tests to Write — section may be empty"
  exit 1
fi

# ── Output ────────────────────────────────────────────────────────────────────

if [[ "${#MISSING[@]}" -eq 0 && "${#UNRESOLVABLE[@]}" -eq 0 ]]; then
  echo "✓ Test check passed: $PLAN_NAME"
  echo "  ${#FOUND[@]} test file(s) present"
  exit 0
fi

echo "Test check: $PLAN_NAME"
echo ""

if [[ "${#FOUND[@]}" -gt 0 ]]; then
  echo "Present (${#FOUND[@]}):"
  for f in "${FOUND[@]}"; do
    echo "  ✓ $f"
  done
  echo ""
fi

if [[ "${#MISSING[@]}" -gt 0 ]]; then
  echo "Missing (${#MISSING[@]}) — tests not written:"
  for f in "${MISSING[@]}"; do
    echo "  ✗ $f"
  done
  echo ""
fi

if [[ "${#UNRESOLVABLE[@]}" -gt 0 ]]; then
  echo "No file path found (${#UNRESOLVABLE[@]}) — add ' — path/to/test.ext' to each line:"
  for l in "${UNRESOLVABLE[@]}"; do
    echo "  ⚠ $l"
  done
  echo ""
fi

[[ "${#MISSING[@]}" -gt 0 ]] && exit 1 || exit 0
