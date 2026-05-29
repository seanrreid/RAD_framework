#!/usr/bin/env bash
# check-scope.sh
# Verifies that all files changed on a work branch are declared in the plan's
# "Files in Scope" section. Also allows test files listed in "Tests to Write".
#
# Usage: scripts/check-scope.sh <plan-file> <work-branch> [base-branch]
#   base-branch defaults to the project default branch (get-default-branch.sh).
#
# Exit codes:
#   0 = all changes within scope
#   1 = out-of-scope files detected
#   2 = usage error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PLAN_FILE="${1:-}"
DELIVER_BRANCH="${2:-}"
BASE_BRANCH="${3:-$("$SCRIPT_DIR/get-default-branch.sh" 2>/dev/null || echo main)}"

[[ -z "$PLAN_FILE" ]]      && { echo "ERROR: plan file required";    exit 2; }
[[ -z "$DELIVER_BRANCH" ]] && { echo "ERROR: work branch required"; exit 2; }
[[ ! -f "$PLAN_FILE" ]]    && { echo "ERROR: plan file not found: $PLAN_FILE"; exit 2; }

# ── Build declared scope set ──────────────────────────────────────────────────

declare -A SCOPE

# Files from ## Files in Scope table (column 2)
while IFS= read -r path; do
  path=$(echo "$path" | tr -d '[:space:]')
  [[ -z "$path" || "$path" == "[path]" || "$path" == "File" ]] && continue
  SCOPE["$path"]=1
done < <(
  awk '/^## Files in Scope/{found=1; next} /^## /{found=0} found && /^\|/' "$PLAN_FILE" \
    | grep -v "^| *File\|^|[-| ]*$" \
    | awk -F'|' '{print $2}'
)

# Test files from ## Tests to Write (path after " — " on each line)
while IFS= read -r line; do
  # Format: - [ ] description — path/to/test_file.ext
  if [[ "$line" =~ —[[:space:]]+([^[:space:]].+)$ ]]; then
    testfile=$(echo "${BASH_REMATCH[1]}" | tr -d '[:space:]')
    [[ -n "$testfile" ]] && SCOPE["$testfile"]=1
  fi
done < <(
  awk '/^## Tests to Write/{found=1; next} /^## /{found=0} found && /^- /' "$PLAN_FILE"
)

# Always allow execution logs and the plan file itself
ALWAYS_ALLOW_PREFIXES=(
  ".agents/logs/"
  ".agents/plans/"
)

# ── Get changed files on the work branch ──────────────────────────────────────

CHANGED_FILES=$(git diff --name-only "origin/$BASE_BRANCH"..."$DELIVER_BRANCH" 2>/dev/null \
  || git diff --name-only "$BASE_BRANCH"..."$DELIVER_BRANCH" 2>/dev/null \
  || git diff --name-only "$BASE_BRANCH".."$DELIVER_BRANCH" 2>/dev/null)

if [[ -z "$CHANGED_FILES" ]]; then
  echo "⚠ No changed files detected between $BASE_BRANCH and $DELIVER_BRANCH"
  exit 0
fi

# ── Check each changed file ───────────────────────────────────────────────────

OUT_OF_SCOPE=()
IN_SCOPE=()

while IFS= read -r file; do
  [[ -z "$file" ]] && continue

  # Check always-allowed prefixes
  allowed=false
  for prefix in "${ALWAYS_ALLOW_PREFIXES[@]}"; do
    if [[ "$file" == "$prefix"* ]]; then
      allowed=true
      break
    fi
  done
  $allowed && continue

  # Check declared scope (exact match or prefix match for directories)
  declared=false
  for declared_path in "${!SCOPE[@]}"; do
    if [[ "$file" == "$declared_path" || "$file" == "$declared_path/"* ]]; then
      declared=true
      break
    fi
  done

  if $declared; then
    IN_SCOPE+=("$file")
  else
    OUT_OF_SCOPE+=("$file")
  fi
done <<< "$CHANGED_FILES"

# ── Output ────────────────────────────────────────────────────────────────────

PLAN_NAME=$(basename "$PLAN_FILE" .md)

if [[ "${#OUT_OF_SCOPE[@]}" -eq 0 ]]; then
  echo "✓ Scope check passed: $PLAN_NAME"
  echo "  ${#IN_SCOPE[@]} file(s) changed — all within declared scope"
  exit 0
fi

echo "✗ Scope violation: $PLAN_NAME"
echo ""
echo "Out-of-scope changes (${#OUT_OF_SCOPE[@]}):"
for f in "${OUT_OF_SCOPE[@]}"; do
  echo "  ✗ $f"
done
echo ""
echo "Declared scope (${#SCOPE[@]} paths):"
for p in "${!SCOPE[@]}"; do
  echo "  · $p"
done
echo ""
echo "Out-of-scope changes require architect approval before this PR can merge."
exit 1
