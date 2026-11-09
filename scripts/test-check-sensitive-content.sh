#!/usr/bin/env bash
# test-check-sensitive-content.sh
# Hermetic tests for scripts/check-sensitive-content.sh: `plan` and `pattern`
# modes, fence/section awareness, and RAD_SENSITIVE_CONTENT_PATTERNS validation.
# Runs under bash 3.2+.
#
# Usage: scripts/test-check-sensitive-content.sh   (exit 0 + "ALL PASS")

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/check-sensitive-content.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
OUT="$TMP/out.txt"
ERR="$TMP/err.txt"
PREFIX="sensitive-content:"

fail() { echo "✗ $1"; exit 1; }

# run_script [env-assignment...] -- <args...>
# Sets RC; stdout/stderr go to $OUT/$ERR. The override is unset unless given.
run_script() {
  local envs=()
  while [[ "$1" != "--" ]]; do envs+=("$1"); shift; done
  shift
  if env -u RAD_SENSITIVE_CONTENT_PATTERNS ${envs[@]+"${envs[@]}"} bash "$SCRIPT" "$@" >"$OUT" 2>"$ERR"; then
    RC=0
  else
    RC=$?
  fi
}

# expect <name> <rc> <expected-stdout>
expect() {
  local name="$1" rc="$2" want="$3" got
  got=$(cat "$OUT")
  [[ "$RC" -eq "$rc" ]] || fail "$name: exit $RC, want $rc ($(cat "$ERR"))"
  [[ "$got" == "$want" ]] || fail "$name: stdout '$got', want '$want'"
  echo "✓ $name"
}

# make_plan <file> <context-line> [task-what-line]
make_plan() {
  printf '# Plan: T\n\n## Context\n%s\n\n## Scope\nplain scope\n\n## Wave Plan\n\n### Wave 1\n\n#### Task 1.1: t\nFile: a.sh\nWhat: %s\nValidate: ok\n' \
    "$2" "${3:-plain task}" > "$1"
}

PLAN="$TMP/plan.md"

# --- empty / clean ---
: > "$TMP/empty.md"
run_script -- plan "$TMP/empty.md"; expect "empty plan" 0 ""
make_plan "$PLAN" "adds a helper"
run_script -- plan "$PLAN"; expect "no sensitive terms" 0 ""

# --- each built-in id ---
check_id() {
  make_plan "$PLAN" "$2"
  run_script -- plan "$PLAN"; expect "id $1" 0 "$PREFIX$1"
}
check_id dynamic-eval "calls eval(input) at startup"
check_id permission-change "runs chmod 600 on the output"
check_id destructive-sql "will drop table users"
check_id credential-handling "logs the api key to disk"
check_id network-egress "runs curl -s https://x to upload"
check_id privilege-escalation "invokes sudo rm on it"

# --- fences and ignored sections ---
printf '# Plan: T\n\n## Context\nplain\n```\nchmod 777 x\n```\n\n## Scope\nplain\n' > "$PLAN"
run_script -- plan "$PLAN"; expect "fenced block ignored" 0 ""
cat > "$PLAN" <<'PLAN_EOF'
# Plan: T

## Context
plain

## Execution Notes

### Do Not Touch
- eval of sudo chmod

## Non-Goals
- curl the password

## Waivers
- sensitive-content:dynamic-eval: uses eval safely
PLAN_EOF
run_script -- plan "$PLAN"; expect "Non-Goals/Do Not Touch/Waivers ignored" 0 ""

# --- task What: and Files-in-Scope Change cell ---
make_plan "$PLAN" "plain" "run sudo here"
run_script -- plan "$PLAN"; expect "task What: flagged" 0 "${PREFIX}privilege-escalation"
printf '# Plan: T\n\n## Files in Scope\n| File | Lines | Change |\n|---|---|---|\n| sudo.sh | 1-5 | calls chmod |\n' > "$PLAN"
run_script -- plan "$PLAN"; expect "Change cell flagged, File cell not" 0 "${PREFIX}permission-change"

# --- bare words in prose are not code-shaped: never flagged ---
make_plan "$PLAN" "evaluation of a regression, the secret garden, egress policy docs, webhook docs, eval fixture"
run_script -- plan "$PLAN"; expect "bare words in prose not flagged" 0 ""
make_plan "$PLAN" 'runs eval "$cmd" once'
run_script -- plan "$PLAN"; expect "eval with a quoted argument flagged" 0 "${PREFIX}dynamic-eval"

# --- unterminated fence fails closed (never reported as "no hits") ---
printf '# Plan: T\n\n## Context\nplain\n```\nnever closed\n\n## Scope\nruns sudo rm now\n' > "$PLAN"
run_script -- plan "$PLAN"; expect "unterminated fence exits 2, stdout empty" 2 ""
grep -q "never closed\|code fence" "$ERR" || fail "unterminated fence: stderr does not name the fence ($(cat "$ERR"))"
printf '# Plan: T\n\n## Context\nplain\n```\nclosed\n```\n\n## Scope\nruns sudo rm now\n' > "$PLAN"
run_script -- plan "$PLAN"; expect "closed fence still scans later sections" 0 "${PREFIX}privilege-escalation"

# --- corpus guard: the built-in table must stay quiet on this repo's own plans ---
CORPUS="$HERE/../.agents/plans"
if [[ -d "$CORPUS" ]]; then
  total=0 flagged=0 errored=0
  for f in "$CORPUS"/*.md; do
    [[ -f "$f" ]] || continue
    total=$((total + 1))
    run_script -- plan "$f"
    [[ "$RC" -eq 0 ]] || { errored=$((errored + 1)); echo "  corpus error: $f ($(cat "$ERR"))"; continue; }
    [[ -s "$OUT" ]] && flagged=$((flagged + 1))
  done
  [[ "$errored" -eq 0 ]] || fail "corpus: $errored plan(s) exited non-zero"
  # at most 10% of existing plans may need a waiver (measured at about 2%)
  [[ $((flagged * 10)) -le "$total" ]] || fail "corpus: $flagged of $total plans flagged (limit 10%)"
  echo "✓ corpus: $flagged of $total existing plans flagged"
fi

# --- missing plan / usage ---
run_script -- plan "$TMP/nope.md"; expect "missing plan" 2 ""
run_script -- bogus; expect "bad mode" 2 ""

# --- override: unset-equivalents use the default table ---
make_plan "$PLAN" "uses sudo now"
run_script RAD_SENSITIVE_CONTENT_PATTERNS= -- plan "$PLAN"; expect "empty override = default" 0 "${PREFIX}privilege-escalation"
run_script "RAD_SENSITIVE_CONTENT_PATTERNS=   " -- plan "$PLAN"; expect "whitespace override = default" 0 "${PREFIX}privilege-escalation"

# --- override: invalid values exit 2 with empty stdout ---
run_script RAD_SENSITIVE_CONTENT_PATTERNS=-evil -- plan "$PLAN"; expect "leading dash" 2 ""
run_script "RAD_SENSITIVE_CONTENT_PATTERNS=a
b" -- plan "$PLAN"; expect "newline" 2 ""
run_script "RAD_SENSITIVE_CONTENT_PATTERNS=(" -- plan "$PLAN"; expect "uncompilable regex" 2 ""

# --- override: valid ---
run_script "RAD_SENSITIVE_CONTENT_PATTERNS=uses s[a-z]do" -- plan "$PLAN"; expect "valid override -> custom" 0 "${PREFIX}custom"
run_script "RAD_SENSITIVE_CONTENT_PATTERNS=zzz-no-match" -- plan "$PLAN"; expect "override no hit" 0 ""

# --- pattern mode ---
run_script -- pattern; expect "pattern default" 0 ""
run_script "RAD_SENSITIVE_CONTENT_PATTERNS=foo|bar" -- pattern; expect "pattern override" 0 "foo|bar"
run_script RAD_SENSITIVE_CONTENT_PATTERNS=-x -- pattern; expect "pattern invalid" 2 ""

echo "ALL PASS"
