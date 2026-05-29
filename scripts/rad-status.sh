#!/usr/bin/env bash
# rad-status.sh
# Deterministic RAD framework status dashboard. No LLM required.
#
# Usage: scripts/rad-status.sh [--json]
#
# Outputs:
#   - Platform and CLI availability
#   - All plans with status, author, waves
#   - Open plan and deliver PRs (if platform CLI available)
#   - Recent execution logs
#   - Agent inventory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JSON_MODE=false
[[ "${1:-}" == "--json" ]] && JSON_MODE=true

PLATFORM=$("$SCRIPT_DIR/detect-platform.sh" --quiet 2>/dev/null || echo "unknown")
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
PROJECT_NAME=$(grep "^\*\*Name:" CLAUDE.md 2>/dev/null | head -1 | sed 's/\*\*Name:\*\*[[:space:]]*//' || basename "$(pwd)")
NOW=$(date -u "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date "+%Y-%m-%dT%H:%M:%SZ")

# ── CLI availability ──────────────────────────────────────────────────────────

cli_available() {
  case "$PLATFORM" in
    github)  command -v gh   &>/dev/null ;;
    gitlab)  command -v glab &>/dev/null ;;
    *)       return 1 ;;
  esac
}

# ── Plan inventory ────────────────────────────────────────────────────────────

# Parse one plan doc (content on stdin) into a board row, keyed by feature slug.
# Under Lane B, in-flight plans live on their rad/ branch tip — not the working
# tree — so the board aggregates from branch tips first. The first source to set
# a feature wins (branch tip > merged on default branch > local working tree).

PREFIX="${RAD_BRANCH_PREFIX:-rad/}"

# Tracks features already emitted, so the first (highest-priority) source wins.
# A space-delimited string keeps this bash-3.2 safe (no associative arrays).
SEEN_FEATURES=" "

emit_plan_row() {
  # $1 = feature slug, $2 = source label, content on stdin
  local feature="$1" source="$2" content status author waves tasks adopted_from
  case "$SEEN_FEATURES" in *" $feature "*) cat >/dev/null; return 0 ;; esac
  SEEN_FEATURES="${SEEN_FEATURES}${feature} "
  content=$(cat)

  status=$(printf '%s\n' "$content"       | grep "^Status:"       | head -1 | awk '{print $2}' || echo "unknown")
  author=$(printf '%s\n' "$content"       | grep "^Author:"       | head -1 | sed 's/^Author:[[:space:]]*//' || echo "")
  adopted_from=$(printf '%s\n' "$content" | grep "^Adopted-From:" | head -1 | sed 's/^Adopted-From:[[:space:]]*//' || echo "")
  waves=$(printf '%s\n' "$content"        | grep -c "^### Wave"  || echo "0")
  tasks=$(printf '%s\n' "$content"        | grep -c "^#### Task" || echo "0")

  echo "$feature|${status:-unknown}|$author|$waves|$tasks|$source|$adopted_from"
}

collect_plans() {
  local base ref branch feature path

  # The three passes run in one subshell (piped to sort) so SEEN_FEATURES stays
  # consistent across them. Priority: branch tip > merged on default > local tree.
  {
    # 1. In-flight: one plan per rad/ branch tip on origin (canonical).
    while read -r ref; do
      [[ -z "$ref" ]] && continue
      branch="${ref#origin/}"
      feature="${branch#"$PREFIX"}"
      git show "origin/${branch}:.agents/plans/${feature}.md" 2>/dev/null \
        | emit_plan_row "$feature" "$branch" || true
    done < <(git branch -r --list "origin/${PREFIX}*" 2>/dev/null | sed 's/^[[:space:]]*//')

    # 2. Merged: plan docs that have landed on the default branch.
    base=$("$SCRIPT_DIR/get-default-branch.sh" 2>/dev/null || echo main)
    while read -r path; do
      [[ -z "$path" ]] && continue
      feature=$(basename "$path" .md)
      git show "origin/${base}:${path}" 2>/dev/null \
        | emit_plan_row "$feature" "${base} (merged)" || true
    done < <(git ls-tree -r --name-only "origin/${base}" -- .agents/plans 2>/dev/null | grep -E '\.agents/plans/.*\.md$' | grep -v 'README.md' || true)

    # 3. Local working tree — a plan authored locally but not yet pushed.
    if [[ -d ".agents/plans" ]]; then
      while read -r path; do
        feature=$(basename "$path" .md)
        emit_plan_row "$feature" "local (unpushed)" < "$path" || true
      done < <(find ".agents/plans" -name "*.md" ! -name "README.md" 2>/dev/null | sort)
    fi
  } | sort
}

# ── Open PRs ──────────────────────────────────────────────────────────────────

collect_prs() {
  cli_available || return

  # Lane B has a single PR per feature — the deliver PR. (There is no plan PR.)
  case "$PLATFORM" in
    github)
      echo "--- deliver PRs ---"
      gh pr list --label "rad:deliver" --state open \
        --json title,url,author,createdAt \
        --jq '.[] | "\(.title)|\(.url)|\(.author.login)|\(.createdAt)"' \
        2>/dev/null || true
      ;;
    gitlab)
      echo "--- deliver PRs ---"
      glab mr list --label "rad:deliver" --state opened --output json 2>/dev/null \
        | python3 -c "
import sys, json
for mr in json.load(sys.stdin):
    print(f\"{mr['title']}|{mr['web_url']}|{mr['author']['username']}|{mr['created_at']}\")
" 2>/dev/null || true
      ;;
  esac
}

# ── Execution logs ────────────────────────────────────────────────────────────

collect_logs() {
  local logs_dir=".agents/logs"
  [[ ! -d "$logs_dir" ]] && return

  # List the 5 newest logs by mtime in a single `ls -t` (no xargs batching, so the
  # ordering is correct regardless of count) and read one path per line (space-safe).
  # `ls -t` on the glob is portable (no GNU `find -printf`); `|| true` guards the
  # no-match case so the empty glob doesn't trip `set -euo pipefail`.
  local logs
  logs=$(ls -t "$logs_dir"/*.md 2>/dev/null | grep -v '/README\.md$' | head -5 || true)
  [[ -z "$logs" ]] && return
  printf '%s\n' "$logs" | while read -r log_file; do
    local feature date_str tasks_done tasks_failed
    feature=$(basename "$log_file" .md | sed 's/-[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}$//')
    date_str=$(basename "$log_file" .md | grep -o '[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}' || echo "")
    # grep -c already prints 0 when there are no matches (it just also exits 1),
    # so swallow the exit with `|| true` — `|| echo 0` would append a SECOND line,
    # making the value multiline and corrupting the downstream `-gt` comparison.
    tasks_done=$(grep -c "✓ complete" "$log_file" 2>/dev/null || true)
    tasks_failed=$(grep -c "✗ failed"  "$log_file" 2>/dev/null || true)
    # Normalize to 0 if grep wrote nothing (e.g. an unreadable file) so the
    # downstream numeric comparison never sees an empty operand.
    echo "$feature|$date_str|${tasks_done:-0}|${tasks_failed:-0}"
  done
}

# ── Agent inventory ───────────────────────────────────────────────────────────

agent_count() {
  find ".claude/agents" -name "*.md" 2>/dev/null | wc -l | tr -d ' '
}

# ── Render ────────────────────────────────────────────────────────────────────

CLI_STATUS="⚠ manual mode"
cli_available && CLI_STATUS="✓ CLI available"

PLANS=$(collect_plans)
LOGS=$(collect_logs)
AGENTS=$(agent_count)

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "RAD Status — ${PROJECT_NAME:-this project}"
echo "$NOW"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Platform:  $PLATFORM  $CLI_STATUS"
echo "Agents:    $AGENTS defined in .claude/agents/"
echo "Branch:    $CURRENT_BRANCH"
echo ""

# ── Plans ─────────────────────────────────────────────────────────────────────

echo "── Active Plans ───────────────────────"

if [[ -z "$PLANS" ]]; then
  echo ""
  echo "  No plans found. Run /rad-plan [feature] to create the first plan."
else
  echo ""
  while IFS='|' read -r feature status author waves tasks where adopted_from; do
    status_icon="·"
    case "$status" in
      pending-review) status_icon="⏳" ;;
      approved)       status_icon="✓" ;;
      in-progress)    status_icon="▶" ;;
      complete)       status_icon="✓✓" ;;
      blocked)        status_icon="✗" ;;
      rejected)       status_icon="✗" ;;
      needs-revision) status_icon="↩" ;;
    esac

    echo "  $status_icon $feature"
    echo "    Status: $status"
    [[ -n "$author" ]] && echo "    Author: $author"
    echo "    Waves:  $waves  Tasks: $tasks"
    [[ -n "$adopted_from" ]] && echo "    Source: $adopted_from"
    [[ -n "$where" ]] && echo "    Branch: $where"

    if [[ "$status" == "approved" ]]; then
      echo "    Run:    /rad-deliver .agents/plans/$feature.md"
    elif [[ "$status" == "pending-review" ]]; then
      echo "    Needs:  architect to run /rad-approve $feature"
    fi
    echo ""
  done <<< "$PLANS"
fi

# ── Open PRs ──────────────────────────────────────────────────────────────────

if cli_available; then
  echo "── Open PRs ────────────────────────────"
  echo ""

  PR_DATA=$(collect_prs)
  IN_SECTION=""
  HAS_PRS=false

  while IFS= read -r line; do
    if [[ "$line" == "--- deliver PRs ---" ]]; then IN_SECTION="deliver"; continue; fi
    [[ -z "$line" ]] && continue

    IFS='|' read -r title url author created_at <<< "$line"
    created_short=$(echo "$created_at" | cut -c1-10)

    echo "  Deliver PR: $title"
    echo "    $url"
    echo "    $author · $created_short"
    echo ""
    HAS_PRS=true
  done <<< "$PR_DATA"

  $HAS_PRS || echo "  No open deliver PRs."
  echo ""
fi

# ── Recent executions ─────────────────────────────────────────────────────────

echo "── Recent Executions ───────────────────"
echo ""

if [[ -z "$LOGS" ]]; then
  echo "  No execution logs found."
else
  while IFS='|' read -r feature date_str tasks_done tasks_failed; do
    if [[ "$tasks_failed" -gt 0 ]]; then
      echo "  ✗ $feature — $date_str — $tasks_done done, $tasks_failed failed"
    else
      echo "  ✓ $feature — $date_str — $tasks_done tasks complete"
    fi
  done <<< "$LOGS"
fi
echo ""

# ── Agents ────────────────────────────────────────────────────────────────────

if [[ "$AGENTS" -eq 0 ]]; then
  echo "── Agents ──────────────────────────────"
  echo ""
  echo "  ⚠ No agents defined."
  echo "    Run /rad-design (architect only) before the team begins planning."
  echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
