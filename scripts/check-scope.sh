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
# Diff ranges tried in order; the first that resolves wins. The winning
# expression is captured because the rename lookup below MUST query the same
# range — two git queries over different ranges can disagree about what changed.

DIFF_REF_CANDIDATES=(
  "origin/$BASE_BRANCH...$DELIVER_BRANCH"
  "$BASE_BRANCH...$DELIVER_BRANCH"
  "$BASE_BRANCH..$DELIVER_BRANCH"
)

REF_EXPR=""
CHANGED_FILES=""
for candidate in "${DIFF_REF_CANDIDATES[@]}"; do
  if CHANGED_FILES=$(git diff --name-only "$candidate" 2>/dev/null); then
    REF_EXPR="$candidate"
    break
  fi
done

if [[ -z "$REF_EXPR" ]]; then
  echo "ERROR: no diff range resolves between $BASE_BRANCH and $DELIVER_BRANCH" >&2
  echo "       (tried: ${DIFF_REF_CANDIDATES[*]})" >&2
  exit 2
fi

if [[ -z "$CHANGED_FILES" ]]; then
  echo "⚠ No changed files detected between $BASE_BRANCH and $DELIVER_BRANCH"
  exit 0
fi

# ── Check each changed file ───────────────────────────────────────────────────

scope_declares() {
  # True iff $1 is declared in scope: an exact match, or inside a declared
  # directory. The single membership rule — the verdict and the rename hint
  # below both ask this question, and must answer it identically.
  local candidate="$1" declared_path
  while IFS= read -r declared_path; do
    [[ -z "$declared_path" ]] && continue
    if [[ "$candidate" == "$declared_path" || "$candidate" == "$declared_path/"* ]]; then
      return 0
    fi
  done <<< "$SCOPE_LIST"
  return 1
}

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
  scope_declares "$file" && declared=true

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

# Rename pairs on the SAME range that produced CHANGED_FILES, as `dest<TAB>src`.
# `--name-status` prints `R<score><TAB>src<TAB>dest`. Advisory data only: it
# annotates the violation list and never feeds the verdict, so a failed lookup
# degrades to today's message rather than blocking — but it says why.
RENAME_PAIRS=""
if ! RENAME_PAIRS=$(git diff --find-renames --diff-filter=R --name-status "$REF_EXPR" 2>/dev/null \
     | awk -F'\t' 'NF >= 3 { print $3 "\t" $2 }'); then
  RENAME_PAIRS=""
  echo "⚠ rename detection unavailable for $REF_EXPR — listing paths without rename hints" >&2
fi

rename_source_in_scope() {
  # Print the declared-in-scope path that $1 was renamed FROM, if the diff
  # recorded such a rename; print nothing otherwise. Always returns 0 — an
  # absent hint is a normal result, not a failure.
  local dest="$1" pair_dest pair_src
  if [[ -n "$RENAME_PAIRS" ]]; then
    while IFS=$'\t' read -r pair_dest pair_src; do
      [[ "$pair_dest" == "$dest" ]] || continue
      if scope_declares "$pair_src"; then
        printf '%s\n' "$pair_src"
        return 0
      fi
    done <<< "$RENAME_PAIRS"
  fi
  return 0
}

echo "✗ Scope violation: $PLAN_NAME"
echo ""
echo "Out-of-scope changes (${#OUT_OF_SCOPE[@]}):"
RENAME_HINT_SHOWN=false
for f in "${OUT_OF_SCOPE[@]}"; do
  rename_src=$(rename_source_in_scope "$f")
  if [[ -n "$rename_src" ]]; then
    echo "  ✗ $f — likely undeclared rename target of declared file: $rename_src"
    RENAME_HINT_SHOWN=true
  else
    echo "  ✗ $f"
  fi
done
echo ""
SCOPE_COUNT=$(printf '%s' "$SCOPE_LIST" | grep -c . || true)
echo "Declared scope (${SCOPE_COUNT} paths):"
while IFS= read -r p; do
  [[ -z "$p" ]] && continue
  echo "  · $p"
done <<< "$SCOPE_LIST"
echo ""
if $RENAME_HINT_SHOWN; then
  echo "A rename declares BOTH paths as separate Files-in-Scope rows: this check"
  echo "reads the File column only and never the Change prose, so a destination"
  echo "described only in prose reads as out-of-scope drift. Add the missing row."
  echo ""
fi
echo "Out-of-scope changes require architect approval before this PR can merge."
exit 1
