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

collect_plans() {
  local plans_dir=".agents/plans"
  [[ ! -d "$plans_dir" ]] && return

  find "$plans_dir" -name "*.md" ! -name "README.md" | sort | while read -r plan_file; do
    local feature status author waves tasks pr adopted_from
    feature=$(basename "$plan_file" .md)
    status=$(grep   "^Status:"       "$plan_file" 2>/dev/null | head -1 | awk '{print $2}' || echo "unknown")
    author=$(grep   "^Author:"       "$plan_file" 2>/dev/null | head -1 | sed 's/^Author:[[:space:]]*//' || echo "")
    pr=$(grep       "^PR:"           "$plan_file" 2>/dev/null | head -1 | sed 's/^PR:[[:space:]]*//' || echo "")
    adopted_from=$(grep "^Adopted-From:" "$plan_file" 2>/dev/null | head -1 | sed 's/^Adopted-From:[[:space:]]*//' || echo "")
    waves=$(grep -c "^### Wave"      "$plan_file" 2>/dev/null || echo "0")
    tasks=$(grep -c "^#### Task"     "$plan_file" 2>/dev/null || echo "0")

    echo "$feature|$status|$author|$waves|$tasks|$pr|$adopted_from"
  done
}

# ── Open PRs ──────────────────────────────────────────────────────────────────

collect_prs() {
  cli_available || return

  case "$PLATFORM" in
    github)
      echo "--- plan PRs ---"
      gh pr list --label "rad:plan" --state open \
        --json title,url,author,createdAt \
        --jq '.[] | "\(.title)|\(.url)|\(.author.login)|\(.createdAt)"' \
        2>/dev/null || true
      echo "--- deliver PRs ---"
      gh pr list --label "rad:deliver" --state open \
        --json title,url,author,createdAt \
        --jq '.[] | "\(.title)|\(.url)|\(.author.login)|\(.createdAt)"' \
        2>/dev/null || true
      ;;
    gitlab)
      echo "--- plan PRs ---"
      glab mr list --label "rad:plan" --state opened --output json 2>/dev/null \
        | python3 -c "
import sys, json
for mr in json.load(sys.stdin):
    print(f\"{mr['title']}|{mr['web_url']}|{mr['author']['username']}|{mr['created_at']}\")
" 2>/dev/null || true
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

  find "$logs_dir" -name "*.md" ! -name "README.md" | \
    xargs ls -t 2>/dev/null | head -5 | while read -r log_file; do
    local feature date_str tasks_done tasks_failed
    feature=$(basename "$log_file" .md | sed 's/-[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}$//')
    date_str=$(basename "$log_file" .md | grep -o '[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}' || echo "")
    tasks_done=$(grep -c "✓ complete" "$log_file" 2>/dev/null || echo "0")
    tasks_failed=$(grep -c "✗ failed"  "$log_file" 2>/dev/null || echo "0")
    echo "$feature|$date_str|$tasks_done|$tasks_failed"
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
  while IFS='|' read -r feature status author waves tasks pr adopted_from; do
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
    [[ -n "$pr" && "$pr" != "PR:" ]] && echo "    PR:     $pr"

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
    if [[ "$line" == "--- plan PRs ---" ]];    then IN_SECTION="plan";    continue; fi
    if [[ "$line" == "--- deliver PRs ---" ]]; then IN_SECTION="deliver"; continue; fi
    [[ -z "$line" ]] && continue

    IFS='|' read -r title url author created_at <<< "$line"
    created_short=$(echo "$created_at" | cut -c1-10)

    case "$IN_SECTION" in
      plan)    echo "  Plan PR:    $title" ;;
      deliver) echo "  Deliver PR: $title" ;;
    esac
    echo "    $url"
    echo "    $author · $created_short"
    echo ""
    HAS_PRS=true
  done <<< "$PR_DATA"

  $HAS_PRS || echo "  No open plan or deliver PRs."
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
