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

# RAD's self-protected path set: the harness's own control surfaces. This set
# is deliberately NOT operator-tunable — a literal, never routed through an
# env var — so a plan cannot loosen the guard that classifies it. Additions
# require a reviewed commit to this file.
readonly RAD_SELF_PROTECTED_PATTERN='^harness/|^scripts/|^\.claude/|^\.agents/state/|(^|/)gates\.ya?ml$|(^|/)matrix\.ya?ml$'

# path_is_self_protected <path>
# True (exit 0) iff <path> falls inside the self-protected set. Delegates to
# path_matches with the literal constant, which is non-empty by construction —
# this check can never resolve to OFF.
path_is_self_protected() {
  path_matches "$1" "$RAD_SELF_PROTECTED_PATTERN"
}

# Known file extensions that make an extension-only token (no directory sep)
# look like a real cited file path. Used by plan_cited_anchors to keep prose
# tokens like `word:12` out of the anchor set. Not operator-tunable; extend by
# editing this list in a reviewed commit.
RAD_ANCHOR_EXT='(js|mjs|cjs|ts|tsx|jsx|sh|bash|py|rb|go|rs|java|c|h|cpp|hpp|yaml|yml|json|md|css|scss|sass|html|htm|txt|sql|toml|ini|cfg|conf|env|mk)'

# Sentinel line plan_cited_anchors' filter loop emits when resolve_anchor_path
# hits a genuine git failure. The loop runs inside a command substitution, so its
# exit status cannot reach the caller — this in-band marker carries the failure
# out instead. It can never collide with a real anchor: the anchor grep charset
# is [A-Za-z0-9._/-], so a space and '!' are un-representable in a path token.
RAD_ANCHOR_RESOLVE_FAILED='!! anchor-resolve-failed'

# resolve_anchor_path <token>
# Resolve a cited anchor to a repo-relative path against the tracked-file set.
# A token that already contains a directory separator is echoed unchanged. A bare
# basename is looked up with `git ls-files`: exactly one tracked match prints that
# path; zero or two-or-more matches print NOTHING — an unknown or ambiguous
# basename yields no signal, because a guess is worse than no signal. The token
# charset excludes glob metacharacters, so it is safe to embed in a pathspec.
# Return codes:
#   0  resolved (path on stdout), or deliberately unresolvable (empty stdout)
#   2  git could not be read — the caller MUST fail closed rather than read this
#      as "unresolvable", which would silently drop a real anchor
resolve_anchor_path() {
  local token="$1" matches status line resolved count
  case "$token" in
    */*) printf '%s\n' "$token"; return 0 ;;
  esac
  # git ls-files exit: 0 = the query ran (empty output is a valid "no match"),
  # non-zero = a real git/read failure. The `if` suspends set -e so we can
  # classify rather than abort. `*/name` matches at any depth (git pathspec
  # globs cross `/`); the bare `name` covers a repo-root file.
  if matches=$(git ls-files -- "*/$token" "$token" 2>/dev/null); then
    status=0
  else
    status=$?
  fi
  if [[ "$status" -ne 0 ]]; then
    echo "resolve_anchor_path: git ls-files failed for '$token' (exit $status)" >&2
    return 2
  fi
  [[ -z "$matches" ]] && return 0
  count=0
  resolved=""
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    count=$((count + 1))
    resolved="$line"
  done <<< "$matches"
  [[ "$count" -eq 1 ]] && printf '%s\n' "$resolved"
  return 0
}

# plan_cited_anchors <plan-file>
# Scan the whole plan body for inline `path/to/file.ext:NNN` anchor tokens and
# print each cited path with the trailing `:NNN` stripped (strip_task_file_lines
# semantics), de-duplicated (sort -u), one per line. A token qualifies only if it
# is real-path-shaped — it contains a `/` OR ends in a known file extension — so
# prose like `AC#3`, a bare `word:12`, or a URL such as `http://host:80` is never
# emitted. A qualifying token with no `/` (prose citing `spine.js:51`) is resolved
# against the tracked-file set by resolve_anchor_path, so the emitted path is
# repo-relative (`harness/spine.js`) and downstream existence checks are asked a
# question they can answer. Empty output (exit 0) when the plan cites no anchors.
plan_cited_anchors() {
  local plan_file="$1" raw status result token path
  # grep exit: 0 = matches, 1 = no anchor tokens (a valid empty result, NOT an
  # error), >1 = a real read failure. The `if` suspends set -e so we can classify
  # rather than abort; a genuine read error surfaces and fails closed.
  if raw=$(grep -oE '[A-Za-z0-9._/-]+:[0-9]+' "$plan_file" 2>/dev/null); then
    status=0
  else
    status=$?
  fi
  if [[ "$status" -gt 1 ]]; then
    echo "plan_cited_anchors: cannot read '$plan_file' (grep exit $status)" >&2
    return "$status"
  fi
  [[ -z "$raw" ]] && return 0
  # Filter to real-path-shaped tokens and de-duplicate. The trailing `|| true`
  # absorbs ONLY the benign non-zero from the read-loop / pipefail at EOF — the
  # sole error source (grep) was already classified above, so nothing is hidden.
  result=$(printf '%s\n' "$raw" | while IFS= read -r token; do
      case "$token" in *//*) continue ;; esac              # drop URL host:port
      path=$(strip_task_file_lines "$token")
      case "$path" in
        */*) echo "$path" ;;                                # has a directory sep
        *.*) echo "$path" | grep -qE "\.${RAD_ANCHOR_EXT}\$" \
               && { resolve_anchor_path "$path" \
                    || printf '%s\n' "$RAD_ANCHOR_RESOLVE_FAILED"; } ;;
      esac
    done | sort -u) || true
  # Fail closed on a git read failure inside the loop: the sentinel is the only
  # channel a subshell failure has, so treat its presence as the read error it is
  # rather than letting a dropped anchor pass as "nothing cited".
  if [[ $'\n'"$result"$'\n' == *$'\n'"$RAD_ANCHOR_RESOLVE_FAILED"$'\n'* ]]; then
    echo "plan_cited_anchors: anchor resolution failed for '$plan_file'" >&2
    return 2
  fi
  [[ -n "$result" ]] && printf '%s\n' "$result"
  return 0
}

# plan_created_paths <plan-file>
# Print the Files-in-Scope table paths declared as CREATE targets — the
# create-exempt set — one per line, de-duplicated. A row is a create target iff
# its Lines column (col 3) is exactly `new file` OR its Change column (col 4)
# begins with the word `New`. Reuses the plan_files_in_scope table-parsing
# approach. Empty output (exit 0) when the plan creates nothing.
plan_created_paths() {
  local plan_file="$1" result
  # `| sort -u` cannot fail on this trusted input; the `|| true` absorbs only the
  # benign pipefail non-zero from grep -v filtering every row out (no rows left).
  result=$(awk '/^## Files in Scope/{found=1; next} /^## /{found=0} found && /^\|/' "$plan_file" \
    | grep -v "^| *File" | grep -v "^|[-| ]*$" \
    | awk -F'|' '{
        path=$2; lines=$3; change=$4;
        gsub(/`/, "", path);
        gsub(/^[ \t]+|[ \t]+$/, "", path);
        gsub(/^[ \t]+|[ \t]+$/, "", lines);
        gsub(/^[ \t]+|[ \t]+$/, "", change);
        if (path=="" || path=="[path]" || path=="File") next;
        if (lines=="new file" || change ~ /^New([^A-Za-z0-9_]|$)/) print path;
      }' \
    | sort -u) || true
  [[ -n "$result" ]] && printf '%s\n' "$result"
  return 0
}

# path_exists_on_ref <path> <ref>
# Existence-only query for <path> on a locally-known git <ref>. NO implicit fetch
# — the caller owns ref freshness. A trailing `:NNN` anchor suffix is stripped
# (strip_task_file_lines semantics) before the query, so a cited anchor may be
# passed through directly. Return codes (callers rely on the distinction to fail
# closed on an unresolvable ref rather than mistaking it for absence):
#   0  <path> is present on <ref>
#   1  <path> is absent on <ref> (ref resolves, blob/tree missing)
#   2  <ref> is unresolvable in the local repo (cannot conclude presence/absence)
path_exists_on_ref() {
  local path ref
  path=$(strip_task_file_lines "$1")
  ref="$2"
  git rev-parse --verify --quiet "${ref}^{commit}" >/dev/null 2>&1 || return 2
  git cat-file -e "${ref}:${path}" >/dev/null 2>&1 && return 0
  return 1
}
