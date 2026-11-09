#!/usr/bin/env bash
# check-sensitive-content.sh
# Content-based scan of a RAD plan for sensitive behavior described in prose.
# Complements the path-based high-risk check: a plan that changes sensitive
# behavior in an innocuously named file is flagged here.
#
# Usage:
#   scripts/check-sensitive-content.sh plan <plan-file>
#   scripts/check-sensitive-content.sh pattern
#
# plan    Print one `sensitive-content:<id>` line per matched pattern id. The
#         scanned text is the Context and Scope sections, wave task `What:`
#         text and Files-in-Scope Change cells. Fenced code blocks and every
#         other section (Non-Goals, Execution Notes incl. Do Not Touch,
#         Waivers, ...) are never scanned.
# pattern Print the effective RAD_SENSITIVE_CONTENT_PATTERNS override, or
#         nothing when the built-in table is in effect.
#
# RAD_SENSITIVE_CONTENT_PATTERNS (extended regex, case-sensitive) replaces the
# built-in table and is reported under the single id `custom`. Empty or
# whitespace-only means unset. A leading `-`, a newline, or a regex that does
# not compile is an error.
#
# Exit codes:
#   0 = scan done (stdout lists hits, possibly none)
#   2 = usage error, unreadable plan, or invalid pattern — stdout EMPTY.
#       Fail closed: an error is never reported as "no hits".

set -euo pipefail

readonly EXIT_ERROR=2
readonly SELF="check-sensitive-content"
readonly FINDING_PREFIX="sensitive-content:"
readonly CUSTOM_ID="custom"
# Built-in pattern ids, in report order. Regexes live in builtin_regex.
readonly BUILTIN_IDS="dynamic-eval permission-change destructive-sql credential-handling network-egress privilege-escalation"
readonly WORD_START='(^|[^[:alnum:]_])'
readonly WORD_END='([^[:alnum:]_]|$)'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/plan-paths.sh
. "$SCRIPT_DIR/lib/plan-paths.sh"

die() {
  echo "$SELF: $1" >&2
  exit "$EXIT_ERROR"
}

# builtin_regex <id>
# Print the extended regex (matched case-insensitively) for a built-in id.
builtin_regex() {
  case "$1" in
    dynamic-eval) printf '%s' "${WORD_START}(eval|exec)${WORD_END}|new Function|child_process|shell=True" ;;
    permission-change) printf '%s' "${WORD_START}(chmod|chown|chgrp|setfacl)${WORD_END}|world-writable|${WORD_START}0?777${WORD_END}" ;;
    destructive-sql) printf '%s' 'drop[[:space:]]+(table|database|schema|index)|truncate[[:space:]]+table|delete[[:space:]]+from|alter[[:space:]]+table' ;;
    credential-handling) printf '%s' 'password|passwd|secret|api[_ -]?key|private[_ -]key|credential|access[_ -]token' ;;
    network-egress) printf '%s' "${WORD_START}(curl|wget|netcat)${WORD_END}|webhook|outbound|egress|XMLHttpRequest|fetch\\(" ;;
    privilege-escalation) printf '%s' "${WORD_START}(sudo|doas|setuid|setgid)${WORD_END}|run as root|root privilege|privilege escalation" ;;
    *) die "unknown built-in id: $1" ;;
  esac
}

# trim_ws <string>
trim_ws() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# regex_compiles <pattern>
# Exit 0 iff grep accepts the pattern (grep exit 2 = bad regex).
regex_compiles() {
  local status=0
  printf '' | grep -E -e "$1" -- >/dev/null 2>&1 || status=$?
  [[ "$status" -le 1 ]]
}

# effective_pattern
# Print the validated override (trimmed), or nothing when unset/blank. Exits 2
# on an invalid override, before any stdout is produced.
effective_pattern() {
  local raw="${RAD_SENSITIVE_CONTENT_PATTERNS:-}" trimmed
  trimmed=$(trim_ws "$raw")
  [[ -z "$trimmed" ]] && return 0
  case "$raw" in
    *$'\n'*) die "RAD_SENSITIVE_CONTENT_PATTERNS must not contain a newline" ;;
  esac
  case "$trimmed" in
    -*) die "RAD_SENSITIVE_CONTENT_PATTERNS must not start with '-'" ;;
  esac
  regex_compiles "$trimmed" || die "RAD_SENSITIVE_CONTENT_PATTERNS is not a valid extended regex"
  printf '%s' "$trimmed"
}

# plan_scan_text <plan-file>
# Print only the scannable plan text: Context/Scope bodies, Files-in-Scope
# Change cells (4th table column) and wave task `What:` text. Fence-aware via
# RAD_FENCE_LINE_RE; every other section is skipped.
plan_scan_text() {
  awk -v fence_re="$RAD_FENCE_LINE_RE" '
    $0 ~ fence_re { fenced = !fenced; next }
    fenced { next }
    /^## / { sec = $0; sub(/^## /, "", sec); sub(/[ \t\r]+$/, "", sec); what = 0; next }
    sec == "Context" || sec == "Scope" { print; next }
    sec == "Files in Scope" && /^\|/ {
      n = split($0, cell, "|")
      if (n >= 5) print cell[4]
      next
    }
    sec == "Wave Plan" {
      if ($0 ~ /^What:/) { what = 1; print; next }
      if (what && ($0 ~ /^[ \t\r]*$/ || $0 ~ /^[A-Za-z]+:/ || $0 ~ /^#/)) what = 0
      if (what) print
    }
  ' "$1"
}

# matched_ids <text> <override>
# Print the finding line for each matching id (just `custom` with an override).
matched_ids() {
  local text="$1" override="$2" id
  if [[ -n "$override" ]]; then
    if printf '%s\n' "$text" | grep -E -q -e "$override" --; then
      printf '%s%s\n' "$FINDING_PREFIX" "$CUSTOM_ID"
    fi
    return 0
  fi
  for id in $BUILTIN_IDS; do
    if printf '%s\n' "$text" | grep -E -i -q -e "$(builtin_regex "$id")" --; then
      printf '%s%s\n' "$FINDING_PREFIX" "$id"
    fi
  done
}

run_plan() {
  local plan_file="$1" override text
  [[ -f "$plan_file" && -r "$plan_file" ]] || die "plan file missing or unreadable: '$plan_file'"
  override=$(effective_pattern)
  text=$(plan_scan_text "$plan_file") || die "cannot read plan: '$plan_file'"
  matched_ids "$text" "$override"
}

main() {
  local mode="${1:-}" override
  case "$mode" in
    plan)
      [[ $# -eq 2 ]] || die "usage: $SELF plan <plan-file>"
      run_plan "$2" ;;
    pattern)
      [[ $# -eq 1 ]] || die "usage: $SELF pattern"
      override=$(effective_pattern)
      [[ -z "$override" ]] || printf '%s\n' "$override" ;;
    *) die "usage: $SELF plan <plan-file> | pattern" ;;
  esac
}

main "$@"
