#!/usr/bin/env bash
# lib/plan-paths.sh
# Shared helpers for extracting the declared-scope path set from a RAD plan and
# matching paths against a |-separated extended-regex pattern. ONE source of
# truth, sourced by scripts/lint-plan.sh.
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

# A comma-separated part that is only a line range (`80-96` or `42`) continues
# the previous part's path (`events.js:16-33, 80-96`) — it is never a path.
readonly RAD_RANGE_ONLY_PART_RE='^[0-9]+(-[0-9]+)?$'

# split_task_file_value <value>
# Split one task File: value on commas and print each path, one per line: each
# part is trimmed, backtick-stripped, and has its :lines suffix removed via
# strip_task_file_lines. Only empty, `[path]`, and range-only parts are dropped —
# a prose part is kept as-is so the classifier still sees it (fail closed toward
# not-low). A comma-free value yields exactly strip_task_file_lines' output. Safe
# because no tracked repo path contains a comma.
split_task_file_value() {
  local part
  printf '%s\n' "$1" | tr ',' '\n' | while IFS= read -r part; do
    part=$(printf '%s' "$part" | tr -d '`' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    part=$(strip_task_file_lines "$part")
    [[ -z "$part" || "$part" == "[path]" ]] && continue
    [[ "$part" =~ $RAD_RANGE_ONLY_PART_RE ]] && continue
    printf '%s\n' "$part"
  done
}

# plan_files_in_scope <plan-file>
# Print the Files-in-Scope table paths (column 2), one per line, skipping the
# header, separator, and placeholder rows. Whitespace and backticks stripped.
# A table with no data rows prints nothing and returns 0; a missing/unreadable
# plan returns non-zero with a stderr message.
plan_files_in_scope() {
  local plan_file="$1"
  require_readable_plan plan_files_in_scope "$plan_file" || return
  # grep exits 1 when it selects no lines — an empty table, not an error — so
  # only exit 1 is accepted; a real grep error (exit >=2) still fails the pipeline.
  awk '/^## Files in Scope/{found=1; next} /^## /{found=0} found && /^\|/' "$plan_file" \
    | { grep -v "^| *File" || [ $? -eq 1 ]; } \
    | { grep -v "^|[-| ]*$" || [ $? -eq 1 ]; } \
    | awk -F'|' '{print $2}' \
    | while IFS= read -r path; do
        path=$(echo "$path" | tr -d '`' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
        [[ -z "$path" || "$path" == "[path]" || "$path" == "File" ]] && continue
        echo "$path"
      done
}

# plan_task_files <plan-file>
# Print every per-task `File:` path, one per line. A File: line may list several
# comma-separated paths; split_task_file_value emits each (suffixes stripped,
# empty / placeholder / range-only parts dropped).
plan_task_files() {
  local plan_file="$1"
  local line
  while IFS= read -r line; do
    [[ "$line" == File:* ]] || continue
    split_task_file_value "${line#File:}"
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
readonly RAD_SELF_PROTECTED_PATTERN='^harness/|^scripts/|^\.claude/|^\.agents/state/|(^|/)gates\.ya?ml$|(^|/)matrix\.ya?ml$|^\.rad/'

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
      # Leading `(` on every pattern: bash 3.2 mis-parses a bare `pat)` inside
      # `$( ... )` as closing the substitution (syntax error at source time).
      case "$token" in
        (*//*) continue ;;                                  # drop URL host:port
      esac
      path=$(strip_task_file_lines "$token")
      case "$path" in
        (*/*) echo "$path" ;;                               # has a directory sep
        (*.*) echo "$path" | grep -qE "\.${RAD_ANCHOR_EXT}\$" \
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

# ── Approval blockers ────────────────────────────────────────────────────────
# Parsing for the approval-blocker check (scripts/check-approval-blockers.sh).
# ONE source of truth: markers, high-risk findings, and waivers are parsed ONLY
# here. Each helper fails closed (non-zero + stderr) on a missing/unreadable plan
# so a caller can never mistake "could not read" for "nothing found".

# Built-in high-risk pattern, used when RAD_HIGH_RISK_PATTERNS is unset OR empty.
# The ONLY copy: scripts/lint-plan.sh reads it through plan_high_risk_pattern.
# Matches whole path segments, not substrings: a stem must start at the path start
# or after a / _ . - separator, may carry an optional plural or auth suffix
# (authn/authz/authentication/authorize…), and must be followed by a separator,
# a capital or digit (camelCase/numbered: authService, auth2), or the path end.
# Substring matching (#143) flagged authority/authors/tokenizer as high-risk.
# Must stay BSD grep -E (ERE) compatible — path_matches evaluates it.
readonly RAD_HIGH_RISK_DEFAULT_PATTERN='(^|[/_.-])(o?auth(n|z|entication|enticate|orization|orize)?|payments?|billing|migrations?|secrets?|credentials?|tokens?)([/_.-]|[A-Z0-9]|$)'

# Prefix of every high-risk finding id; the rest of the id is the scope path.
readonly RAD_HIGH_RISK_FINDING_PREFIX='high-risk:'

# A line beginning with three backticks toggles a ``` fenced code block. Shared
# (passed to awk as -v fence_re) by plan_clarification_markers and
# plan_waivers_section so both skip fenced examples by the SAME rule — a fenced
# example must never count as a marker, a section heading, or a waiver.
readonly RAD_FENCE_LINE_RE='^```'

# require_readable_plan <caller> <plan-file>
# Return 0 iff <plan-file> is a readable regular file; else name the caller and
# the plan on stderr and return 2.
require_readable_plan() {
  local caller="$1" plan_file="$2"
  if [[ -z "$plan_file" || ! -f "$plan_file" || ! -r "$plan_file" ]]; then
    echo "$caller: plan file missing or unreadable: '$plan_file'" >&2
    return 2
  fi
}

# plan_clarification_markers <plan-file>
# Print `<line>\t<question>` for every `[NEEDS CLARIFICATION: <question>]` marker
# that is NOT code. Two kinds of code are skipped:
#   - ``` fenced blocks: a line beginning with three backticks toggles the fence.
#   - inline spans on a non-fenced line (CommonMark rule): a run of N backticks
#     opens a span closed by the next run of EXACTLY N backticks; the text
#     between is code. So `x`, ``x`` and ```` ``` ```` are all spans. A run with
#     no equal-length closer is literal: the rest of the line is NOT code, so a
#     marker after an unpaired backtick still counts (fail toward reporting). A
#     marker whose opening `[NEEDS CLARIFICATION:` lies inside a span is skipped.
# Several markers on one line are each reported; the question is trimmed and may
# be empty (an empty question still counts). An unterminated marker (no closing
# `]`) counts too, with the rest of the line as its question — a marker is never
# silently dropped. No markers → no output, exit 0.
plan_clarification_markers() {
  local plan_file="$1"
  require_readable_plan plan_clarification_markers "$plan_file" || return
  awk -v fence_re="$RAD_FENCE_LINE_RE" '
    function trim(s) { gsub(/^[ \t]+|[ \t\r]+$/, "", s); return s }
    function run_at(s, p,   n) {
      for (n = 0; substr(s, p + n, 1) == "`"; n++) ;
      return n
    }
    # Offset of the next run of exactly n backticks at or after q, else 0.
    function closer(s, q, n,   m) {
      while (q <= length(s)) {
        if (substr(s, q, 1) != "`") { q++; continue }
        m = run_at(s, q)
        if (m == n) return q
        q += m
      }
      return 0
    }
    # Replace each inline code span with one space; unmatched runs stay literal.
    function strip_spans(s,   out, p, n, q) {
      out = ""; p = 1
      while (p <= length(s)) {
        if (substr(s, p, 1) != "`") { out = out substr(s, p, 1); p++; continue }
        n = run_at(s, p); q = closer(s, p + n, n)
        if (q > 0) { out = out " "; p = q + n }
        else { out = out substr(s, p, n); p += n }
      }
      return out
    }
    $0 ~ fence_re { fenced = !fenced; next }
    fenced { next }
    {
      rest = strip_spans($0); open = "[NEEDS CLARIFICATION:"
      while ((i = index(rest, open)) > 0) {
        rest = substr(rest, i + length(open))
        j = index(rest, "]")
        q = (j > 0) ? substr(rest, 1, j - 1) : rest
        print NR "\t" trim(q)
        if (j == 0) break
        rest = substr(rest, j + 1)
      }
    }
  ' "$plan_file"
}

# plan_high_risk_pattern
# Print the effective high-risk pattern: RAD_HIGH_RISK_PATTERNS when set and
# non-empty, else the built-in default. The check can be NARROWED but never
# disabled — `${var:-default}` treats empty as unset, matching lint-plan.sh.
plan_high_risk_pattern() {
  printf '%s' "${RAD_HIGH_RISK_PATTERNS:-$RAD_HIGH_RISK_DEFAULT_PATTERN}"
}

# plan_high_risk_pattern_is_default
# Exit 0 iff the effective pattern (plan_high_risk_pattern) is exactly the
# built-in default — RAD_HIGH_RISK_PATTERNS unset, empty, or set to the default
# string verbatim; else exit 1. Compares the EFFECTIVE pattern, never the raw env,
# so the empty-falls-back rule has one definition.
plan_high_risk_pattern_is_default() {
  [[ "$(plan_high_risk_pattern)" == "$RAD_HIGH_RISK_DEFAULT_PATTERN" ]]
}

# plan_high_risk_findings <plan-file>
# Print `high-risk:<path>` for every plan_scope_paths entry matching the
# effective high-risk pattern (path_matches — the same matcher and path union as
# the lint advisory), de-duplicated. No matching path → no output, exit 0.
plan_high_risk_findings() {
  local plan_file="$1" pattern paths path
  require_readable_plan plan_high_risk_findings "$plan_file" || return
  pattern=$(plan_high_risk_pattern)
  # Readability was checked above, so plan_scope_paths' only non-zero is the
  # benign pipefail from its `grep -v` filters when the plan declares no paths —
  # an empty path set, not an error.
  paths=$(plan_scope_paths "$plan_file") || true
  [[ -z "$paths" ]] && return 0
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    if path_matches "$path" "$pattern"; then
      printf '%s%s\n' "$RAD_HIGH_RISK_FINDING_PREFIX" "$path"
    fi
  done <<< "$paths" | sort -u
}

# plan_waivers_section <plan-file>
# Print the raw, fence-free body of the `## Waivers` section: every line after the
# heading up to the next `## ` heading, with ``` fenced blocks (fence lines and
# their content) removed. Fence-aware in both directions: a `## Waivers` heading
# inside a fence is NOT a section start, and a `## ` heading inside a fence does
# NOT end the real section. The ONE reader of the section — plan_waivers and
# lint-plan.sh's empty-justification warning both consume it. No section → no
# output, exit 0; unreadable plan → exit 2.
plan_waivers_section() {
  local plan_file="$1"
  require_readable_plan plan_waivers_section "$plan_file" || return
  awk -v fence_re="$RAD_FENCE_LINE_RE" '
    $0 ~ fence_re { fenced = !fenced; next }
    fenced { next }
    /^## / { in_waivers = ($0 ~ /^## Waivers[ \t\r]*$/); next }
    in_waivers { print }
  ' "$plan_file"
}

# plan_waivers <plan-file>
# Print `<id>\t<justification>` for every `- <id>: <justification>` bullet in the
# fence-free `## Waivers` body (plan_waivers_section). Split on the FIRST ": " so
# a justification may itself contain ": ". id and justification are trimmed; a
# bullet with an empty id or empty justification is dropped (an unjustified
# waiver is no waiver). No section → no output, exit 0.
plan_waivers() {
  local plan_file="$1" body
  body=$(plan_waivers_section "$plan_file") || return
  [[ -z "$body" ]] && return 0
  printf '%s\n' "$body" | awk '
    function trim(s) { gsub(/^[ \t]+|[ \t\r]+$/, "", s); return s }
    !/^[ \t]*- / { next }
    {
      body = $0; sub(/^[ \t]*- /, "", body)
      k = index(body, ": ")
      if (k == 0) next
      id = trim(substr(body, 1, k - 1)); why = trim(substr(body, k + 2))
      if (id != "" && why != "") print id "\t" why
    }
  '
}

# ── Wave shape, layers, mockups ──────────────────────────────────────────────
# Parsing for the advisory stack-ordered-wave and missing-mockup lints
# (scripts/lint-plan.sh). Advisory only: a wrong answer here can at worst emit a
# spurious warning, so the layer patterns classify only on confident path
# signals and otherwise say `unknown`.

# A `### Wave N` heading; group 1 is the wave number N.
readonly RAD_WAVE_HEADING_RE='^### Wave ([0-9]+)'

# Layer patterns (extended regex, matched via path_matches). Checked in the
# fixed precedence of path_layer; built in, not operator-tunable.
readonly RAD_LAYER_TEST_RE='(^|/)(tests?|__tests__|spec)/|\.(test|spec)\.'
readonly RAD_LAYER_SCHEMA_RE='(^|/)(migrations?|schema|db)/|\.sql$|\.prisma$'
readonly RAD_LAYER_API_RE='(^|/)(api|routes?|controllers?|handlers?|graphql)/|\.graphql$|openapi\.(ya?ml|json)$'
readonly RAD_LAYER_UI_RE='\.(tsx|jsx|vue|svelte|css|scss|sass|html?)$|(^|/)(components?|pages|views|ui|frontend|styles)/'
readonly RAD_LAYER_SERVICE_RE='(^|/)(services?|domain|models?|server|backend)/'

# A mockup reference: .agents/mockups/<name>.html or .htm.
readonly RAD_MOCKUP_REF_RE='\.agents/mockups/[A-Za-z0-9._-]+\.html?'

# plan_wave_task_files <plan-file>
# Print `<wave>\t<path>` for every task `File:` path under its enclosing
# `### Wave N` heading, split exactly as plan_task_files does (via
# split_task_file_value). A File: line is attributed only while inside a numbered
# wave: lines before the first wave, after a `### Wave` heading with no number,
# or after any `## ` heading (the Wave Plan section ended) are ignored — an
# unattributable path must never be guessed into a wave. No waves → no output,
# exit 0; unreadable plan → exit 2.
plan_wave_task_files() {
  local plan_file="$1" line wave="" path
  require_readable_plan plan_wave_task_files "$plan_file" || return
  while IFS= read -r line; do
    if [[ "$line" =~ $RAD_WAVE_HEADING_RE ]]; then
      wave="${BASH_REMATCH[1]}"
      continue
    fi
    if [[ "$line" == "### Wave"* || "$line" == "## "* ]]; then
      wave=""
      continue
    fi
    [[ -n "$wave" && "$line" == File:* ]] || continue
    split_task_file_value "${line#File:}" | while IFS= read -r path; do
      printf '%s\t%s\n' "$wave" "$path"
    done
  done < "$plan_file"
}

# path_layer <path>
# Print exactly one word — test | schema | api | ui | service | unknown — the
# first layer pattern <path> matches, in that fixed precedence (a test file is a
# test wherever it lives; an api dir beats a .tsx extension). No match, including
# RAD's own harness/scripts/docs paths, is `unknown`.
path_layer() {
  local path="$1"
  if path_matches "$path" "$RAD_LAYER_TEST_RE"; then echo test
  elif path_matches "$path" "$RAD_LAYER_SCHEMA_RE"; then echo schema
  elif path_matches "$path" "$RAD_LAYER_API_RE"; then echo api
  elif path_matches "$path" "$RAD_LAYER_UI_RE"; then echo ui
  elif path_matches "$path" "$RAD_LAYER_SERVICE_RE"; then echo service
  else echo unknown
  fi
}

# plan_mockup_refs <plan-file>
# Print each distinct `.agents/mockups/<name>.html|.htm` reference in the plan,
# one per line, de-duplicated in FIRST-SEEN order. Lines inside ``` fences
# (RAD_FENCE_LINE_RE) are skipped; inline backtick spans are NOT — a reference is
# normally written backticked, so it must still count. No refs → no output,
# exit 0; unreadable plan → exit 2; a grep read failure → its exit code.
plan_mockup_refs() {
  local plan_file="$1" body refs status
  require_readable_plan plan_mockup_refs "$plan_file" || return
  body=$(awk -v fence_re="$RAD_FENCE_LINE_RE" '
    $0 ~ fence_re { fenced = !fenced; next }
    !fenced { print }
  ' "$plan_file") || return
  [[ -z "$body" ]] && return 0
  # grep exit: 0 = refs found, 1 = none (a valid empty result), >1 = real error.
  if refs=$(printf '%s\n' "$body" | grep -oE "$RAD_MOCKUP_REF_RE"); then
    status=0
  else
    status=$?
  fi
  if [[ "$status" -gt 1 ]]; then
    echo "plan_mockup_refs: cannot scan '$plan_file' (grep exit $status)" >&2
    return "$status"
  fi
  [[ -z "$refs" ]] && return 0
  printf '%s\n' "$refs" | awk '!seen[$0]++'
}

# ── Planning tier ────────────────────────────────────────────────────────────
# Parsing for the light planning tier (`Tier: light` in the plan header). A light
# plan is bounded; any bound it exceeds is a NON-WAIVABLE approval blocker
# (scripts/check-approval-blockers.sh). No `Tier:` header ⇒ `standard` ⇒ no
# light-tier output, so standard plans behave exactly as before.

# Light-tier bounds. Built in, not operator-tunable: a plan must not loosen the
# limits that classify it.
readonly RAD_LIGHT_MAX_WAVES=1
readonly RAD_LIGHT_MAX_TASKS=3

# Prefix of every light-tier violation line. Never a waiver id: the blocker
# script counts these without consulting ## Waivers.
readonly RAD_LIGHT_BLOCKER_PREFIX='light-tier'

# plan_tier <plan-file>
# Print the plan's tier from the first `Tier:` line in the HEADER BLOCK only —
# the lines before the first `## ` heading — so a `Tier:` line in the body (e.g.
# a fenced example) can never change the tier. `light` / `standard` are matched
# trimmed and case-insensitively and printed lower-case; absent ⇒ `standard`;
# any other value is printed trimmed but otherwise verbatim for the caller to
# reject. Unreadable plan ⇒ exit 2.
plan_tier() {
  local plan_file="$1" raw normalized
  require_readable_plan plan_tier "$plan_file" || return
  raw=$(awk '
    /^## / { exit }
    /^Tier:/ { v = substr($0, 6); gsub(/^[ \t]+|[ \t\r]+$/, "", v); print v; found = 1; exit }
    END { if (!found) print "standard" }
  ' "$plan_file") || return
  normalized=$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')
  case "$normalized" in
    light|standard) printf '%s\n' "$normalized" ;;
    *)              printf '%s\n' "$raw" ;;
  esac
}

# plan_light_violations <plan-file>
# Print one `light-tier: <reason>` line per bound a light plan exceeds: more than
# RAD_LIGHT_MAX_WAVES `### Wave` headings, more than RAD_LIGHT_MAX_TASKS
# `#### Task` headings, and — for each plan_scope_paths entry — a high-risk
# match (plan_high_risk_pattern) and/or a self-protected match (both lines when
# both apply). Non-light tier or within bounds ⇒ no output, exit 0. Unreadable
# plan or a failing helper ⇒ non-zero + stderr, never "no violations".
plan_light_violations() {
  local plan_file="$1" tier counts waves tasks pattern paths path
  require_readable_plan plan_light_violations "$plan_file" || return
  tier=$(plan_tier "$plan_file") || return
  [[ "$tier" == "light" ]] || return 0
  counts=$(awk '/^### Wave/ { w++ } /^#### Task/ { t++ } END { print w + 0, t + 0 }' \
    "$plan_file") || return
  read -r waves tasks <<< "$counts"
  if [[ "$waves" -gt "$RAD_LIGHT_MAX_WAVES" ]]; then
    printf '%s: %s waves (max %s)\n' "$RAD_LIGHT_BLOCKER_PREFIX" "$waves" "$RAD_LIGHT_MAX_WAVES"
  fi
  if [[ "$tasks" -gt "$RAD_LIGHT_MAX_TASKS" ]]; then
    printf '%s: %s tasks (max %s)\n' "$RAD_LIGHT_BLOCKER_PREFIX" "$tasks" "$RAD_LIGHT_MAX_TASKS"
  fi
  pattern=$(plan_high_risk_pattern)
  # Readability was checked above, so plan_scope_paths' only non-zero is the
  # benign pipefail from its `grep -v` filters when the plan declares no paths —
  # an empty path set, not an error (same contract as plan_high_risk_findings).
  paths=$(plan_scope_paths "$plan_file") || true
  [[ -z "$paths" ]] && return 0
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    if path_matches "$path" "$pattern"; then
      printf '%s: high-risk path %s\n' "$RAD_LIGHT_BLOCKER_PREFIX" "$path"
    fi
    if path_is_self_protected "$path"; then
      printf '%s: self-protected path %s\n' "$RAD_LIGHT_BLOCKER_PREFIX" "$path"
    fi
  done <<< "$paths"
}
