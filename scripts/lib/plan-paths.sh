#!/usr/bin/env bash
# lib/plan-paths.sh
# Shared helpers for extracting the declared-scope path set from a RAD plan and
# matching paths against a |-separated extended-regex pattern. ONE source of
# truth, sourced by both scripts/lint-plan.sh and scripts/classify-low-risk.sh.
#
# Usage: source this file, then call the functions below. Functions read the
# plan file path passed as $1 — they do not depend on caller-set globals.
#
# bash 3.2 (macOS stock) compatible: no associative arrays, no `mapfile`.

# strip_task_file_lines <value>
# Strip a trailing :lines suffix from a task File: value (e.g. path:290-410 or
# path:150 → path). Paths without a :digits suffix pass through unchanged.
strip_task_file_lines() {
  case "$1" in
    *:[0-9]*) echo "${1%:*}" ;;
    *)        echo "$1" ;;
  esac
}

# plan_files_in_scope <plan-file>
# Print the Files-in-Scope table paths (column 2), one per line, skipping the
# header, separator, and placeholder rows. Whitespace and backticks stripped.
plan_files_in_scope() {
  local plan_file="$1"
  awk '/^## Files in Scope/{found=1; next} /^## /{found=0} found && /^\|/' "$plan_file" \
    | grep -v "^| *File" | grep -v "^|[-| ]*$" \
    | awk -F'|' '{print $2}' \
    | while IFS= read -r path; do
        path=$(echo "$path" | tr -d '`' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
        [[ -z "$path" || "$path" == "[path]" || "$path" == "File" ]] && continue
        echo "$path"
      done
}

# plan_task_files <plan-file>
# Print each per-task `File:` path (with the :lines suffix stripped), one per
# line, skipping empty and placeholder values.
plan_task_files() {
  local plan_file="$1"
  local line file_val file_path
  while IFS= read -r line; do
    [[ "$line" == File:* ]] || continue
    file_val=$(echo "$line" | sed 's/^File:[[:space:]]*//' | sed 's/[[:space:]]*$//')
    file_path=$(strip_task_file_lines "$file_val")
    [[ -z "$file_path" || "$file_path" == "[path]" ]] && continue
    echo "$file_path"
  done < "$plan_file"
}

# plan_scope_paths <plan-file>
# Print the de-duplicated union of Files-in-Scope and per-task File: paths,
# one path per line, sorted. This is the path set both the high-risk advisory
# and the low-risk classifier reason over.
plan_scope_paths() {
  local plan_file="$1"
  {
    plan_files_in_scope "$plan_file"
    plan_task_files "$plan_file"
  } | grep -v '^$' | sort -u
}

# path_matches <path> <pattern>
# True (exit 0) iff <path> matches the |-separated extended-regex <pattern>.
# An empty pattern never matches (returns non-zero) — callers rely on this for
# fail-closed / OFF semantics.
path_matches() {
  local path="$1" pattern="$2"
  [[ -z "$pattern" ]] && return 1
  echo "$path" | grep -qE "$pattern"
}
