#!/usr/bin/env bash
# lint-shell-safety.sh
# Shell-safety lint over the RAD scripts: flags UNGUARDED untrusted input
# flowing into command lines that interpret their arguments (git / jq /
# node -e / eval). READ-ONLY — reports, never rewrites.
#
# Heuristic (grep-based, NOT an AST — tuned for near-zero false positives):
#   A variable is TAINTED when its assignment's right-hand side STARTS with a
#   positional parameter ($1..$9, $@, $*) or a RAD_* environment expansion,
#   e.g.:  BRANCH="${1:-}"   local branch="$1"   PREFIX="${RAD_BRANCH_PREFIX:-rad/}"
#   A tainted variable VIOLATES when it is interpolated ("$VAR" or $VAR)
#   directly into a git / jq / node -e / eval command line, AND no guard on
#   that variable appears EARLIER in the same file. A guard is:
#     - a regex validation:   [[ "$VAR" =~ ... ]]   (negated form included)
#     - a case pattern match: case "$VAR" in ...
#   Mere -z / -n / -f existence checks do NOT count as guards.
#
# Known limits (documented, accepted):
#   - No taint propagation: DERIVED="$TAINTED" is not tracked.
#   - Only RHS-leading taint sources: VAR=$(cmd "$1") is not tracked.
#   - Only RAD_* env vars are treated as env taint sources; other env vars
#     are indistinguishable from local variables by grep.
#   - Guard/use ordering is by line number, not control flow.
#   - Lines whose command is echo/printf are treated as messages, not sinks
#     (prose like "git branch tips" is not an invocation) — unless the line
#     pipes into a sink command.
#
# Scan target: <scripts-dir>/*.sh, EXCLUDING test-*.sh fixtures (scripts/lib/
# is never entered — the glob does not recurse).
#
# Baseline ratchet: <baseline-file> lists filenames (one per line, '#'
# comments allowed, including a trailing per-entry comment after the name).
#   - violation in a baselined file      → "⚠ baseline: <file>: <reason>", no fail
#   - violation in a non-baselined file  → "✗ <file>: <reason>", exit 1
#   - baseline entry with NO violations  → "⚠ stale baseline: <file>", still exit 0
# A missing baseline file is treated as an empty baseline.
#
# Usage: scripts/lint-shell-safety.sh [scripts-dir] [baseline-file]
#   defaults: scripts  scripts/lint-shell-safety-baseline.txt
#
# Exit codes:
#   0 = clean (possibly with baseline / stale-baseline warnings)
#   1 = one or more violations in non-baselined files
#   2 = usage error (too many args, or scripts dir not found)

set -euo pipefail

if [[ $# -gt 2 ]]; then
  echo "usage: lint-shell-safety.sh [scripts-dir] [baseline-file]" >&2
  exit 2
fi

SCRIPTS_DIR="${1:-scripts}"
BASELINE_FILE="${2:-scripts/lint-shell-safety-baseline.txt}"

[[ -d "$SCRIPTS_DIR" ]] || { echo "ERROR: scripts dir not found at: $SCRIPTS_DIR"; exit 2; }

VIOLATIONS=0

# Tainted assignment: optional local/readonly/export, then NAME= whose RHS
# starts with $1..$9 / $@ / $* / ${RAD_...} (optionally brace/quote-wrapped).
ASSIGN_RE='^[[:space:]]*(local[[:space:]]+|readonly[[:space:]]+|export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=["'"'"']?\$\{?([1-9]([^0-9]|$)|@|\*|RAD_[A-Z_])'

# Sink command line: git / jq at a word boundary followed by whitespace,
# node ... -e, or eval. (Boundary class keeps e.g. "digit" and "git/jq" in
# prose from matching.)
SINK_RE='(^|[[:space:]]|[|&;(`])((git|jq)[[:space:]]|node[[:space:]]+-e([[:space:]]|$)|eval[[:space:]])'

# Baseline entries: strip comments (full-line and trailing) and whitespace.
BASELINE_ENTRIES=""
if [[ -f "$BASELINE_FILE" ]]; then
  BASELINE_ENTRIES=$(sed 's/#.*//' "$BASELINE_FILE" \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' || true)
fi

in_baseline() {
  [[ -n "$BASELINE_ENTRIES" ]] && printf '%s\n' "$BASELINE_ENTRIES" | grep -qx "$1"
}

FLAGGED_FILES=""   # newline-separated basenames that had >=1 violation

# scan_file <file> — print one "line<TAB>reason" per violating tainted var.
scan_file() {
  local f="$1" assigns vars v guard_pat gline use_pat uses lnum rest
  assigns=$(grep -nE "$ASSIGN_RE" "$f" || true)
  [[ -z "$assigns" ]] && return 0
  vars=$(printf '%s\n' "$assigns" \
    | sed -E 's/^[0-9]+:[[:space:]]*(local[[:space:]]+|readonly[[:space:]]+|export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/' \
    | sort -u)
  while IFS= read -r v; do
    [[ -z "$v" ]] && continue
    # Earliest guard on this variable: [[ "$v" =~ ... ]] or case "$v" in.
    guard_pat='\[\[[[:space:]]+(![[:space:]]+)?"?\$\{?'"$v"'\}?"?[[:space:]]+=~|(^|[[:space:]])case[[:space:]]+"?\$\{?'"$v"'\}?"?[[:space:]]+in'
    gline=$( { grep -nE "$guard_pat" "$f" || true; } | head -1 | cut -d: -f1)
    # Sink lines interpolating this variable (comments excluded).
    use_pat='\$\{?'"$v"'([^A-Za-z0-9_]|$)'
    uses=$(grep -nE "$SINK_RE" "$f" | grep -Ev '^[0-9]+:[[:space:]]*#' \
      | grep -E "$use_pat" \
      | awk -F: '$2 !~ /^[[:space:]]*(echo|printf)[[:space:]]/ || $0 ~ /\|[[:space:]]*(git|jq|node|eval)[[:space:]]/' \
      || true)
    [[ -z "$uses" ]] && continue
    while IFS=: read -r lnum rest; do
      [[ -z "$lnum" ]] && continue
      if [[ -z "$gline" || "$gline" -ge "$lnum" ]]; then
        printf '%s\t%s\n' "$lnum" \
          "unguarded \$$v (positional/env input) interpolated into a git/jq/node -e/eval command at line $lnum — add a [[ \"\$$v\" =~ ... ]] or case guard before use"
        break   # one report per variable is enough
      fi
    done <<< "$uses"
  done <<< "$vars"
}

for f in "$SCRIPTS_DIR"/*.sh; do
  [[ -e "$f" ]] || continue
  base=$(basename "$f")
  case "$base" in test-*.sh) continue ;; esac

  reports=$(scan_file "$f")
  [[ -z "$reports" ]] && continue

  FLAGGED_FILES="${FLAGGED_FILES}${base}
"
  while IFS=$'\t' read -r lnum reason; do
    [[ -z "$reason" ]] && continue
    if in_baseline "$base"; then
      echo "⚠ baseline: $base: $reason"
    else
      echo "✗ $base: $reason"
      VIOLATIONS=1
    fi
  done <<< "$reports"
done

# Stale-baseline pass: entries whose file no longer has any violation.
if [[ -n "$BASELINE_ENTRIES" ]]; then
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    if ! printf '%s\n' "$FLAGGED_FILES" | grep -qx "$entry"; then
      echo "⚠ stale baseline: $entry"
    fi
  done <<< "$BASELINE_ENTRIES"
fi

if [[ "$VIOLATIONS" -ne 0 ]]; then
  exit 1
fi

echo "PASS: no unguarded positional/env input flows into git/jq/node -e/eval outside the baseline"
exit 0
