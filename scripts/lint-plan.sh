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

PLAN_FILE="${1:-}"
[[ -z "$PLAN_FILE" ]] && { echo "ERROR: plan file path required"; exit 1; }
[[ ! -f "$PLAN_FILE" ]] && { echo "ERROR: plan file not found: $PLAN_FILE"; exit 1; }

ERRORS=()
WARNINGS=()

# ── Helpers ──────────────────────────────────────────────────────────────────

has_section() {
  grep -q "^## $1" "$PLAN_FILE"
}

section_content() {
  awk "/^## $1/{found=1; next} /^## /{found=0} found{print}" "$PLAN_FILE"
}

header_field() {
  grep "^$1:" "$PLAN_FILE" | head -1 | sed "s/^$1:[[:space:]]*//"
}

# ── Header fields ─────────────────────────────────────────────────────────────

STATUS=$(header_field "Status")
AUTHOR=$(header_field "Author")
CREATED=$(header_field "Created")
ADOPTED_FROM=$(header_field "Adopted-From")

[[ -z "$STATUS" ]]  && ERRORS+=("Missing required field: Status")
[[ -z "$AUTHOR" ]]  && ERRORS+=("Missing required field: Author")
[[ -z "$CREATED" ]] && ERRORS+=("Missing required field: Created")

VALID_STATUSES="pending-review approved in-progress complete blocked rejected needs-revision"
if [[ -n "$STATUS" ]] && ! echo "$VALID_STATUSES" | grep -qw "$STATUS"; then
  ERRORS+=("Invalid Status value: '$STATUS'. Must be one of: $VALID_STATUSES")
fi

# ── Required sections ─────────────────────────────────────────────────────────

REQUIRED_SECTIONS=("Context" "Agent Scope" "Files in Scope" "Execution Notes" "Wave Plan" "Tests to Write" "Non-Goals" "Risks")
for section in "${REQUIRED_SECTIONS[@]}"; do
  has_section "$section" || ERRORS+=("Missing required section: ## $section")
done

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
    fi
  done < <(
    awk '/^## Files in Scope/{found=1; next} /^## /{found=0} found && /^\|/' "$PLAN_FILE" \
      | grep -v "^| *File\|^|[-| ]*$" \
      | awk -F'|' '{print $2}'
  )
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
        | grep -v "^| *File\|^|[-| ]*$" | awk -F'|' '{print $2}'
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
  echo "✓ $PLAN_NAME — plan is valid (waves: $WAVE_COUNT)"
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
