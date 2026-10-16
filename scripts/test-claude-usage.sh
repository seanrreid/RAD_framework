#!/usr/bin/env bash
# test-claude-usage.sh
# End-to-end tests for claude-usage.mjs against a scripted fake `claude` placed
# first on PATH (the real CLI is never called): usage line first, argument and
# stdin pass-through (large and empty prompts), is_error, non-zero exits with
# JSON and with plain text, non-JSON output, a missing CLI, and a signal death.
# Each scenario asserts stdout, stderr and the exit status. Runs under bash 3.2+.
#
# Usage: scripts/test-claude-usage.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$HERE/claude-usage.mjs"
NODE="$(command -v node)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

readonly BIG_PROMPT_BYTES=1500000
PASSED=0
RC=0

fail() { echo "✗ $1"; exit 1; }
pass() { PASSED=$((PASSED + 1)); echo "✓ $1"; }

# The fake CLI: records its argv and stdin, then prints the scripted stdout and
# stderr files and exits with the scripted status (or kills itself with a signal).
mkdir -p "$TMP/bin" "$TMP/empty"
cat > "$TMP/bin/claude" <<'FAKE'
#!/bin/sh
printf '%s\n' "$@" > "$FAKE_ARGS_OUT"
cat > "$FAKE_STDIN_OUT"
[ -f "$FAKE_STDOUT" ] && cat "$FAKE_STDOUT"
[ -f "$FAKE_STDERR" ] && cat "$FAKE_STDERR" >&2
if [ -n "${FAKE_SIGNAL:-}" ]; then kill -s "$FAKE_SIGNAL" $$; fi
exit "${FAKE_EXIT:-0}"
FAKE
chmod 755 "$TMP/bin/claude"

# scenario <name> — fresh scratch dir with the fake CLI's script files.
scenario() {
  D="$TMP/$1"
  mkdir -p "$D"
  export FAKE_STDOUT="$D/fake.stdout" FAKE_STDERR="$D/fake.stderr"
  export FAKE_ARGS_OUT="$D/args" FAKE_STDIN_OUT="$D/stdin"
  export FAKE_EXIT=0
  unset FAKE_SIGNAL
}

# run_wrapper <stdin-file> [args...] — runs the wrapper with the fake CLI first on PATH.
run_wrapper() {
  local input="$1"; shift
  RC=0
  PATH="$TMP/bin:$PATH" "$NODE" "$WRAPPER" "$@" < "$input" > "$D/out" 2> "$D/err" || RC=$?
}

# run_wrapper_no_cli <stdin-file> — PATH holds no `claude` at all.
run_wrapper_no_cli() {
  RC=0
  PATH="$TMP/empty" "$NODE" "$WRAPPER" < "$1" > "$D/out" 2> "$D/err" || RC=$?
}

expect_rc() { [ "$RC" -eq "$1" ] || fail "$2: exit $RC, expected $1 (stderr: $(head -c 300 "$D/err"))"; }
expect_same() { cmp -s "$1" "$2" || fail "$3: $1 differs from $2"; }

JSON_OK='{"type":"result","subtype":"success","is_error":false,"result":"Hello there.","total_cost_usd":0.5,"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":20,"iterations":[]},"modelUsage":{}}'
EXPECTED_USAGE='RAD_USAGE {"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":20,"total":135,"cost":0.5}'

echo "hello prompt" > "$TMP/prompt.txt"
: > "$TMP/empty.txt"

# ── success: usage line first, text second, exit 0 ────────────────────────
scenario success
printf '%s' "$JSON_OK" > "$FAKE_STDOUT"
run_wrapper "$TMP/prompt.txt"
expect_rc 0 "success"
printf '%s\nHello there.\n' "$EXPECTED_USAGE" > "$D/want"
expect_same "$D/out" "$D/want" "success stdout"
[ ! -s "$D/err" ] || fail "success: stderr should be empty"
pass "success — usage line first, text second, exit 0, no stderr"

# ── arguments: forwarded after -p --output-format json ────────────────────
scenario args
printf '%s' "$JSON_OK" > "$FAKE_STDOUT"
run_wrapper "$TMP/prompt.txt" --model sonnet --allowedTools "Edit Bash"
expect_rc 0 "args"
printf '%s\n' -p --output-format json --permission-mode acceptEdits --model sonnet --allowedTools "Edit Bash" > "$D/want"
expect_same "$FAKE_ARGS_OUT" "$D/want" "forwarded arguments"
expect_same "$FAKE_STDIN_OUT" "$TMP/prompt.txt" "prompt on stdin"
pass "pass-through — arguments follow -p --output-format json; prompt reaches stdin"

# ── permission mode: default acceptEdits unless the caller chose one ──────
scenario permdefault
printf '%s' "$JSON_OK" > "$FAKE_STDOUT"
run_wrapper "$TMP/prompt.txt"
expect_rc 0 "permission default"
printf '%s\n' -p --output-format json --permission-mode acceptEdits > "$D/want"
expect_same "$FAKE_ARGS_OUT" "$D/want" "default permission mode (no args)"
expect_same "$FAKE_STDIN_OUT" "$TMP/prompt.txt" "prompt on stdin"
pass "permission mode — acceptEdits applied by default with no arguments"

scenario permspace
printf '%s' "$JSON_OK" > "$FAKE_STDOUT"
run_wrapper "$TMP/prompt.txt" --permission-mode plan
expect_rc 0 "permission caller (space)"
printf '%s\n' -p --output-format json --permission-mode plan > "$D/want"
expect_same "$FAKE_ARGS_OUT" "$D/want" "caller --permission-mode plan"
pass "permission mode — caller '--permission-mode plan' suppresses the default"

scenario permequals
printf '%s' "$JSON_OK" > "$FAKE_STDOUT"
run_wrapper "$TMP/prompt.txt" --permission-mode=plan --model sonnet
expect_rc 0 "permission caller (equals)"
printf '%s\n' -p --output-format json --permission-mode=plan --model sonnet > "$D/want"
expect_same "$FAKE_ARGS_OUT" "$D/want" "caller --permission-mode=plan"
pass "permission mode — caller '--permission-mode=plan' suppresses the default"

scenario permempty
printf '%s' "$JSON_OK" > "$FAKE_STDOUT"
run_wrapper "$TMP/empty.txt"
expect_rc 0 "permission default (empty argv, empty prompt)"
printf '%s\n' -p --output-format json --permission-mode acceptEdits > "$D/want"
expect_same "$FAKE_ARGS_OUT" "$D/want" "default permission mode (empty argv)"
pass "permission mode — empty argv still gets the default"

# ── large prompt (> 1 MiB) and empty prompt ───────────────────────────────
scenario large
printf '%s' "$JSON_OK" > "$FAKE_STDOUT"
head -c "$BIG_PROMPT_BYTES" /dev/zero | tr '\0' 'a' > "$TMP/big.txt"
run_wrapper "$TMP/big.txt"
expect_rc 0 "large prompt"
expect_same "$FAKE_STDIN_OUT" "$TMP/big.txt" "large prompt"
pass "pass-through — a prompt over 1 MiB reaches stdin unchanged"

scenario emptyprompt
printf '%s' "$JSON_OK" > "$FAKE_STDOUT"
run_wrapper "$TMP/empty.txt"
expect_rc 0 "empty prompt"
[ -f "$FAKE_STDIN_OUT" ] && [ ! -s "$FAKE_STDIN_OUT" ] || fail "empty prompt: stdin should be empty"
pass "pass-through — an empty prompt reaches stdin as empty"

# ── is_error with exit 0 -> usage line, text, exit 1 ──────────────────────
scenario iserror
printf '%s' '{"type":"result","is_error":true,"result":"Not logged in","usage":{"input_tokens":1,"output_tokens":2}}' > "$FAKE_STDOUT"
run_wrapper "$TMP/prompt.txt"
expect_rc 1 "is_error"
printf 'RAD_USAGE {"input_tokens":1,"output_tokens":2,"total":3}\nNot logged in\n' > "$D/want"
expect_same "$D/out" "$D/want" "is_error stdout"
pass "is_error with exit 0 — usage line and text printed, exit 1"

# ── CLI exits non-zero with a JSON body: same status, converted output ────
scenario jsonfail
printf '%s' "$JSON_OK" > "$FAKE_STDOUT"
printf 'warning: slow\n' > "$FAKE_STDERR"
FAKE_EXIT=3
run_wrapper "$TMP/prompt.txt"
expect_rc 3 "json body, non-zero"
printf '%s\nHello there.\n' "$EXPECTED_USAGE" > "$D/want"
expect_same "$D/out" "$D/want" "json non-zero stdout"
expect_same "$D/err" "$FAKE_STDERR" "json non-zero stderr"
pass "non-zero exit with JSON body — CLI status kept, stderr unchanged"

# ── CLI exits non-zero with plain text: raw pass-through ──────────────────
scenario plainfail
printf 'boom: not json\n' > "$FAKE_STDOUT"
printf 'fatal: bad thing\n' > "$FAKE_STDERR"
FAKE_EXIT=2
run_wrapper "$TMP/prompt.txt"
expect_rc 2 "plain text, non-zero"
expect_same "$D/out" "$FAKE_STDOUT" "plain non-zero stdout"
expect_same "$D/err" "$FAKE_STDERR" "plain non-zero stderr"
pass "non-zero exit with plain text — raw stdout/stderr, same status"

# ── non-JSON output with exit 0: raw pass-through, no usage line ──────────
scenario nonjson
printf 'just some text, no json\n' > "$FAKE_STDOUT"
run_wrapper "$TMP/prompt.txt"
expect_rc 0 "non-JSON, exit 0"
expect_same "$D/out" "$FAKE_STDOUT" "non-JSON stdout"
! grep -q '^RAD_USAGE' "$D/out" || fail "non-JSON: must not add a RAD_USAGE line"
[ ! -s "$D/err" ] || fail "non-JSON: stderr should be empty"
pass "non-JSON output with exit 0 — raw pass-through, no usage line, exit 0"

# ── JSON that is not a result object: raw pass-through ────────────────────
scenario notresult
printf '%s' '{"type":"result","result":42,"usage":{"input_tokens":1}}' > "$FAKE_STDOUT"
run_wrapper "$TMP/prompt.txt"
expect_rc 0 "non-string result"
expect_same "$D/out" "$FAKE_STDOUT" "non-string result stdout"
pass "result that is not a string — raw pass-through, no usage line"

# ── CLI not on PATH ────────────────────────────────────────────────────────
scenario nocli
run_wrapper_no_cli "$TMP/prompt.txt"
[ "$RC" -ne 0 ] || fail "missing CLI: expected non-zero exit"
[ ! -s "$D/out" ] || fail "missing CLI: stdout should be empty"
grep -q 'could not run claude' "$D/err" || fail "missing CLI: expected a message on stderr"
pass "CLI not on PATH — non-zero exit, message on stderr"

# ── CLI killed by a signal ─────────────────────────────────────────────────
scenario signal
printf '%s' "$JSON_OK" > "$FAKE_STDOUT"
export FAKE_SIGNAL=KILL
run_wrapper "$TMP/prompt.txt"
[ "$RC" -ne 0 ] || fail "signal: expected non-zero exit"
grep -q 'killed by signal' "$D/err" || fail "signal: expected a message on stderr"
pass "CLI killed by a signal — non-zero exit, message on stderr"

echo "All $PASSED claude-usage assertions passed"
