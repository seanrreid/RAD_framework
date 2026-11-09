#!/usr/bin/env bash
# check-sensitive-content.sh
# Content-based scan of a RAD plan for sensitive behavior described in prose.
# Complements the path-based high-risk check: a plan that changes sensitive
# behavior in an innocuously named file is flagged here.
#
# Usage:
#   scripts/check-sensitive-content.sh plan <plan-file>
#   scripts/check-sensitive-content.sh diff <base> <head>
#   scripts/check-sensitive-content.sh pattern
#
# plan    Print one `sensitive-content:<id>` line per matched pattern id. The
#         scanned text is the Context and Scope sections, wave task `What:`
#         text and Files-in-Scope Change cells. Fenced code blocks and every
#         other section (Non-Goals, Execution Notes incl. Do Not Touch,
#         Waivers, ...) are never scanned.
# diff    Scan only the lines ADDED by the three-dot diff `base...head` (deleted
#         and context lines are never flagged). Added comment lines ARE scanned.
#         Not scanned: test files (RAD_TEST_PATH_RE), markdown (`.md`), anything
#         under `.agents/`; binary files and rename-only changes add no lines.
#         Output is one line per matched id, in built-in table order:
#           sensitive-content:<id><TAB><hit count><TAB><path:line,path:line,...>
#         with at most MAX_LOCATIONS locations in diff order. A base or head
#         must be a plain ref/sha (letters, digits, . _ / @ ^ ~ -, no leading
#         dash, no newline) that resolves to a commit. Writes no file.
# pattern Print the effective RAD_SENSITIVE_CONTENT_PATTERNS override, or
#         nothing when the built-in table is in effect.
#
# The built-in patterns are deliberately code-shaped (a call, a command with an
# argument, a secret moved by a verb), not bare words: bare words such as "eval",
# "egress" or "secret" flagged about a third of this repo's own plans.
#
# RAD_SENSITIVE_CONTENT_PATTERNS (extended regex, case-sensitive) replaces the
# built-in table and is reported under the single id `custom`. Empty or
# whitespace-only means unset. A leading `-`, a newline, or a regex that does
# not compile is an error.
#
# Exit codes:
#   0 = scan done (stdout lists hits, possibly none)
#   2 = usage error, unreadable plan, an unterminated code fence, an unsafe or
#       unresolvable ref, a failed git diff, or invalid pattern — stdout EMPTY.
#       Fail closed: an error is never reported as "no hits".

set -euo pipefail

readonly EXIT_ERROR=2
readonly SELF="check-sensitive-content"
readonly FINDING_PREFIX="sensitive-content:"
readonly CUSTOM_ID="custom"
# Most path:line locations reported per id in diff mode.
readonly MAX_LOCATIONS=5
# The only characters a diff-mode ref may contain (checked before git sees it).
readonly SAFE_REF_RE='^[A-Za-z0-9._/@^~-]+$'
# Built-in pattern ids, in report order. Regexes live in builtin_regex.
readonly BUILTIN_IDS="dynamic-eval permission-change destructive-sql credential-handling network-egress privilege-escalation"
readonly WORD_START='(^|[^[:alnum:]_])'
readonly WORD_END='([^[:alnum:]_]|$)'
# A quote or shell expansion: the start of a command argument, not of prose.
readonly QUOTE_OR_EXPANSION="[\"'\$\`]"
# Verbs that move a secret somewhere it should not go (hard-code, log, commit...).
readonly SECRET_VERBS='(hard-?cod(e|es|ed|ing)|embed(s|ded|ding)?|print(s|ed|ing)?|log(s|ged|ging)?|echo(es|ed|ing)?|writ(e|es|ing)|stor(e|es|ed|ing)|persist(s|ed|ing)?|commit(s|ted|ting)?)'
readonly SECRET_NOUNS='(password|passwd|secret|api[_ -]?key|private[_ -]key|credentials?|access[_ -]token)'

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
    dynamic-eval) printf '%s' "${WORD_START}(eval|exec)\\(|new Function\\(|child_process|shell=True|${WORD_START}eval[[:space:]]+${QUOTE_OR_EXPANSION}" ;;
    permission-change) printf '%s' "${WORD_START}(chmod|chown|chgrp|setfacl)[[:space:]]|world-writable|${WORD_START}0?777${WORD_END}" ;;
    destructive-sql) printf '%s' 'drop[[:space:]]+(table|database|schema|index)|truncate[[:space:]]+table|delete[[:space:]]+from|alter[[:space:]]+table' ;;
    credential-handling) printf '%s' "${SECRET_VERBS}[^.|]{0,40}${SECRET_NOUNS}|(password|passwd|secret|api[_-]?key)[[:space:]]*=|BEGIN [A-Z ]*PRIVATE KEY" ;;
    network-egress) printf '%s' "${WORD_START}(curl|wget|netcat)[[:space:]]+(-|https?:|${QUOTE_OR_EXPANSION})|XMLHttpRequest|${WORD_START}fetch\\(" ;;
    privilege-escalation) printf '%s' "${WORD_START}(sudo|doas)[[:space:]]|${WORD_START}(setuid|setgid)${WORD_END}|run as root|privilege escalation" ;;
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
    END { if (fenced) exit 3 }
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

# id_regex <id> <override>
# Print the regex for an id: the override for `custom`, else the built-in one.
id_regex() {
  if [[ "$1" == "$CUSTOM_ID" ]]; then
    printf '%s' "$2"
  else
    builtin_regex "$1"
  fi
}

# active_ids <override>
# Print the ids in effect, in report order: `custom` alone with an override.
active_ids() {
  if [[ -n "$1" ]]; then
    printf '%s\n' "$CUSTOM_ID"
  else
    printf '%s\n' $BUILTIN_IDS
  fi
}

# id_grep <id> <override> [grep-flag...]
# grep stdin for an id's regex. Built-ins match case-insensitively, the
# override case-sensitively. Exit status is grep's (0 hit, 1 none, 2 error).
id_grep() {
  local id="$1" override="$2" flags=(-E)
  shift 2
  [[ "$id" == "$CUSTOM_ID" ]] || flags+=(-i)
  grep "${flags[@]}" "$@" -e "$(id_regex "$id" "$override")" --
}

# matched_ids <text> <override>
# Print the finding line for each matching id (just `custom` with an override).
matched_ids() {
  local text="$1" override="$2" id
  for id in $(active_ids "$override"); do
    if printf '%s\n' "$text" | id_grep "$id" "$override" -q; then
      printf '%s%s\n' "$FINDING_PREFIX" "$id"
    fi
  done
}

run_plan() {
  local plan_file="$1" override text
  [[ -f "$plan_file" && -r "$plan_file" ]] || die "plan file missing or unreadable: '$plan_file'"
  override=$(effective_pattern)
  text=$(plan_scan_text "$plan_file") || die "cannot scan plan (unreadable, or a code fence is never closed): '$plan_file'"
  matched_ids "$text" "$override"
}

# validate_ref <name> <value>
# Print the commit sha <value> resolves to. Dies (exit 2) on a leading dash, a
# newline, a character outside SAFE_REF_RE, or a ref that is not a commit.
validate_ref() {
  local name="$1" value="$2" sha
  case "$value" in
    *$'\n'*) die "$name must not contain a newline" ;;
    -*) die "$name must not start with '-'" ;;
  esac
  [[ "$value" =~ $SAFE_REF_RE ]] || die "$name contains characters outside the safe set: '$value'"
  sha=$(git rev-parse --verify --quiet "${value}^{commit}") || sha=""
  [[ -n "$sha" ]] || die "$name does not resolve to a commit: '$value'"
  printf '%s\n' "$sha"
}

# is_scanned_path <path>
# True iff diff mode scans the file: not a test, not markdown, not under .agents/.
is_scanned_path() {
  case "$1" in
    *.md | .agents/*) return 1 ;;
  esac
  ! path_matches "$1" "$RAD_TEST_PATH_RE"
}

# added_rows <diff-text>
# Print `path<TAB>line<TAB>text` for every added line of a zero-context diff.
# Hunk header counts keep an added line that starts with `++` from being read
# as a file header.
added_rows() {
  printf '%s\n' "$1" | awk '
    function count(s,   a) { split(s, a, ","); return (a[2] == "") ? 1 : a[2] + 0 }
    function start(s,   a) { split(s, a, ","); return a[1] + 0 }
    oldrem > 0 || newrem > 0 {
      c = substr($0, 1, 1)
      if (c == "+") { print file "\t" nl "\t" substr($0, 2); nl++; newrem-- }
      else if (c == "-") oldrem--
      else if (c == " ") { oldrem--; newrem--; nl++ }
      next
    }
    /^\+\+\+ / {
      file = substr($0, 5); sub(/\t.*$/, "", file)
      if (file == "/dev/null") file = ""; else sub(/^b\//, "", file)
      next
    }
    /^@@ / {
      split($0, p, " ")
      o = substr(p[2], 2); n = substr(p[3], 2)
      oldrem = count(o); newrem = count(n); nl = start(n)
      if (file == "") { oldrem = 0; newrem = 0 }
    }
  '
}

# diff_added_lines <base-sha> <head-sha>
# Print `path<TAB>line<TAB>text` for added lines in scanned files only.
diff_added_lines() {
  local raw path line text last_path="" skip=0
  raw=$(git -c core.quotepath=off diff --no-color --no-ext-diff --no-textconv -M \
    --unified=0 --src-prefix=a/ --dst-prefix=b/ "$1...$2" --) \
    || die "git diff failed for $1...$2"
  added_rows "$raw" | while IFS=$'\t' read -r path line text; do
    if [[ "$path" != "$last_path" ]]; then
      last_path="$path"
      skip=0
      is_scanned_path "$path" || skip=1
    fi
    [[ "$skip" -eq 1 ]] || printf '%s\t%s\t%s\n' "$path" "$line" "$text"
  done
}

# hit_locations <numbers> <locations>
# Print up to MAX_LOCATIONS comma-joined locations: <numbers> are 1-based row
# numbers (one per line), <locations> holds one location per row.
hit_locations() {
  local numbers="$1" locations="$2" n out="" shown=0
  for n in $numbers; do
    [[ "$shown" -lt "$MAX_LOCATIONS" ]] || break
    out="${out:+$out,}$(printf '%s\n' "$locations" | sed -n "${n}p")"
    shown=$((shown + 1))
  done
  printf '%s' "$out"
}

# tally_hits <override>
# Read `path<TAB>line<TAB>text` rows on stdin; print one line per matched id.
# Output is built fully before printing so an error never leaves partial stdout.
tally_hits() {
  local override="$1" path line text texts="" locations="" id numbers status out=""
  while IFS=$'\t' read -r path line text; do
    [[ -n "$path" ]] || continue
    texts="$texts$text"$'\n'
    locations="$locations$path:$line"$'\n'
  done
  [[ -n "$texts" ]] || return 0
  for id in $(active_ids "$override"); do
    status=0
    numbers=$(printf '%s' "$texts" | id_grep "$id" "$override" -n | cut -d: -f1) || status=$?
    [[ "$status" -le 1 ]] || die "pattern match failed for id $id"
    [[ -n "$numbers" ]] || continue
    out="$out$FINDING_PREFIX$id"$'\t'"$(printf '%s\n' "$numbers" | wc -l | tr -d ' ')"$'\t'"$(hit_locations "$numbers" "$locations")"$'\n'
  done
  printf '%s' "$out"
}

# run_diff <base> <head>
run_diff() {
  local override base head rows
  override=$(effective_pattern)
  base=$(validate_ref base "$1")
  head=$(validate_ref head "$2")
  rows=$(diff_added_lines "$base" "$head")
  printf '%s\n' "$rows" | tally_hits "$override"
}

main() {
  local mode="${1:-}" override
  case "$mode" in
    plan)
      [[ $# -eq 2 ]] || die "usage: $SELF plan <plan-file>"
      run_plan "$2" ;;
    diff)
      [[ $# -eq 3 ]] || die "usage: $SELF diff <base> <head>"
      run_diff "$2" "$3" ;;
    pattern)
      [[ $# -eq 1 ]] || die "usage: $SELF pattern"
      override=$(effective_pattern)
      [[ -z "$override" ]] || printf '%s\n' "$override" ;;
    *) die "usage: $SELF plan <plan-file> | diff <base> <head> | pattern" ;;
  esac
}

main "$@"
