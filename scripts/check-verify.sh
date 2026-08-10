#!/usr/bin/env bash
# check-verify.sh
# EXECUTES a plan-declared verification command and passes its real exit code
# back to the deliver spine. This is the execution counterpart to
# check-tests-present.sh: that script only asks whether a promised test FILE
# exists on disk; this one runs a command and reads what actually happened.
# The two are deliberately separate checks (issue #91) — neither replaces the
# other.
#
# Usage: scripts/check-verify.sh <command>
#
#   <command>  the shell command declared by a plan's per-wave `Verify:` line.
#              The deliver spine passes it as the single positional argument via
#              the injected `sh` port, whose shape is unchanged.
#
# Exit codes:
#   0    = the command succeeded; its output is DISCARDED (nothing on stdout)
#   124  = the command exceeded the timeout and was killed (RESERVED — reported
#          distinctly from ordinary failure so the spine can map it to
#          fail-timeout rather than fail-tests; a retry cannot fix a hang)
#   2    = usage error (wrong argument count, empty command, bad config)
#   *    = the command's OWN non-zero exit code, with a BOUNDED excerpt of its
#          combined stdout/stderr printed on stdout
#
# Trust boundary: <command> is arbitrary shell out of a HUMAN-APPROVED plan doc.
# Approval is the boundary and it is unchanged by this script. What this script
# adds is containment of the execution:
#
#   - the command runs under an ALLOW-LISTED env subset (`env -i` + the same
#     variables the wave adapters allow), so no credential in the parent
#     environment reaches it;
#   - it runs under a hard timeout, so a wedged process cannot hang deliver;
#   - its output is truncated to a bounded excerpt, so a failing suite cannot
#     flood the retry prompt (the context flood this feature exists to prevent).
#
# Working directory: this script never changes directory. It executes the
# command in the cwd it inherits from the spine's `sh` port, which is the
# worktree checkout when RAD_WORKTREE isolation is active and the main checkout
# otherwise. Verification therefore always runs against the tree under test.

set -euo pipefail

# ── Named constants ───────────────────────────────────────────────────────────

# Wall-clock ceiling for the declared command. Overridable via
# RAD_VERIFY_TIMEOUT_SECONDS (positive integer); a malformed override is a hard
# usage error, never a silent fall back to the default.
readonly VERIFY_TIMEOUT_SECONDS_DEFAULT=600
# Poll interval of the watchdog. Bounds how long an orphaned `sleep` can outlive
# this script, and how precisely the timeout fires.
readonly VERIFY_POLL_SECONDS=1
# Grace period between SIGTERM and SIGKILL for a timed-out command.
readonly VERIFY_KILL_GRACE_SECONDS=5
# Exit code reserved for "killed by the timeout". Matches the GNU timeout(1)
# convention. A command that exits 124 on its own is reported as a timeout.
readonly VERIFY_TIMEOUT_STATUS=124
# Exit code for a usage/config error.
readonly VERIFY_USAGE_STATUS=2
# Output caps for the failure excerpt. Both bite: lines first, then bytes (so a
# single enormous line cannot slip past a lines-only cap).
readonly VERIFY_OUTPUT_MAX_LINES=40
readonly VERIFY_OUTPUT_MAX_BYTES=8000
# The env subset handed to the executed command. Mirrors ENV_ALLOW_LIST in
# harness/adapters/agent/command.js — one treatment for every spawn boundary.
readonly VERIFY_ENV_ALLOW_LIST=(PATH HOME LANG LC_ALL TMPDIR TERM)

# ── Argument + config validation (fail-closed) ────────────────────────────────

usage_error() {
  echo "ERROR: $1" >&2
  echo "Usage: scripts/check-verify.sh <command>" >&2
  exit "$VERIFY_USAGE_STATUS"
}

[[ "$#" -eq 1 ]] || usage_error "exactly one argument (the command) is required, got $#"
COMMAND="$1"
[[ -n "${COMMAND// /}" ]] || usage_error "the command must not be empty"

TIMEOUT_SECONDS="${RAD_VERIFY_TIMEOUT_SECONDS:-$VERIFY_TIMEOUT_SECONDS_DEFAULT}"
[[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] ||
  usage_error "RAD_VERIFY_TIMEOUT_SECONDS must be a positive integer, got '$TIMEOUT_SECONDS'"

# ── Allow-listed environment ──────────────────────────────────────────────────

# Build the `KEY=value` assignments for the allow-listed variables that are
# actually set. Everything else in this process's environment is dropped by
# `env -i`, so a credential the operator exported never reaches the command.
ENV_ASSIGNMENTS=()
build_allowed_env() {
  local key
  for key in "${VERIFY_ENV_ALLOW_LIST[@]}"; do
    if [[ -n "${!key+set}" ]]; then
      ENV_ASSIGNMENTS+=("$key=${!key}")
    fi
  done
}

# ── Execution under a portable timeout ────────────────────────────────────────

# `timeout(1)` is NOT present by default on macOS, so the kill-after-N mechanism
# is built from a background child plus a polling watchdog: the watchdog exits as
# soon as the child does, and after TIMEOUT_SECONDS it records a marker, sends
# SIGTERM, waits out the grace period, then sends SIGKILL. The marker — not the
# child's wait status — is what distinguishes a timeout from an ordinary failure,
# because a SIGTERMed process and a process that chose to exit 143 look alike.
#
# Sets: COMMAND_STATUS, TIMED_OUT.
run_command_with_timeout() {
  local output_file="$1" timeout_marker="$2" done_marker="$3"
  local child_pid watchdog_pid

  # The `[@]+` guard keeps an EMPTY allow-list from tripping `set -u` on bash 3.2
  # (the macOS default shell), where "${arr[@]}" on an empty array is unbound.
  env -i ${ENV_ASSIGNMENTS[@]+"${ENV_ASSIGNMENTS[@]}"} /bin/sh -c "$COMMAND" \
    >"$output_file" 2>&1 &
  child_pid=$!

  (
    elapsed=0
    while [[ "$elapsed" -lt "$TIMEOUT_SECONDS" ]]; do
      kill -0 "$child_pid" 2>/dev/null || exit 0
      sleep "$VERIFY_POLL_SECONDS"
      elapsed=$((elapsed + VERIFY_POLL_SECONDS))
    done
    if [[ -e "$done_marker" ]]; then exit 0; fi
    : >"$timeout_marker"
    kill -TERM "$child_pid" 2>/dev/null || true
    sleep "$VERIFY_KILL_GRACE_SECONDS"
    kill -KILL "$child_pid" 2>/dev/null || true
  ) &
  watchdog_pid=$!

  COMMAND_STATUS=0
  # 2>/dev/null suppresses only bash's own "Terminated: 15" job notice (emitted by
  # bash 3.2 — the macOS system shell — when it reaps a killed background job).
  # The command's own stderr was already redirected into $output_file above, so
  # nothing diagnostic is discarded here; the timeout is still reported explicitly.
  wait "$child_pid" 2>/dev/null || COMMAND_STATUS=$?
  : >"$done_marker"
  kill -TERM "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true

  TIMED_OUT=0
  if [[ -e "$timeout_marker" ]]; then TIMED_OUT=1; fi
  return 0
}

# ── Bounded failure excerpt ───────────────────────────────────────────────────

# Print at most VERIFY_OUTPUT_MAX_LINES lines / VERIFY_OUTPUT_MAX_BYTES bytes of
# the command's combined output, taken from the TAIL (where runners put the
# failure summary). Truncation is mandatory, not best-effort: an untruncated
# failing suite in the retry prompt reproduces the context flood this check
# exists to prevent. When a cap bites, say so explicitly.
print_bounded_excerpt() {
  local output_file="$1"
  local total_lines total_bytes excerpt
  total_lines=$(wc -l <"$output_file" | tr -d '[:space:]')
  total_bytes=$(wc -c <"$output_file" | tr -d '[:space:]')

  if [[ "$total_lines" -gt "$VERIFY_OUTPUT_MAX_LINES" ]]; then
    echo "  (truncated: last $VERIFY_OUTPUT_MAX_LINES of $total_lines lines)"
  fi
  if [[ "$total_bytes" -gt "$VERIFY_OUTPUT_MAX_BYTES" ]]; then
    echo "  (truncated: output capped at $VERIFY_OUTPUT_MAX_BYTES bytes of $total_bytes)"
  fi

  excerpt=$(tail -n "$VERIFY_OUTPUT_MAX_LINES" "$output_file" | tail -c "$VERIFY_OUTPUT_MAX_BYTES")
  if [[ -n "$excerpt" ]]; then printf '%s\n' "$excerpt"; fi
  return 0
}

# ── Main ──────────────────────────────────────────────────────────────────────

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/rad-verify.XXXXXX")
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

build_allowed_env
run_command_with_timeout "$WORK_DIR/output" "$WORK_DIR/timed-out" "$WORK_DIR/done"

if [[ "$TIMED_OUT" -eq 1 ]]; then
  echo "✗ Verification TIMED OUT after ${TIMEOUT_SECONDS}s: $COMMAND"
  echo "  The command was killed. A retry cannot fix a hang — this is surfaced,"
  echo "  not retried."
  print_bounded_excerpt "$WORK_DIR/output"
  exit "$VERIFY_TIMEOUT_STATUS"
fi

if [[ "$COMMAND_STATUS" -eq 0 ]]; then
  # Passing output is DISCARDED: a green run has nothing the retry prompt needs.
  exit 0
fi

echo "✗ Verification FAILED (exit $COMMAND_STATUS): $COMMAND"
print_bounded_excerpt "$WORK_DIR/output"
exit "$COMMAND_STATUS"
