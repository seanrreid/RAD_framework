#!/usr/bin/env bash
# test-fetch-provenance.sh
# Tests for fetch-provenance.sh: TSV shape, pagination, bots, a missing
# association, a failure at each gh call, the GitHub-only gate and argument
# validation. A fake `gh` is first on PATH; RAD_PLATFORM skips platform
# detection. Runs under bash 3.2+.
#
# Usage: scripts/test-fetch-provenance.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/fetch-provenance.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

command -v jq >/dev/null 2>&1 || { echo "✗ jq not found"; exit 1; }

fail() { echo "✗ $1"; exit 1; }
TAB=$(printf '\t')

BIN="$TMP/bin"
mkdir -p "$BIN"
# Fake gh: FAKE_FAIL=repo|issue|comments fails that call; fixtures come from
# $FAKE_DIR/issue.json and $FAKE_DIR/comments.json (concatenated pages allowed).
cat > "$BIN/gh" <<'GH'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_DIR/calls"
if [[ "$1" == "repo" ]]; then
  [[ "${FAKE_FAIL:-}" == "repo" ]] && { echo "repo boom" >&2; exit 1; }
  echo "org/repo"; exit 0
fi
last="${!#}"
if [[ "$last" == */comments ]]; then
  [[ "${FAKE_FAIL:-}" == "comments" ]] && { echo "comments boom" >&2; exit 1; }
  cat "$FAKE_DIR/comments.json"; exit 0
fi
[[ "${FAKE_FAIL:-}" == "issue" ]] && { echo "issue boom" >&2; exit 1; }
cat "$FAKE_DIR/issue.json"
GH
chmod +x "$BIN/gh"

export FAKE_DIR="$TMP/fx"
mkdir -p "$FAKE_DIR"
export PATH="$BIN:$PATH"
export RAD_PLATFORM=github

ISSUE_OWNER='{"user":{"login":"alice","type":"User"},"author_association":"OWNER"}'

# run <args...> → sets OUT, ERR, CODE
run() {
  set +e
  OUT=$("$SCRIPT" "$@" 2>"$TMP/err")
  CODE=$?
  set -e
  ERR=$(cat "$TMP/err")
}

expect() { # name expected-code expected-stdout
  [[ "$CODE" == "$2" ]] || fail "$1: exit $CODE, expected $2 (stderr: $ERR)"
  [[ "$OUT" == "$3" ]] || fail "$1: stdout was [$OUT], expected [$3]"
  echo "✓ $1"
}

fixture() { printf '%s' "$1" > "$FAKE_DIR/issue.json"; printf '%s' "$2" > "$FAKE_DIR/comments.json"; }

fixture "$ISSUE_OWNER" '[]'
run 42
expect "zero comments" 0 "issue${TAB}alice${TAB}User${TAB}OWNER"

fixture "$ISSUE_OWNER" '[{"user":{"login":"bob","type":"User"},"author_association":"NONE"}]'
run 42
expect "one comment" 0 "issue${TAB}alice${TAB}User${TAB}OWNER
comment${TAB}bob${TAB}User${TAB}NONE"

fixture "$ISSUE_OWNER" '[{"user":{"login":"a","type":"User"},"author_association":"MEMBER"},{"user":{"login":"b","type":"User"},"author_association":"CONTRIBUTOR"},{"user":{"login":"c","type":"User"},"author_association":"COLLABORATOR"}]'
run 42
expect "many comments" 0 "issue${TAB}alice${TAB}User${TAB}OWNER
comment${TAB}a${TAB}User${TAB}MEMBER
comment${TAB}b${TAB}User${TAB}CONTRIBUTOR
comment${TAB}c${TAB}User${TAB}COLLABORATOR"

fixture "$ISSUE_OWNER" '[{"user":{"login":"p1","type":"User"},"author_association":"OWNER"}][{"user":{"login":"p2","type":"User"},"author_association":"NONE"}]'
run 42
expect "multiple pages" 0 "issue${TAB}alice${TAB}User${TAB}OWNER
comment${TAB}p1${TAB}User${TAB}OWNER
comment${TAB}p2${TAB}User${TAB}NONE"
grep -q -- '--paginate' "$FAKE_DIR/calls" || fail "comments call did not use --paginate"

fixture '{"user":{"login":"dependabot[bot]","type":"Bot"},"author_association":"CONTRIBUTOR"}' '[]'
run 42
expect "bot author" 0 "issue${TAB}dependabot[bot]${TAB}Bot${TAB}CONTRIBUTOR"

fixture '{"user":{"login":"carol","type":"User"}}' '[{"user":{"login":"dave","type":"User"}}]'
run 42
expect "missing association" 0 "issue${TAB}carol${TAB}User${TAB}
comment${TAB}dave${TAB}User${TAB}"

fixture "$ISSUE_OWNER" '[]'
for step in repo issue comments; do
  FAKE_FAIL=$step run 42
  [[ "$CODE" == 1 ]] || fail "gh $step failing: exit $CODE, expected 1"
  [[ -z "$OUT" ]] || fail "gh $step failing: stdout must be empty, got [$OUT]"
  [[ "$ERR" == *"$step boom"* ]] || fail "gh $step failing: reason missing from stderr [$ERR]"
  echo "✓ gh $step fails → exit 1 with reason"
done

fixture 'not json' '[]'
run 42
[[ "$CODE" == 1 && -z "$OUT" && -n "$ERR" ]] || fail "unparseable issue: exit $CODE out [$OUT] err [$ERR]"
echo "✓ unparseable response → exit 1"

fixture "$ISSUE_OWNER" '[]'
RAD_PLATFORM=gitlab run 42
expect "non-GitHub platform" 3 "unsupported${TAB}gitlab"

for bad in "abc" "" "0" "-1" "4 2" '$(id)'; do
  run "$bad"
  [[ "$CODE" == 1 && -z "$OUT" && "$ERR" == *"positive integer"* ]] || fail "bad arg [$bad]: exit $CODE out [$OUT] err [$ERR]"
  echo "✓ rejects argument [$bad]"
done
run
[[ "$CODE" == 1 && "$ERR" == *"positive integer"* ]] || fail "no argument: exit $CODE err [$ERR]"
echo "✓ rejects missing argument"

echo "All fetch-provenance tests passed."
