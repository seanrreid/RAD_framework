#!/usr/bin/env bash
# check-disposition.sh
# Intake early exit (#94): reads a /rad-research artifact's optional
# `Disposition:` / `Disposition-Evidence:` headers and decides whether
# /rad-plan or /rad-adopt should proceed.
#
# FAIL-OPEN toward actionable: an absent, empty, unknown, or UNCITED
# disposition is treated as `actionable` (with a stderr warning for the latter
# two). A cited non-actionable disposition refuses (exit 1), but a refusal is
# NEVER a lock — `--override "<reason>"` always proceeds.
#
# Only the HEADER BLOCK is read — the lines before the first `## ` heading
# (CR stripped) — so a `Disposition:` line in the body can never change the
# outcome. Mirrors plan_tier in lib/plan-paths.sh.
#
# Dispositions: actionable | not-actionable | insufficient-context | superseded
#
# Usage: scripts/check-disposition.sh <research-artifact> [--override "<reason>"]
#
# Exit codes:
#   0 = proceed. stdout: `actionable`, or
#       `overridden: <d> (<evidence>) — <reason>` when an override was applied
#   1 = cited non-actionable disposition, no override. stdout:
#       `<d>: <evidence>` then the override hint
#   2 = usage error, missing/unreadable artifact, or empty override reason

set -euo pipefail

readonly EXIT_OK=0
readonly EXIT_REFUSED=1
readonly EXIT_ERROR=2
readonly SELF="check-disposition"
readonly ACTIONABLE="actionable"

usage() {
  echo "usage: $SELF <research-artifact> [--override \"<reason>\"]" >&2
  exit "$EXIT_ERROR"
}

die() {
  echo "$SELF: $1" >&2
  exit "$EXIT_ERROR"
}

# header_value <file> <key> — trimmed value of the first `<key>:` line in the
# header block (before the first `## `), CR stripped; empty when absent.
header_value() {
  awk -v key="$2:" '
    { sub(/\r$/, "") }
    /^## / { exit }
    index($0, key) == 1 {
      v = substr($0, length(key) + 1); gsub(/^[ \t]+|[ \t]+$/, "", v); print v; exit
    }
  ' "$1"
}

is_known_disposition() {
  case "$1" in
    actionable|not-actionable|insufficient-context|superseded) return 0 ;;
    *) return 1 ;;
  esac
}

ARTIFACT=""
OVERRIDE_SET=0
OVERRIDE_REASON=""

parse_args() {
  [[ $# -ge 1 ]] || usage
  case "$1" in
    -*) echo "$SELF: unknown flag '$1'" >&2; usage ;;
  esac
  ARTIFACT="$1"; shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --override)
        [[ $# -ge 2 ]] || die "--override requires a non-empty reason"
        [[ "$OVERRIDE_SET" -eq 0 ]] || die "--override given more than once"
        OVERRIDE_SET=1; OVERRIDE_REASON="$2"; shift 2
        [[ -n "${OVERRIDE_REASON//[[:space:]]/}" ]] || die "--override requires a non-empty reason"
        ;;
      -*) echo "$SELF: unknown flag '$1'" >&2; usage ;;
      *)  echo "$SELF: unexpected argument '$1'" >&2; usage ;;
    esac
  done
}

main() {
  parse_args "$@"
  [[ -f "$ARTIFACT" && -r "$ARTIFACT" ]] || die "research artifact missing or unreadable: $ARTIFACT"

  local raw d e
  raw=$(header_value "$ARTIFACT" "Disposition") || die "failed to read header block: $ARTIFACT"
  e=$(header_value "$ARTIFACT" "Disposition-Evidence") || die "failed to read header block: $ARTIFACT"
  d=$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')

  if [[ -z "$d" || "$d" == "$ACTIONABLE" ]]; then
    echo "$ACTIONABLE"; exit "$EXIT_OK"
  fi
  if ! is_known_disposition "$d"; then
    echo "warning: unknown disposition '$d' — treated as actionable" >&2
    echo "$ACTIONABLE"; exit "$EXIT_OK"
  fi
  if [[ -z "$e" ]]; then
    echo "warning: uncited $d — treated as actionable" >&2
    echo "$ACTIONABLE"; exit "$EXIT_OK"
  fi
  if [[ "$OVERRIDE_SET" -eq 1 ]]; then
    echo "overridden: $d ($e) — $OVERRIDE_REASON"; exit "$EXIT_OK"
  fi
  echo "$d: $e"
  echo "to proceed anyway: re-run with --override-disposition \"<reason>\""
  exit "$EXIT_REFUSED"
}

main "$@"
