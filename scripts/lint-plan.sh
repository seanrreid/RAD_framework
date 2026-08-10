#!/usr/bin/env bash
# lint-plan.sh
# Validates a RAD plan file for structure, required fields, and basic correctness.
#
# Usage: scripts/lint-plan.sh <plan-file>
#
# Exit codes:
#   0 = valid
#   1 = invalid (errors printed to stdout)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/plan-paths.sh
. "$SCRIPT_DIR/lib/plan-paths.sh"

PLAN_FILE="${1:-}"
[[ -z "$PLAN_FILE" ]] && { echo "ERROR: plan file path required"; exit 1; }
[[ ! -f "$PLAN_FILE" ]] && { echo "ERROR: plan file not found: $PLAN_FILE"; exit 1; }

ERRORS=()
WARNINGS=()
TOTAL_LINES=0
BUDGET_COMPUTED=false
# Newline-delimited Files-in-Scope paths already reported absent from disk. The
# premise-freshness advisory subtracts this set so one fact yields one finding: a
# path the plan is about to create is absent from the base branch by construction,
# and "does not exist" already says so. A string, not an array — an empty array
# expansion is an error under `set -u` on bash 3.2.
MISSING_IN_SCOPE=""

# ── Helpers ──────────────────────────────────────────────────────────────────

has_section() {
  grep -q "^## $1" "$PLAN_FILE"
}

section_content() {
  awk "/^## $1/{found=1; next} /^## /{found=0} found{print}" "$PLAN_FILE"
}

header_field() {
  grep "^$1:" "$PLAN_FILE" | head -1 | sed "s/^$1:[[:space:]]*//" || true
}

# ── Header fields ─────────────────────────────────────────────────────────────

STATUS=$(header_field "Status")
AUTHOR=$(header_field "Author")
CREATED=$(header_field "Created")
BRANCH=$(header_field "Branch")
ADOPTED_FROM=$(header_field "Adopted-From")

[[ -z "$STATUS" ]]  && ERRORS+=("Missing required field: Status")
[[ -z "$AUTHOR" ]]  && ERRORS+=("Missing required field: Author")
[[ -z "$CREATED" ]] && ERRORS+=("Missing required field: Created")

# Branch (Lane B work branch). Missing is a warning (older/migrated plans);
# a present-but-malformed value is an error since /rad-deliver gates on it.
# Use a literal prefix test (not regex) so a custom RAD_BRANCH_PREFIX with regex
# metacharacters can't break validation; the slug after the prefix is then
# checked against the allowed character set.
PREFIX="${RAD_BRANCH_PREFIX:-rad/}"
if [[ -z "$BRANCH" ]]; then
  WARNINGS+=("Missing Branch field — Lane B plans should record their work branch (e.g. ${PREFIX}feature-slug)")
elif [[ "$BRANCH" != "${PREFIX}"* || ! "${BRANCH#"$PREFIX"}" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  ERRORS+=("Invalid Branch value: '$BRANCH' (expected ${PREFIX}feature-slug, lowercase/digits/hyphens)")
fi

VALID_STATUSES="pending-review approved in-progress complete blocked rejected needs-revision"
if [[ -n "$STATUS" ]] && ! echo "$VALID_STATUSES" | grep -qw "$STATUS"; then
  ERRORS+=("Invalid Status value: '$STATUS'. Must be one of: $VALID_STATUSES")
fi

# ── Required sections ─────────────────────────────────────────────────────────

REQUIRED_SECTIONS=("Context" "Scope" "Acceptance Criteria" "Agent Scope" "Files in Scope" "Execution Notes" "Wave Plan" "Tests to Write" "Non-Goals" "Risks")
for section in "${REQUIRED_SECTIONS[@]}"; do
  has_section "$section" || ERRORS+=("Missing required section: ## $section")
done

# ── Acceptance Criteria — non-empty, and every task validates against one ──────

if has_section "Acceptance Criteria"; then
  AC_COUNT=$(section_content "Acceptance Criteria" | grep -cE "^[0-9]+\." || true)
  [[ "$AC_COUNT" -eq 0 ]] && ERRORS+=("## Acceptance Criteria is empty — list at least one numbered, testable outcome")

  # Every task should cite an AC# in its Validate: line.
  TASKS_TOTAL=$(grep -cE "^#### Task" "$PLAN_FILE" || true)
  TASKS_WITH_AC=$(grep -E "^Validate:" "$PLAN_FILE" | grep -cE "AC#?[0-9]+" || true)
  if [[ "$TASKS_TOTAL" -gt 0 && "$TASKS_WITH_AC" -lt "$TASKS_TOTAL" ]]; then
    WARNINGS+=("$((TASKS_TOTAL - TASKS_WITH_AC)) of $TASKS_TOTAL tasks have a Validate: line that does not cite an AC# — every task should map to an acceptance criterion")
  fi
fi

# Adopted plans require Issue Gaps
if [[ -n "$ADOPTED_FROM" ]]; then
  has_section "Issue Gaps" || ERRORS+=("Adopted plans require ## Issue Gaps section (captures assumptions from under-specified issue)")

  if has_section "Issue Gaps"; then
    GAP_ENTRIES=$(section_content "Issue Gaps" | grep -c "^- " || true)
    [[ "$GAP_ENTRIES" -eq 0 ]] && ERRORS+=("## Issue Gaps section is empty — document assumptions or write 'None' if the issue was fully specified")
  fi
fi

# ── Non-Goals count ───────────────────────────────────────────────────────────

if has_section "Non-Goals"; then
  NONGOAL_COUNT=$(section_content "Non-Goals" | grep -c "^- " || true)
  [[ "$NONGOAL_COUNT" -lt 2 ]] && ERRORS+=("## Non-Goals requires at least 2 entries (found $NONGOAL_COUNT)")
fi

# ── Wave count ────────────────────────────────────────────────────────────────

WAVE_COUNT=$(grep -c "^### Wave" "$PLAN_FILE" || true)
[[ "$WAVE_COUNT" -gt 5 ]] && ERRORS+=("Too many waves: $WAVE_COUNT (max 5). Split into two plans.")
[[ "$WAVE_COUNT" -eq 0 ]] && has_section "Wave Plan" && ERRORS+=("## Wave Plan has no waves defined (expected '### Wave N')")

# ── Tasks per wave ────────────────────────────────────────────────────────────

if [[ "$WAVE_COUNT" -gt 0 ]]; then
  WAVE_NUM=0
  TASK_COUNT=0
  while IFS= read -r line; do
    if [[ "$line" =~ ^"### Wave" ]]; then
      if [[ "$WAVE_NUM" -gt 0 && "$TASK_COUNT" -gt 3 ]]; then
        ERRORS+=("Wave $WAVE_NUM has $TASK_COUNT tasks (max 3). Add another wave or split the plan.")
      fi
      WAVE_NUM=$((WAVE_NUM + 1))
      TASK_COUNT=0
    elif [[ "$line" =~ ^"#### Task" ]]; then
      TASK_COUNT=$((TASK_COUNT + 1))
    fi
  done < "$PLAN_FILE"
  # Check last wave
  if [[ "$WAVE_NUM" -gt 0 && "$TASK_COUNT" -gt 3 ]]; then
    ERRORS+=("Wave $WAVE_NUM has $TASK_COUNT tasks (max 3). Add another wave or split the plan.")
  fi
fi

# ── Files in Scope — paths exist ──────────────────────────────────────────────

if has_section "Files in Scope"; then
  # Extract file paths from the table (column 2, skip header and separator rows)
  while IFS= read -r path; do
    path=$(echo "$path" | tr -d '[:space:]')
    [[ -z "$path" ]] && continue
    # Skip placeholder values
    [[ "$path" == "[path]" || "$path" == "File" ]] && continue
    # Check file exists
    if [[ ! -f "$path" && ! -d "$path" ]]; then
      WARNINGS+=("File in scope does not exist: $path")
      MISSING_IN_SCOPE="${MISSING_IN_SCOPE}${path}"$'\n'
    fi
  done < <(
    awk '/^## Files in Scope/{found=1; next} /^## /{found=0} found && /^\|/' "$PLAN_FILE" \
      | grep -v "^| *File" | grep -v "^|[-| ]*$" \
      | awk -F'|' '{print $2}'
  )
fi

# ── Per-task File: paths exist (advisory) ─────────────────────────────────────
# Each `#### Task` block carries a `File:` line in a path:lines form
# (e.g. harness/cli.js:290-410). Strip the trailing :lines suffix and, for any
# path that is neither a file nor a directory on disk, warn (never error) naming
# the task and the missing path. Parity with the Files-in-Scope existence check:
# a directory counts as existing.

# strip_task_file_lines is provided by lib/plan-paths.sh (single source of truth).

CURRENT_TASK=""
while IFS= read -r line; do
  if [[ "$line" =~ ^####\ Task ]]; then
    CURRENT_TASK=$(echo "$line" | sed 's/^####[[:space:]]*//')
  elif [[ "$line" =~ ^File: ]]; then
    file_val=$(echo "$line" | sed 's/^File:[[:space:]]*//' | sed 's/[[:space:]]*$//')
    file_path=$(strip_task_file_lines "$file_val")
    [[ -z "$file_path" || "$file_path" == "[path]" ]] && continue
    if [[ ! -f "$file_path" && ! -d "$file_path" ]]; then
      WARNINGS+=("Task '${CURRENT_TASK}' references a File: path that does not exist: $file_path")
    fi
  fi
done < "$PLAN_FILE"

# ── High-risk path advisory ───────────────────────────────────────────────────
# Over the union of Files-in-Scope paths and task `File:` paths, warn (never
# error) for any path matching a high-risk pattern, advising close architect
# review. RAD_HIGH_RISK_PATTERNS overrides the generic default (a |-separated
# extended-regex alternation of generic infra-risk terms).
RAD_HIGH_RISK_PATTERNS="${RAD_HIGH_RISK_PATTERNS:-auth|payment|billing|migration|secret|credential|token}"

HIGH_RISK_HIT=false
if [[ -n "$RAD_HIGH_RISK_PATTERNS" ]]; then
  # Union of Files-in-Scope and task File: paths (de-duped) via the shared helper.
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    if path_matches "$path" "$RAD_HIGH_RISK_PATTERNS"; then
      WARNINGS+=("High-risk path in scope — flag for close architect review: $path")
      HIGH_RISK_HIT=true
    fi
  done < <(plan_scope_paths "$PLAN_FILE")
fi

# ── Program Design section advisory ───────────────────────────────────────────
# A "large" plan (>=3 waves, or at least one high-risk path in scope) is advised
# to carry a ## Program Design section (signatures, a call-stack sketch, and a
# file-tree diff) before delivery. Presence-check only — the section's contents
# are never validated. WARNING only; the exit code is unaffected. Program Design
# is deliberately NOT in REQUIRED_SECTIONS: omitting it is advisory, never an error.
if { [ "$WAVE_COUNT" -ge 3 ] || $HIGH_RISK_HIT; } && ! has_section "Program Design"; then
  WARNINGS+=("large plan (>=3 waves or high-risk path) has no ## Program Design section — capture signatures, a call-stack sketch, and a file-tree diff before delivery")
fi

# ── Self-protected path advisory ──────────────────────────────────────────────
# Over the same path union, warn (never error) for any path inside RAD's
# self-protected set (lib/plan-paths.sh literal — harness/, scripts/, .claude/,
# .agents/state/, gates.yaml, matrix.yaml). Deliberately NOT gated on
# RAD_HIGH_RISK_PATTERNS: the set is not operator-tunable, so this advisory
# fires regardless of any pattern override.
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  if path_is_self_protected "$path"; then
    WARNINGS+=("self-protected path (RAD machinery — never auto-clearable): $path")
  fi
done < <(plan_scope_paths "$PLAN_FILE")

# ── Premise-freshness advisory ────────────────────────────────────────────────
# Over the union of cited `path:line` anchors, per-task File: paths, and
# Files-in-Scope entries — MINUS the paths this plan creates (create-exempt: they
# don't yet exist on the base by design) and MINUS any path the Files-in-Scope
# existence check already reported absent from disk (one fact, one finding) —
# warn (never error) for any path absent
# on origin/<default_branch>: a plan anchored to removed/renamed code. Existence
# only; line numbers are never verified. Queries the locally-known ref — NO
# implicit fetch. Fail-closed: an unresolvable base ref yields ONE advisory that
# freshness could not be verified, and the per-path scan is skipped (no spam).
FRESHNESS_BASE=$("$SCRIPT_DIR/get-default-branch.sh" 2>/dev/null || echo main)
FRESHNESS_REF="origin/$FRESHNESS_BASE"
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  freshness_rc=0
  path_exists_on_ref "$path" "$FRESHNESS_REF" || freshness_rc=$?
  case "$freshness_rc" in
    1) WARNINGS+=("stale premise: $path not found on $FRESHNESS_REF — plan may be written against removed/renamed code") ;;
    2) WARNINGS+=("freshness not verified: base ref $FRESHNESS_REF unresolvable"); break ;;
  esac
done < <(
  {
    plan_cited_anchors "$PLAN_FILE"
    plan_task_files "$PLAN_FILE"
    plan_files_in_scope "$PLAN_FILE"
  } | grep -v '^$' | sort -u \
    | grep -Fxv -f <(plan_created_paths "$PLAN_FILE") \
    | grep -Fxv -f <(printf '%s' "$MISSING_IN_SCOPE")
)

# ── Context budget ────────────────────────────────────────────────────────────
# Sum line ranges from the Files in Scope table (column 3 = Lines).
# Range "45-120" → 76 lines. Plain number "150" → 150 lines. Others skipped.

BUDGET_WARN=800
BUDGET_ERROR=1500

if has_section "Files in Scope"; then
  while IFS= read -r lines_val; do
    lines_val=$(echo "$lines_val" | tr -d '[:space:]')
    [[ -z "$lines_val" || "$lines_val" == "Lines" || "$lines_val" == "[start-end]" || "$lines_val" == "[range]" ]] && continue
    if [[ "$lines_val" =~ ^([0-9]+)-([0-9]+)$ ]]; then
      count=$(( ${BASH_REMATCH[2]} - ${BASH_REMATCH[1]} + 1 ))
      TOTAL_LINES=$(( TOTAL_LINES + count ))
      BUDGET_COMPUTED=true
    elif [[ "$lines_val" =~ ^[0-9]+$ ]]; then
      TOTAL_LINES=$(( TOTAL_LINES + lines_val ))
      BUDGET_COMPUTED=true
    fi
  done < <(
    awk '/^## Files in Scope/{found=1; next} /^## /{found=0} found && /^\|/' "$PLAN_FILE" \
      | grep -v "^| *File" | grep -v "^|[-| ]*$" \
      | awk -F'|' '{print $3}'
  )

  if $BUDGET_COMPUTED; then
    if [[ "$TOTAL_LINES" -gt "$BUDGET_ERROR" ]]; then
      ERRORS+=("Context budget too large: ~${TOTAL_LINES} lines in scope (max ${BUDGET_ERROR}). Split into two plans.")
    elif [[ "$TOTAL_LINES" -gt "$BUDGET_WARN" ]]; then
      WARNINGS+=("Context budget is large: ~${TOTAL_LINES} lines across all files. Consider splitting if waves are dense.")
    fi
  fi
fi

# ── Execution Notes — Do Not Touch vs Files in Scope conflict ────────────────

if has_section "Execution Notes" && has_section "Files in Scope"; then
  while IFS= read -r dnt_path; do
    dnt_path=$(echo "$dnt_path" | sed 's/^-[[:space:]]*//' | tr -d '[:space:]')
    [[ -z "$dnt_path" || "$dnt_path" == "None" ]] && continue

    while IFS= read -r scope_path; do
      scope_path=$(echo "$scope_path" | tr -d '[:space:]')
      [[ -z "$scope_path" || "$scope_path" == "[path]" || "$scope_path" == "File" ]] && continue

      if [[ "$scope_path" == "$dnt_path" || "$scope_path" == "$dnt_path/"* ]]; then
        ERRORS+=("Conflict: '$dnt_path' is listed in both Do Not Touch and Files in Scope")
      fi
    done < <(
      awk '/^## Files in Scope/{found=1; next} /^## /{found=0} found && /^\|/' "$PLAN_FILE" \
        | grep -v "^| *File" | grep -v "^|[-| ]*$" | awk -F'|' '{print $2}'
    )
  done < <(
    awk '/^### Do Not Touch/{found=1; next} /^### /{found=0} found && /^- /' "$PLAN_FILE"
  )
fi

# ── Tests to Write — not empty ────────────────────────────────────────────────

if has_section "Tests to Write"; then
  TEST_COUNT=$(section_content "Tests to Write" | grep -c "^- " || true)
  [[ "$TEST_COUNT" -eq 0 ]] && ERRORS+=("## Tests to Write is empty — every plan must specify tests")
fi

# ── Output ────────────────────────────────────────────────────────────────────

PLAN_NAME=$(basename "$PLAN_FILE")

if [[ "${#ERRORS[@]}" -eq 0 && "${#WARNINGS[@]}" -eq 0 ]]; then
  BUDGET_MSG=""
  $BUDGET_COMPUTED && BUDGET_MSG=", budget: ~${TOTAL_LINES}L"
  echo "✓ $PLAN_NAME — plan is valid (waves: $WAVE_COUNT${BUDGET_MSG})"
  exit 0
fi

echo "Plan lint: $PLAN_NAME"
echo ""

if [[ "${#ERRORS[@]}" -gt 0 ]]; then
  echo "Errors (must fix before approval):"
  for err in "${ERRORS[@]}"; do
    echo "  ✗ $err"
  done
fi

if [[ "${#WARNINGS[@]}" -gt 0 ]]; then
  echo ""
  echo "Warnings (verify before execution):"
  for warn in "${WARNINGS[@]}"; do
    echo "  ⚠ $warn"
  done
fi

[[ "${#ERRORS[@]}" -gt 0 ]] && exit 1 || exit 0
