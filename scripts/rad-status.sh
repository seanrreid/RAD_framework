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
  # Must run in the caller's shell (fed by redirection, never on the right of a
  # pipe) or the SEEN_FEATURES update is lost in a subshell and a plan present
  # on several sources is listed once per source.
  local feature="$1" source="$2" content status author waves tasks adopted_from
  case "$SEEN_FEATURES" in *" $feature "*) cat >/dev/null; return 0 ;; esac
  SEEN_FEATURES="${SEEN_FEATURES}${feature} "
  content=$(cat)

  status=$(printf '%s\n' "$content"       | grep "^Status:"       | head -1 | awk '{print $2}' || echo "unknown")
  author=$(printf '%s\n' "$content"       | grep "^Author:"       | head -1 | sed 's/^Author:[[:space:]]*//' || echo "")
  adopted_from=$(printf '%s\n' "$content" | grep "^Adopted-From:" | head -1 | sed 's/^Adopted-From:[[:space:]]*//' || echo "")
  # grep -c always prints the count (0 included) but exits 1 on no match, so the
  # fallback must print nothing — `|| echo 0` yields "0\n0" and splits the row.
  waves=$(printf '%s\n' "$content"        | grep -c "^### Wave"  || true)
  tasks=$(printf '%s\n' "$content"        | grep -c "^#### Task" || true)

  echo "$feature|${status:-unknown}|$author|$waves|$tasks|$source|$adopted_from"
}

collect_plans() {
  local base ref branch feature path

  # The three passes share one group (piped to sort); emit_plan_row runs in that
  # group's shell — fed by redirection, never piped into — so SEEN_FEATURES
  # carries across passes. Priority: branch tip > merged on default > local tree.
  {
    # 1. In-flight: one plan per rad/ branch tip on origin (canonical). A tip
    # with no plan doc (e.g. research only) is not a plan source: skip it so it
    # neither renders an empty row nor shadows a lower-priority copy.
    while read -r ref; do
      [[ -z "$ref" ]] && continue
      branch="${ref#origin/}"
      feature="${branch#"$PREFIX"}"
      path=".agents/plans/${feature}.md"
      git cat-file -e "origin/${branch}:${path}" 2>/dev/null || continue
      emit_plan_row "$feature" "$branch" \
        < <(git show "origin/${branch}:${path}" 2>/dev/null || true) || true
    done < <(git branch -r --list "origin/${PREFIX}*" 2>/dev/null | sed 's/^[[:space:]]*//')

    # 2. Merged: plan docs that have landed on the default branch.
    base=$("$SCRIPT_DIR/get-default-branch.sh" 2>/dev/null || echo main)
    while read -r path; do
      [[ -z "$path" ]] && continue
      feature=$(basename "$path" .md)
      emit_plan_row "$feature" "${base} (merged)" \
        < <(git show "origin/${base}:${path}" 2>/dev/null || true) || true
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

# ── Research inventory ────────────────────────────────────────────────────────

# Research artifacts (.agents/research/<slug>.md) are the pre-plan stage. Same
# source priority as plans (branch tip > merged on default > local tree), but a
# research slug need not match its branch's feature, so each branch tip's whole
# research dir is listed rather than one keyed path.

RESEARCH_DIR=".agents/research"

# Separate from SEEN_FEATURES: a research slug and a plan feature may share a name.
SEEN_RESEARCH=" "

emit_research_row() {
  # $1 = research slug, $2 = source label, content on stdin
  # Must run in the caller's shell (fed by redirection, never on the right of a
  # pipe) or the SEEN_RESEARCH update is lost in a subshell.
  local slug="$1" source="$2" status
  case "$SEEN_RESEARCH" in *" $slug "*) cat >/dev/null; return 0 ;; esac
  SEEN_RESEARCH="${SEEN_RESEARCH}${slug} "
  status=$(grep "^Status:" | head -1 | awk '{print $2}' || true)
  echo "$slug|${status:-unknown}|$source"
}

# Lists research doc paths in a git tree-ish, README excluded.
list_research_paths() {
  git ls-tree -r --name-only "$1" -- "$RESEARCH_DIR" 2>/dev/null \
    | grep -E "^${RESEARCH_DIR}/.*\.md$" | grep -v '/README\.md$' || true
}

collect_research() {
  local base ref branch path

  base=$("$SCRIPT_DIR/get-default-branch.sh" 2>/dev/null || echo main)
  # One subshell (piped to sort) so SEEN_RESEARCH stays consistent across passes.
  {
    # 1. In-flight: research on each rad/ branch tip. A branch cut from the base
    # carries every merged artifact too; only a doc that is new or changed on the
    # tip belongs to that branch — an identical blob falls through to pass 2.
    while read -r ref; do
      [[ -z "$ref" ]] && continue
      branch="${ref#origin/}"
      while read -r path; do
        [[ -z "$path" ]] && continue
        if [[ "$(git rev-parse -q --verify "origin/${branch}:${path}" 2>/dev/null)" \
           == "$(git rev-parse -q --verify "origin/${base}:${path}" 2>/dev/null || true)" ]]; then
          continue
        fi
        emit_research_row "$(basename "$path" .md)" "$branch" \
          < <(git show "origin/${branch}:${path}" 2>/dev/null || true)
      done < <(list_research_paths "origin/${branch}")
    done < <(git branch -r --list "origin/${PREFIX}*" 2>/dev/null | sed 's/^[[:space:]]*//')

    # 2. Merged: research that has landed on the default branch.
    while read -r path; do
      [[ -z "$path" ]] && continue
      emit_research_row "$(basename "$path" .md)" "${base} (merged)" \
        < <(git show "origin/${base}:${path}" 2>/dev/null || true)
    done < <(list_research_paths "origin/${base}")

    # 3. Local working tree — research authored locally but not yet pushed.
    if [[ -d "$RESEARCH_DIR" ]]; then
      while read -r path; do
        emit_research_row "$(basename "$path" .md)" "local (unpushed)" < "$path"
      done < <(find "$RESEARCH_DIR" -name "*.md" ! -name "README.md" 2>/dev/null | sort)
    fi
  } | sort
}

# Research is consumed once a plan exists for its slug (any source, any status)
# or its header says so; consumed research leaves the pre-plan section.
RESEARCH_CONSUMED_STATUS="consumed"

# Space-delimited slug set from collect_plans rows (bash 3.2: no assoc arrays).
plan_slug_set() {
  local set=" " feature rest
  while IFS='|' read -r feature rest; do
    [[ -n "$feature" ]] && set="${set}${feature} "
  done <<< "$1"
  printf '%s' "$set"
}

research_is_consumed() {
  # $1 = research slug, $2 = research status; reads PLAN_SLUGS
  [[ "$2" == "$RESEARCH_CONSUMED_STATUS" ]] && return 0
  case "$PLAN_SLUGS" in *" $1 "*) return 0 ;; esac
  return 1
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
RESEARCH=$(collect_research)
PLAN_SLUGS=$(plan_slug_set "$PLANS")
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
      review)         status_icon="👀" ;;
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

# ── Research ──────────────────────────────────────────────────────────────────

echo "── Research (pre-plan) ────────────────"
echo ""

if [[ -z "$RESEARCH" ]]; then
  echo "  (no research artifacts)"
  echo ""
else
  RESEARCH_HIDDEN=0
  RESEARCH_SHOWN=0
  while IFS='|' read -r slug status where; do
    if research_is_consumed "$slug" "$status"; then
      RESEARCH_HIDDEN=$((RESEARCH_HIDDEN + 1))
      continue
    fi
    RESEARCH_SHOWN=$((RESEARCH_SHOWN + 1))
    echo "  · $slug"
    echo "    Status: $status"
    echo "    Source: $where"
    # Only the two actionable states get a hint; parked and any other value
    # are listed as-is.
    case "$status" in
      pending-design) echo "    Next:   /rad-design $slug" ;;
      pending-plan)   echo "    Next:   /rad-plan $slug" ;;
    esac
    echo ""
  done <<< "$RESEARCH"
  # Hiding is reported, never silent.
  if [[ "$RESEARCH_SHOWN" -eq 0 ]]; then
    echo "  (no pre-plan research; ${RESEARCH_HIDDEN} consumed)"
    echo ""
  fi
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
