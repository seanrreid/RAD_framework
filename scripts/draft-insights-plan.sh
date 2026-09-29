#!/usr/bin/env bash
# draft-insights-plan.sh
# Drafts ONE RAD plan bundling every findings category that recurs at or above
# the recurrence threshold (/rad-insights Step 3b), cuts its rad/ work branch
# from the default branch, and commits only the plan. Mapped categories get a
# CLAUDE.md `## Coding Conventions` bullet task; unmapped ones get a described
# lint task (never skipped). Every rule-specific decision is left as a
# clarification marker, so check-approval-blockers.sh refuses the plan until a
# human finishes it. NEVER pushes and never approves.
#
# Usage: scripts/draft-insights-plan.sh [--dry-run]   (run from the repo root)
#   RAD_FINDINGS_FILE       findings log (default .agents/findings.jsonl)
#   RAD_FINDINGS_THRESHOLD  parsed like Step 3b: unset/0/non-numeric/negative → 5
#
#   RAD_BRANCH_PREFIX       work-branch prefix (default rad/)
#
# Exit codes:
#   0 = drafted (prints `drafted: <plan> on <branch>`), --dry-run printed the
#       plan, or `nothing to draft (threshold <t>)`
#   1 = refused, nothing written: dirty tracked worktree, target branch exists
#       locally or on origin, origin cannot be verified, too many categories for
#       one lint-valid plan, or a git step failed
#   2 = usage error, missing/unreadable findings log, malformed findings line,
#       RAD_FINDINGS_FILE starting with '-' or containing a newline, or an
#       invalid branch name from RAD_BRANCH_PREFIX

set -euo pipefail

readonly SELF="draft-insights-plan"
readonly DEFAULT_THRESHOLD=5
readonly FINDINGS_FILE="${RAD_FINDINGS_FILE:-.agents/findings.jsonl}"
readonly MAPPED_CATEGORIES=" testing code-clarity security error-handling correctness "
readonly TASKS_PER_WAVE=3
readonly MAX_WAVES=5 # lint-plan.sh caps a plan at 5 waves x 3 tasks
readonly NEW_FILE_LINES="1-40"
readonly FALLBACK_CONVENTIONS_LINES="1-1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "$SELF: $2" >&2; exit "$1"; }

# validate_findings_file — a leading `-` would be read as a jq option, and a
# newline cannot be a safe path argument; refuse both (usage error, exit 2).
validate_findings_file() {
  case "$FINDINGS_FILE" in
    -*) die 2 "RAD_FINDINGS_FILE must not start with '-' (option injection): $FINDINGS_FILE" ;;
    *$'\n'*) die 2 "RAD_FINDINGS_FILE must not contain a newline" ;;
  esac
}

# parse_threshold — Number.parseInt semantics: leading integer, else default.
parse_threshold() {
  local raw="${RAD_FINDINGS_THRESHOLD:-}" n
  if [[ "$raw" =~ ^[[:space:]]*([+-]?[0-9]+) ]]; then
    n="${BASH_REMATCH[1]}"
    if [[ "$n" != -* ]]; then
      n=$(printf '%s' "${n#+}" | sed -E 's/^0+//')
      [[ -n "$n" ]] && { echo "$n"; return; }
    fi
  fi
  echo "$DEFAULT_THRESHOLD"
}

slugify() {
  local s
  s=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
  echo "${s:-uncategorized}"
}

is_mapped() { [[ "$MAPPED_CATEGORIES" == *" $1 "* ]]; }

hint_for() {
  case "$1" in
    testing) echo "test-coverage expectations for changed behavior" ;;
    code-clarity) echo "naming, function-size and comment expectations" ;;
    security) echo "input handling and secret hygiene" ;;
    error-handling) echo "error propagation versus swallowing" ;;
    correctness) echo "edge-case and validation expectations" ;;
  esac
}

# crossing_rows <threshold> — "count<TAB>category", count desc then name.
crossing_rows() {
  local cats
  cats=$(jq -r 'select(.type=="finding") | .category' "$FINDINGS_FILE") \
    || die 2 "malformed findings log: $FINDINGS_FILE (jq failed to parse it)"
  [[ -z "$cats" ]] && return 0
  printf '%s\n' "$cats" | sort | uniq -c | sed -E 's/^ *([0-9]+) /\1	/' \
    | awk -F'\t' -v t="$1" '$1 >= t+0' | sort -t "$(printf '\t')" -k1,1nr -k2,2
}

conventions_range() {
  local start end
  start=$(grep -n '^## Coding Conventions' CLAUDE.md 2>/dev/null | head -1 | cut -d: -f1) \
    || { echo "$FALLBACK_CONVENTIONS_LINES"; return; } # no CLAUDE.md or no section → fallback
  [[ -z "$start" ]] && { echo "$FALLBACK_CONVENTIONS_LINES"; return; }
  end=$(awk -v s="$start" 'NR > s && /^## / { print NR - 1; exit } END { if (NR > s) print NR }' CLAUDE.md | head -1)
  echo "$start-${end:-$start}"
}

render_header() {
  cat <<EOF
# Plan: Insights Proposals $DATE
Created: $DATE
Author: insights-draft
Status: pending-review
Branch: $BRANCH

## Context

This plan was machine-drafted by \`/rad-insights --draft-plans\` from \`$FINDINGS_FILE\`. It must be finished by a human: every rule-specific decision is an open clarification marker, and the plan cannot be approved until each one is resolved.

Recurrence evidence (threshold: $THRESHOLD findings):
EOF
  local i
  for ((i = 0; i < N; i++)); do echo "- \`${CATS[$i]}\`: ${COUNTS[$i]} findings (threshold $THRESHOLD)"; done
  printf '\n## Scope\n\n| In scope | Out of scope |\n|---|---|\n'
  for ((i = 0; i < N; i++)); do
    if is_mapped "${CATS[$i]}"; then echo "| \`${SLUGS[$i]}\`: CLAUDE.md convention bullet | Rewriting existing code for \`${SLUGS[$i]}\` |"
    else echo "| \`${SLUGS[$i]}\`: described lint rule + fixture | Auto-fixing \`${SLUGS[$i]}\` findings |"; fi
  done
}

render_criteria() {
  local i
  printf '\n## Acceptance Criteria\n\n'
  for ((i = 0; i < N; i++)); do
    if is_mapped "${CATS[$i]}"; then
      echo "$((i + 1)). CLAUDE.md \`## Coding Conventions\` gains one concrete, checkable bullet targeting recurring \`${SLUGS[$i]}\` findings."
    else
      echo "$((i + 1)). \`scripts/lint-${SLUGS[$i]}.sh\` flags the recurring \`${SLUGS[$i]}\` pattern, with a co-located \`scripts/test-lint-${SLUGS[$i]}.sh\` fixture."
    fi
  done
  printf '\n## Agent Scope\n\nNone — drafted from findings recurrence; no mapper agents were consulted.\n'
}

render_files() {
  local i
  printf '\n## Files in Scope\n\n| File | Lines | Change |\n|------|-------|--------|\n'
  [[ "$HAS_MAPPED" == 1 ]] && echo "| CLAUDE.md | $CONV_RANGE | Add \`## Coding Conventions\` bullets |"
  for ((i = 0; i < N; i++)); do
    is_mapped "${CATS[$i]}" && continue
    echo "| scripts/lint-${SLUGS[$i]}.sh | $NEW_FILE_LINES | New |"
    echo "| scripts/test-lint-${SLUGS[$i]}.sh | $NEW_FILE_LINES | New |"
  done
  cat <<EOF

## Execution Notes

### Do Not Touch
- $FINDINGS_FILE
- harness/

### Key Files
- CLAUDE.md — \`## Coding Conventions\` ($CONV_RANGE)
- $FINDINGS_FILE — the recurrence evidence

### Reminders
- Resolve every clarification marker before requesting approval.
- Every new lint script ships its co-located test fixture in the same commit.
EOF
}

render_task() {
  local i="$1" id="$2" c="${CATS[$1]}" s="${SLUGS[$1]}"
  local edge="edge cases: empty findings log (nothing drafted), threshold boundary (count == threshold still drafts), category with no mapping (gets a lint task, never skipped)"
  if is_mapped "$c"; then
    printf '\n#### Task %s: %s convention bullet\nFile: CLAUDE.md:%s\n' "$id" "$s" "$CONV_RANGE"
    echo "What: Add one \`## Coding Conventions\` bullet about $(hint_for "$c") (${COUNTS[$i]} findings, threshold $THRESHOLD)."
    echo "[NEEDS CLARIFICATION: exact wording/regex for the $s rule]"
    echo "Validate: AC#$((i + 1)) — prose only, no testable surface: review the bullet; $edge."
  else
    printf '\n#### Task %s: %s lint rule\n' "$id" "$s"
    echo "File: scripts/lint-$s.sh:$NEW_FILE_LINES, scripts/test-lint-$s.sh:$NEW_FILE_LINES"
    echo "What: \`$s\` has no convention mapping (${COUNTS[$i]} findings, threshold $THRESHOLD); add a described lint rule and its co-located fixture."
    echo "[NEEDS CLARIFICATION: exact wording/regex for the $s rule]"
    echo "Validate: AC#$((i + 1)) — \`bash scripts/test-lint-$s.sh\`; $edge."
  fi
}

render_waves() {
  local i w
  printf '\n## Wave Plan\n'
  for ((i = 0; i < N; i++)); do
    w=$((i / TASKS_PER_WAVE + 1))
    if ((i % TASKS_PER_WAVE == 0)); then
      printf '\n### Wave %s — sequential\nTasks run one at a time (convention tasks share CLAUDE.md).\n' "$w"
    fi
    render_task "$i" "$w.$((i % TASKS_PER_WAVE + 1))"
  done
}

render_tail() {
  local i
  printf '\n## Tests to Write\n'
  for ((i = 0; i < N; i++)); do
    if is_mapped "${CATS[$i]}"; then echo "- [ ] \`${SLUGS[$i]}\` bullet — none (prose; reviewed, not tested)"
    else echo "- [ ] scripts/test-lint-${SLUGS[$i]}.sh — fixture for the \`${SLUGS[$i]}\` lint rule"; fi
  done
  cat <<EOF

## Non-Goals
- Auto-approving, auto-pushing, or auto-applying this plan; Gate 1 stays with the architect.
- Rewriting existing code or existing findings to satisfy the new rules.

## Out-of-Scope Dependencies
None.

## Risks
- **Over-broad rules.** A rule worded from category counts alone may flag legitimate code; the clarification markers force a human to scope it.
- **Stale evidence.** Counts reflect the findings log at $DATE; re-run \`/rad-insights\` before approving.

## Issue Gaps
- **ASSUMPTION — machine draft.** Generated from findings recurrence at threshold $THRESHOLD; rule wording, regexes and lint scope are unresolved until a human edits the markers.
EOF
}

render_plan() { render_header; render_criteria; render_files; render_waves; render_tail; }

# validate_branch — BRANCH is built from RAD_BRANCH_PREFIX; it must be a plain
# ref name (no leading '-', whitespace, or '..' segment) before any git use.
validate_branch() {
  [[ "$BRANCH" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] \
    || die 2 "invalid branch name from RAD_BRANCH_PREFIX: '$BRANCH' (allowed: [A-Za-z0-9._/-], no leading '-')"
  case "$BRANCH" in
    *..*) die 2 "invalid branch name from RAD_BRANCH_PREFIX: '$BRANCH' (contains '..')" ;;
  esac
}

# refuse_unless_clean — exit 1 (nothing written) on any precondition failure.
refuse_unless_clean() {
  local dirty rc=0
  dirty=$(git status --porcelain --untracked-files=no) || die 1 "not a git repository (git status failed)"
  [[ -z "$dirty" ]] || die 1 "tracked files have uncommitted changes; commit or stash them first"
  git show-ref --verify --quiet "refs/heads/$BRANCH" && die 1 "branch $BRANCH already exists locally"
  git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1 || rc=$?
  [[ "$rc" -eq 0 ]] && die 1 "branch $BRANCH already exists on origin"
  [[ "$rc" -eq 2 ]] || die 1 "cannot verify origin (git ls-remote exited $rc); refusing to draft"
}

commit_plan() {
  local base plan=".agents/plans/$SLUG.md"
  base=$(bash "$SCRIPT_DIR/get-default-branch.sh") || base="main" # script always exits 0; fallback is the documented default
  git fetch -q origin "$base" || die 1 "git fetch origin $base failed"
  git checkout -q -b "$BRANCH" "origin/$base" || die 1 "could not create $BRANCH from origin/$base"
  mkdir -p .agents/plans
  render_plan > "$plan"
  git add -- "$plan"
  git commit -q -m "adopt: Insights Proposals $DATE" -m "Adopted-From: /rad-insights --draft-plans
Author: insights-draft
Waves: $(((N + TASKS_PER_WAVE - 1) / TASKS_PER_WAVE))
Tasks: $N" || die 1 "git commit failed on $BRANCH"
  echo "drafted: $plan on $BRANCH"
}

main() {
  local dry_run=0 rows count cat
  case "${1:-}" in
    "") ;;
    --dry-run) dry_run=1 ;;
    *) die 2 "usage: $SELF [--dry-run]" ;;
  esac
  [[ $# -le 1 ]] || die 2 "usage: $SELF [--dry-run]"
  validate_findings_file
  [[ -f "$FINDINGS_FILE" && -r "$FINDINGS_FILE" ]] || die 2 "findings log not found or unreadable: $FINDINGS_FILE"
  THRESHOLD=$(parse_threshold)
  rows=$(crossing_rows "$THRESHOLD")
  [[ -z "$rows" ]] && { echo "nothing to draft (threshold $THRESHOLD)"; exit 0; }
  N=0 HAS_MAPPED=0
  while IFS="$(printf '\t')" read -r count cat; do
    CATS[N]="$cat" COUNTS[N]="$count" SLUGS[N]=$(slugify "$cat")
    is_mapped "$cat" && HAS_MAPPED=1
    N=$((N + 1))
  done <<< "$rows"
  ((N <= MAX_WAVES * TASKS_PER_WAVE)) \
    || die 1 "$N categories cross the threshold (max $((MAX_WAVES * TASKS_PER_WAVE)) per plan); raise RAD_FINDINGS_THRESHOLD"
  DATE=$(date +%Y-%m-%d) SLUG="insights-proposals-$DATE"
  BRANCH="${RAD_BRANCH_PREFIX:-rad/}$SLUG" CONV_RANGE=$(conventions_range)
  validate_branch
  if [[ "$dry_run" == 1 ]]; then render_plan; exit 0; fi
  refuse_unless_clean
  commit_plan
}

main "$@"
