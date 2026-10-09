#!/usr/bin/env bash
# test-worktree-lifecycle.sh
# Regression test for worktree-lifecycle.sh node_modules linking: create links the
# main checkout's harness/node_modules, remove deletes only that symlink, preserve
# keeps it, and a missing source or existing destination is a note, never an error.
# Real git in a temp repo. Usage: scripts/test-worktree-lifecycle.sh
# Runs under bash 3.2+ (set -u safe).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/worktree-lifecycle.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILED=0

fail() { echo "FAIL: $*" >&2; FAILED=1; }

REPO="$TMP/repo"
mkdir -p "$REPO/harness"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email t@example.test
git -C "$REPO" config user.name t
printf 'node_modules\n' > "$REPO/harness/.gitignore"
echo x > "$REPO/harness/a.txt"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m init
for b in b1 b2 b3 b4 b5 b7 b8 b9 b10; do git -C "$REPO" branch "$b"; done

run() { (cd "$REPO" && "$@"); }
mk_src() { mkdir -p "$REPO/harness/node_modules/pkg"; echo ok > "$REPO/harness/node_modules/pkg/i.js"; }

# 1. create links; ignore rule holds; git add -A never stages it
mk_src
D1="$TMP/wt one"
run bash "$SCRIPT" create f1 b1 "$D1" >/dev/null 2>&1 || fail "create f1 exited non-zero"
[[ -L "$D1/harness/node_modules" ]] || fail "create did not link node_modules"
[[ -f "$D1/harness/node_modules/pkg/i.js" ]] || fail "link does not resolve to the source"
git -C "$D1" check-ignore -q harness/node_modules || fail "symlink is not ignored"
git -C "$D1" add -A
git -C "$D1" diff --cached --name-only | grep -q node_modules && fail "git add -A staged the link"

# 2. preserve keeps the link
run bash "$SCRIPT" preserve f1 "$D1" >/dev/null 2>&1 || fail "preserve exited non-zero"
[[ -L "$D1/harness/node_modules" ]] || fail "preserve removed the link"

# 3. remove from inside a worktree deletes only the link; target intact
git -C "$D1" reset -q
(cd "$D1" && bash "$SCRIPT" remove f1 "$D1" >/dev/null 2>&1) || fail "remove from inside worktree failed"
[[ -e "$D1" ]] && fail "worktree dir still exists after remove"
[[ -f "$REPO/harness/node_modules/pkg/i.js" ]] || fail "remove damaged the link target"

# 4. no source: create succeeds with a stderr note and no link
rm -rf "$REPO/harness/node_modules"
D2="$TMP/wt2"
ERR="$(run bash "$SCRIPT" create f2 b2 "$D2" 2>&1 >/dev/null)" || fail "create with no source failed"
[[ -e "$D2/harness/node_modules" || -L "$D2/harness/node_modules" ]] && fail "link made without a source"
echo "$ERR" | grep -q "no .*node_modules" || fail "no stderr note for missing source"
run bash "$SCRIPT" remove f2 "$D2" >/dev/null 2>&1 || fail "remove f2 failed"

# 5. existing destination (a branch tracking harness/node_modules): left alone, noted
mk_src
git -C "$REPO" checkout -q -b b6
mkdir -p "$REPO/harness/node_modules"; echo mine > "$REPO/harness/node_modules/keep"
git -C "$REPO" add -f harness/node_modules/keep
git -C "$REPO" commit -q -m tracked
git -C "$REPO" checkout -q main
D3="$TMP/wt3"
ERR="$(run bash "$SCRIPT" create f3 b6 "$D3" 2>&1 >/dev/null)" || fail "create with existing destination failed"
[[ -d "$D3/harness/node_modules" && ! -L "$D3/harness/node_modules" ]] || fail "existing destination was replaced"
[[ -f "$D3/harness/node_modules/keep" ]] || fail "existing destination content lost"
echo "$ERR" | grep -q "already exists" || fail "no stderr note for existing destination"

# 6. remove leaves a real directory alone (git, not us, decides); source untouched
run bash "$SCRIPT" remove f3 "$D3" >/dev/null 2>&1 || true
[[ -f "$REPO/harness/node_modules/pkg/i.js" ]] || fail "remove damaged the link target"

# 7. paths with spaces: explicit dir with a space (and a space in its parent)
mk_src
D4="$TMP/with space/f4 dir"
OUT4="$(run bash "$SCRIPT" create f4 b7 "$D4" 2>/dev/null)" || fail "create with spaces exited non-zero"
[[ "$(echo "$OUT4" | tail -n 1)" == "$D4" ]] || fail "create did not print the spaced dir as last line"
[[ -L "$D4/harness/node_modules" ]] || fail "no symlink in spaced worktree"
[[ "$(cd "$D4/harness/node_modules" && pwd -P)" == "$(cd "$REPO/harness/node_modules" && pwd -P)" ]] \
  || fail "spaced worktree link does not resolve to the main checkout"
run bash "$SCRIPT" remove f4 "$D4" >/dev/null 2>&1 || fail "remove of spaced worktree failed"
[[ -e "$D4" ]] && fail "spaced worktree dir still exists after remove"
[[ -f "$REPO/harness/node_modules/pkg/i.js" ]] || fail "remove of spaced worktree damaged the source"

# 8. unmarked directory: remove still refuses and touches nothing
D5="$TMP/unmarked dir"
mkdir -p "$D5/harness"
echo precious > "$D5/precious.txt"
ln -s "$REPO/harness/node_modules" "$D5/harness/node_modules"
RC5=0
OUT5="$(run bash "$SCRIPT" remove f5 "$D5" 2>&1)" || RC5=$?
[[ "$RC5" -ne 0 ]] || fail "remove of an unmarked directory exited 0"
echo "$OUT5" | grep -q "refusing to remove" || fail "no 'refusing to remove' message for unmarked directory"
[[ -f "$D5/precious.txt" ]] || fail "unmarked directory content was removed"
[[ -L "$D5/harness/node_modules" ]] || fail "unmarked directory's symlink was touched"
[[ -f "$REPO/harness/node_modules/pkg/i.js" ]] || fail "refused remove damaged the link target"

# 9. create run from inside a worktree links from the MAIN checkout
D6="$TMP/wt6"
D7="$TMP/wt7"
run bash "$SCRIPT" create f6 b8 "$D6" >/dev/null 2>&1 || fail "create f6 exited non-zero"
(cd "$D6" && bash "$SCRIPT" create f7 b9 "$D7" >/dev/null 2>&1) || fail "create from inside a worktree exited non-zero"
[[ -L "$D7/harness/node_modules" ]] || fail "create from a worktree made no symlink"
T7="$(readlink "$D7/harness/node_modules")"
[[ "$(cd "$T7" && pwd -P)" == "$(cd "$REPO/harness/node_modules" && pwd -P)" ]] \
  || fail "worktree-created link does not target the main checkout"
[[ "$T7" == "$D6/harness/node_modules" ]] && fail "link targets the first worktree's link path"
run bash "$SCRIPT" remove f7 "$D7" >/dev/null 2>&1 || fail "remove f7 failed"
run bash "$SCRIPT" remove f6 "$D6" >/dev/null 2>&1 || fail "remove f6 failed"
[[ -f "$REPO/harness/node_modules/pkg/i.js" ]] || fail "removes damaged the link target"

if [[ "$FAILED" -ne 0 ]]; then exit 1; fi
echo "test-worktree-lifecycle: all assertions passed"
