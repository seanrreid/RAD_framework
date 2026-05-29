#!/usr/bin/env bash
# check-tests.sh
# Verifies that every test file listed in a plan's "Tests to Write" section
# has been created on disk.
#
# Usage: scripts/check-tests.sh <plan-file>
#
# Exit codes:
#   0 = all test files present
#   1 = one or more test files missing
#   2 = usage error

set -euo pipefail

PLAN_FILE="${1:-}"
[[ -z "$PLAN_FILE" ]] && { echo "ERROR: plan file required"; exit 2; }
[[ ! -f "$PLAN_FILE" ]] && { echo "ERROR: plan file not found: $PLAN_FILE"; exit 2; }

MISSING=()
FOUND=()
UNRESOLVABLE=()

# ── Parse ## Tests to Write ───────────────────────────────────────────────────
# Expected format: - [ ] description — path/to/test_file.ext
# Also handles:    - [x] description — path/to/test_file.ext

while IFS= read -r line; do
  if [[ "$line" =~ —[[:space:]]+([^[:space:]].+)$ ]]; then
    testfile="${BASH_REMATCH[1]}"
    # Strip Markdown backticks (authors commonly wrap the path) and trailing space.
    testfile="${testfile//\`/}"
    testfile=$(echo "$testfile" | sed 's/[[:space:]]*$//')

    if [[ -z "$testfile" || "$testfile" == "[file]" ]]; then
      UNRESOLVABLE+=("$line")
      continue
    fi

    if [[ -f "$testfile" ]]; then
      FOUND+=("$testfile")
    else
      MISSING+=("$testfile")
    fi
  else
    # Line has no file reference — flag as unresolvable
    UNRESOLVABLE+=("$line")
  fi
done < <(
  awk '/^## Tests to Write/{found=1; next} /^## /{found=0} found && /^- /' "$PLAN_FILE"
)

# ── Check if section is empty ─────────────────────────────────────────────────

TOTAL=$(( ${#FOUND[@]} + ${#MISSING[@]} + ${#UNRESOLVABLE[@]} ))

if [[ "$TOTAL" -eq 0 ]]; then
  echo "⚠ No tests listed in ## Tests to Write — section may be empty"
  exit 1
fi

# ── Output ────────────────────────────────────────────────────────────────────

PLAN_NAME=$(basename "$PLAN_FILE" .md)

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
