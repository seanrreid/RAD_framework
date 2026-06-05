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
# Newline-delimited list rather than an associative array, so this runs on
# bash 3.2 (macOS stock) as well as bash 4+. Membership is an exact line match.

SCOPE_LIST=""

scope_add() {
  # Append a path if non-empty; dedup is unnecessary (membership test is exact).
  [[ -n "$1" ]] && SCOPE_LIST="${SCOPE_LIST}${1}"$'\n'
}

# Files from ## Files in Scope table (column 2)
while IFS= read -r path; do
  path=$(echo "$path" | tr -d '[:space:]`')
  [[ -z "$path" || "$path" == "[path]" || "$path" == "File" ]] && continue
  scope_add "$path"
done < <(
  awk '/^## Files in Scope/{found=1; next} /^## /{found=0} found && /^\|/' "$PLAN_FILE" \
    | grep -v "^| *File" | grep -v "^|[-| ]*$" \
    | awk -F'|' '{print $2}'
)

# Test files from ## Tests to Write (path after " — " on each line)
while IFS= read -r line; do
  # Format: - [ ] description — path/to/test_file.ext
  if [[ "$line" =~ —[[:space:]]+([^[:space:]].+)$ ]]; then
    # Strip Markdown backticks as well as whitespace (authors often wrap the path).
    testfile=$(echo "${BASH_REMATCH[1]}" | tr -d '[:space:]`')
    scope_add "$testfile"
  fi
done < <(
  awk '/^## Tests to Write/{found=1; next} /^## /{found=0} found && /^- /' "$PLAN_FILE"
)

# Always allow execution logs, the plan file itself, state files, and the review findings log
ALWAYS_ALLOW_PREFIXES=(
  ".agents/logs/"
  ".agents/plans/"
  ".agents/state/"
  ".agents/findings.jsonl"
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
  while IFS= read -r declared_path; do
    [[ -z "$declared_path" ]] && continue
    if [[ "$file" == "$declared_path" || "$file" == "$declared_path/"* ]]; then
      declared=true
      break
    fi
  done <<< "$SCOPE_LIST"

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
SCOPE_COUNT=$(printf '%s' "$SCOPE_LIST" | grep -c . || true)
echo "Declared scope (${SCOPE_COUNT} paths):"
while IFS= read -r p; do
  [[ -z "$p" ]] && continue
  echo "  · $p"
done <<< "$SCOPE_LIST"
echo ""
echo "Out-of-scope changes require architect approval before this PR can merge."
exit 1
