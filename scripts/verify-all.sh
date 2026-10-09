#!/usr/bin/env bash
# verify-all.sh
# The single definition of "what CI runs, locally": runs the repo's CI checks
# sequentially, continues past failures, and reports every failing check in one
# run. Intended as a plan's last-wave verification:
#
#   Verify: exec bash scripts/verify-all.sh
#
# (`exec` makes the process scripts/check-verify.sh kills on a timeout THIS
# script, which then cleans up its own children on a signal. Run `rad deliver`
# with RAD_VERIFY_TIMEOUT_SECONDS=1800; the default of 600 s is too short.)
#
# Usage: scripts/verify-all.sh [--base <ref>] [--list] [--only <name>[,<name>...]]
#
#   --base <ref>   base for the checks that need one (default: origin/main when
#                  it resolves). An explicit ref that does not resolve is a
#                  usage error; with no resolvable default those checks SKIP.
#   --list         print the built-in check names and exit 0
#   --only a,b     run just the named checks; the rest are reported as skipped
#
# Mirrors the .github/workflows/ci.yml jobs: harness-tests, evals-scripted,
# script-tests, generated-drift, playbook-lint, invariant-lint, agent-file-lint,
# claude-md-budget, shell-safety-lint, plan-lint, events-append-only (plus
# `config validate`). EXCLUDED: deliver-integrity and matrix-replay — both need
# PR context (head ref, base ref, rad/* branch tips) that a local run lacks.
#
# Output: one line per check — `ok   <name> (<s>s)`, `FAIL <name> (exit <N>, <s>s)`
# or `skip  <name> (<reason>)` — then the last 12 lines of each failed check's
# output, then the LAST line `verify-all: <p> passed, <f> failed, <s> skipped`
# (so a 40-line failure excerpt always shows what failed). Exit 0 only when
# nothing failed; 2 on a usage error; 143 after TERM/INT.
#
# Test hook (TEST-ONLY): RAD_VERIFY_ALL_CHECKS_FILE names a file of
# `name<TAB>command[<TAB>base]` lines that replaces the built-in table; a
# trailing `base` marks a check that needs a base ref. Blank lines and `#`
# comments are ignored.
#
# Bash 3.2 compatible (no associative arrays, no mapfile).

set -euo pipefail

# ── Named constants ───────────────────────────────────────────────────────────

readonly DEFAULT_BASE_REF="origin/main"
readonly FAIL_EXCERPT_LINES=12
readonly USAGE_STATUS=2
readonly INTERRUPTED_STATUS=143
readonly DEFAULT_GIT_NAME="rad-verify"
readonly DEFAULT_GIT_EMAIL="rad-verify@localhost"
readonly BASE_MARKER="base"
readonly TAB=$'\t'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Built-in check table: name<TAB>command[<TAB>base] ─────────────────────────

# Commands run with `bash -c` from the repo root; $VERIFY_ALL_BASE is the base ref.
builtin_checks() {
  printf '%s\n' \
    "harness-tests${TAB}node --test harness/test/*.test.js" \
    "evals${TAB}node --test harness/evals/*.eval.js" \
    "script-tests${TAB}unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL; rc=0; for t in scripts/test-*.sh; do bash \"\$t\" >/dev/null 2>&1 || { echo \"FAILED: \$t\"; rc=1; }; done; exit \$rc" \
    "generate-drift${TAB}node harness/cli.js generate --check" \
    "playbook-lint${TAB}node harness/cli.js playbook lint" \
    "config-validate${TAB}node harness/cli.js config validate" \
    "lint-invariants${TAB}scripts/lint-invariants.sh" \
    "lint-agent-files${TAB}scripts/lint-agent-files.sh" \
    "lint-claude-md${TAB}scripts/lint-claude-md.sh" \
    "lint-shell-safety${TAB}scripts/lint-shell-safety.sh" \
    "plan-lint${TAB}rc=0; for p in \$(git diff --name-only \"\$VERIFY_ALL_BASE\"...HEAD -- '.agents/plans/*.md'); do [ -f \"\$p\" ] || continue; scripts/lint-plan.sh \"\$p\" || rc=1; done; exit \$rc${TAB}${BASE_MARKER}" \
    "events-append-only${TAB}scripts/check-events-append-only.sh \"\$VERIFY_ALL_BASE\"${TAB}${BASE_MARKER}"
}

checks_table() {
  if [[ -n "${RAD_VERIFY_ALL_CHECKS_FILE:-}" ]]; then
    cat "$RAD_VERIFY_ALL_CHECKS_FILE"
  else
    builtin_checks
  fi
}

# ── Arguments ─────────────────────────────────────────────────────────────────

usage_error() {
  echo "ERROR: $1" >&2
  echo "Usage: scripts/verify-all.sh [--base <ref>] [--list] [--only <name>[,<name>...]]" >&2
  exit "$USAGE_STATUS"
}

BASE_ARG=""
ONLY=""
LIST=0
parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --base)
        [[ "$#" -ge 2 && -n "$2" ]] || usage_error "--base needs a ref"
        BASE_ARG="$2"; shift 2 ;;
      --only)
        [[ "$#" -ge 2 && -n "$2" ]] || usage_error "--only needs a comma-separated name list"
        ONLY="$2"; shift 2 ;;
      --list) LIST=1; shift ;;
      *) usage_error "unknown argument '$1'" ;;
    esac
  done
}

resolve_base() {
  BASE=""
  if [[ -n "$BASE_ARG" ]]; then
    [[ "$BASE_ARG" =~ ^[A-Za-z0-9._/~^@-]+$ && "$BASE_ARG" != -* ]] ||
      usage_error "--base '$BASE_ARG' is not a plausible git ref"
    git -C "$ROOT" rev-parse --verify --quiet "$BASE_ARG^{commit}" >/dev/null ||
      usage_error "--base '$BASE_ARG' does not resolve to a commit"
    BASE="$BASE_ARG"
  elif git -C "$ROOT" rev-parse --verify --quiet "$DEFAULT_BASE_REF^{commit}" >/dev/null; then
    BASE="$DEFAULT_BASE_REF"
  fi
}

is_selected() {
  [[ -z "$ONLY" ]] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; esac
  return 1
}

# Every --only name must exist in the table; a typo is a usage error, never a
# silent "nothing ran".
validate_only() {
  local want name rest
  [[ -n "$ONLY" ]] || return 0
  for want in $(printf '%s' "$ONLY" | tr ',' ' '); do
    found=0
    while IFS="$TAB" read -r name rest; do
      [[ "$name" == "$want" ]] && found=1
    done < <(checks_table)
    [[ "$found" -eq 1 ]] || usage_error "--only names unknown check '$want'"
  done
}

# ── Signals ───────────────────────────────────────────────────────────────────

CURRENT_PID=""
WORK=""

collect_descendants() {
  local kid
  for kid in $(pgrep -P "$1" 2>/dev/null || true); do
    echo "$kid"
    collect_descendants "$kid"
  done
}

# Best effort: snapshot the whole tree FIRST so killing a parent cannot
# reparent (and hide) its children before they are signalled.
kill_current_tree() {
  local pid
  [[ -n "$CURRENT_PID" ]] || return 0
  local victims
  victims="$(collect_descendants "$CURRENT_PID")"
  for pid in $victims "$CURRENT_PID"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
}

on_signal() {
  kill_current_tree
  echo "verify-all: interrupted"
  exit "$INTERRUPTED_STATUS"
}

cleanup() { [[ -z "$WORK" ]] || rm -rf "$WORK"; }

# ── Running ───────────────────────────────────────────────────────────────────

PASSED=0; FAILED=0; SKIPPED=0
FAILED_NAMES=()

run_one() {
  local name="$1" cmd="$2" out="$WORK/$1.out" start rc=0
  start="$SECONDS"
  (cd "$ROOT" && VERIFY_ALL_BASE="$BASE" exec bash -c "$cmd") >"$out" 2>&1 &
  CURRENT_PID=$!
  wait "$CURRENT_PID" 2>/dev/null || rc=$?
  CURRENT_PID=""
  if [[ "$rc" -eq 0 ]]; then
    PASSED=$((PASSED + 1))
    echo "ok   $name ($((SECONDS - start))s)"
  else
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("$name")
    echo "FAIL $name (exit $rc, $((SECONDS - start))s)"
  fi
}

skip_one() {
  SKIPPED=$((SKIPPED + 1))
  echo "skip  $1 ($2)"
}

run_all() {
  local name cmd flag
  while IFS="$TAB" read -r name cmd flag; do
    [[ -n "$name" && "${name:0:1}" != "#" ]] || continue
    TOTAL=$((TOTAL + 1))
    if ! is_selected "$name"; then skip_one "$name" "not selected"
    elif [[ "$flag" == "$BASE_MARKER" && -z "$BASE" ]]; then skip_one "$name" "no base ref"
    else run_one "$name" "$cmd"
    fi
  done < <(checks_table)
}

print_failures() {
  local name
  for name in ${FAILED_NAMES[@]+"${FAILED_NAMES[@]}"}; do
    echo "--- $name (last $FAIL_EXCERPT_LINES lines) ---"
    tail -n "$FAIL_EXCERPT_LINES" "$WORK/$name.out"
  done
}

main() {
  parse_args "$@"
  if [[ "$LIST" -eq 1 ]]; then
    checks_table | while IFS="$TAB" read -r name _; do
      [[ -n "$name" && "${name:0:1}" != "#" ]] && echo "$name"
    done
    return 0
  fi
  export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-$DEFAULT_GIT_NAME}"
  export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-$DEFAULT_GIT_EMAIL}"
  export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-$DEFAULT_GIT_NAME}"
  export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-$DEFAULT_GIT_EMAIL}"
  resolve_base
  validate_only
  WORK="$(mktemp -d)"
  trap cleanup EXIT
  trap on_signal TERM INT
  TOTAL=0
  run_all
  [[ "$TOTAL" -gt 0 ]] || usage_error "no checks to run (empty checks table)"
  print_failures
  echo "verify-all: $PASSED passed, $FAILED failed, $SKIPPED skipped"
  [[ "$FAILED" -eq 0 ]]
}

main "$@"
