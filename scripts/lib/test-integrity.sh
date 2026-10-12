#!/usr/bin/env bash
# lib/test-integrity.sh
# Test-weakening guard: reports test files a delivery deleted, renamed away, or
# gave a skip marker, unless the plan waives that exact path. Sourced by
# scripts/check-scope.sh. Requires lib/plan-paths.sh to be sourced first.
#
# Usage: source this file, then
#   test_integrity_violations <plan-file> <diff-range>
# Prints one violation per line on stdout; returns 0 (checked), 2 (git or plan
# read failure — never reported as clean).
#
# bash 3.2 (macOS stock) compatible: no associative arrays, no `mapfile`.

readonly TI_FAILURE_EXIT=2

# _ti_waived_paths <plan-file>
# Print the <path> of every `- test-removal:<path>: <reason>` waiver, one per
# line. plan_waivers already drops bullets with an empty reason.
_ti_waived_paths() {
  local plan_file="$1" waivers id _why
  waivers=$(plan_waivers "$plan_file") || return "$TI_FAILURE_EXIT"
  while IFS=$'\t' read -r id _why; do
    if [[ "$id" == "$RAD_TEST_WAIVER_PREFIX"* ]]; then
      printf '%s\n' "${id#"$RAD_TEST_WAIVER_PREFIX"}"
    fi
  done <<< "$waivers"
  return 0
}

# _ti_added_skip_lines <diff-range> <path>
# Print the added lines of <path> that match a skip marker. A marker on a
# removed line never counts. Returns 2 if git or grep fails.
_ti_added_skip_lines() {
  local range="$1" path="$2" diff_out added rc
  diff_out=$(git diff --no-ext-diff -U0 "$range" -- ":(literal)$path") || {
    echo "ERROR: test-integrity: git diff failed for $path ($range)" >&2
    return "$TI_FAILURE_EXIT"
  }
  added=$(printf '%s\n' "$diff_out" | awk '/^@@/ { body = 1; next } body && /^\+/ { print substr($0, 2) }')
  printf '%s\n' "$added" | grep -E -e "$RAD_SKIP_MARKER_RE" && rc=0 || rc=$?
  [[ "$rc" -le 1 ]] || return "$TI_FAILURE_EXIT"
  return 0
}

# _ti_report_change <status> <old> <new> <range>
# Print the violation line(s) for one changed test path; nothing if it is fine.
_ti_report_change() {
  local status="$1" old="$2" new="$3" range="$4" line lines
  case "$status" in
    D*) printf '%s — deleted\n' "$old" ;;
    R*) printf '%s — renamed to %s\n' "$old" "$new" ;;
    M*)
      lines=$(_ti_added_skip_lines "$range" "$old") || return "$TI_FAILURE_EXIT"
      while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        printf '%s — added skip marker: %s\n' "$old" "$line"
      done <<< "$lines"
      ;;
  esac
  return 0
}

# _ti_scan_changes <name-status -z file> <range> <waived paths>
_ti_scan_changes() {
  local changes="$1" range="$2" waived="$3" status old new=""
  while IFS= read -r -d '' status; do
    IFS= read -r -d '' old || { echo "ERROR: test-integrity: truncated git output" >&2; return "$TI_FAILURE_EXIT"; }
    new=""
    case "$status" in
      R*|C*) IFS= read -r -d '' new || { echo "ERROR: test-integrity: truncated git output" >&2; return "$TI_FAILURE_EXIT"; } ;;
    esac
    path_matches "$old" "$RAD_TEST_PATH_RE" || continue
    grep -Fxq -e "$old" <<< "$waived" && continue
    _ti_report_change "$status" "$old" "$new" "$range" || return "$TI_FAILURE_EXIT"
  done < "$changes"
  return 0
}

test_integrity_violations() {
  local plan_file="$1" range="$2" waived tmp rc
  waived=$(_ti_waived_paths "$plan_file") || return "$TI_FAILURE_EXIT"
  tmp=$(mktemp) || return "$TI_FAILURE_EXIT"
  if ! git diff --find-renames --name-status -z "$range" -- > "$tmp"; then
    rm -f "$tmp"
    echo "ERROR: test-integrity: git diff failed for $range" >&2
    return "$TI_FAILURE_EXIT"
  fi
  _ti_scan_changes "$tmp" "$range" "$waived" && rc=0 || rc=$?
  rm -f "$tmp"
  return "$rc"
}
