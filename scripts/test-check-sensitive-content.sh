#!/usr/bin/env bash
# test-check-sensitive-content.sh
# Hermetic tests for scripts/check-sensitive-content.sh: `plan`, `diff` and
# `pattern` modes, fence/section awareness, and RAD_SENSITIVE_CONTENT_PATTERNS validation.
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

# --- diff mode: hermetic temp repo (the script only sources plan-paths.sh) ---
REPO="$TMP/repo"
mkdir -p "$REPO/scripts/lib" "$REPO/tests" "$REPO/.agents"
cp "$HERE/check-sensitive-content.sh" "$REPO/scripts/"
cp "$HERE/lib/plan-paths.sh" "$REPO/scripts/lib/"
DSCRIPT="$REPO/scripts/check-sensitive-content.sh"
TAB=$'\t'
repo_git() { git -C "$REPO" -c user.email=t@t -c user.name=t -c commit.gpgsign=false "$@" >/dev/null; }
commit_all() { repo_git add -A; repo_git commit -q -m "$1"; git -C "$REPO" rev-parse HEAD; }
# diff_run [env-assignment...] -- <args...>   (runs inside the temp repo)
diff_run() {
  local envs=()
  while [[ "$1" != "--" ]]; do envs+=("$1"); shift; done
  shift
  if (cd "$REPO" && env -u RAD_SENSITIVE_CONTENT_PATTERNS ${envs[@]+"${envs[@]}"} bash "$DSCRIPT" "$@") >"$OUT" 2>"$ERR"; then
    RC=0
  else
    RC=$?
  fi
}

repo_git init -q -b main
printf 'safe\nold sudo rm\n' > "$REPO/app.sh"
printf 'x\n' > "$REPO/tests/t.sh"; printf 'x\n' > "$REPO/doc.md"; printf 'x\n' > "$REPO/.agents/n.txt"
printf 'bin\000a\n' > "$REPO/blob.bin"; printf 'one\ntwo\nthree\nfour\nfive\nsix\n' > "$REPO/orig.txt"
BASE=$(commit_all base)
repo_git checkout -q -b feature

diff_run -- diff "$BASE" "$BASE"; expect "diff: empty diff" 0 ""

printf 'safe\n' > "$REPO/app.sh"
DEL=$(commit_all deleted)
diff_run -- diff "$BASE" "$DEL"; expect "diff: only deleted sensitive line not flagged" 0 ""

printf 'safe\nrun sudo rm now\n# chmod 600 key\n' > "$REPO/app.sh"
ADD=$(commit_all added)
WANT_ADD="${PREFIX}permission-change${TAB}1${TAB}app.sh:3
${PREFIX}privilege-escalation${TAB}1${TAB}app.sh:2"
diff_run -- diff "$BASE" "$ADD"; expect "diff: added line + comment line flagged, table order" 0 "$WANT_ADD"
diff_run -- diff main feature; expect "diff: branch names as refs" 0 "$WANT_ADD"

printf 'sudo x\n' > "$REPO/tests/t.sh"; printf 'sudo x\n' > "$REPO/doc.md"; printf 'sudo x\n' > "$REPO/.agents/n.txt"
TESTS=$(commit_all excluded)
diff_run -- diff "$ADD" "$TESTS"; expect "diff: test, markdown and .agents files not scanned" 0 ""

printf 'bin\000sudo rm\n' > "$REPO/blob.bin"
BIN=$(commit_all binary)
diff_run -- diff "$TESTS" "$BIN"; expect "diff: binary file yields no hits" 0 ""

git -C "$REPO" mv orig.txt moved.txt
MV=$(commit_all rename)
diff_run -- diff "$BIN" "$MV"; expect "diff: rename with no added lines" 0 ""

diff_run -- diff "$BASE" 0000000000000000000000000000000000000001; expect "diff: unreachable head" 2 ""
grep -q "head" "$ERR" || fail "unreachable head: stderr does not name head ($(cat "$ERR"))"
diff_run -- diff 0000000000000000000000000000000000000001 "$ADD"; expect "diff: unreachable base" 2 ""
grep -q "base" "$ERR" || fail "unreachable base: stderr does not name base ($(cat "$ERR"))"

diff_run -- diff -evil "$ADD"; expect "diff: leading dash base" 2 ""
diff_run -- diff "$BASE" --output=x; expect "diff: leading dash head" 2 ""
diff_run -- diff "$BASE
$ADD" "$ADD"; expect "diff: newline in ref" 2 ""
diff_run -- diff 'main;touch x' "$ADD"; expect "diff: semicolon in ref" 2 ""
diff_run -- diff '$(id)' "$ADD"; expect "diff: command substitution in ref" 2 ""
diff_run -- diff 'a b' "$ADD"; expect "diff: space in ref" 2 ""
[[ ! -e "$REPO/x" ]] || fail "hostile ref created a file"
diff_run -- diff "$BASE"; expect "diff: missing head arg" 2 ""
diff_run -- diff; expect "diff: no args" 2 ""

diff_run RAD_SENSITIVE_CONTENT_PATTERNS=-evil -- diff "$BASE" "$ADD"; expect "diff: override leading dash" 2 ""
diff_run "RAD_SENSITIVE_CONTENT_PATTERNS=(" -- diff "$BASE" "$ADD"; expect "diff: override uncompilable" 2 ""
diff_run "RAD_SENSITIVE_CONTENT_PATTERNS=chmod [0-9]+" -- diff "$BASE" "$ADD"
expect "diff: valid override -> custom" 0 "${PREFIX}custom${TAB}1${TAB}app.sh:3"
diff_run "RAD_SENSITIVE_CONTENT_PATTERNS=zzz-no-match" -- diff "$BASE" "$ADD"; expect "diff: override no hit" 0 ""

# count and MAX_LOCATIONS cap (5): seven hits -> count 7, first five locations
printf 'sudo a\nsudo b\nsudo c\nsudo d\nsudo e\nsudo f\nsudo g\n' > "$REPO/many.sh"
MANY=$(commit_all many)
WANT_MANY="${PREFIX}privilege-escalation${TAB}7${TAB}many.sh:1,many.sh:2,many.sh:3,many.sh:4,many.sh:5"
diff_run -- diff "$MV" "$MANY"; expect "diff: count and location cap" 0 "$WANT_MANY"
FIRST=$(cat "$OUT")
diff_run -- diff "$MV" "$MANY"
[[ "$(cat "$OUT")" == "$FIRST" ]] || fail "diff: output order not stable across runs"
echo "✓ diff: order stable across two runs"

# a line starting with '++' is added content, not a file header
printf '++ sudo z\n' > "$REPO/plus.sh"
PLUS=$(commit_all plus)
diff_run -- diff "$MANY" "$PLUS"; expect "diff: added line starting with ++" 0 "${PREFIX}privilege-escalation${TAB}1${TAB}plus.sh:1"

# file names with spaces and non-ASCII characters are reported unquoted
printf 'sudo a\n' > "$REPO/my file.sh"; printf 'sudo b\n' > "$REPO/café.sh"
SPACES=$(commit_all spaces)
diff_run -- diff "$PLUS" "$SPACES"
expect "diff: space and non-ASCII file names" 0 "${PREFIX}privilege-escalation${TAB}2${TAB}café.sh:1,my file.sh:1"

# a rename WITH edits scans the added lines under the new name
printf 'a\nb\nc\nd\ne\nf\ng\nh\n' > "$REPO/orig2.txt"
SEED=$(commit_all seed2)
git -C "$REPO" mv orig2.txt renamed2.sh
printf 'a\nb\nc\nd\ne\nf\ng\nh\nsudo extra\n' > "$REPO/renamed2.sh"
RENAMED=$(commit_all rename-edit)
diff_run -- diff "$SEED" "$RENAMED"
expect "diff: rename with edits flagged under the new name" 0 "${PREFIX}privilege-escalation${TAB}1${TAB}renamed2.sh:9"

# markdown is excluded whatever the case of the extension
printf 'sudo x\n' > "$REPO/NOTES.MD"; printf 'sudo y\n' > "$REPO/more.Md"
UPPER=$(commit_all upper-md)
diff_run -- diff "$RENAMED" "$UPPER"; expect "diff: .MD and .Md files not scanned" 0 ""

# the script that defines the patterns is never scanned (its table would flag itself)
# appended as comments: the copy under test must stay runnable
printf '# edit\n# sudo y\n' >> "$REPO/scripts/check-sensitive-content.sh"
SELFED=$(commit_all self-edit)
diff_run -- diff "$UPPER" "$SELFED"; expect "diff: the pattern script itself is not scanned" 0 ""

# plan mode and pattern mode are unchanged
make_plan "$PLAN" "uses sudo now"
run_script -- plan "$PLAN"; expect "diff: plan mode unchanged" 0 "${PREFIX}privilege-escalation"
run_script -- pattern; expect "diff: pattern mode unchanged" 0 ""

echo "ALL PASS"
